// Slice de PREVIEW — bus PFL (P5 — divisió del store en slices).
//
// Concentra totes les accions que gestionen el bus de pre-escolta (PFL):
// armar/desarmar, disparar el preview d'un slot, aturar-lo i notificar que
// ha acabat sol. S'incorpora al store amb `...createPreviewSlice(set, get)`.
//
// Variables de mòdul (a nivell de fitxer, fora de la factory): només les
// accions d'aquest slice les necessiten, així que viuen aquí.

import { AudioCtx } from '../audioCtx';
import { invoke } from '@tauri-apps/api/core';
import { csPreviewStart, csPreviewStop } from '../../lib/cueStreamEngine';
import { isAsioTarget, parseTarget } from '../../lib/outputTarget';
import { PREVIEW_VOICE_ID } from '../../lib/asioIds';
import { clearAsioTelemetry } from '../../lib/asioTelemetry';
import { hasClip, isImage, isVideo, slotDuration } from '../../lib/slotAudio';

// Font activa del bus de preview (node Web Audio): permet aturar-la des de
// stopPreview sense haver de guardar-la a l'estat Zustand (és un objecte
// mutable, no serialitzable).
let previewSource = null;

// Comptador rotatori: genera un voice id ASIO nou a cada preview per
// descartar telemetria residual de la veu anterior.
let previewSeq = 0;

