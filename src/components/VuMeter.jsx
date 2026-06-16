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

// Picòmetre vertical (L + R) que omple el seu contenidor. Les barres creixen
// de baix cap a dalt i s'animen via requestAnimationFrame mentre el slot sona.
export function VuMeter({ analyserNode, isPlaying }) {
  const canvasRef = useRef(null);
  const wrapRef   = useRef(null);
  const rafRef    = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap   = wrapRef.current;
    if (!canvas || !wrap) return;
    const ctx = canvas.getContext('2d');
    const dataArray = analyserNode
      ? new Uint8Array(analyserNode.frequencyBinCount)
      : null;

    const draw = () => {
      const dpr = window.devicePixelRatio || 1;
      const w = wrap.clientWidth;
      const h = wrap.clientHeight;

      if (w > 0 && h > 0) {
        const bw = Math.round(w * dpr);
        const bh = Math.round(h * dpr);
        if (canvas.width !== bw || canvas.height !== bh) {
          canvas.width = bw;
          canvas.height = bh;
        }
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

        ctx.fillStyle = VU_BG;
        ctx.fillRect(0, 0, w, h);

        if (analyserNode && isPlaying) {
          analyserNode.getByteTimeDomainData(dataArray);
          const n    = dataArray.length;
          const half = Math.floor(n / 2);

          // RMS com a proxy de L i R (mono → simulem dos canals)
          let sumL = 0, sumR = 0;
          for (let i = 0; i < half; i++) {
            const v = (dataArray[i] - 128) / 128;
            sumL += v * v;
          }
          for (let i = half; i < n; i++) {
            const v = (dataArray[i] - 128) / 128;
            sumR += v * v;
          }
          const fillL = Math.min(Math.sqrt(sumL / half) * 4, 1);
          const fillR = Math.min(Math.sqrt(sumR / half) * 4, 1);

          const gap  = 2;
          const barW = (w - gap) / 2;
          const hL   = fillL * h;
          const hR   = fillR * h;

          ctx.fillStyle = levelColor(fillL);
          ctx.fillRect(0, h - hL, barW, hL);

          ctx.fillStyle = levelColor(fillR);
          ctx.fillRect(barW + gap, h - hR, barW, hR);
        }
      }

      rafRef.current = requestAnimationFrame(draw);
    };

    rafRef.current = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(rafRef.current);
  }, [analyserNode, isPlaying]);

  return (
    <div ref={wrapRef} className="vu-wrap">
      <canvas ref={canvasRef} className="vu-canvas" />
    </div>
  );
}
