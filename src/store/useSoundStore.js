import { create } from 'zustand';
import {
  plPlayPause, plStop, plNext, plPrev, plPlayIndex, plSetVolume, plSetDevice, plSeek,
  plPosition, plStartAt,
  duckAdd, duckRemove, duckReset, duckRefresh,
} from '../lib/playlistEngine';
import {
  csPlay, csStop, csPause, csResume, csSeek, csSetVolume,
  csPreviewStart, csPreviewStop,
} from '../lib/cueStreamEngine';
import {
  plaPlayPause, plaStop, plaNext, plaPrev, plaPlayIndex, plaSetVolume, plaSeek, plaSetDevice,
  plaPosition, plaStartAt,
} from '../lib/playlistAsio';
import { invoke } from '@tauri-apps/api/core';
import { hasClip, isVideo, effFadeIn, effFadeOut, slotDuration } from '../lib/slotAudio';
import { dispatchCue } from '../lib/cueDispatch';
import { isAsioTarget, resolveCueTargetStr, parseTarget } from '../lib/outputTarget';
import { clearAsioTelemetry, asioPosition } from '../lib/asioTelemetry';
import { PREVIEW_VOICE_ID } from '../lib/asioIds';
import { emitVideoPlay, emitVideoStop, emitVideoBlack, emitVideoVolume, emitVideoSeek } from '../lib/videoOutput';

const SLOTS_PER_PAGE = 32;   // 8 columnes × 4 files
const NUM_PAGES = 4;         // pàgines de cues (4 × 32 = 128 cues)
const NUM_SLOTS = SLOTS_PER_PAGE * NUM_PAGES;

const createEmptySlot = (id) => ({
  id,
  label: '',
  filePath: null,      // ruta absoluta del fitxer (per recarregar des de la Library)
  mediaType: 'audio',  // 'audio' | 'video' (els cues de vídeo van a la finestra de sortida)
  loading: false,      // s'està llegint/descodificant
  audioUrl: null,
  audioBuffer: null,
  isStreaming: false,  // cue llarg (>60s): es reprodueix amb <audio> en streaming
  streamDuration: 0,   // durada (s) del fitxer en streaming (des de les metadades)
  peaks: null,         // pics min/max de la forma d'ona (streaming; generats en segon pla)
  gainNode: null,
  fadeGainNode: null,  // node de guany dedicat als fades (independent del volum)
  analyserNode: null,
  sourceNode: null,
  isPlaying: false,
  asioActive: false,   // sona pel motor ASIO natiu (playhead/VU venen per telemetria)
  volume: 0.8,
  startedAt: 0,        // instant (audioContext.currentTime) en què va començar a sonar
  pausedAt: null,      // posició (s dins el segment) on s'ha pausat (null = no pausat)
  loop: false,         // opció de reproducció: repeteix el mateix slot
  color: null,         // color del cue (organització + futur routing per grup)
  stopOthers: false,   // en disparar, atura la resta de cues (QLab)
  duck: false,         // en sonar, abaixa el volum de la Playlist (ducking)
  stopPlaylist: false, // en disparar, atura del tot la Playlist (alternatiu al duck)
  // Edició del slot (segons l'editor) — tot en segons
  startPoint: 0,       // punt d'inici dins el buffer
  stopPoint: null,     // punt de stop (null = final del buffer)
  fadeIn: null,        // fade in propi (null = usa el global; 0 = tall sec explícit)
  fadeOut: null,       // fade out propi (null = usa el global; 0 = tall sec explícit)
  // Seqüència estil QLab (mode GO)
  preWait: 0,          // retard (s) entre prémer GO i que el cue soni
  continueMode: 'none',// 'none' | 'auto' (auto-continue: dispara el següent tot seguit)
});

// Versió de l'esquema de persistència dels slots. v2 introdueix el fade com a
// override nullable (null = segueix el global; 0 = tall sec explícit). Abans, 0
// volia dir "segueix el global", per això migrem els 0 antics a null.
const SLOTS_SCHEMA = 2;
const loadPersistedSlots = () => {
  try {
    const saved = localStorage.getItem('the-player-slots');
    if (!saved) return null;
    const parsed = JSON.parse(saved);
    // Format antic (array directe, sense versió): migra fadeIn/fadeOut 0 → null
    if (Array.isArray(parsed)) {
      return parsed.map((s) => (s ? {
        ...s,
        fadeIn: s.fadeIn ? s.fadeIn : null,
        fadeOut: s.fadeOut ? s.fadeOut : null,
      } : s));
    }
    return Array.isArray(parsed.slots) ? parsed.slots : null;
  } catch {
    return null;
  }
};

const savedSlots = loadPersistedSlots();

const loadGlobals = () => {
  try { return JSON.parse(localStorage.getItem('the-player-globals')) || {}; }
  catch { return {}; }
};
const savedGlobals = loadGlobals();

const loadPlaylist = () => {
  try { return JSON.parse(localStorage.getItem('the-player-playlist')) || {}; }
  catch { return {}; }
};
const savedPlaylist = loadPlaylist();
let plNextId = 1;
let previewSource = null; // font activa del bus de preview (a nivell de mòdul)
// Timers pendents de la seqüència GO (pre-wait i encadenament auto-continue).
// A nivell de mòdul perquè els puguem cancel·lar des de stopAll o d'un GO nou.
const goTimers = new Set();
// Cues que formen part de la cadena auto-continue en curs: dins una cadena no
// es tallen entre ells (Stop Others només actua sobre cues de FORA la cadena).
// Només l'usa el camí de GO; els disparos manuals (teclat/clic) no el passen.
const goChain = new Set();
const clearGoTimers = () => {
  for (const t of goTimers) clearTimeout(t);
  goTimers.clear();
  goChain.clear();
};
const cueCtxRegistry = new Map(); // deviceId → AudioContext (busos de color dels cues)
if (Array.isArray(savedPlaylist.tracks)) {
  for (const t of savedPlaylist.tracks) if (t.id >= plNextId) plNextId = t.id + 1;
}

const initialSlots = Array.from({ length: NUM_SLOTS }, (_, i) => {
  const base = createEmptySlot(i + 1);
  if (savedSlots && savedSlots[i]) {
    return {
      ...base,
      label: savedSlots[i].label || '',
      filePath: savedSlots[i].filePath ?? null,
      mediaType: savedSlots[i].mediaType ?? 'audio',
      isStreaming: savedSlots[i].isStreaming ?? false,
      streamDuration: savedSlots[i].streamDuration ?? 0,
      volume: savedSlots[i].volume ?? 0.8,
      loop: savedSlots[i].loop ?? false,
      color: savedSlots[i].color ?? null,
      stopOthers: savedSlots[i].stopOthers ?? false,
      duck: savedSlots[i].duck ?? false,
      stopPlaylist: savedSlots[i].stopPlaylist ?? false,
      startPoint: savedSlots[i].startPoint ?? 0,
      stopPoint: savedSlots[i].stopPoint ?? null,
      fadeIn: savedSlots[i].fadeIn ?? null,
      fadeOut: savedSlots[i].fadeOut ?? null,
      preWait: savedSlots[i].preWait ?? 0,
      continueMode: savedSlots[i].continueMode ?? 'none',
    };
  }
  return base;
});

