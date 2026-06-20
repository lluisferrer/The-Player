import { useState, useEffect } from 'react';
import { useSoundStore } from '../store/useSoundStore';
import { slotDuration } from '../lib/slotAudio';
import { csPosition } from '../lib/cueStreamEngine';
import { asioPosition } from '../lib/asioTelemetry';

// Retorna el temps de reproducció d'un slot en temps real:
//   { elapsed, duration, progress }  (progress = 0..1)
// Mentre el slot sona, s'actualitza cada frame amb requestAnimationFrame.
// En mode continu (loop) el temps es plega amb el mòdul de la durada.
export function usePlaybackTime(slot) {
  const audioContext = useSoundStore((s) => s.audioContext);
  // Durada del segment efectiu (punt d'inici → stop), no del fitxer sencer
  const total = slotDuration(slot);
  const startPoint = (slot && slot.startPoint) || 0;
  const stopPoint = (slot && slot.stopPoint != null) ? slot.stopPoint : total;
  const duration = Math.max(0, stopPoint - startPoint);
  const isPlaying = Boolean(slot && slot.isPlaying);
  const isStreaming = Boolean(slot && slot.isStreaming);
  // Cue routejat al motor ASIO natiu: la posició ve per telemetria (no per
  // AudioContext ni element <audio>). Té prioritat sobre les altres dues vies.
  const isAsio = Boolean(slot && slot.asioActive);
  const slotId = slot && slot.id;
  const startedAt = (slot && slot.startedAt) || 0;
  const pausedAt = slot && slot.pausedAt != null ? slot.pausedAt : null;
  const [state, setState] = useState({ elapsed: 0, duration, progress: 0 });

  // ASIO: la posició ve de la telemetria del motor natiu (asioPosition)
  useEffect(() => {
    if (!isAsio) return undefined;
    if (!isPlaying || !duration) {
      setState({ elapsed: 0, duration, progress: 0 });
      return undefined;
    }
    let raf;
    const tick = () => {
      const pos = asioPosition(slotId);
      const e = pos != null ? Math.min(pos, duration) : 0;
      setState({ elapsed: e, duration, progress: duration ? e / duration : 0 });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [isAsio, isPlaying, duration, slotId]);

  // Streaming: la posició ve de l'element <audio> (csPosition)
  useEffect(() => {
    if (isAsio) return undefined;
    if (!isStreaming) return undefined;
    if (!isPlaying || !duration) {
      if (pausedAt != null && duration) {
        const p = Math.min(pausedAt, duration);
        setState({ elapsed: p, duration, progress: p / duration });
      } else {
        setState({ elapsed: 0, duration, progress: 0 });
      }
      return undefined;
    }
    let raf;
    const tick = () => {
      const pos = csPosition(slotId);
      const e = pos != null ? Math.min(pos, duration) : 0;
      setState({ elapsed: e, duration, progress: duration ? e / duration : 0 });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [isStreaming, isPlaying, duration, pausedAt, slotId]);

  useEffect(() => {
    if (isAsio) return undefined;
    if (isStreaming) return undefined;
    if (!isPlaying || !audioContext || !duration) {
      // En pausa, mostra la posició congelada; aturat, a zero
      if (pausedAt != null && duration) {
        const p = Math.min(pausedAt, duration);
        setState({ elapsed: p, duration, progress: p / duration });
      } else {
        setState({ elapsed: 0, duration, progress: 0 });
      }
      return;
    }

    let raf;
    const tick = () => {
      let elapsed = audioContext.currentTime - startedAt;
      if (elapsed < 0) elapsed = 0;
      const e = elapsed % duration;              // plega en loop
      setState({ elapsed: e, duration, progress: e / duration });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [isStreaming, isPlaying, startedAt, audioContext, duration, pausedAt]);

  return state;
}

// Format mm:ss
export function fmtTime(seconds) {
  if (!isFinite(seconds) || seconds < 0) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}