export function createPreviewSlice(set, get) {
  return {
    // Arma o desarma el mode preview (PFL). Quan és true, clicar un slot
    // el posa en pre-escolta en lloc de disparar-lo.
    setPreviewArmed: (armed) => set({ previewArmed: armed }),

    // Posa en preview el slot indicat. Si ja estava en preview, l'atura (toggle).
    // Cobreix tots els camins de reproducció: ASIO, motor natiu cpal, streaming
    // i Web Audio bufferitzat.
    previewSlot: (slotId) => {
      // Toggle: si aquest slot ja està en preview, l'atura
      if (get().previewingSlot === slotId) { get().stopPreview(); return; }

      const slot = get().slots.find((s) => s.id === slotId);
      if (!slot || !hasClip(slot)) return;
      // Cues d'IMATGE: no tenen preview viu (ja es veuen com a miniatura al tile).
      if (isImage(slot)) { get().stopPreview(); return; }
      // Cues de VÍDEO: preview VISUAL dins el propi tile (no pel motor d'àudio/ASIO,
      // que no en sap el còdec). El WebView descodifica el vídeo i el SoundButton el
      // reprodueix amb un <video>; el so va al dispositiu de preview si és WASAPI, o
      // mut si és ASIO/no disponible. Només un preview viu alhora (atura l'anterior).
      if (isVideo(slot)) {
        get().stopPreview();
        set({ previewingSlot: slotId, previewStartedAt: performance.now() / 1000 });
        return;
      }

      // Preview per ASIO: toca el cue pel motor natiu cap als canals del bus de
      // preview (un sol preview alhora, voice id reservat). Cobreix curt i streaming.
      if (isAsioTarget(get().previewDeviceId)) {
        get().stopPreview();
        // Un voice id NOU a cada preview: la telemetria residual de la veu anterior
        // (que pot arribar entre l'stop i el play) va a l'id vell, que ja no es llegeix.
        const voiceId = PREVIEW_VOICE_ID + (previewSeq = (previewSeq + 1) % 100000);
        const tgt = parseTarget(get().previewDeviceId);
        const total = slotDuration(slot);
        const startPoint = Math.max(0, Math.min(slot.startPoint || 0, total || 0));
        const stopPoint = slot.stopPoint != null ? slot.stopPoint : 0; // 0 = fins al final
        invoke('asio_play_voice', {
          voiceId,
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
        // Playhead del preview ASIO per rellotge JS (no per telemetria): garanteix
        // que comença a 0 a cada cue, sense valors residuals d'un id compartit.
        set({ previewingSlot: slotId, previewStartedAt: performance.now() / 1000, previewVoiceId: voiceId });
        return;
      }

      // Preview pel motor natiu cpal: si el motor natiu està actiu i el dispositiu de
      // preview NO és ASIO, toca el cue pel bus natiu cap als canals de preview. Dona
      // pre-escolta multicanal real també a Mac (curt i streaming).
      if (get().useNativeCueEngine && !isAsioTarget(get().previewDeviceId)) {
        get().stopPreview();
        const voiceId = PREVIEW_VOICE_ID + (previewSeq = (previewSeq + 1) % 100000);
        const total = slotDuration(slot);
        const startPoint = Math.max(0, Math.min(slot.startPoint || 0, total || 0));
        const stopPoint = slot.stopPoint != null ? slot.stopPoint : 0; // 0 = fins al final
        invoke('native_play_cue', {
          voiceId,
          deviceName: get().nativePreviewDeviceName || '',
          filePath: slot.filePath,
          channels: get().nativePreviewChannels || [],
          gain: slot.volume ?? 0.8,
          fadeIn: 0,
          fadeOut: 0,
          loopOn: !!slot.loop,
          startPoint,
          stopPoint,
          streaming: !!slot.isStreaming,
        }).catch((e) => console.warn('[native] preview:', e));
        set({ previewingSlot: slotId, previewStartedAt: performance.now() / 1000, previewVoiceId: voiceId });
        return;
      }

      // Cue en streaming: preview amb element <audio> al bus de preview
      if (slot.isStreaming) {
        get().stopPreview();
        if (csPreviewStart(get, set, slotId)) {
          set({ previewingSlot: slotId, previewStartedAt: performance.now() / 1000 });
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
      set({ previewingSlot: slotId, previewStartedAt: performance.now() / 1000 });
    },

    // Atura immediatament el preview en curs (tots els camins: Web Audio, streaming,
    // ASIO i motor natiu cpal). Neteja la telemetria del voice id actual.
    stopPreview: () => {
      if (previewSource) { try { previewSource.onended = null; previewSource.stop(); } catch { /* res */ } previewSource = null; }
      csPreviewStop();
      // Atura també un possible preview pel motor ASIO (no-op si no n'hi ha) i neteja
      // la seva telemetria perquè el playhead vermell no arrossegui la posició vella.
      const pvid = get().previewVoiceId;
      if (isAsioTarget(get().previewDeviceId)) {
        invoke('asio_stop_voice', { voiceId: pvid, fadeOut: 0 }).catch(() => {});
      } else if (get().useNativeCueEngine) {
        invoke('native_stop_voice', { voiceId: pvid, fadeOut: 0 }).catch(() => {});
      }
      clearAsioTelemetry(pvid);
      set({ previewingSlot: null });
    },

    // El motor ASIO informa que el preview ha acabat sol → neteja l'estat i la
    // telemetria (perquè el playhead no es quedi clavat al final).
    previewEnded: () => { clearAsioTelemetry(get().previewVoiceId); set({ previewingSlot: null }); },

    // Assegura que el context d'àudio del bus de preview existeix i no està tancat.
    // El crea si cal i li aplica el sinkId del dispositiu de preview seleccionat.
    ensurePreviewCtx: () => {
      let ctx = get().previewCtx;
      if (!ctx || ctx.state === 'closed') {
        ctx = new AudioCtx();
        set({ previewCtx: ctx });
        const dev = get().previewDeviceId;
        // setSinkId és asíncron; el rebuig (dispositiu absent) es captura amb .catch.
        if (ctx.setSinkId && dev) {
          ctx.setSinkId(dev).catch((e) =>
            console.warn('[setSinkId] ensurePreviewCtx: dispositiu no disponible:', dev, e)
          );
        }
      }
      if (ctx.state === 'suspended') ctx.resume();
      return ctx;
    },
  };
}
