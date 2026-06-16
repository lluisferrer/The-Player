import { create } from 'zustand';

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
  loop: false,         // opció de reproducció: repeteix el mateix slot
  // Edició del slot (segons l'editor) — tot en segons
  startPoint: 0,       // punt d'inici dins el buffer
  stopPoint: null,     // punt de stop (null = final del buffer)
  fadeIn: 0,           // durada del fade in
  fadeOut: 0,          // durada del fade out
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

const initialSlots = Array.from({ length: NUM_SLOTS }, (_, i) => {
  const base = createEmptySlot(i + 1);
  if (savedSlots && savedSlots[i]) {
    return {
      ...base,
      label: savedSlots[i].label || '',
      filePath: savedSlots[i].filePath ?? null,
      volume: savedSlots[i].volume ?? 0.8,
      loop: savedSlots[i].loop ?? false,
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
  mode: 'single',
  viewMode: 'grid',        // 'grid' (botonera 8×4) | 'list' (llista de files)
  editingSlot: null,       // id del slot obert a l'editor (o null)
  dragOverSlot: null,      // id del slot sota un drag&drop natiu (o null)
  activeSlot: null,
  audioDevices: [],
  selectedDeviceId: 'default',
  audioContext: null,
  outputChannels: 2,       // canals màxims de sortida del dispositiu seleccionat

  initAudioContext: () => {
    const existing = get().audioContext;
    if (existing && existing.state !== 'closed') return existing;
    const ctx = new AudioContext();
    set({ audioContext: ctx });
    return ctx;
  },

  setMode: (mode) => set({ mode }),

  setViewMode: (viewMode) => set({ viewMode }),

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
    const { slots, audioContext } = get();
    const ctx = audioContext || get().initAudioContext();

    // Graf: source → fadeGain → gain (volum) → analyser → destination
    const fadeGainNode = ctx.createGain();
    fadeGainNode.gain.value = 1;
    const gainNode = ctx.createGain();
    const analyserNode = ctx.createAnalyser();
    analyserNode.fftSize = 256;

    fadeGainNode.connect(gainNode);
    gainNode.connect(analyserNode);
    analyserNode.connect(ctx.destination);

    const currentSlot = slots.find((s) => s.id === slotId);
    gainNode.gain.value = currentSlot?.volume ?? 0.8;

    set((state) => ({
      slots: state.slots.map((s) =>
        s.id === slotId
          ? {
              ...s,
              label: file.name,
              filePath,
              audioUrl,
              audioBuffer,
              gainNode,
              fadeGainNode,
              analyserNode,
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
    const { slots, mode, activeSlot, audioContext } = get();
    const ctx = audioContext || get().initAudioContext();
    const slot = slots.find((s) => s.id === slotId);
    if (!slot || !slot.audioBuffer) return;

    // En mode single, atura l'actiu
    if (mode === 'single' && activeSlot && activeSlot !== slotId) {
      get().stopSlot(activeSlot);
    }

    // En mode continuous, si ja sona el togglam
    if (slot.isPlaying) {
      get().stopSlot(slotId);
      return;
    }

    const source = ctx.createBufferSource();
    source.buffer = slot.audioBuffer;
    source.connect(slot.fadeGainNode || slot.gainNode);

    // Punts d'inici/stop (segment) i durada efectiva
    const total = slot.audioBuffer.duration;
    const startPoint = Math.max(0, Math.min(slot.startPoint || 0, total));
    const stopPoint  = Math.min(slot.stopPoint ?? total, total);
    const segDur     = Math.max(0.02, stopPoint - startPoint);
    const fadeIn     = Math.max(0, Math.min(slot.fadeIn || 0, segDur));
    const fadeOut    = Math.max(0, Math.min(slot.fadeOut || 0, segDur));

    const now = ctx.currentTime;

    // Envolupant de fade sobre el node de fade (0..1), independent del volum
    const fg = slot.fadeGainNode;
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
        s.id === slotId ? { ...s, sourceNode: source, isPlaying: true, startedAt } : s
      ),
      activeSlot: slotId,
    }));
  },

  // Gestiona el final natural d'un clip: l'atura i, en mode continuous,
  // encadena el següent slot amb àudio (per ordre, sense fer la volta).
  handleEnded: (slotId) => {
    const st = get();
    const current = st.slots.find((s) => s.id === slotId);
    if (!current || !current.isPlaying) return;

    set((state) => ({
      slots: state.slots.map((s) =>
        s.id === slotId ? { ...s, isPlaying: false, sourceNode: null } : s
      ),
      activeSlot: state.activeSlot === slotId ? null : state.activeSlot,
    }));

    if (st.mode === 'continuous' && !current.loop) {
      const next = st.slots.find((s) => s.id > slotId && s.audioBuffer);
      if (next) get().playSlot(next.id);
    }
  },

  // Salta a una posició (ratio 0..1 dins el segment) mentre el slot sona,
  // recreant el node de reproducció amb el nou offset.
  seekSlot: (slotId, ratio) => {
    const { slots, audioContext } = get();
    const ctx = audioContext;
    const slot = slots.find((s) => s.id === slotId);
    if (!slot || !slot.audioBuffer || !ctx || !slot.isPlaying) return;

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
      const fadeOut = Math.max(0, Math.min(slot.fadeOut || 0, segDur));
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

  // Activa/desactiva el loop d'un slot (opció de reproducció persistida)
  setLoop: (slotId, loop) => {
    set((state) => ({
      slots: state.slots.map((s) =>
        s.id === slotId ? { ...s, loop } : s
      ),
    }));
    get().persistSlots();
  },

  stopSlot: (slotId) => {
    const { slots } = get();
    const slot = slots.find((s) => s.id === slotId);
    if (!slot || !slot.sourceNode) return;

    try {
      slot.sourceNode.onended = null;
      slot.sourceNode.stop();
    } catch {
      // ja aturat
    }

    set((state) => ({
      slots: state.slots.map((s) =>
        s.id === slotId ? { ...s, sourceNode: null, isPlaying: false } : s
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
      startPoint: s.startPoint,
      stopPoint: s.stopPoint,
      fadeIn: s.fadeIn,
      fadeOut: s.fadeOut,
    }));
    localStorage.setItem('the-player-slots', JSON.stringify(data));
  },
}));
