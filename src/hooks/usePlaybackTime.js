import { useState, useEffect, useRef } from 'react';
import { useSoundStore } from '../store/useSoundStore';
import { slotDuration } from '../lib/slotAudio';
import { csPosition } from '../lib/cueStreamEngine';
import { asioPosition } from '../lib/asioTelemetry';

// Interval mínim entre actualitzacions de l'estat React (ms).
// ~16 Hz és imperceptible per a un cronòmetre o barra de progrés i redueix
// molt el cost de re-render quan hi ha 8-10 cues sonant alhora.
const THROTTLE_MS = 62; // ≈ 16 Hz

// Retorna el temps de reproducció d'un slot en temps real:
//   { elapsed, duration, progress }  (progress = 0..1)
// Mentre el slot sona, s'actualitza cada frame amb requestAnimationFrame,
// però l'estat React es propaga com a màxim cada THROTTLE_MS mil·lisegons.
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
  // Cue routejat al motor ASIO natiu o al motor natiu cpal: la posició ve per
  // telemetria (no per AudioContext ni element <audio>). Tots dos motors desen la
  // telemetria al mateix Map (asioPosition). Té prioritat sobre les altres vies.
  const isAsio = Boolean(slot && (slot.asioActive || slot.nativeActive));
  const slotId = slot && slot.id;
  const startedAt = (slot && slot.startedAt) || 0;
  const pausedAt = slot && slot.pausedAt != null ? slot.pausedAt : null;
  const [state, setState] = useState({ elapsed: 0, duration, progress: 0 });

  // Ref per guardar el timestamp de l'última actualització de l'estat React.
  // Compartida pels tres efectes però cada un en té la seva pròpia (no shared).
  // (Les refs es declaren abans dels efectes per respectar les regles dels hooks.)
  const lastUpdateAsio = useRef(0);
  const lastUpdateStream = useRef(0);
  const lastUpdateBuf = useRef(0);

  // ASIO: la posició ve de la telemetria del motor natiu (asioPosition)
  useEffect(() => {
    if (!isAsio) return undefined;
    if (!isPlaying || !duration) {
      // En pausa, mostra la posició congelada; aturat, a zero
      if (pausedAt != null && duration) {
        const p = Math.min(pausedAt, duration);
        setState({ elapsed: p, duration, progress: p / duration });
      } else {
        setState({ elapsed: 0, duration, progress: 0 });
      }
      lastUpdateAsio.current = 0; // reinicia el throttle per al pròxim play
      return undefined;
    }
    // Primer tick: força actualització immediata (lastUpdate = 0)
    lastUpdateAsio.current = 0;
    let raf;
    const tick = () => {
      const now = performance.now();
      const pos = asioPosition(slotId);
      const e = pos != null ? Math.min(pos, duration) : 0;
      // Throttle: propaga l'estat React només si han passat prou ms
      if (now - lastUpdateAsio.current >= THROTTLE_MS) {
        lastUpdateAsio.current = now;
        setState({ elapsed: e, duration, progress: duration ? e / duration : 0 });
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [isAsio, isPlaying, duration, slotId, pausedAt]);

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
      lastUpdateStream.current = 0; // reinicia el throttle per al pròxim play
      return undefined;
    }
    // Primer tick: força actualització immediata (lastUpdate = 0)
    lastUpdateStream.current = 0;
    let raf;
    const tick = () => {
      const now = performance.now();
      const pos = csPosition(slotId);
      const e = pos != null ? Math.min(pos, duration) : 0;
      // Throttle: propaga l'estat React només si han passat prou ms
      if (now - lastUpdateStream.current >= THROTTLE_MS) {
        lastUpdateStream.current = now;
        setState({ elapsed: e, duration, progress: duration ? e / duration : 0 });
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [isStreaming, isPlaying, duration, pausedAt, slotId]);

  // Buffer/Web Audio: la posició es calcula a partir de audioContext.currentTime
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
      lastUpdateBuf.current = 0; // reinicia el throttle per al pròxim play
      return;
    }
    // Primer tick: força actualització immediata (lastUpdate = 0)
    lastUpdateBuf.current = 0;
    let raf;
    const tick = () => {
      const now = performance.now();
      let elapsed = audioContext.currentTime - startedAt;
      if (elapsed < 0) elapsed = 0;
      const e = elapsed % duration;              // plega en loop
      // Throttle: propaga l'estat React només si han passat prou ms
      if (now - lastUpdateBuf.current >= THROTTLE_MS) {
        lastUpdateBuf.current = now;
        setState({ elapsed: e, duration, progress: e / duration });
      }
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
