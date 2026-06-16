import { useEffect, useRef } from 'react';
import { drawWavePath } from '../lib/waveformDraw';

// Colors de la forma d'ona
const WAVE_COLOR        = '#52525b'; // gris en repòs
const WAVE_COLOR_ACTIVE = '#3b82f6'; // accent (blau) quan el slot sona
const WAVE_BG           = '#141416';

// Dibuixa la forma d'ona estàtica d'un AudioBuffer dins d'un canvas que
// s'adapta a la mida del seu contenidor. Si startRatio/stopRatio retallen el
// tram (0..1), enfosqueix la part exterior i marca els límits.
export function Waveform({ audioBuffer, active, startRatio = 0, stopRatio = 1 }) {
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

      ctx.fillStyle = WAVE_BG;
      ctx.fillRect(0, 0, w, h);

      if (!audioBuffer) return;

      const channel = audioBuffer.getChannelData(0);
      drawWavePath(ctx, channel, w, h, active ? WAVE_COLOR_ACTIVE : WAVE_COLOR);

      // Tram retallat: enfosqueix fora de [startRatio, stopRatio]
      if (startRatio > 0 || stopRatio < 1) {
        ctx.fillStyle = 'rgba(10, 10, 12, 0.55)';
        if (startRatio > 0) ctx.fillRect(0, 0, startRatio * w, h);
        if (stopRatio < 1)  ctx.fillRect(stopRatio * w, 0, (1 - stopRatio) * w, h);

        ctx.strokeStyle = 'rgba(244, 244, 245, 0.35)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(startRatio * w, 0); ctx.lineTo(startRatio * w, h);
        ctx.moveTo(stopRatio * w, 0);  ctx.lineTo(stopRatio * w, h);
        ctx.stroke();
      }
    };

    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [audioBuffer, active, startRatio, stopRatio]);

  return (
    <div ref={wrapRef} className="waveform-wrap">
      <canvas ref={canvasRef} className="waveform-canvas" />
    </div>
  );
}
