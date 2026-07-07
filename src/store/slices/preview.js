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
import { isAsioTarget, isNativeTarget, parseTarget } from '../../lib/outputTarget';
import { PREVIEW_VOICE_ID } from '../../lib/asioIds';
import { clearAsioTelemetry } from '../../lib/asioTelemetry';
import { hasClip, isImage, isVideo, isPdf, slotDuration } from '../../lib/slotAudio';

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
      // Cues de SLIDES (PDF): no tenen so; el Ctrl+clic entra al mode FULLEIG (browse
      // de pàgines DINS el tile, sense projectar a la sortida). Reutilitza
      // `previewingSlot` (un sol preview/fulleig alhora) perquè el toggle del principi
      // el faci sortir amb un altre Ctrl+clic, igual que àudio/vídeo. Sense motor: només
      // estat; la navegació i el render de pàgina viuen al SoundButton. IMPORTANT: va
      // ABANS del camí d'àudio de sota, que faria `slot.audioBuffer.duration` (null → error).
      if (isPdf(slot)) {
        get().stopPreview(); // atura qualsevol preview sonor d'un altre slot
        set({ previewingSlot: slotId, previewStartedAt: performance.now() / 1000 });
        return;
      }
      // Cues de VÍDEO: preview VISUAL dins el propi tile (el WebView descodifica el
      // vídeo i el SoundButton el reprodueix amb un <video>). El SO:
      //   - WASAPI/default: el treu el propi <video> (SoundButton fa setSinkId).
      //   - ASIO/natiu: el WebView no hi pot enrutar el <video> → toquem l'ÀUDIO del
      //     fitxer pel motor cap al bus de preview (el <video> va mut, només imatge),
      //     igual que separateVideoAudio fa per als cues. Sync prou bo per a un PFL curt.
      // Només un preview viu alhora (atura l'anterior).
      if (isVideo(slot)) {
        get().stopPreview();
        const pdev = get().previewDeviceId;
        if (isAsioTarget(pdev) || isNativeTarget(pdev)) {
          const voiceId = PREVIEW_VOICE_ID + (previewSeq = (previewSeq + 1) % 100000);
          const tgt = parseTarget(pdev);
          const total = slotDuration(slot);
          const startPoint = Math.max(0, Math.min(slot.startPoint || 0, total || 0));
          const stopPoint = slot.stopPoint != null ? slot.stopPoint : 0; // 0 = fins al final
          const base = {
            voiceId, filePath: slot.filePath, gain: slot.volume ?? 0.8,
            fadeIn: 0, fadeOut: 0, loopOn: !!slot.loop, startPoint, stopPoint,
            streaming: !!slot.isStreaming,
          };
          if (isAsioTarget(pdev)) {
            invoke('asio_play_voice', { ...base, driver: tgt.driver, channels: tgt.channels })
              .catch((e) => console.warn('[asio] preview video:', e));
          } else {
            invoke('native_play_cue', { ...base, deviceName: tgt.device || '', channels: tgt.channels || [] })
              .catch((e) => console.warn('[native] preview video:', e));
          }
          set({ previewingSlot: slotId, previewStartedAt: performance.now() / 1000, previewVoiceId: voiceId });
          return;
        }
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

      // Preview pel motor natiu cpal: si el bus de preview routeja a un target
      // "native:…", toca el cue pel motor cap al dispositiu/canals del target. Dona
      // pre-escolta multicanal real també a Mac (curt i streaming).
      if (isNativeTarget(get().previewDeviceId)) {
        get().stopPreview();
        const ptgt = parseTarget(get().previewDeviceId);
        const voiceId = PREVIEW_VOICE_ID + (previewSeq = (previewSeq + 1) % 100000);
        const total = slotDuration(slot);
        const startPoint = Math.max(0, Math.min(slot.startPoint || 0, total || 0));
        const stopPoint = slot.stopPoint != null ? slot.stopPoint : 0; // 0 = fins al final
        invoke('native_play_cue', {
          voiceId,
          deviceName: ptgt.device || '',
          filePath: slot.filePath,
          channels: ptgt.channels || [],
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
      } else if (isNativeTarget(get().previewDeviceId)) {
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
