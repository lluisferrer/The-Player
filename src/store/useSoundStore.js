import { create } from 'zustand';
import {
  plPlayPause, plStop, plNext, plPrev, plPlayIndex, plSetVolume,
} from '../lib/playlistEngine';

const NUM_SLOTS = 32;

const createEmptySlot = (id) => ({
  id,
  label: '',
  filePath: null,      // ruta absoluta del fitxer (per recarregar des de la Library)
  audioUrl: null,
  audioBuffer: null,
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
  useGlobalFades: true,// usa els fades globals per defecte (override si false)
  // Edició del slot (segons l'editor) — tot en segons
  startPoint: 0,       // punt d'inici dins el buffer
  stopPoint: null,     // punt de stop (null = final del buffer)
  fadeIn: 0,           // durada del fade in (override propi)
  fadeOut: 0,          // durada del fade out (override propi)
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
      volume: savedSlots[i].volume ?? 0.8,
      loop: savedSlots[i].loop ?? false,
      color: savedSlots[i].color ?? null,
      stopOthers: savedSlots[i].stopOthers ?? false,
      useGlobalFades: savedSlots[i].useGlobalFades ?? true,
      startPoint: savedSlots[i].startPoint ?? 0,
      stopPoint: savedSlots[i].stopPoint ?? null,
      fadeIn: savedSlots[i].fadeIn ?? 0,
      fadeOut: savedSlots[i].fadeOut ?? 0,
    };
  }
  return base;
});

