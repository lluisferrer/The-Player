import { useEffect, useRef } from 'react';

const VU_GREEN  = '#22c55e';
const VU_YELLOW = '#eab308';
const VU_RED    = '#ef4444';
const VU_BG     = '#0a0a0a';

function levelColor(ratio) {
  if (ratio > 0.85) return VU_RED;
  if (ratio > 0.6)  return VU_YELLOW;
  return VU_GREEN;
}

export function VuMeter({ analyserNode, isPlaying }) {
  const canvasRef = useRef(null);
  const rafRef    = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');

    const draw = () => {
      const { width, height } = canvas;
      ctx.fillStyle = VU_BG;
      ctx.fillRect(0, 0, width, height);

      if (!analyserNode || !isPlaying) {
        rafRef.current = requestAnimationFrame(draw);
        return;
      }

      const bufferLength = analyserNode.frequencyBinCount;
      const dataArray    = new Uint8Array(bufferLength);
      analyserNode.getByteTimeDomainData(dataArray);

      // Calcula RMS com a proxy de L i R (mono — usem meitat del buffer per cada canal simulat)
      const half = Math.floor(bufferLength / 2);

      let sumL = 0, sumR = 0;
      for (let i = 0; i < half; i++) {
        const v = (dataArray[i] - 128) / 128;
        sumL += v * v;
      }
      for (let i = half; i < bufferLength; i++) {
        const v = (dataArray[i] - 128) / 128;
        sumR += v * v;
      }

      const rmsL = Math.sqrt(sumL / half);
      const rmsR = Math.sqrt(sumR / half);

      const barW  = Math.floor(width / 2) - 2;
      const fillL = Math.min(rmsL * 4, 1);
      const fillR = Math.min(rmsR * 4, 1);

      // Canal L
      const hL = fillL * height;
      ctx.fillStyle = levelColor(fillL);
      ctx.fillRect(0, height - hL, barW, hL);

      // Canal R
      const hR = fillR * height;
      ctx.fillStyle = levelColor(fillR);
      ctx.fillRect(barW + 2, height - hR, barW, hR);

      rafRef.current = requestAnimationFrame(draw);
    };

    rafRef.current = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(rafRef.current);
  }, [analyserNode, isPlaying]);

  return (
    <canvas
      ref={canvasRef}
      width={36}
      height={48}
      style={{ display: 'block', borderRadius: 2 }}
    />
  );
}
