import { useEffect, useRef } from 'react';
import { asioLevel } from '../lib/asioTelemetry';

const VU_GREEN  = '#22c55e';
const VU_YELLOW = '#eab308';
const VU_RED    = '#ef4444';
const VU_BG     = '#0a0a0a';

// Escala en dBFS: −60 dB (silenci) → 0 dB (màxim). Llindars de color fixos
// (no depenen del senyal), per tant fiables:
//   verd fins −18 dB · groc −18…−6 dB · vermell per sobre de −6 dB
const DB_MIN     = -60;
const Y_THRESH   = (-18 - DB_MIN) / -DB_MIN; // 0.70
const R_THRESH   = (-6  - DB_MIN) / -DB_MIN; // 0.90

// Converteix una amplitud lineal (0..1) a posició normalitzada a l'escala dB
function toNorm(amp) {
  if (amp <= 1e-6) return 0;
  const db = 20 * Math.log10(amp);
  return Math.min(1, Math.max(0, (db - DB_MIN) / -DB_MIN));
}

function zoneColor(n) {
  if (n > R_THRESH) return VU_RED;
  if (n > Y_THRESH) return VU_YELLOW;
  return VU_GREEN;
}

// Picòmetre vertical (dues barres) amb balística realista: atac ràpid i
// caiguda lenta, més una marca de retenció de pic que decau amb retard.
// `asioId`: si el cue sona pel motor ASIO natiu (sense analyserNode), el nivell
// es llegeix de la telemetria nativa (asioLevel) en comptes del time-domain.
export function VuMeter({ analyserNode, isPlaying, asioId = null }) {
  const canvasRef = useRef(null);
  const wrapRef   = useRef(null);
  const rafRef    = useRef(null);
  const levelRef  = useRef(0);   // nivell mostrat (suavitzat)
  const peakRef   = useRef(0);   // marca de retenció de pic
  const peakAtRef = useRef(0);   // instant del darrer pic

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap   = wrapRef.current;
    if (!canvas || !wrap) return;
    const ctx = canvas.getContext('2d');
    const data = analyserNode ? new Float32Array(analyserNode.fftSize) : null;
    levelRef.current = 0;
    peakRef.current = 0;

    const fillZones = (x, w, h, level) => {
      // Verd
      const gTop = Math.min(level, Y_THRESH);
      if (gTop > 0) { ctx.fillStyle = VU_GREEN; ctx.fillRect(x, h - gTop * h, w, gTop * h); }
      // Groc
      if (level > Y_THRESH) {
        const yTop = Math.min(level, R_THRESH);
        ctx.fillStyle = VU_YELLOW;
        ctx.fillRect(x, h - yTop * h, w, (yTop - Y_THRESH) * h);
      }
      // Vermell
      if (level > R_THRESH) {
        ctx.fillStyle = VU_RED;
        ctx.fillRect(x, h - level * h, w, (level - R_THRESH) * h);
      }
    };

    const draw = () => {
      const dpr = window.devicePixelRatio || 1;
      const w = wrap.clientWidth;
      const h = wrap.clientHeight;

      if (w > 0 && h > 0) {
        const bw = Math.round(w * dpr);
        const bh = Math.round(h * dpr);
        if (canvas.width !== bw || canvas.height !== bh) { canvas.width = bw; canvas.height = bh; }
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

        ctx.fillStyle = VU_BG;
        ctx.fillRect(0, 0, w, h);

        // Nivell objectiu a partir de l'RMS i del pic instantani
        let target = 0, instPeak = 0;
        if (analyserNode && isPlaying && data) {
          analyserNode.getFloatTimeDomainData(data);
          let sum = 0, pk = 0;
          for (let i = 0; i < data.length; i++) {
            const v = data[i];
            sum += v * v;
            const a = Math.abs(v);
            if (a > pk) pk = a;
          }
          target = toNorm(Math.sqrt(sum / data.length));
          instPeak = toNorm(pk);
        } else if (asioId != null && isPlaying) {
          // Cue ASIO: nivell (pic lineal) per telemetria nativa. Sense forma
          // d'ona instantània: fem servir el mateix valor com a RMS i pic.
          const lin = asioLevel(asioId);
          target = toNorm(lin);
          instPeak = toNorm(lin);
        }

        // Balística: atac ràpid (puja de pressa), release lent (baixa a poc a poc)
        const L = levelRef.current;
        levelRef.current = target > L ? L + (target - L) * 0.5 : L + (target - L) * 0.10;

        // Retenció de pic: marca el màxim i el manté ~0.8s abans de decaure
        const now = performance.now();
        if (instPeak > peakRef.current) { peakRef.current = instPeak; peakAtRef.current = now; }
        else if (now - peakAtRef.current > 800) {
          peakRef.current = Math.max(levelRef.current, peakRef.current - 0.006);
        }

        const gap  = 2;
        const barW = (w - gap) / 2;
        const lvl  = levelRef.current;
        fillZones(0, barW, h, lvl);
        fillZones(barW + gap, barW, h, lvl);

        // Marca de pic (línia fina del color de la seva zona)
        const pk = peakRef.current;
        if (pk > 0.001) {
          const y = h - pk * h;
          ctx.fillStyle = zoneColor(pk);
          ctx.fillRect(0, y - 1, barW, 2);
          ctx.fillRect(barW + gap, y - 1, barW, 2);
        }
      }

      rafRef.current = requestAnimationFrame(draw);
    };

    rafRef.current = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(rafRef.current);
  }, [analyserNode, isPlaying, asioId]);

  return (
    <div ref={wrapRef} className="vu-wrap">
      <canvas ref={canvasRef} className="vu-canvas" />
    </div>
  );
}