export const useSoundStore = create((set, get) => ({
  slots: initialSlots,
  globalFadeIn: savedGlobals.globalFadeIn ?? 0,   // fades per defecte de tots els cues
  globalFadeOut: savedGlobals.globalFadeOut ?? 0,
  cuesStopOthers: savedGlobals.cuesStopOthers ?? false, // Stop Others global per a tots els cues
  cuesDuck: savedGlobals.cuesDuck ?? false,             // Ducking per defecte dels cues nous
  cuesStopPlaylist: savedGlobals.cuesStopPlaylist ?? false, // Stop Playlist per defecte dels cues nous
  // ── Ducking de la Playlist (híbrid: paràmetres globals + activador per cue) ──
  duckEnabled: savedGlobals.duckEnabled ?? false,  // activa el ducking globalment
  duckAmount: savedGlobals.duckAmount ?? 0.3,       // volum al qual baixa la playlist (factor lineal 0..1; 0.3 = 30%)
  duckAttack: savedGlobals.duckAttack ?? 0.2,       // temps (s) de baixada en començar un cue de duck
  duckRelease: savedGlobals.duckRelease ?? 0.8,     // temps (s) de recuperació quan no queda cap cue de duck
  duckHold: savedGlobals.duckHold ?? 0,             // espera (s) abans de recuperar (0 = immediat)
  viewMode: 'grid',        // 'grid' (botonera 8×4) | 'list' (llista de files)
  editingSlot: null,       // id del slot obert a l'editor (o null)
  dragOverSlot: null,      // id del slot sota un drag&drop natiu (o null)
  selectedSlot: 1,         // slot seleccionat (cursor de teclat per al transport)
  currentPage: 0,          // pàgina de cues visible (0..NUM_PAGES-1)
  numPages: NUM_PAGES,
  activeSlot: null,
  audioDevices: [],
  // Tres busos de sortida (cada un a un dispositiu estèreo)
  selectedDeviceId: savedGlobals.cuesDeviceId ?? 'default',  // sortida dels CUES
  playlistDeviceId: savedGlobals.playlistDeviceId ?? 'default',
  previewDeviceId: savedGlobals.previewDeviceId ?? 'default',
  asioMasterGain: savedGlobals.asioMasterGain ?? 1,  // gain mestre del bus ASIO (0..1)
  audioContext: null,      // context dels cues
  playlistCtx: null,       // context de la playlist
  previewCtx: null,        // context del preview
  outputChannels: 2,       // canals màxims de sortida del dispositiu de cues
  previewArmed: false,     // Ctrl premut: mode preview
  previewingSlot: null,    // slot que sona ara pel bus de preview
  previewStartedAt: 0,     // instant (previewCtx) en què va començar el preview
  colorOutputs: savedGlobals.colorOutputs || {}, // { color: deviceId } routing per grup

  // ── Playlist (VLC) ──
  playlist: Array.isArray(savedPlaylist.tracks) ? savedPlaylist.tracks : [],
  playlistIndex: -1,
  playlistSelected: 0,     // cursor de selecció a la llista (fletxes / clic)
  playlistPlaying: false,
  playlistPaused: false,
  crossfade: savedPlaylist.crossfade ?? 3,
  // Mode de repetició: 'off' | 'song' (repeteix la pista) | 'list' (repeteix la llista)
  // Retrocompatibilitat amb sessions antigues que guardaven repeat com a booleà.
  playlistRepeatMode: savedPlaylist.repeatMode ?? (savedPlaylist.repeat ? 'list' : 'off'),
  playlistShuffle: savedPlaylist.shuffle ?? false,
  playlistVolume: savedPlaylist.volume ?? 0.8,

  initAudioContext: () => {
    const existing = get().audioContext;
    if (existing && existing.state !== 'closed') return existing;
    const ctx = new AudioContext();
    set({ audioContext: ctx });
    return ctx;
  },

  persistGlobals: () => {
    const {
      globalFadeIn, globalFadeOut, cuesStopOthers, cuesDuck, cuesStopPlaylist, selectedDeviceId, playlistDeviceId, previewDeviceId, colorOutputs,
      duckEnabled, duckAmount, duckAttack, duckRelease, duckHold, asioMasterGain,
    } = get();
    localStorage.setItem('the-player-globals', JSON.stringify({
      globalFadeIn, globalFadeOut, cuesStopOthers, cuesDuck, cuesStopPlaylist,
      cuesDeviceId: selectedDeviceId, playlistDeviceId, previewDeviceId,
      colorOutputs,
      duckEnabled, duckAmount, duckAttack, duckRelease, duckHold, asioMasterGain,
    }));
  },

  // Gain mestre del bus ASIO (0..1). S'aplica al motor natiu (abans del soft clip)
  // i es desa. També es reaplica en arrencar (initAsioMaster).
  setAsioMasterGain: (v) => {
    const gain = Math.max(0, Math.min(1.5, v));
    set({ asioMasterGain: gain });
    invoke('asio_set_master_gain', { gain }).catch(() => { /* sense ASIO */ });
    get().persistGlobals();
  },
  // Aplica el gain mestre desat al motor en arrencar.
  initAsioMaster: () => {
    invoke('asio_set_master_gain', { gain: get().asioMasterGain ?? 1 }).catch(() => { /* res */ });
  },

  // Stop Others global: en disparar qualsevol cue, atura la resta
  setCuesStopOthers: (on) => { set({ cuesStopOthers: !!on }); get().persistGlobals(); },
  // Acció per defecte dels cues nous sobre la Playlist: 'none' | 'duck' | 'stop'
  // (duck i stop són mútuament excloents)
  setCuesPlaylistAction: (action) => {
    set({ cuesDuck: action === 'duck', cuesStopPlaylist: action === 'stop' });
    get().persistGlobals();
  },

  // Paràmetres globals del ducking. Reaplica el factor de duck al motor de la
  // playlist (p. ex. canviar duckAmount mentre està duckejat, o desactivar-lo).
  setDuckSettings: (patch) => {
    set(patch);
    get().persistGlobals();
    duckRefresh(get);
  },

  // Acció d'un cue sobre la Playlist: 'none' | 'duck' | 'stop'. Duck (abaixa) i
  // stop (atura del tot) són mútuament excloents. Si el cue ja sona, ajusta el
  // comptador de ducking en calent i, si passa a 'stop', atura la playlist ara.
  setPlaylistAction: (slotId, action) => {
    const slot = get().slots.find((s) => s.id === slotId);
    const wasPlaying = slot && (slot.isPlaying || slot.pausedAt != null);
    const wasDuck = !!(slot && slot.duck);
    const duck = action === 'duck';
    const stopPlaylist = action === 'stop';
    set((state) => ({
      slots: state.slots.map((s) => (s.id === slotId ? { ...s, duck, stopPlaylist } : s)),
    }));
    if (wasPlaying) {
      if (duck && !wasDuck) duckAdd(get, slotId);
      else if (!duck && wasDuck) duckRemove(get, slotId);
      if (stopPlaylist) get().playlistStop();
    }
    get().persistSlots();
  },

  // Retorna (o crea) el context d'un dispositiu de sortida per als cues.
  // El bus de Cues reutilitza l'audioContext principal.
  ctxForDevice: (deviceId) => {
    const st = get();
    if (!deviceId || deviceId === st.selectedDeviceId) {
      return st.audioContext || get().initAudioContext();
    }
    let ctx = cueCtxRegistry.get(deviceId);
    if (!ctx || ctx.state === 'closed') {
      ctx = new AudioContext();
      if (ctx.setSinkId) { try { ctx.setSinkId(deviceId); } catch { /* res */ } }
      cueCtxRegistry.set(deviceId, ctx);
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  },

  // Assigna un color a un dispositiu de sortida (routing per grup)
  setColorOutput: (color, deviceId) => {
    set((state) => {
      const colorOutputs = { ...state.colorOutputs };
      if (!deviceId || deviceId === 'cues') delete colorOutputs[color];
      else colorOutputs[color] = deviceId;
      return { colorOutputs };
    });
    get().persistGlobals();
    // El routing per color ha canviat: pre-descodifica els cues que ara són ASIO.
    get().preloadAllAsioCues();
  },

  setGlobalFades: (patch) => {
    set(patch);
    get().persistGlobals();
  },

  // Crea/reutilitza el context d'un bus i li aplica el dispositiu de sortida
  ensurePlaylistCtx: () => {
    let ctx = get().playlistCtx;
    if (!ctx || ctx.state === 'closed') {
      ctx = new AudioContext();
      set({ playlistCtx: ctx });
      const dev = get().playlistDeviceId;
      if (ctx.setSinkId && dev) { try { ctx.setSinkId(dev); } catch { /* res */ } }
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  },

  ensurePreviewCtx: () => {
    let ctx = get().previewCtx;
    if (!ctx || ctx.state === 'closed') {
      ctx = new AudioContext();
      set({ previewCtx: ctx });
      const dev = get().previewDeviceId;
      if (ctx.setSinkId && dev) { try { ctx.setSinkId(dev); } catch { /* res */ } }
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  },

  setPlaylistDevice: (deviceId) => {
    const oldDev = get().playlistDeviceId;
    if (oldDev === deviceId) return;
    const wasAsio = isAsioTarget(oldDev);
    const willAsio = isAsioTarget(deviceId);

    // WASAPI → WASAPI: canvi de sink en calent, sense cap tall.
    if (!wasAsio && !willAsio) {
      set({ playlistDeviceId: deviceId });
      plSetDevice(get);
      get().persistGlobals();
      return;
    }

    // Canvi que implica ASIO (o de tipus): captura la posició actual, fa fade-out
    // a la sortida antiga i reprèn a la nova des de la mateixa posició (crossfade
    // entre sortides). Si estava en pausa, simplement atura (no es reprèn).
    const wasPlaying = get().playlistPlaying;
    let resumeIndex = -1, resumePos = 0;
    if (wasPlaying) {
      const p = wasAsio ? plaPosition() : plPosition();
      if (p && p.index >= 0) { resumeIndex = p.index; resumePos = Math.max(0, p.elapsed); }
    }
    get().playlistStop(); // atura el motor antic (routeja amb el deviceId encara antic)
    set({ playlistDeviceId: deviceId });
    if (wasPlaying && resumeIndex >= 0) {
      const cf = Math.max(0, get().crossfade || 0);
      if (willAsio) plaStartAt(get, set, resumeIndex, resumePos, cf);
      else plStartAt(get, set, resumeIndex, resumePos, cf);
    }
    get().persistGlobals();
  },

  setPreviewDevice: async (deviceId) => {
    // En canviar de dispositiu, atura qualsevol preview en curs (no es pot
    // migrar en calent entre WASAPI i ASIO).
    if (get().previewingSlot != null) get().stopPreview();
    set({ previewDeviceId: deviceId });
    // ASIO no és un sinkId WASAPI vàlid: no toquem el setSinkId del context.
    if (!isAsioTarget(deviceId)) {
      const ctx = get().previewCtx;
      if (ctx && ctx.setSinkId) { try { await ctx.setSinkId(deviceId); } catch (e) { console.warn(e); } }
    }
    get().persistGlobals();
  },

  // ── Preview (PFL) ──
  setPreviewArmed: (armed) => set({ previewArmed: armed }),

  previewSlot: (slotId) => {
    // Toggle: si aquest slot ja està en preview, l'atura
    if (get().previewingSlot === slotId) { get().stopPreview(); return; }

    const slot = get().slots.find((s) => s.id === slotId);
    if (!slot || !hasClip(slot)) return;

    // Preview per ASIO: toca el cue pel motor natiu cap als canals del bus de
    // preview (un sol preview alhora, voice id reservat). Cobreix curt i streaming.
    if (isAsioTarget(get().previewDeviceId)) {
      get().stopPreview();
      const tgt = parseTarget(get().previewDeviceId);
      const total = slotDuration(slot);
      const startPoint = Math.max(0, Math.min(slot.startPoint || 0, total || 0));
      const stopPoint = slot.stopPoint != null ? slot.stopPoint : 0; // 0 = fins al final
      invoke('asio_play_voice', {
        voiceId: PREVIEW_VOICE_ID,
        driver: tgt.driver,
        filePath: slot.filePath,
        channels: tgt.channels,
        gain: slot.volume ?? 0.8,
        fadeIn: 0,
        fadeOut: 0,
        loopOn: !!slot.loop,
        startPoint,
        stopPoint,
        streaming: !!slot.isStreaming,
      }).catch((e) => console.warn('[asio] preview:', e));
      set({ previewingSlot: slotId, previewStartedAt: 0 });
      return;
    }

    // Cue en streaming: preview amb element <audio> al bus de preview
    if (slot.isStreaming) {
      get().stopPreview();
      if (csPreviewStart(get, set, slotId)) {
        set({ previewingSlot: slotId, previewStartedAt: 0 });
      }
      return;
    }

    const ctx = get().ensurePreviewCtx();

    if (previewSource) { try { previewSource.onended = null; previewSource.stop(); } catch { /* res */ } previewSource = null; }

    const total = slot.audioBuffer.duration;
    const startPoint = Math.max(0, Math.min(slot.startPoint || 0, total));
    const stopPoint = Math.min(slot.stopPoint ?? total, total);
    const segDur = Math.max(0.02, stopPoint - startPoint);

    const gain = ctx.createGain();
    gain.gain.value = slot.volume ?? 0.8;
    gain.connect(ctx.destination);
    const source = ctx.createBufferSource();
    source.buffer = slot.audioBuffer;
    source.connect(gain);
    source.onended = () => {
      if (get().previewingSlot === slotId) set({ previewingSlot: null });
    };
    source.start(0, startPoint, slot.loop ? undefined : segDur);
    if (slot.loop) { source.loop = true; source.loopStart = startPoint; source.loopEnd = stopPoint; }
    previewSource = source;
    set({ previewingSlot: slotId, previewStartedAt: ctx.currentTime });
  },

  stopPreview: () => {
    if (previewSource) { try { previewSource.onended = null; previewSource.stop(); } catch { /* res */ } previewSource = null; }
    csPreviewStop();
    // Atura també un possible preview pel motor ASIO (no-op si no n'hi ha).
    if (isAsioTarget(get().previewDeviceId)) {
      invoke('asio_stop_voice', { voiceId: PREVIEW_VOICE_ID, fadeOut: 0 }).catch(() => {});
    }
    set({ previewingSlot: null });
  },

  // El motor ASIO informa que el preview ha acabat sol → neteja l'estat.
  previewEnded: () => set({ previewingSlot: null }),

  setViewMode: (viewMode) => set({ viewMode }),

  // ── Accions de la Playlist ──
  persistPlaylist: () => {
    const { playlist, crossfade, playlistRepeatMode, playlistShuffle, playlistVolume } = get();
    localStorage.setItem('the-player-playlist', JSON.stringify({
      tracks: playlist, crossfade, repeatMode: playlistRepeatMode, shuffle: playlistShuffle, volume: playlistVolume,
    }));
  },

  addPlaylistTracks: (items) => {
    set((state) => ({
      playlist: [
        ...state.playlist,
        ...items.map((it) => ({ id: plNextId++, filePath: it.filePath, label: it.label })),
      ],
    }));
    get().persistPlaylist();
  },

  removePlaylistTrack: (id) => {
    set((state) => {
      const idx = state.playlist.findIndex((t) => t.id === id);
      const playlist = state.playlist.filter((t) => t.id !== id);
      let playlistIndex = state.playlistIndex;
      if (idx >= 0 && idx < playlistIndex) playlistIndex -= 1;
      // Manté el cursor de selecció coherent amb la nova llista
      let playlistSelected = state.playlistSelected;
      if (idx >= 0 && idx < playlistSelected) playlistSelected -= 1;
      playlistSelected = Math.max(0, Math.min(playlistSelected, playlist.length - 1));
      return { playlist, playlistIndex, playlistSelected };
    });
    get().persistPlaylist();
  },

  movePlaylistTrack: (from, to) => {
    set((state) => {
      const playlist = [...state.playlist];
      if (from < 0 || from >= playlist.length || to < 0 || to >= playlist.length) return {};
      const [item] = playlist.splice(from, 1);
      playlist.splice(to, 0, item);
      // El cursor de selecció segueix el moviment de les pistes
      let playlistSelected = state.playlistSelected;
      if (playlistSelected === from) playlistSelected = to;
      else if (from < playlistSelected && to >= playlistSelected) playlistSelected -= 1;
      else if (from > playlistSelected && to <= playlistSelected) playlistSelected += 1;
      return { playlist, playlistSelected };
    });
    get().persistPlaylist();
  },

  clearPlaylist: () => {
    get().playlistStop();
    set({ playlist: [], playlistIndex: -1, playlistSelected: 0 });
    get().persistPlaylist();
  },

  // Cert si la playlist routeja a un dispositiu ASIO (→ motor natiu de veus).
  plIsAsio: () => isAsioTarget(get().playlistDeviceId),

  setCrossfade: (sec) => { set({ crossfade: Math.max(0, sec) }); get().persistPlaylist(); },
  // Cicla el mode de repetició: off → song → list → off
  cyclePlaylistRepeat: () => {
    const next = { off: 'song', song: 'list', list: 'off' };
    set((s) => ({ playlistRepeatMode: next[s.playlistRepeatMode] ?? 'song' }));
    get().persistPlaylist();
  },
  togglePlaylistShuffle: () => { set((s) => ({ playlistShuffle: !s.playlistShuffle })); get().persistPlaylist(); },
  setPlaylistVolume: (v) => {
    set({ playlistVolume: v });
    if (get().plIsAsio()) plaSetVolume(get); else plSetVolume(get);
    get().persistPlaylist();
  },

  playlistPlayPause: () => (get().plIsAsio() ? plaPlayPause(get, set) : plPlayPause(get, set)),
  playlistStop: () => (get().plIsAsio() ? plaStop(get, set) : plStop(get, set)),
  playlistNext: () => (get().plIsAsio() ? plaNext(get, set) : plNext(get, set)),
  playlistPrev: () => (get().plIsAsio() ? plaPrev(get, set) : plPrev(get, set)),
  playlistPlayIndex: (i) => {
    set({ playlistSelected: i });
    if (get().plIsAsio()) plaPlayIndex(get, set, i); else plPlayIndex(get, set, i);
  },

  // Selecció (cursor) de la llista: clic o fletxes
  setPlaylistSelected: (i) => {
    const n = get().playlist.length;
    if (n === 0) { set({ playlistSelected: 0 }); return; }
    set({ playlistSelected: Math.max(0, Math.min(i, n - 1)) });
  },
  movePlaylistSelection: (dir) => {
    const { playlist, playlistSelected } = get();
    if (playlist.length === 0) return;
    const next = Math.max(0, Math.min((playlistSelected || 0) + dir, playlist.length - 1));
    set({ playlistSelected: next });
  },
  playlistPlaySelected: () => {
    const { playlist, playlistSelected } = get();
    if (playlist.length === 0) return;
    const i = Math.max(0, Math.min(playlistSelected || 0, playlist.length - 1));
    if (get().plIsAsio()) plaPlayIndex(get, set, i); else plPlayIndex(get, set, i);
  },
  // Salta a una fracció (0..1) de la pista que sona ara
  playlistSeek: (fraction) => (get().plIsAsio() ? plaSeek(get, fraction) : plSeek(get, fraction)),

  // Salta un cue de vídeo en reproducció a "elapsed" segons dins el segment.
  // Emet el seek a la sortida i ajusta startedAt perquè el playhead del tile hi quadri.
  seekVideo: (slotId, elapsed) => {
    const slot = get().slots.find((s) => s.id === slotId);
    if (!slot || !isVideo(slot) || !slot.isPlaying) return;
    const segDur = Math.max(0, (slot.stopPoint != null ? slot.stopPoint : (slot.streamDuration || 0)) - (slot.startPoint || 0));
    const e = Math.max(0, segDur > 0 ? Math.min(elapsed, segDur) : elapsed);
    emitVideoSeek((slot.startPoint || 0) + e);
    set((state) => ({
      slots: state.slots.map((s) =>
        s.id === slotId ? { ...s, startedAt: performance.now() / 1000 - e } : s
      ),
    }));
  },

  setEditingSlot: (slotId) => set({ editingSlot: slotId }),

  setDragOverSlot: (slotId) => set({ dragOverSlot: slotId }),

  // Aplica una configuració desada a un slot (després de recarregar l'àudio)
  applySlotConfig: (slotId, cfg) => {
    const slot = get().slots.find((s) => s.id === slotId);
    if (slot && slot.gainNode && cfg.volume != null) {
      slot.gainNode.gain.value = cfg.volume;
    }
    set((state) => ({
      slots: state.slots.map((s) =>
        s.id === slotId
          ? {
              ...s,
              label: cfg.label != null ? cfg.label : s.label,
              filePath: cfg.filePath != null ? cfg.filePath : s.filePath,
              mediaType: cfg.mediaType === 'video' ? 'video' : s.mediaType,
              volume: cfg.volume != null ? cfg.volume : s.volume,
              startPoint: cfg.startPoint || 0,
              stopPoint: cfg.stopPoint != null ? cfg.stopPoint : null,
              fadeIn: cfg.fadeIn ?? null,
              fadeOut: cfg.fadeOut ?? null,
              loop: !!cfg.loop,
              color: cfg.color != null ? cfg.color : null,
              stopOthers: !!cfg.stopOthers,
              duck: !!cfg.duck,
              stopPlaylist: !!cfg.stopPlaylist,
              preWait: cfg.preWait || 0,
              continueMode: cfg.continueMode === 'auto' ? 'auto' : 'none',
            }
          : s
      ),
    }));
    get().persistSlots();
    // El fitxer o el color (→ routing) poden haver canviat: re-preload si és ASIO.
    get().preloadAsioSlot(slotId);
  },

  // Actualitza els camps d'edició d'un slot (startPoint, stopPoint, fadeIn, fadeOut)
  updateSlotEdit: (slotId, patch) =>
    set((state) => ({
      slots: state.slots.map((s) =>
        s.id === slotId ? { ...s, ...patch } : s
      ),
    })),

  setAudioDevices: (devices) => set({ audioDevices: devices }),

  // ── Pre-decode ASIO (dispar instantani) ───────────────────────────────────
  // Demana a Rust que descodifiqui i deixi a la cau el PCM d'un cue que routeja
  // a ASIO, perquè el seu GO no carregui la latència de descodificació (~2 s).
  // No fa res per a cues WASAPI, sense fitxer o en streaming a un altre camí.
  preloadAsioSlot: (slotId) => {
    const slot = get().slots.find((s) => s.id === slotId);
    if (!slot || !slot.filePath) return;
    const target = parseTarget(resolveCueTargetStr(get(), slot));
    if (target.kind !== 'asio') return;
    invoke('asio_preload', { driver: target.driver, filePath: slot.filePath })
      .catch((e) => console.warn('[asio] preload:', e));
  },

  // Pre-descodifica tots els cues carregats que routegen a ASIO. S'hi crida en
  // canviar el routing (bus de Cues o routing per color) a un driver ASIO.
  preloadAllAsioCues: () => {
    for (const s of get().slots) {
      if (s.filePath) get().preloadAsioSlot(s.id);
    }
  },

  setSelectedDevice: async (deviceId) => {
    const { audioContext } = get();
    set({ selectedDeviceId: deviceId });
    // Si el bus de Cues s'assigna a un target ASIO (string "asio:…"), NO és un
    // sinkId WASAPI vàlid: no toquem el setSinkId del context Web Audio (el
    // render ASIO és el pas següent). Guardem el valor igualment (routing).
    if (!isAsioTarget(deviceId) && audioContext && audioContext.setSinkId) {
      try {
        await audioContext.setSinkId(deviceId);
      } catch (e) {
        console.warn('setSinkId no suportat:', e);
      }
    }
    if (!isAsioTarget(deviceId)) get().detectOutputChannels();
    get().persistGlobals();
    // El bus de Cues ha canviat: pre-descodifica els cues que ara routegen a ASIO.
    get().preloadAllAsioCues();
  },

  // Detecta quants canals de sortida exposa el dispositiu seleccionat.
  // maxChannelCount > 2 vol dir que podem fer routing multicanal / cue
  // via Web Audio (ChannelMergerNode). Si és 2, només estèreo.
  detectOutputChannels: async () => {
    const ctx = get().audioContext || get().initAudioContext();
    const dev = get().selectedDeviceId;
    // Si el bus de Cues apunta a ASIO, no és un sinkId WASAPI: no el toquem.
    if (ctx.setSinkId && dev && dev !== 'default' && !isAsioTarget(dev)) {
      try { await ctx.setSinkId(dev); } catch { /* res */ }
    }
    const max = ctx.destination.maxChannelCount;
    set({ outputChannels: max });
    return max;
  },

  loadAudio: (slotId, file, audioBuffer, audioUrl, filePath = null, opts = {}) => {
    // Els nodes (gain/fade/analyser) es construeixen al Play, al context del
    // dispositiu segons el color del cue (routing per grup).
    const streaming = !!opts.streaming;
    const mediaType = opts.mediaType === 'video' ? 'video' : 'audio';
    // Allibera el blob URL anterior d'aquest slot (si n'hi havia)
    const prev = get().slots.find((s) => s.id === slotId);
    // Si el slot previ sonava (o estava pausat), atura'l abans de reescriure'l:
    // evita reproducció òrfena i que el seu id quedi penjat al comptador de duck.
    if (prev && (prev.isPlaying || prev.pausedAt != null)) get().stopSlot(slotId);
    if (prev && prev.duck) duckRemove(get, slotId);
    if (prev && prev.audioUrl && prev.audioUrl !== audioUrl) {
      try { URL.revokeObjectURL(prev.audioUrl); } catch { /* res */ }
    }
    set((state) => ({
      slots: state.slots.map((s) =>
        s.id === slotId
          ? {
              ...s,
              label: file.name,
              filePath,
              mediaType,
              loading: false,
              audioUrl,
              audioBuffer,
              isStreaming: streaming,
              // Durada de les metadades: per streaming d'àudio i també per als
              // cues de vídeo (perquè slotDuration() i l'editor tinguin timeline).
              streamDuration: (streaming || mediaType === 'video') ? (opts.duration || 0) : 0,
              peaks: null,
              gainNode: null,
              fadeGainNode: null,
              analyserNode: null,
              sourceNode: null,
              isPlaying: false,
              // Cue nou: Stop Others i acció de Playlist prenen el valor per defecte global (Settings)
              stopOthers: get().cuesStopOthers,
              duck: get().cuesDuck,
              stopPlaylist: get().cuesStopPlaylist,
              // Un fitxer nou reinicia els punts d'edició
              startPoint: 0,
              stopPoint: null,
              fadeIn: null,
              fadeOut: null,
              // ...i les opcions de seqüència
              preWait: 0,
              continueMode: 'none',
            }
          : s
      ),
    }));

    get().persistSlots();
    // Si aquest cue routeja a ASIO, pre-descodifica'l ja per a un GO instantani.
    get().preloadAsioSlot(slotId);
  },

  playSlot: (slotId, opts = {}) => {
    const { slots, globalFadeIn, globalFadeOut, colorOutputs } = get();
    const slot = slots.find((s) => s.id === slotId);
    if (!slot || !hasClip(slot)) return;

    // Si ja sona, el togglam (atura amb fade out)
    if (slot.isPlaying) {
      get().stopSlot(slotId, true);
      return;
    }

    // "Stop others" del cue: atura la resta de cues que sonin, excepte els que
    // formen part de la mateixa cadena auto-continue (opts.exemptIds).
    if (slot.stopOthers) {
      const exempt = opts.exemptIds;
      slots.forEach((s) => {
        if (s.id === slotId || (exempt && exempt.has(s.id))) return;
        if (s.isPlaying || s.pausedAt != null) get().stopSlot(s.id);
      });
    }

    // Cue de vídeo: es reprodueix a la finestra de sortida (no per Web Audio).
    // Emet l'event video-play amb un payload ric (volum, fades efectius, routing
    // per color i loop); la finestra de sortida aplica volum/fades/sortida/loop
    // sobre l'element <video>. Si la finestra no està oberta, no passa res.
    // Marquem isPlaying perquè el tile/transport ho reflecteixin.
    if (isVideo(slot)) {
      // Routing per color (com el camí d'àudio); per defecte, bus de Cues.
      // Els cues de VÍDEO surten per la finestra de sortida amb <video>.setSinkId,
      // que només entén deviceIds WASAPI. Si el color apunta a un target ASIO,
      // no és servible per vídeo → caiem al bus de Cues WASAPI per defecte.
      const colorOut = slot.color ? colorOutputs[slot.color] : null;
      const outDev = (colorOut && !isAsioTarget(colorOut)) ? colorOut : get().selectedDeviceId;
      // Fades efectius: el propi del cue si és >0, si no el global
      const effIn = Math.max(0, effFadeIn(slot, globalFadeIn));
      const effOut = Math.max(0, effFadeOut(slot, globalFadeOut));
      emitVideoPlay(slot.filePath, slot.startPoint || 0, slot.stopPoint || 0, slotId, {
        volume: slot.volume,
        fadeIn: effIn,
        fadeOut: effOut,
        deviceId: outDev,
        loop: !!slot.loop,
      });
      // Ducking: si aquest cue de vídeo abaixa la playlist, incrementa el comptador
      if (slot.duck) duckAdd(get, slotId);
      // Stop Playlist: si aquest cue atura del tot la playlist, atura-la ara
      if (slot.stopPlaylist) get().playlistStop();
      set((state) => ({
        slots: state.slots.map((s) =>
          // startedAt en rellotge de paret (s) per estimar el playhead/temps al tile
          s.id === slotId ? { ...s, isPlaying: true, pausedAt: null, startedAt: performance.now() / 1000 } : s
        ),
        activeSlot: slotId,
      }));
      return;
    }

    // Ducking: si aquest cue abaixa la playlist, incrementa el comptador.
    // (Vàlid tant per a cues en buffer com en streaming; el decrement es fa a
    // stopSlot / handleEnded / final natural de l'streaming.)
    if (slot.duck) duckAdd(get, slotId);
    // Stop Playlist: si aquest cue atura del tot la playlist, atura-la ara
    if (slot.stopPlaylist) get().playlistStop();

    // ── DISPATCH de routing: WASAPI (Web Audio) vs ASIO (natiu) ──────────────
    // Regla anti-duplicació: si el target del cue és ASIO, NO l'enviem també per
    // Web Audio (sonaria dos cops al mateix dispositiu físic). El render ASIO
    // real és el pas següent; de moment el camí ASIO és un STUB que NO treu so
    // però marca el cue com a "reproduint" perquè la UI/transport ho reflecteixin.
    const decision = dispatchCue(get(), slot, { kind: 'play' });
    if (decision.route === 'asio') {
      // Render natiu: descodifica i mescla el cue pel motor ASIO (fil
      // `asio-engine`), cap als canals del target. NO toca Web Audio (regla
      // anti-duplicació). Fades/volum/segment/loop efectius del store.
      const total = slotDuration(slot);
      const startPoint = Math.max(0, Math.min(slot.startPoint || 0, total || Infinity));
      const stopPoint = slot.stopPoint != null ? slot.stopPoint : 0; // 0 = fins al final
      const segDur = Math.max(0.02, (stopPoint > 0 ? stopPoint : total) - startPoint);
      const effIn = Math.max(0, Math.min(effFadeIn(slot, globalFadeIn), segDur));
      const effOut = Math.max(0, Math.min(effFadeOut(slot, globalFadeOut), segDur));
      invoke('asio_play_voice', {
        voiceId: slot.id,
        driver: decision.target.driver,
        filePath: slot.filePath,
        channels: decision.target.channels,
        gain: slot.volume ?? 0.8,
        fadeIn: effIn,
        fadeOut: effOut,
        loopOn: !!slot.loop,
        startPoint,
        stopPoint,
        // Cue llarg (>60s): render natiu en streaming (decode-ahead), no a RAM sencer
        streaming: !!slot.isStreaming,
      }).catch((e) => console.warn('[asio] play_voice:', e));
      set((state) => ({
        slots: state.slots.map((s) =>
          s.id === slotId
            ? { ...s, isPlaying: true, asioActive: true, pausedAt: null, startedAt: performance.now() / 1000 }
            : s
        ),
        activeSlot: slotId,
      }));
      return;
    }

    // Cue llarg en streaming: reproducció amb element <audio>
    if (slot.isStreaming) { csPlay(get, set, slotId); return; }

    // Atura qualsevol font residual d'aquest slot (p. ex. en ple fade out)
    if (slot.sourceNode) {
      try { slot.sourceNode.onended = null; slot.sourceNode.stop(); } catch { /* res */ }
    }

    // Context segons el color del cue (routing per grup); per defecte, bus Cues
    const outDev = (slot.color && colorOutputs[slot.color]) || get().selectedDeviceId;
    const ctx = get().ctxForDevice(outDev);
    if (ctx.state === 'suspended') ctx.resume();

    // (Re)construeix el graf si no existeix o és d'un altre context
    let { fadeGainNode, gainNode, analyserNode } = slot;
    if (!fadeGainNode || fadeGainNode.context !== ctx) {
      try { slot.fadeGainNode && slot.fadeGainNode.disconnect(); } catch { /* res */ }
      try { slot.gainNode && slot.gainNode.disconnect(); } catch { /* res */ }
      try { slot.analyserNode && slot.analyserNode.disconnect(); } catch { /* res */ }
      fadeGainNode = ctx.createGain();
      fadeGainNode.gain.value = 1;
      gainNode = ctx.createGain();
      gainNode.gain.value = slot.volume ?? 0.8;
      analyserNode = ctx.createAnalyser();
      analyserNode.fftSize = 1024;
      fadeGainNode.connect(gainNode);
      gainNode.connect(analyserNode);
      analyserNode.connect(ctx.destination);
    }

    const source = ctx.createBufferSource();
    source.buffer = slot.audioBuffer;
    source.connect(fadeGainNode);

    // Punts d'inici/stop (segment) i durada efectiva
    const total = slot.audioBuffer.duration;
    const startPoint = Math.max(0, Math.min(slot.startPoint || 0, total));
    const stopPoint  = Math.min(slot.stopPoint ?? total, total);
    const segDur     = Math.max(0.02, stopPoint - startPoint);
    // Fades efectius: el propi del cue si és >0, si no el global
    const fadeIn     = Math.max(0, Math.min(effFadeIn(slot, globalFadeIn), segDur));
    const fadeOut    = Math.max(0, Math.min(effFadeOut(slot, globalFadeOut), segDur));

    const now = ctx.currentTime;

    // Envolupant de fade sobre el node de fade (0..1), independent del volum
    const fg = fadeGainNode;
    if (fg) {
      fg.gain.cancelScheduledValues(now);
      if (fadeIn > 0) {
        fg.gain.setValueAtTime(0, now);
        fg.gain.linearRampToValueAtTime(1, now + fadeIn);
      } else {
        fg.gain.setValueAtTime(1, now);
      }
      // El fade out només té sentit si el slot no està en loop infinit
      if (!slot.loop && fadeOut > 0) {
        fg.gain.setValueAtTime(1, now + segDur - fadeOut);
        fg.gain.linearRampToValueAtTime(0, now + segDur);
      }
    }

    // En acabar de forma natural: atura i, si cal, encadena (mode continuous)
    source.onended = () => get().handleEnded(slotId);

    if (slot.loop) {
      // Loop del segment [startPoint, stopPoint]
      source.loop = true;
      source.loopStart = startPoint;
      source.loopEnd = stopPoint;
      source.start(0, startPoint);
    } else {
      source.start(0, startPoint, segDur);
    }
    const startedAt = ctx.currentTime;

    set((state) => ({
      slots: state.slots.map((s) =>
        s.id === slotId
          ? { ...s, sourceNode: source, fadeGainNode, gainNode, analyserNode, isPlaying: true, startedAt, pausedAt: null }
          : s
      ),
      activeSlot: slotId,
    }));
  },

  // Re-dispara un slot des de l'inici (per la tecla del teclat). opts es passa a
  // playSlot (p. ex. exemptIds de la cadena auto-continue del GO).
  triggerSlot: (slotId, opts = {}) => {
    const slot = get().slots.find((s) => s.id === slotId);
    if (!slot || !hasClip(slot)) return;
    if (slot.isPlaying) get().stopSlot(slotId);
    set((state) => ({
      slots: state.slots.map((s) => (s.id === slotId ? { ...s, pausedAt: null } : s)),
      selectedSlot: slotId,
    }));
    get().playSlot(slotId, opts);
  },

  // Pausa: atura recordant la posició dins el segment
  pauseSlot: (slotId) => {
    const slot = get().slots.find((s) => s.id === slotId);
    if (!slot || !slot.isPlaying) return;
    // Els cues de vídeo no es pausen (4a): pausar equival a aturar
    if (isVideo(slot)) { get().stopSlot(slotId); return; }
    // En pausar deixa de sonar → deixa de duckejar (es reincrementa al resume)
    if (slot.duck) duckRemove(get, slotId);
    // Cue ASIO: congela la veu nativa (no l'atura). La posició la guardem des de
    // la telemetria per mostrar-la congelada; el motor manté la pos exacta.
    if (slot.asioActive) {
      const pos = asioPosition(slotId) ?? 0;
      invoke('asio_set_paused', { voiceId: slotId, paused: true })
        .catch((e) => console.warn('[asio] pause:', e));
      set((state) => ({
        slots: state.slots.map((s) =>
          s.id === slotId ? { ...s, isPlaying: false, pausedAt: pos } : s
        ),
      }));
      return;
    }
    if (slot.isStreaming) { csPause(get, set, slotId); return; }
    const ctx = slot.fadeGainNode ? slot.fadeGainNode.context : get().audioContext;
    if (!ctx) return;

    const total = slot.audioBuffer.duration;
    const startPoint = Math.max(0, Math.min(slot.startPoint || 0, total));
    const stopPoint = Math.min(slot.stopPoint ?? total, total);
    const segDur = Math.max(0.02, stopPoint - startPoint);
    let pos = ctx.currentTime - slot.startedAt;
    if (slot.loop) pos = pos % segDur;
    pos = Math.max(0, Math.min(pos, segDur));

    if (slot.sourceNode) {
      try { slot.sourceNode.onended = null; slot.sourceNode.stop(); } catch { /* ja aturat */ }
    }
    set((state) => ({
      slots: state.slots.map((s) =>
        s.id === slotId ? { ...s, sourceNode: null, isPlaying: false, pausedAt: pos } : s
      ),
    }));
  },

  // Reprèn la reproducció des de la posició pausada
  resumeSlot: (slotId) => {
    const slot = get().slots.find((s) => s.id === slotId);
    if (!slot || !hasClip(slot) || slot.pausedAt == null) return;
    if (isVideo(slot)) return; // els cues de vídeo no tenen estat de pausa (4a)
    // Torna a sonar → torna a duckejar (si és un cue de duck)
    if (slot.duck) duckAdd(get, slotId);
    // Cue ASIO: reprèn la veu nativa des de la posició congelada (el motor l'ha
    // mantingut). No cal seek: continua exactament des d'on s'havia pausat.
    if (slot.asioActive) {
      invoke('asio_set_paused', { voiceId: slotId, paused: false })
        .catch((e) => console.warn('[asio] resume:', e));
      set((state) => ({
        slots: state.slots.map((s) =>
          s.id === slotId ? { ...s, isPlaying: true, pausedAt: null } : s
        ),
        activeSlot: slotId,
      }));
      return;
    }
    if (slot.isStreaming) { csResume(get, set, slotId); return; }
    const ctx = slot.fadeGainNode ? slot.fadeGainNode.context : (get().audioContext || get().initAudioContext());

    const total = slot.audioBuffer.duration;
    const startPoint = Math.max(0, Math.min(slot.startPoint || 0, total));
    const stopPoint = Math.min(slot.stopPoint ?? total, total);
    const segDur = Math.max(0.02, stopPoint - startPoint);
    const pos = Math.max(0, Math.min(slot.pausedAt, segDur));
    const offset = startPoint + pos;
    const remaining = Math.max(0.02, stopPoint - offset);

    const source = ctx.createBufferSource();
    source.buffer = slot.audioBuffer;
    source.connect(slot.fadeGainNode || slot.gainNode);

    const now = ctx.currentTime;
    const fg = slot.fadeGainNode;
    if (fg) {
      fg.gain.cancelScheduledValues(now);
      fg.gain.setValueAtTime(1, now); // sense fade in en reprendre
      const fadeOut = Math.max(0, Math.min(effFadeOut(slot, get().globalFadeOut), segDur));
      if (!slot.loop && fadeOut > 0 && remaining > fadeOut) {
        fg.gain.setValueAtTime(1, now + remaining - fadeOut);
        fg.gain.linearRampToValueAtTime(0, now + remaining);
      }
    }

    source.onended = () => get().handleEnded(slotId);
    if (slot.loop) {
      source.loop = true;
      source.loopStart = startPoint;
      source.loopEnd = stopPoint;
      source.start(0, offset);
    } else {
      source.start(0, offset, remaining);
    }
    const startedAt = now - pos;

    set((state) => ({
      slots: state.slots.map((s) =>
        s.id === slotId ? { ...s, sourceNode: source, isPlaying: true, startedAt, pausedAt: null } : s
      ),
      activeSlot: slotId,
    }));
  },

  setSelectedSlot: (slotId) => set({ selectedSlot: slotId }),

  // Canvia de pàgina (conserva la posició del cursor dins la graella)
  setPage: (n) => {
    const page = Math.max(0, Math.min(n, NUM_PAGES - 1));
    const local = (get().selectedSlot - 1) % SLOTS_PER_PAGE;
    set({ currentPage: page, selectedSlot: page * SLOTS_PER_PAGE + local + 1 });
  },

  // Mou el cursor de selecció amb les fletxes.
  // Esquerra/dreta: seqüencial travessant files I pàgines (auto-flip de pàgina).
  // Amunt/avall: moviment vertical dins la pàgina actual (8×4).
  moveSelection: (dir) => {
    const { selectedSlot, currentPage } = get();
    if (dir === 'left' || dir === 'right') {
      let id = (selectedSlot || 1) + (dir === 'right' ? 1 : -1);
      id = Math.max(1, Math.min(NUM_SLOTS, id));
      set({ selectedSlot: id, currentPage: Math.floor((id - 1) / SLOTS_PER_PAGE) });
      return;
    }
    const base = currentPage * SLOTS_PER_PAGE;
    let local = (selectedSlot - 1) % SLOTS_PER_PAGE;
    const row = Math.floor(local / 8);
    if (dir === 'up' && row > 0) local -= 8;
    if (dir === 'down' && row < 3) local += 8;
    set({ selectedSlot: base + local + 1 });
  },

  // Mou la selecció al cue carregat anterior/següent, dins la pàgina activa
  selectStep: (delta) => {
    const { selectedSlot, slots, currentPage } = get();
    const base = currentPage * SLOTS_PER_PAGE;
    let id = (selectedSlot || 1) + delta;
    while (id >= base + 1 && id <= base + SLOTS_PER_PAGE) {
      const s = slots.find((x) => x.id === id);
      if (s && hasClip(s)) { set({ selectedSlot: id }); return; }
      id += delta;
    }
  },

  // Transport sobre un slot: play si aturat, pausa si sona, reprèn si pausat
  togglePlayPause: (slotId) => {
    const slot = get().slots.find((s) => s.id === slotId);
    if (!slot || !hasClip(slot)) return;
    if (slot.isPlaying) get().pauseSlot(slotId);
    else if (slot.pausedAt != null) get().resumeSlot(slotId);
    else get().triggerSlot(slotId);
  },

  // Parada d'emergència: atura TOTS els slots
  // Parada d'emergència de TOTS els cues, amb fade out (segons el fade-out
  // efectiu de cada cue; si és 0, tall sec).
  stopAll: () => {
    // Cancel·la qualsevol seqüència GO pendent (pre-wait en curs o cadena
    // auto-continue): si l'usuari prem Stop All mentre hi ha un disparo
    // programat, no s'ha de disparar.
    clearGoTimers();
    const { slots } = get();
    slots.forEach((s) => {
      if (s.isPlaying || s.pausedAt != null) get().stopSlot(s.id, true);
    });
    get().stopPreview();
    // Negre a la sortida de vídeo (pànic: assegura pantalla negra encara que
    // cap cue de vídeo constés com a actiu)
    emitVideoBlack();
    // Seguretat: buida el comptador de ducking (recupera la playlist) per si
    // hagués quedat algun id penjat
    duckReset(get);
    set({ activeSlot: null });
  },

  // Gestiona el final natural d'un clip: l'atura (l'encadenament és manual
  // amb GO, o automàtic a la Playlist; la botonera no avança sola).
  handleEnded: (slotId) => {
    const current = get().slots.find((s) => s.id === slotId);
    if (!current || !current.isPlaying) return;
    // El cue ha acabat de forma natural: deixa de duckejar (si tocava)
    if (current.duck) duckRemove(get, slotId);
    if (current.asioActive) clearAsioTelemetry(slotId);
    set((state) => ({
      slots: state.slots.map((s) =>
        s.id === slotId ? { ...s, isPlaying: false, asioActive: false, sourceNode: null } : s
      ),
      activeSlot: state.activeSlot === slotId ? null : state.activeSlot,
    }));
  },

  // La finestra de sortida informa que un cue de vídeo ha acabat sol: reseteja
  // el seu estat perquè el tile/transport deixin de marcar-lo com a actiu.
  handleVideoEnded: (slotId) => {
    // El cue de vídeo ha acabat (final natural, stopPoint o stop): deixa de
    // duckejar (idempotent) abans de resetejar el seu estat.
    const cur = get().slots.find((s) => s.id === slotId);
    if (cur && cur.mediaType === 'video' && cur.duck) duckRemove(get, slotId);
    set((state) => ({
      slots: state.slots.map((s) =>
        s.id === slotId && s.mediaType === 'video' ? { ...s, isPlaying: false, pausedAt: null } : s
      ),
      activeSlot: state.activeSlot === slotId ? null : state.activeSlot,
    }));
  },

  // Reseteja l'estat de tots els cues de vídeo (p. ex. en tancar la finestra de
  // sortida amb la X o pel botó): evita que quedin marcats com a reproduint.
  clearVideoCues: () => {
    // Deixa de duckejar qualsevol cue de vídeo actiu (idempotent)
    get().slots.forEach((s) => {
      if (s.mediaType === 'video' && (s.isPlaying || s.pausedAt != null) && s.duck) {
        duckRemove(get, s.id);
      }
    });
    set((state) => {
      let activeSlot = state.activeSlot;
      const slots = state.slots.map((s) => {
        if (s.mediaType === 'video' && (s.isPlaying || s.pausedAt != null)) {
          if (activeSlot === s.id) activeSlot = null;
          return { ...s, isPlaying: false, pausedAt: null };
        }
        return s;
      });
      return { slots, activeSlot };
    });
  },

  // Avança el standby al següent cue carregat (per id), travessant pàgines.
  // Si surt de la pàgina actual, fa auto-flip de currentPage perquè el standby
  // quedi visible. Si no hi ha cap cue carregat després, manté el standby.
  advanceStandby: (fromId) => {
    const { slots } = get();
    const next = slots.find((s) => s.id > fromId && hasClip(s));
    if (!next) return null;
    const page = Math.floor((next.id - 1) / SLOTS_PER_PAGE);
    set({ selectedSlot: next.id, currentPage: page });
    return next.id;
  },

  // GO seqüencial estil QLab: dispara el standby (respectant el seu pre-wait),
  // avança el standby al següent cue carregat (travessant pàgines), i si el cue
  // disparat és auto-continue, encadena un GO sobre el nou standby.
  //
  // Cancel·lació: un GO manual nou cancel·la qualsevol seqüència pendent (pre-wait
  // o cadena) abans d'iniciar-ne una de nova — comportament més predictible que
  // ignorar-lo o encuar-lo. stopAll també la cancel·la.
  go: () => {
    clearGoTimers();
    get()._goStep();
  },

  // Un pas de la seqüència (intern). No cancel·la timers: l'usa la cadena.
  _goStep: () => {
    const { selectedSlot, slots } = get();
    const sel = selectedSlot || 1;
    const slot = slots.find((s) => s.id === sel);
    if (!slot || !hasClip(slot)) return; // cap cue carregat al standby: GO no fa res

    const continueMode = slot.continueMode;
    const preWait = Math.max(0, slot.preWait || 0);

    // Dispara el cue (immediat o després del pre-wait). Un cop disparat,
    // avança el standby i, si cal, encadena.
    const fire = () => {
      // Afegeix aquest cue a la cadena ABANS de disparar-lo, perquè el seu
      // Stop Others (si en té) no talli els cues anteriors de la mateixa cadena.
      goChain.add(sel);
      get().triggerSlot(sel, { exemptIds: goChain });
      const nextId = get().advanceStandby(sel);
      // Auto-continue: encadena sobre el nou standby. Evita bucles: només si
      // el standby ha avançat de debò (nextId != null i != sel).
      if (continueMode === 'auto' && nextId != null && nextId !== sel) {
        get()._goStep();
      }
    };

    if (preWait > 0) {
      const t = setTimeout(() => { goTimers.delete(t); fire(); }, preWait * 1000);
      goTimers.add(t);
    } else {
      fire();
    }
  },

  // Salta a una posició (ratio 0..1 dins el segment) mentre el slot sona,
  // recreant el node de reproducció amb el nou offset.
  seekSlot: (slotId, ratio) => {
    const slot = get().slots.find((s) => s.id === slotId);
    if (!slot || !hasClip(slot) || !slot.isPlaying) return;
    if (isVideo(slot)) return; // el vídeo no es busca des d'aquí (4a)
    // Cue ASIO actiu: reposiciona la veu nativa (no té graf Web Audio). El
    // playhead s'actualitzarà sol per la telemetria. Va ABANS de l'streaming
    // (un cue ASIO pot ser >60s i estar marcat isStreaming sense graf Web Audio).
    if (slot.asioActive) {
      const total = slotDuration(slot);
      const startPoint = Math.max(0, Math.min(slot.startPoint || 0, total || 0));
      const stopPoint = slot.stopPoint != null ? Math.min(slot.stopPoint, total) : total;
      const segDur = Math.max(0.02, stopPoint - startPoint);
      const r = Math.min(1, Math.max(0, ratio));
      // position ABSOLUTA dins el fitxer (inici del tram + offset dins el tram)
      invoke('asio_seek', { voiceId: slotId, position: startPoint + r * segDur })
        .catch((e) => console.warn('[asio] seek:', e));
      return;
    }
    if (slot.isStreaming) { csSeek(get, set, slotId, ratio); return; }
    const ctx = slot.fadeGainNode ? slot.fadeGainNode.context : get().audioContext;
    if (!ctx) return;

    const total      = slot.audioBuffer.duration;
    const startPoint = Math.max(0, Math.min(slot.startPoint || 0, total));
    const stopPoint  = Math.min(slot.stopPoint ?? total, total);
    const segDur     = Math.max(0.02, stopPoint - startPoint);
    const r          = Math.min(1, Math.max(0, ratio));
    const offset     = startPoint + r * segDur;
    const remaining  = Math.max(0.02, stopPoint - offset);

    // Atura el node actual sense disparar l'encadenament
    if (slot.sourceNode) {
      try { slot.sourceNode.onended = null; slot.sourceNode.stop(); } catch { /* ja aturat */ }
    }

    const source = ctx.createBufferSource();
    source.buffer = slot.audioBuffer;
    source.connect(slot.fadeGainNode || slot.gainNode);

    const now = ctx.currentTime;
    const fg = slot.fadeGainNode;
    if (fg) {
      // En fer seek no apliquem fade in; mantenim el fade out cap al final
      fg.gain.cancelScheduledValues(now);
      fg.gain.setValueAtTime(1, now);
      const fadeOut = Math.max(0, Math.min(effFadeOut(slot, get().globalFadeOut), segDur));
      if (!slot.loop && fadeOut > 0 && remaining > fadeOut) {
        fg.gain.setValueAtTime(1, now + remaining - fadeOut);
        fg.gain.linearRampToValueAtTime(0, now + remaining);
      }
    }

    source.onended = () => get().handleEnded(slotId);

    if (slot.loop) {
      source.loop = true;
      source.loopStart = startPoint;
      source.loopEnd = stopPoint;
      source.start(0, offset);
    } else {
      source.start(0, offset, remaining);
    }

    // startedAt ajustat perquè el progrés reflecteixi la posició actual
    const startedAt = now - (offset - startPoint);

    set((state) => ({
      slots: state.slots.map((s) =>
        s.id === slotId ? { ...s, sourceNode: source, startedAt } : s
      ),
    }));
  },

  // Elimina el clip d'un slot: l'atura, allibera recursos i el deixa buit
  clearSlot: (slotId) => {
    const { slots } = get();
    const slot = slots.find((s) => s.id === slotId);
    if (!slot) return;

    // Si era un cue de ducking actiu, deixa de comptar
    if (slot.duck) duckRemove(get, slotId);

    // Atura la veu ASIO nativa (sonant o pausada) perquè no quedi penjada al motor
    if (slot.asioActive) {
      invoke('asio_stop_voice', { voiceId: slotId, fadeOut: 0 })
        .catch((e) => console.warn('[asio] stop_voice (clear):', e));
      clearAsioTelemetry(slotId);
    }
    // Atura l'streaming (l'element <audio> no és un sourceNode)
    if (slot.isStreaming) csStop(get, set, slotId);
    if (slot.sourceNode) {
      try { slot.sourceNode.onended = null; slot.sourceNode.stop(); } catch { /* ja aturat */ }
    }
    if (slot.audioUrl) {
      try { URL.revokeObjectURL(slot.audioUrl); } catch { /* res */ }
    }
    try { slot.fadeGainNode && slot.fadeGainNode.disconnect(); } catch { /* res */ }
    try { slot.gainNode && slot.gainNode.disconnect(); } catch { /* res */ }
    try { slot.analyserNode && slot.analyserNode.disconnect(); } catch { /* res */ }

    set((state) => ({
      slots: state.slots.map((s) => (s.id === slotId ? createEmptySlot(slotId) : s)),
      activeSlot: state.activeSlot === slotId ? null : state.activeSlot,
      editingSlot: state.editingSlot === slotId ? null : state.editingSlot,
    }));
    get().persistSlots();
  },

  setSlotLoading: (slotId, loading) =>
    set((state) => ({
      slots: state.slots.map((s) => (s.id === slotId ? { ...s, loading } : s)),
    })),

  // Desa els pics de la forma d'ona d'un cue en streaming (generats en segon pla)
  setSlotPeaks: (slotId, peaks) =>
    set((state) => ({
      slots: state.slots.map((s) => (s.id === slotId ? { ...s, peaks } : s)),
    })),

  setColor: (slotId, color) => {
    set((state) => ({
      slots: state.slots.map((s) => (s.id === slotId ? { ...s, color } : s)),
    }));
    get().persistSlots();
  },

  // Activa/desactiva el loop d'un slot (opció de reproducció persistida)
  setLoop: (slotId, loop) => {
    set((state) => ({
      slots: state.slots.map((s) =>
        s.id === slotId ? { ...s, loop } : s
      ),
    }));
    get().persistSlots();
  },

  // fade: false/undefined = tall sec · true = usa el fade-out efectiu del cue
  //       · número = fade d'aquests segons
  stopSlot: (slotId, fade = false) => {
    const { audioContext, globalFadeOut } = get();
    const slot = get().slots.find((s) => s.id === slotId);
    // Res a fer si ja està del tot aturat (sense source ni pausa)
    if (!slot || (!slot.sourceNode && slot.pausedAt == null && !slot.isPlaying)) return;
    // Cue de vídeo: atura la sortida i marca'l aturat (sense Web Audio)
    if (isVideo(slot)) {
      // Deixa de duckejar (idempotent: el Set evita doble compte si ja no hi era)
      if (slot.duck) duckRemove(get, slotId);
      emitVideoStop();
      set((state) => ({
        slots: state.slots.map((s) =>
          s.id === slotId ? { ...s, isPlaying: false, pausedAt: null } : s
        ),
        activeSlot: state.activeSlot === slotId ? null : state.activeSlot,
      }));
      return;
    }
    // Deixa de duckejar (el Set evita doble compte si ja no hi era)
    if (slot.duck) duckRemove(get, slotId);
    // Cue routejat a ASIO: no té graf Web Audio (ni sourceNode). Atura la veu
    // nativa al fil `asio-engine` amb el fade-out efectiu i marca'l aturat.
    // IMPORTANT: aquesta comprovació va ABANS de la d'streaming — un cue ASIO
    // pot ser >60s (marcat isStreaming), però NO té graf Web Audio, així que
    // csStop no l'aturaria; ha de parar per la via nativa. (A playSlot el
    // dispatch ASIO també es resol abans de l'streaming.)
    if (isAsioTarget(resolveCueTargetStr(get(), slot)) && !slot.sourceNode) {
      // Calcula el fade-out: true → efectiu del cue; número → aquests segons.
      let fadeSec = 0;
      if (fade === true) fadeSec = Math.max(0, effFadeOut(slot, globalFadeOut));
      else if (typeof fade === 'number') fadeSec = Math.max(0, fade);
      // Si està PAUSAT, la veu no avança al motor: un release amb fade quedaria
      // encallat. Atura-la de cop (fade 0).
      if (slot.pausedAt != null) fadeSec = 0;
      invoke('asio_stop_voice', { voiceId: slot.id, fadeOut: fadeSec })
        .catch((e) => console.warn('[asio] stop_voice:', e));
      clearAsioTelemetry(slotId);
      set((state) => ({
        slots: state.slots.map((s) =>
          s.id === slotId ? { ...s, isPlaying: false, asioActive: false, pausedAt: null } : s
        ),
        activeSlot: state.activeSlot === slotId ? null : state.activeSlot,
      }));
      return;
    }
    if (slot.isStreaming) { csStop(get, set, slotId, fade); return; }
    const ctx = slot.fadeGainNode ? slot.fadeGainNode.context : audioContext;

    // Calcula la durada del fade out
    let fadeSec = 0;
    if (fade === true) {
      const total = slot.audioBuffer ? slot.audioBuffer.duration : 0;
      const segDur = Math.max(
        0.02,
        Math.min(slot.stopPoint ?? total, total) - Math.max(0, slot.startPoint || 0)
      );
      fadeSec = Math.max(0, Math.min(effFadeOut(slot, globalFadeOut), segDur));
    } else if (typeof fade === 'number') {
      fadeSec = Math.max(0, fade);
    }

    const fading = slot.sourceNode && fadeSec > 0 && slot.fadeGainNode && ctx;
    if (fading) {
      // Fade out: rampa el node de fade a 0 i atura la font en acabar.
      // Mantenim la referència perquè playSlot la pugui aturar si es re-dispara.
      const now = ctx.currentTime;
      const fg = slot.fadeGainNode;
      try {
        fg.gain.cancelScheduledValues(now);
        fg.gain.setValueAtTime(fg.gain.value, now);
        fg.gain.linearRampToValueAtTime(0, now + fadeSec);
        slot.sourceNode.onended = null;
        slot.sourceNode.stop(now + fadeSec + 0.05);
      } catch { /* res */ }
    } else if (slot.sourceNode) {
      try { slot.sourceNode.onended = null; slot.sourceNode.stop(); } catch { /* ja aturat */ }
    }

    set((state) => ({
      slots: state.slots.map((s) =>
        s.id === slotId
          ? { ...s, sourceNode: fading ? s.sourceNode : null, isPlaying: false, pausedAt: null }
          : s
      ),
      activeSlot: state.activeSlot === slotId ? null : state.activeSlot,
    }));
  },

  setVolume: (slotId, volume) => {
    const { slots } = get();
    const slot = slots.find((s) => s.id === slotId);
    if (slot?.gainNode) {
      slot.gainNode.gain.value = volume;
    }
    // Cue ASIO actiu: aplica el volum a la veu nativa en calent (no té gainNode)
    if (slot?.asioActive) {
      invoke('asio_set_gain', { voiceId: slotId, gain: volume })
        .catch((e) => console.warn('[asio] set_gain:', e));
    }
    if (slot?.isStreaming) csSetVolume(get, slotId, volume);
    // Cue de vídeo en reproducció: aplica el volum a la finestra de sortida
    if (slot && isVideo(slot) && slot.isPlaying) emitVideoVolume(volume);
    set((state) => ({
      slots: state.slots.map((s) =>
        s.id === slotId ? { ...s, volume } : s
      ),
    }));
    get().persistSlots();
  },

  persistSlots: () => {
    const { slots } = get();
    const data = slots.map((s) => ({
      label: s.label,
      filePath: s.filePath,
      mediaType: s.mediaType,
      isStreaming: s.isStreaming,
      streamDuration: s.streamDuration,
      volume: s.volume,
      loop: s.loop,
      color: s.color,
      stopOthers: s.stopOthers,
      duck: s.duck,
      stopPlaylist: s.stopPlaylist,
      startPoint: s.startPoint,
      stopPoint: s.stopPoint,
      fadeIn: s.fadeIn,
      fadeOut: s.fadeOut,
      preWait: s.preWait,
      continueMode: s.continueMode,
    }));
    localStorage.setItem('the-player-slots', JSON.stringify({ v: SLOTS_SCHEMA, slots: data }));
  },
}));