export const useSoundStore = create((set, get) => ({
  slots: initialSlots,
  globalFadeIn: savedGlobals.globalFadeIn ?? 0,   // fades per defecte de tots els cues
  globalFadeOut: savedGlobals.globalFadeOut ?? 0,
  viewMode: 'grid',        // 'grid' (botonera 8×4) | 'list' (llista de files)
  editingSlot: null,       // id del slot obert a l'editor (o null)
  dragOverSlot: null,      // id del slot sota un drag&drop natiu (o null)
  selectedSlot: 1,         // slot seleccionat (cursor de teclat per al transport)
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
  playlistPlaying: false,
  playlistPaused: false,
  crossfade: savedPlaylist.crossfade ?? 3,
  playlistRepeat: savedPlaylist.repeat ?? false,
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
    const { globalFadeIn, globalFadeOut, selectedDeviceId, playlistDeviceId, previewDeviceId, colorOutputs } = get();
    localStorage.setItem('the-player-globals', JSON.stringify({
      globalFadeIn, globalFadeOut,
      cuesDeviceId: selectedDeviceId, playlistDeviceId, previewDeviceId,
      colorOutputs,
    }));
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

  setPlaylistDevice: async (deviceId) => {
    set({ playlistDeviceId: deviceId });
    const ctx = get().playlistCtx;
    if (ctx && ctx.setSinkId) { try { await ctx.setSinkId(deviceId); } catch (e) { console.warn(e); } }
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
    if (!slot || !slot.audioBuffer) return;
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
    set({ previewingSlot: null });
  },

  setViewMode: (viewMode) => set({ viewMode }),

  // ── Accions de la Playlist ──
  persistPlaylist: () => {
    const { playlist, crossfade, playlistRepeat, playlistShuffle, playlistVolume } = get();
    localStorage.setItem('the-player-playlist', JSON.stringify({
      tracks: playlist, crossfade, repeat: playlistRepeat, shuffle: playlistShuffle, volume: playlistVolume,
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
      return { playlist, playlistIndex };
    });
    get().persistPlaylist();
  },

  movePlaylistTrack: (from, to) => {
    set((state) => {
      const playlist = [...state.playlist];
      if (from < 0 || from >= playlist.length || to < 0 || to >= playlist.length) return {};
      const [item] = playlist.splice(from, 1);
      playlist.splice(to, 0, item);
      return { playlist };
    });
    get().persistPlaylist();
  },

  clearPlaylist: () => {
    plStop(get, set);
    set({ playlist: [], playlistIndex: -1 });
    get().persistPlaylist();
  },

  setCrossfade: (sec) => { set({ crossfade: Math.max(0, sec) }); get().persistPlaylist(); },
  togglePlaylistRepeat: () => { set((s) => ({ playlistRepeat: !s.playlistRepeat })); get().persistPlaylist(); },
  togglePlaylistShuffle: () => { set((s) => ({ playlistShuffle: !s.playlistShuffle })); get().persistPlaylist(); },
  setPlaylistVolume: (v) => { set({ playlistVolume: v }); plSetVolume(get, v); get().persistPlaylist(); },

  playlistPlayPause: () => plPlayPause(get, set),
  playlistStop: () => plStop(get, set),
  playlistNext: () => plNext(get, set),
  playlistPrev: () => plPrev(get, set),
  playlistPlayIndex: (i) => plPlayIndex(get, set, i),

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
              volume: cfg.volume != null ? cfg.volume : s.volume,
              startPoint: cfg.startPoint || 0,
              stopPoint: cfg.stopPoint != null ? cfg.stopPoint : null,
              fadeIn: cfg.fadeIn || 0,
              fadeOut: cfg.fadeOut || 0,
              loop: !!cfg.loop,
              color: cfg.color != null ? cfg.color : null,
              stopOthers: !!cfg.stopOthers,
              useGlobalFades: cfg.useGlobalFades != null ? cfg.useGlobalFades : true,
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

  loadAudio: (slotId, file, audioBuffer, audioUrl, filePath = null) => {
    // Els nodes (gain/fade/analyser) es construeixen al Play, al context del
    // dispositiu segons el color del cue (routing per grup).
    set((state) => ({
      slots: state.slots.map((s) =>
        s.id === slotId
          ? {
              ...s,
              label: file.name,
              filePath,
              audioUrl,
              audioBuffer,
              gainNode: null,
              fadeGainNode: null,
              analyserNode: null,
              sourceNode: null,
              isPlaying: false,
              // Un fitxer nou reinicia els punts d'edició
              startPoint: 0,
              stopPoint: null,
              fadeIn: 0,
              fadeOut: 0,
            }
          : s
      ),
    }));

    get().persistSlots();
  },

  playSlot: (slotId) => {
    const { slots, globalFadeIn, globalFadeOut, colorOutputs } = get();
    const slot = slots.find((s) => s.id === slotId);
    if (!slot || !slot.audioBuffer) return;

    // Si ja sona, el togglam (atura amb fade out)
    if (slot.isPlaying) {
      get().stopSlot(slotId, true);
      return;
    }

    // "Stop others" per cue: atura la resta de cues que sonin
    if (slot.stopOthers) {
      slots.forEach((s) => {
        if (s.id !== slotId && (s.isPlaying || s.pausedAt != null)) get().stopSlot(s.id);
      });
    }

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
      analyserNode.fftSize = 256;
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
    // Fades efectius: globals per defecte, o els propis del cue si fa override
    const rawIn  = slot.useGlobalFades ? globalFadeIn : slot.fadeIn;
    const rawOut = slot.useGlobalFades ? globalFadeOut : slot.fadeOut;
    const fadeIn     = Math.max(0, Math.min(rawIn || 0, segDur));
    const fadeOut    = Math.max(0, Math.min(rawOut || 0, segDur));

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

  // Re-dispara un slot des de l'inici (per la tecla del teclat)
  triggerSlot: (slotId) => {
    const slot = get().slots.find((s) => s.id === slotId);
    if (!slot || !slot.audioBuffer) return;
    if (slot.isPlaying) get().stopSlot(slotId);
    set((state) => ({
      slots: state.slots.map((s) => (s.id === slotId ? { ...s, pausedAt: null } : s)),
      selectedSlot: slotId,
    }));
    get().playSlot(slotId);
  },

  // Pausa: atura recordant la posició dins el segment
  pauseSlot: (slotId) => {
    const slot = get().slots.find((s) => s.id === slotId);
    if (!slot || !slot.isPlaying) return;
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
    if (!slot || !slot.audioBuffer || slot.pausedAt == null) return;
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
      const fadeOut = Math.max(0, Math.min((slot.useGlobalFades ? get().globalFadeOut : slot.fadeOut) || 0, segDur));
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

  // Mou el cursor de selecció amb les fletxes (segons graella o llista)
  moveSelection: (dir) => {
    const { selectedSlot, viewMode } = get();
    let id = selectedSlot || 1;
    if (viewMode === 'list') {
      if (dir === 'up' || dir === 'left') id = Math.max(1, id - 1);
      if (dir === 'down' || dir === 'right') id = Math.min(32, id + 1);
    } else {
      const col = (id - 1) % 8;
      const row = Math.floor((id - 1) / 8);
      if (dir === 'left' && col > 0) id -= 1;
      if (dir === 'right' && col < 7) id += 1;
      if (dir === 'up' && row > 0) id -= 8;
      if (dir === 'down' && row < 3) id += 8;
    }
    set({ selectedSlot: id });
  },

  // Transport sobre un slot: play si aturat, pausa si sona, reprèn si pausat
  togglePlayPause: (slotId) => {
    const slot = get().slots.find((s) => s.id === slotId);
    if (!slot || !slot.audioBuffer) return;
    if (slot.isPlaying) get().pauseSlot(slotId);
    else if (slot.pausedAt != null) get().resumeSlot(slotId);
    else get().triggerSlot(slotId);
  },

  // Parada d'emergència: atura TOTS els slots
  // Parada d'emergència de TOTS els cues, amb fade out (segons el fade-out
  // efectiu de cada cue; si és 0, tall sec).
  stopAll: () => {
    const { slots } = get();
    slots.forEach((s) => {
      if (s.isPlaying || s.pausedAt != null) get().stopSlot(s.id, true);
    });
    get().stopPreview();
    set({ activeSlot: null });
  },

  // Gestiona el final natural d'un clip: l'atura (l'encadenament és manual
  // amb GO, o automàtic a la Playlist; la botonera no avança sola).
  handleEnded: (slotId) => {
    const current = get().slots.find((s) => s.id === slotId);
    if (!current || !current.isPlaying) return;
    set((state) => ({
      slots: state.slots.map((s) =>
        s.id === slotId ? { ...s, isPlaying: false, sourceNode: null } : s
      ),
      activeSlot: state.activeSlot === slotId ? null : state.activeSlot,
    }));
  },

  // GO: dispara el slot seleccionat i avança la selecció al següent cue amb àudio
  go: () => {
    const { selectedSlot, slots } = get();
    const sel = selectedSlot || 1;
    const slot = slots.find((s) => s.id === sel);
    if (slot && slot.audioBuffer) get().triggerSlot(sel);
    // Avança la selecció al següent slot amb àudio (sense fer la volta)
    const next = slots.find((s) => s.id > sel && s.audioBuffer);
    if (next) set({ selectedSlot: next.id });
  },

  // Salta a una posició (ratio 0..1 dins el segment) mentre el slot sona,
  // recreant el node de reproducció amb el nou offset.
  seekSlot: (slotId, ratio) => {
    const slot = get().slots.find((s) => s.id === slotId);
    if (!slot || !slot.audioBuffer || !slot.isPlaying) return;
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
      const fadeOut = Math.max(0, Math.min((slot.useGlobalFades ? get().globalFadeOut : slot.fadeOut) || 0, segDur));
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
    const ctx = slot.fadeGainNode ? slot.fadeGainNode.context : audioContext;

    // Calcula la durada del fade out
    let fadeSec = 0;
    if (fade === true) {
      const total = slot.audioBuffer ? slot.audioBuffer.duration : 0;
      const segDur = Math.max(
        0.02,
        Math.min(slot.stopPoint ?? total, total) - Math.max(0, slot.startPoint || 0)
      );
      fadeSec = Math.max(0, Math.min((slot.useGlobalFades ? globalFadeOut : slot.fadeOut) || 0, segDur));
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
      volume: s.volume,
      loop: s.loop,
      color: s.color,
      stopOthers: s.stopOthers,
      useGlobalFades: s.useGlobalFades,
      startPoint: s.startPoint,
      stopPoint: s.stopPoint,
      fadeIn: s.fadeIn,
      fadeOut: s.fadeOut,
    }));
    localStorage.setItem('the-player-slots', JSON.stringify(data));
  },
}));
