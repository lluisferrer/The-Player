import { create } from 'zustand';

const NUM_SLOTS = 32;

const createEmptySlot = (id) => ({
  id,
  label: '',
  audioUrl: null,
  audioBuffer: null,
  gainNode: null,
  analyserNode: null,
  sourceNode: null,
  isPlaying: false,
  volume: 0.8,
  startedAt: 0,        // instant (audioContext.currentTime) en què va començar a sonar
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
      volume: savedSlots[i].volume ?? 0.8,
    };
  }
  return base;
});

export const useSoundStore = create((set, get) => ({
  slots: initialSlots,
  mode: 'single',
  activeSlot: null,
  audioDevices: [],
  selectedDeviceId: 'default',
  audioContext: null,

  initAudioContext: () => {
    const existing = get().audioContext;
    if (existing && existing.state !== 'closed') return existing;
    const ctx = new AudioContext();
    set({ audioContext: ctx });
    return ctx;
  },

  setMode: (mode) => set({ mode }),

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
  },

  loadAudio: (slotId, file, audioBuffer, audioUrl) => {
    const { slots, audioContext } = get();
    const ctx = audioContext || get().initAudioContext();

    const gainNode = ctx.createGain();
    const analyserNode = ctx.createAnalyser();
    analyserNode.fftSize = 256;

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
              audioUrl,
              audioBuffer,
              gainNode,
              analyserNode,
              sourceNode: null,
              isPlaying: false,
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
    source.connect(slot.gainNode);

    if (mode === 'continuous') {
      source.loop = true;
    }

    source.onended = () => {
      const currentSlot = get().slots.find((s) => s.id === slotId);
      if (currentSlot && currentSlot.isPlaying && mode !== 'continuous') {
        set((state) => ({
          slots: state.slots.map((s) =>
            s.id === slotId ? { ...s, isPlaying: false, sourceNode: null } : s
          ),
          activeSlot: state.activeSlot === slotId ? null : state.activeSlot,
        }));
      }
    };

    source.start(0);
    const startedAt = ctx.currentTime;

    set((state) => ({
      slots: state.slots.map((s) =>
        s.id === slotId ? { ...s, sourceNode: source, isPlaying: true, startedAt } : s
      ),
      activeSlot: slotId,
    }));
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
    const data = slots.map((s) => ({ label: s.label, volume: s.volume }));
    localStorage.setItem('the-player-slots', JSON.stringify(data));
  },
}));
