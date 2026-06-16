import { useState, useEffect } from 'react';
import { useSoundStore } from '../store/useSoundStore';

// Retorna el temps de reproducció d'un slot en temps real:
//   { elapsed, duration, progress }  (progress = 0..1)
// Mentre el slot sona, s'actualitza cada frame amb requestAnimationFrame.
// En mode continu (loop) el temps es plega amb el mòdul de la durada.
export function usePlaybackTime(slot) {
  const audioContext = useSoundStore((s) => s.audioContext);
  const duration = slot.audioBuffer ? slot.audioBuffer.duration : 0;
  const [state, setState] = useState({ elapsed: 0, duration, progress: 0 });

  useEffect(() => {
    if (!slot.isPlaying || !audioContext || !duration) {
      setState({ elapsed: 0, duration, progress: 0 });
      return;
    }

    let raf;
    const tick = () => {
      let elapsed = audioContext.currentTime - slot.startedAt;
      if (elapsed < 0) elapsed = 0;
      const e = elapsed % duration;              // plega en loop
      setState({ elapsed: e, duration, progress: e / duration });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [slot.isPlaying, slot.startedAt, audioContext, duration]);

  return state;
}

// Format mm:ss
export function fmtTime(seconds) {
  if (!isFinite(seconds) || seconds < 0) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}
