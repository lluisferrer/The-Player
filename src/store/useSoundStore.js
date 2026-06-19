import { create } from 'zustand';
import {
  plPlayPause, plStop, plNext, plPrev, plPlayIndex, plSetVolume, plSetDevice,
  duckAdd, duckRemove, duckReset, duckRefresh,
} from '../lib/playlistEngine';
import {
  csPlay, csStop, csPause, csResume, csSeek, csSetVolume,
  csPreviewStart, csPreviewStop,
} from '../lib/cueStreamEngine';
import { hasClip, isVideo, effFadeIn, effFadeOut } from '../lib/slotAudio';
import { emitVideoPlay, emitVideoStop, emitVideoBlack } from '../lib/videoOutput';

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
  volume: 0.8,
  startedAt: 0,        // instant (audioContext.currentTime) en què va començar a sonar
  pausedAt: null,      // posició (s dins el segment) on s'ha pausat (null = no pausat)
  loop: false,         // opció de reproducció: repeteix el mateix slot
  color: null,         // color del cue (organització + futur routing per grup)
  stopOthers: false,   // en disparar, atura la resta de cues (QLab)
  duck: false,         // en sonar, abaixa el volum de la Playlist (ducking)
  // Edició del slot (segons l'editor) — tot en segons
  startPoint: 0,       // punt d'inici dins el buffer
  stopPoint: null,     // punt de stop (null = final del buffer)
  fadeIn: 0,           // fade in propi (0 = usa el fade in global)
  fadeOut: 0,          // fade out propi (0 = usa el fade out global)
  // Seqüència estil QLab (mode GO)
  preWait: 0,          // retard (s) entre prémer GO i que el cue soni
  continueMode: 'none',// 'none' | 'auto' (auto-continue: dispara el següent tot seguit)
});

