import { useEffect, useRef } from 'react';

// Colors de la forma d'ona
const WAVE_COLOR        = '#52525b'; // gris en repòs
const WAVE_COLOR_ACTIVE = '#3b82f6'; // accent (blau) quan el slot sona
const WAVE_BG           = '#141416';

// Dibuixa la forma d'ona estàtica d'un AudioBuffer dins d'un canvas que
// s'adapta a la mida del seu contenidor. Recalcula els pics per columna de
// píxel, de manera que sempre es veu nítid encara que canviï la mida.
export function Waveform({ audioBuffer, active }) {
  const canvasRef = useRef(null);
  const wrapRef   = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap   = wrapRef.current;
    if (!canvas || !wrap) return;
    const ctx = canvas.getContext('2d');

    const draw = () => {
      const dpr = window.devicePixelRatio || 1;
      const w = wrap.clientWidth;
      const h = wrap.clientHeight;
      if (w === 0 || h === 0) return;

      canvas.width  = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      // Fons
      ctx.fillStyle = WAVE_BG;
      ctx.fillRect(0, 0, w, h);

      if (!audioBuffer) return;

      // Un pic (min/max) per columna de píxel
      const buckets = Math.max(1, Math.floor(w));
      const channel = audioBuffer.getChannelData(0);
      const step    = Math.max(1, Math.floor(channel.length / buckets));
      const mid     = h / 2;

      ctx.strokeStyle = active ? WAVE_COLOR_ACTIVE : WAVE_COLOR;
      ctx.lineWidth   = 1;
      ctx.beginPath();
      for (let i = 0; i < buckets; i++) {
        let min = 1, max = -1;
        const start = i * step;
        const end   = Math.min(start + step, channel.length);
        for (let j = start; j < end; j++) {
          const v = channel[j];
          if (v < min) min = v;
          if (v > max) max = v;
        }
        const x = i + 0.5;
        ctx.moveTo(x, mid - max * mid);
        ctx.lineTo(x, mid - min * mid);
      }
      ctx.stroke();
    };

    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [audioBuffer, active]);

  return (
    <div ref={wrapRef} className="waveform-wrap">
      <canvas ref={canvasRef} className="waveform-canvas" />
    </div>
  );
}
