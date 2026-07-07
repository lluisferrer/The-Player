// Slice de VÍDEO (P5 — divisió del store en slices).
//
// Concentra totes les accions que gestionen la finestra de sortida de vídeo:
// obertura/tancament, configuració de monitor i patró de blackout, àudio separat,
// seek, finalització natural i neteja en bloc. S'incorpora al store amb
// `...createVideoSlice(set, get)`.

import { duckRemove } from '../../lib/playlistEngine';
import { clearAsioTelemetry } from '../../lib/asioTelemetry';
import { emitVideoSeek, emitVideoIdlePattern, emitVideoBlack, stopVideoResync } from '../../lib/videoOutput';
import { isVideo, isVisual } from '../../lib/slotAudio';
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

    // Patró de la pantalla de blackout ('black' | 'bars' | 'testcard' | 'custom').
    // Es desa i s'emet a la finestra de sortida perquè el canvi s'apliqui en calent.
    setVideoIdlePattern: (pattern) => {
      const p = ['black', 'bars', 'testcard', 'custom'].includes(pattern) ? pattern : 'black';
      set({ videoIdlePattern: p });
      get().persistGlobals();
      const { videoIdleImage, videoIdleImageFit } = get();
      emitVideoIdlePattern(p, videoIdleImage, videoIdleImageFit);
    },

    // Ruta de la imatge de fons personalitzada (patró 'custom'). null la treu.
    // Emet el patró actual amb la nova imatge perquè la sortida s'actualitzi en viu.
    setVideoIdleImage: (path) => {
      set({ videoIdleImage: path || null });
      get().persistGlobals();
      const { videoIdlePattern, videoIdleImageFit } = get();
      emitVideoIdlePattern(videoIdlePattern, path || null, videoIdleImageFit);
    },

    // Encaix de la imatge de fons: 'cover' o 'contain'. També s'aplica en calent.
    setVideoIdleImageFit: (fit) => {
      const f = fit === 'contain' ? 'contain' : 'cover';
      set({ videoIdleImageFit: f });
      get().persistGlobals();
      const { videoIdlePattern, videoIdleImage } = get();
      emitVideoIdlePattern(videoIdlePattern, videoIdleImage, f);
    },

    setSeparateVideoAudio: (on) => { set({ separateVideoAudio: !!on }); get().persistGlobals(); },

    // Botó Black/Bars/Card del transport: "clear screen" respectant el FADE OUT del
    // cue (o el global). Si hi ha cues visuals sonant, els atura amb fade via
    // stopSlot(true): la sortida fa el fade d'opacitat (i el fade de l'àudio separat)
    // i, en acabar, queda al patró d'inactivitat triat. Si el cue té fade out 0, és
    // tall sec. Si no hi ha res sonant, neteja directa al patró (per si quedava un
    // frame orfe). Així no queda àudio orfe sonant amb la pantalla negra.
    goToBlack: () => {
      const { slots } = get();
      const visualPlaying = slots.filter((s) => isVisual(s) && (s.isPlaying || s.pausedAt != null));
      if (visualPlaying.length > 0) {
        visualPlaying.forEach((s) => get().stopSlot(s.id, true));
      } else {
        get().clearVideoCues(); // res sonant: neteja tiles i para el resync
        emitVideoBlack();       // sortida al patró (black/bars/testcard)
      }
    },

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
      // 4c separat: si la imatge ha acabat, atura també l'àudio pel motor que el
      // reprodueix (ASIO a Windows, natiu cpal a Mac) i para el resync.
      if (cur && cur.videoSeparated) {
        const cmd = cur.videoSeparated === 'asio' ? 'asio_stop_voice' : 'native_stop_voice';
        invoke(cmd, { voiceId: slotId, fadeOut: 0 }).catch(() => {});
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
      get().slots.forEach((s) => {
        if (s.mediaType === 'video' && (s.isPlaying || s.pausedAt != null)) {
          // Deixa de duckejar qualsevol cue de vídeo actiu (idempotent)
          if (s.duck) duckRemove(get, s.id);
          // 4c separat: si l'àudio d'aquest cue sortia pel motor (ASIO/natiu), atura
          // també la veu. Sense això, tancar la sortida amb la X mentre sona deixava
          // l'àudio sonant per sempre (el tile es resetejava però el motor no).
          if (s.videoSeparated) {
            const cmd = s.videoSeparated === 'asio' ? 'asio_stop_voice' : 'native_stop_voice';
            invoke(cmd, { voiceId: s.id, fadeOut: 0 }).catch(() => {});
            clearAsioTelemetry(s.id);
          }
        }
      });
      stopVideoResync(); // timer únic de resync imatge→àudio (el compartia el cue actiu)
      set((state) => {
        let activeSlot = state.activeSlot;
        const slots = state.slots.map((s) => {
          if (s.mediaType === 'video' && (s.isPlaying || s.pausedAt != null)) {
            if (activeSlot === s.id) activeSlot = null;
            return { ...s, isPlaying: false, pausedAt: null, videoSeparated: false };
          }
          return s;
        });
        return { slots, activeSlot };
      });
    },

    // C2 (resiliència de vídeo): el watchdog de monitors ha detectat que el
    // monitor de la sortida s'ha desconnectat a mitja funció. Decisió v1.0: NO
    // moure la finestra (evita que el vídeo aparegui per sorpresa al monitor
    // principal); en canvi, negre immediat + avís a l'operador. clearVideoCues
    // atura també l'àudio separat i el resync i reseteja els tiles.
    handleOutputMonitorLost: (name) => {
      emitVideoBlack();
      get().clearVideoCues();
      get().pushNotification({
        type: 'error',
        message: `Output monitor disconnected — output blacked out${name ? ` (${name})` : ''}`,
      });
    },
  };
}