const loadPersistedSlots = () => {
  try {
    const saved = localStorage.getItem('the-player-slots');
    if (!saved) return null;
    return JSON.parse(saved);
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
      startPoint: savedSlots[i].startPoint ?? 0,
      stopPoint: savedSlots[i].stopPoint ?? null,
      fadeIn: savedSlots[i].fadeIn ?? 0,
      fadeOut: savedSlots[i].fadeOut ?? 0,
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
      globalFadeIn, globalFadeOut, cuesStopOthers, selectedDeviceId, playlistDeviceId, previewDeviceId, colorOutputs,
      duckEnabled, duckAmount, duckAttack, duckRelease, duckHold,
    } = get();
    localStorage.setItem('the-player-globals', JSON.stringify({
      globalFadeIn, globalFadeOut, cuesStopOthers,
      cuesDeviceId: selectedDeviceId, playlistDeviceId, previewDeviceId,
      colorOutputs,
      duckEnabled, duckAmount, duckAttack, duckRelease, duckHold,
    }));
  },

  // Stop Others global: en disparar qualsevol cue, atura la resta
  setCuesStopOthers: (on) => { set({ cuesStopOthers: !!on }); get().persistGlobals(); },

  // Paràmetres globals del ducking. Reaplica el factor de duck al motor de la
  // playlist (p. ex. canviar duckAmount mentre està duckejat, o desactivar-lo).
  setDuckSettings: (patch) => {
    set(patch);
    get().persistGlobals();
    duckRefresh(get);
  },

  // Activador per cue: marca/desmarca un slot com a cue de ducking. Si el cue
  // ja sona i canvia l'estat, ajusta el comptador en calent.
  setDuck: (slotId, on) => {
    const slot = get().slots.find((s) => s.id === slotId);
    const wasPlaying = slot && (slot.isPlaying || slot.pausedAt != null);
    set((state) => ({
      slots: state.slots.map((s) => (s.id === slotId ? { ...s, duck: !!on } : s)),
    }));
    if (wasPlaying) {
      if (on) duckAdd(get, slotId);
      else duckRemove(get, slotId);
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
    set({ playlistDeviceId: deviceId });
    plSetDevice(get);
    get().persistGlobals();
  },

  setPreviewDevice: async (deviceId) => {
    set({ previewDeviceId: deviceId });
    const ctx = get().previewCtx;
    if (ctx && ctx.setSinkId) { try { await ctx.setSinkId(deviceId); } catch (e) { console.warn(e); } }
    get().persistGlobals();
  },

  // ── Preview (PFL) ──
  setPreviewArmed: (armed) => set({ previewArmed: armed }),

  previewSlot: (slotId) => {
    // Toggle: si aquest slot ja està en preview, l'atura
    if (get().previewingSlot === slotId) { get().stopPreview(); return; }

    const slot = get().slots.find((s) => s.id === slotId);
    if (!slot || !hasClip(slot)) return;

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
    set({ previewingSlot: null });
  },

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
    plStop(get, set);
    set({ playlist: [], playlistIndex: -1, playlistSelected: 0 });
    get().persistPlaylist();
  },

  setCrossfade: (sec) => { set({ crossfade: Math.max(0, sec) }); get().persistPlaylist(); },
  // Cicla el mode de repetició: off → song → list → off
  cyclePlaylistRepeat: () => {
    const next = { off: 'song', song: 'list', list: 'off' };
    set((s) => ({ playlistRepeatMode: next[s.playlistRepeatMode] ?? 'song' }));
    get().persistPlaylist();
  },
  togglePlaylistShuffle: () => { set((s) => ({ playlistShuffle: !s.playlistShuffle })); get().persistPlaylist(); },
  setPlaylistVolume: (v) => { set({ playlistVolume: v }); plSetVolume(get); get().persistPlaylist(); },

  playlistPlayPause: () => plPlayPause(get, set),
  playlistStop: () => plStop(get, set),
  playlistNext: () => plNext(get, set),
  playlistPrev: () => plPrev(get, set),
  playlistPlayIndex: (i) => { set({ playlistSelected: i }); plPlayIndex(get, set, i); },

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
    plPlayIndex(get, set, i);
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
              fadeIn: cfg.fadeIn || 0,
              fadeOut: cfg.fadeOut || 0,
              loop: !!cfg.loop,
              color: cfg.color != null ? cfg.color : null,
              stopOthers: !!cfg.stopOthers,
              duck: !!cfg.duck,
              preWait: cfg.preWait || 0,
              continueMode: cfg.continueMode === 'auto' ? 'auto' : 'none',
            }
          : s
      ),
    }));
    get().persistSlots();
  },

  // Actualitza els camps d'edició d'un slot (startPoint, stopPoint, fadeIn, fadeOut)
  updateSlotEdit: (slotId, patch) =>
    set((state) => ({
      slots: state.slots.map((s) =>
        s.id === slotId ? { ...s, ...patch } : s
      ),
    })),

  setAudioDevices: (devices) => set({ audioDevices: devices }),

  setSelectedDevice: async (deviceId) => {
    const { audioContext } = get();
    set({ selectedDeviceId: deviceId });
    if (audioContext && audioContext.setSinkId) {
      try {
        await audioContext.setSinkId(deviceId);
      } catch (e) {
        console.warn('setSinkId no suportat:', e);
      }
    }
    get().detectOutputChannels();
    get().persistGlobals();
  },

  // Detecta quants canals de sortida exposa el dispositiu seleccionat.
  // maxChannelCount > 2 vol dir que podem fer routing multicanal / cue
  // via Web Audio (ChannelMergerNode). Si és 2, només estèreo.
  detectOutputChannels: async () => {
    const ctx = get().audioContext || get().initAudioContext();
    const dev = get().selectedDeviceId;
    if (ctx.setSinkId && dev && dev !== 'default') {
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
              // Cue nou: Stop Others pren el valor per defecte global (Settings)
              stopOthers: get().cuesStopOthers,
              // Un fitxer nou reinicia els punts d'edició
              startPoint: 0,
              stopPoint: null,
              fadeIn: 0,
              fadeOut: 0,
              // ...i les opcions de seqüència
              preWait: 0,
              continueMode: 'none',
            }
          : s
      ),
    }));

    get().persistSlots();
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
      // Routing per color (com el camí d'àudio); per defecte, bus de Cues
      const outDev = (slot.color && colorOutputs[slot.color]) || get().selectedDeviceId;
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
      set((state) => ({
        slots: state.slots.map((s) =>
          s.id === slotId ? { ...s, isPlaying: true, pausedAt: null } : s
        ),
        activeSlot: slotId,
      }));
      return;
    }

    // Ducking: si aquest cue abaixa la playlist, incrementa el comptador.
    // (Vàlid tant per a cues en buffer com en streaming; el decrement es fa a
    // stopSlot / handleEnded / final natural de l'streaming.)
    if (slot.duck) duckAdd(get, slotId);

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

  // Mou el cursor de selecció amb les fletxes, dins la pàgina activa (8×4)
  moveSelection: (dir) => {
    const { selectedSlot, currentPage } = get();
    const base = currentPage * SLOTS_PER_PAGE;
    let local = (selectedSlot - 1) % SLOTS_PER_PAGE;
    const col = local % 8;
    const row = Math.floor(local / 8);
    if (dir === 'left' && col > 0) local -= 1;
    if (dir === 'right' && col < 7) local += 1;
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
    set((state) => ({
      slots: state.slots.map((s) =>
        s.id === slotId ? { ...s, isPlaying: false, sourceNode: null } : s
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
    if (slot?.isStreaming) csSetVolume(get, slotId, volume);
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
      startPoint: s.startPoint,
      stopPoint: s.stopPoint,
      fadeIn: s.fadeIn,
      fadeOut: s.fadeOut,
      preWait: s.preWait,
      continueMode: s.continueMode,
    }));
    localStorage.setItem('the-player-slots', JSON.stringify(data));
  },
}));
