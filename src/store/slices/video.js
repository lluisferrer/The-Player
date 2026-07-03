// Slice de VÍDEO (P5 — divisió del store en slices).
//
// Concentra totes les accions que gestionen la finestra de sortida de vídeo:
// obertura/tancament, configuració de monitor i patró de blackout, àudio separat,
// seek, finalització natural i neteja en bloc. S'incorpora al store amb
// `...createVideoSlice(set, get)`.

import { duckRemove } from '../../lib/playlistEngine';
import { clearAsioTelemetry } from '../../lib/asioTelemetry';
import { emitVideoSeek, emitVideoIdlePattern, stopVideoResync } from '../../lib/videoOutput';
import { isVideo } from '../../lib/slotAudio';
import { invoke } from '@tauri-apps/api/core';

export function createVideoSlice(set, get) {
  return {
    // Recorda si la sortida de vídeo està oberta (persistència de sessió).
    setVideoOutputOpen: (open) => {
      set({ videoOutputOpen: !!open });
      get().persistGlobals();
    },

    // Monitor predeterminat de la finestra de sortida de vídeo (per nom; null = auto).
    // Es desa als globals i s'aplica la pròxima vegada que s'obri la finestra.
    setVideoMonitorName: (name) => {
      set({ videoMonitorName: name || null });
      get().persistGlobals();
    },

    // Patró de la pantalla de blackout ('black' | 'bars' | 'testcard'). Es desa i
    // s'emet a la finestra de sortida perquè el canvi s'apliqui en calent.
    setVideoIdlePattern: (pattern) => {
      const p = ['black', 'bars', 'testcard'].includes(pattern) ? pattern : 'black';
      set({ videoIdlePattern: p });
      get().persistGlobals();
      emitVideoIdlePattern(p);
    },

    setSeparateVideoAudio: (on) => { set({ separateVideoAudio: !!on }); get().persistGlobals(); },

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

    // La finestra de sortida informa que un cue de vídeo ha acabat sol: reseteja
    // el seu estat perquè el tile/transport deixin de marcar-lo com a actiu.
    handleVideoEnded: (slotId) => {
      // El cue de vídeo ha acabat (final natural, stopPoint o stop): deixa de
      // duckejar (idempotent) abans de resetejar el seu estat.
      const cur = get().slots.find((s) => s.id === slotId);
      if (cur && cur.mediaType === 'video' && cur.duck) duckRemove(get, slotId);
      // 4c separat: si la imatge ha acabat, atura també l'àudio del motor i el resync.
      if (cur && cur.videoSeparated) {
        invoke('native_stop_voice', { voiceId: slotId, fadeOut: 0 }).catch(() => {});
        stopVideoResync();
        clearAsioTelemetry(slotId);
      }
      set((state) => ({
        slots: state.slots.map((s) =>
          s.id === slotId && s.mediaType === 'video' ? { ...s, isPlaying: false, pausedAt: null, videoSeparated: false } : s
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
  };
}
