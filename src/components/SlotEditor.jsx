import { useEffect, useRef, useState } from 'react';
import { useSoundStore } from '../store/useSoundStore';
import { drawWavePath } from '../lib/waveformDraw';
import { CUE_COLORS } from '../lib/colors';
import { hasClip, slotDuration } from '../lib/slotAudio';
import { usePlaybackTime, fmtTime } from '../hooks/usePlaybackTime';

const BG          = '#141416';
const WAVE_COLOR  = '#6b7280';
const ACCENT      = '#3b82f6';
const DIM         = 'rgba(10, 10, 12, 0.6)';
const HANDLE_HIT  = 8; // marge en px per agafar un marcador

export function SlotEditor() {
  const editingSlot    = useSoundStore((s) => s.editingSlot);
  const slot           = useSoundStore((s) =>
    s.editingSlot ? s.slots.find((x) => x.id === s.editingSlot) : null
  );
  const setEditingSlot = useSoundStore((s) => s.setEditingSlot);
  const updateSlotEdit = useSoundStore((s) => s.updateSlotEdit);
  const setLoop        = useSoundStore((s) => s.setLoop);
  const setColor       = useSoundStore((s) => s.setColor);
  const seekSlot       = useSoundStore((s) => s.seekSlot);
  const playSlot       = useSoundStore((s) => s.playSlot);
  const stopSlot       = useSoundStore((s) => s.stopSlot);

  const canvasRef = useRef(null);
  const wrapRef   = useRef(null);
  const rulerRef  = useRef(null);
  const [dragging, setDragging] = useState(null); // 'start' | 'stop' | 'playhead' | null
  const [playScrub, setPlayScrub] = useState(null); // ratio dins segment mentre s'arrossega el playhead
  const playScrubRef = useRef(null);
  const [zoom, setZoom] = useState(1); // 1× = tot el buffer; 2/4/8× amplia amb scroll

  // Posició de reproducció (per la línia de playhead estil DAW)
  const { progress } = usePlaybackTime(slot);

  const hasAudio = hasClip(slot);
  const isStreaming = slot && slot.isStreaming;
  const total    = hasAudio ? slotDuration(slot) : 0;
  const start    = hasAudio ? Math.max(0, slot.startPoint || 0) : 0;
  const stop     = hasAudio ? (slot.stopPoint ?? total) : 0;
  const fadeIn   = hasAudio ? (slot.fadeIn || 0) : 0;
  const fadeOut  = hasAudio ? (slot.fadeOut || 0) : 0;
  const segDur   = Math.max(0, stop - start);

  // ─── Dibuix del canvas ───
  useEffect(() => {
    if (!hasAudio) return;
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

      ctx.fillStyle = BG;
      ctx.fillRect(0, 0, w, h);

      const data = slot.audioBuffer ? slot.audioBuffer.getChannelData(0) : slot.peaks;
      if (data) {
        drawWavePath(ctx, data, w, h, WAVE_COLOR);
      } else {
        // Streaming sense pics encara: línia central + avís
        ctx.strokeStyle = WAVE_COLOR;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, h / 2 + 0.5);
        ctx.lineTo(w, h / 2 + 0.5);
        ctx.stroke();
        ctx.fillStyle = '#52525b';
        ctx.font = '11px "JetBrains Mono", monospace';
        ctx.textBaseline = 'middle';
        ctx.fillText('STREAMING — generant forma d\'ona…', 10, h / 2 - 12);
      }

      const xStart = (start / total) * w;
      const xStop  = (stop / total) * w;

      // Enfosqueix fora del segment
      ctx.fillStyle = DIM;
      ctx.fillRect(0, 0, xStart, h);
      ctx.fillRect(xStop, 0, w - xStop, h);

      // Rampes de fade (línies des de baix→dalt a l'inici, dalt→baix al final)
      ctx.strokeStyle = 'rgba(59, 130, 246, 0.8)';
      ctx.lineWidth = 1.5;
      if (fadeIn > 0) {
        const xIn = ((start + Math.min(fadeIn, segDur)) / total) * w;
        ctx.beginPath();
        ctx.moveTo(xStart, h);
        ctx.lineTo(xIn, 0);
        ctx.stroke();
      }
      if (fadeOut > 0) {
        const xOut = ((stop - Math.min(fadeOut, segDur)) / total) * w;
        ctx.beginPath();
        ctx.moveTo(xOut, 0);
        ctx.lineTo(xStop, h);
        ctx.stroke();
      }

      // Marcadors inici/stop
      ctx.strokeStyle = ACCENT;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(xStart, 0); ctx.lineTo(xStart, h);
      ctx.moveTo(xStop, 0);  ctx.lineTo(xStop, h);
      ctx.stroke();

      // Petits tiradors a dalt
      ctx.fillStyle = ACCENT;
      ctx.fillRect(xStart - 3, 0, 6, 8);
      ctx.fillRect(xStop - 3, 0, 6, 8);
    };

    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [hasAudio, slot, total, start, stop, fadeIn, fadeOut, segDur]);

  // ─── Regla de temps (ticks + etiquetes mm:ss) ───
  useEffect(() => {
    if (!hasAudio) return;
    const canvas = rulerRef.current;
    const host   = canvas && canvas.parentElement;
    if (!canvas || !host) return;
    const ctx = canvas.getContext('2d');

    const draw = () => {
      const dpr = window.devicePixelRatio || 1;
      const w = host.clientWidth;
      const h = host.clientHeight;
      if (w === 0 || h === 0 || total === 0) return;
      canvas.width  = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      ctx.fillStyle = '#1b1b1e';
      ctx.fillRect(0, 0, w, h);

      // Tria un interval de tick que deixi ~55px entre marques
      const pxPerSec = w / total;
      const candidates = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
      let interval = candidates[candidates.length - 1];
      for (const c of candidates) { if (c * pxPerSec >= 55) { interval = c; break; } }

      ctx.strokeStyle = 'rgba(244, 244, 245, 0.22)';
      ctx.fillStyle = '#71717a';
      ctx.font = '9px "JetBrains Mono", monospace';
      ctx.textBaseline = 'bottom';
      ctx.lineWidth = 1;
      for (let t = 0; t <= total + 1e-6; t += interval) {
        const x = (t / total) * w;
        ctx.beginPath();
        ctx.moveTo(x + 0.5, h - 6);
        ctx.lineTo(x + 0.5, h);
        ctx.stroke();
        const lbl = interval < 1 ? `${t.toFixed(1)}s` : fmtTime(t);
        ctx.fillText(lbl, x + 3, h - 5);
      }
    };

    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(host);
    return () => ro.disconnect();
  }, [hasAudio, total, slot]);

  // ─── Accions i conversió (funcions normals, no hooks) ───
  const handleClose = () => {
    stopSlot(editingSlot);
    useSoundStore.getState().persistSlots(); // desa les edicions del cue
    setEditingSlot(null);
  };

  const handleReset = () => {
    updateSlotEdit(editingSlot, {
      startPoint: 0, stopPoint: null, fadeIn: 0, fadeOut: 0,
    });
  };

  const xToTime = (clientX) => {
    const wrap = wrapRef.current;
    if (!wrap) return 0;
    const rect = wrap.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    return ratio * total;
  };

  // ─── Tancar amb Escape ───
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') handleClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingSlot]);

  // ─── Drag dels marcadors inici/stop i del playhead ───
  useEffect(() => {
    if (!dragging) return;
    const onMove = (e) => {
      const t = xToTime(e.clientX);
      if (dragging === 'start') {
        const ns = Math.min(t, stop - 0.05);
        updateSlotEdit(editingSlot, { startPoint: Math.max(0, ns) });
      } else if (dragging === 'stop') {
        const ne = Math.max(t, start + 0.05);
        updateSlotEdit(editingSlot, { stopPoint: Math.min(total, ne) });
      } else if (dragging === 'playhead') {
        // Ratio dins el segment (salt en deixar anar)
        const r = segDur > 0 ? Math.min(1, Math.max(0, (t - start) / segDur)) : 0;
        playScrubRef.current = r;
        setPlayScrub(r);
      }
    };
    const onUp = () => {
      if (dragging === 'playhead') {
        const v = playScrubRef.current;
        playScrubRef.current = null;
        setPlayScrub(null);
        if (v != null) seekSlot(editingSlot, v);
      }
      setDragging(null);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dragging, start, stop, total, segDur, editingSlot]);

  // Tots els hooks han quedat per sobre d'aquest punt
  if (!editingSlot || !hasAudio) return null;

  const handlePointerDown = (e) => {
    const rect = wrapRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const xStart = (start / total) * rect.width;
    const xStop  = (stop / total) * rect.width;
    // Agafa el marcador més proper si el clic hi és a prop
    if (Math.abs(x - xStart) <= HANDLE_HIT) setDragging('start');
    else if (Math.abs(x - xStop) <= HANDLE_HIT) setDragging('stop');
    else if (x < xStart) setDragging('start');
    else if (x > xStop) setDragging('stop');
    else setDragging(Math.abs(x - xStart) < Math.abs(x - xStop) ? 'start' : 'stop');
  };

  const label = slot.label || `Slot ${editingSlot}`;

  // Posició del playhead (0..1 dins el segment → fracció del buffer sencer)
  const headRatio = playScrub != null ? playScrub : progress;
  const playheadPct = total
    ? ((start + Math.min(1, Math.max(0, headRatio)) * segDur) / total) * 100
    : 0;
  const showPlayhead = slot.isPlaying || playScrub != null;

  return (
    <div className="editor-overlay" onClick={handleClose}>
      <div className="editor-panel" onClick={(e) => e.stopPropagation()}>
        <div className="editor-header">
          <span className="editor-title">{label}</span>
          <button className="editor-close" onClick={handleClose}>✕</button>
        </div>

        <div className="editor-wave-toolbar">
          <span className="editor-zoom-label">Zoom {zoom}×</span>
          <button
            className="editor-zoom-btn"
            onClick={() => setZoom((z) => Math.max(1, z / 2))}
            disabled={zoom <= 1}
            title="Allunya"
          >−</button>
          <button
            className="editor-zoom-btn"
            onClick={() => setZoom((z) => Math.min(8, z * 2))}
            disabled={zoom >= 8}
            title="Apropa"
          >+</button>
          <button
            className="editor-zoom-btn"
            onClick={() => setZoom(1)}
            disabled={zoom === 1}
            title="Ajusta a tot"
          >Fit</button>
        </div>

        <div className="editor-wave-scroll">
          <div className="editor-wave-inner" style={{ width: `${zoom * 100}%` }}>
            <div className="editor-ruler">
              <canvas ref={rulerRef} className="editor-ruler-canvas" />
            </div>
            <div
              ref={wrapRef}
              className="editor-wave"
              onPointerDown={handlePointerDown}
            >
              <canvas ref={canvasRef} className="editor-canvas" />
              {showPlayhead && (
                <div
                  className="editor-playhead"
                  style={{ left: `${playheadPct}%` }}
                  onPointerDown={(e) => { e.stopPropagation(); setDragging('playhead'); }}
                />
              )}
            </div>
          </div>
        </div>

        <div className="editor-times">
          <span>Inici: <b>{fmtTime(start)}</b></span>
          <span>Stop: <b>{fmtTime(stop)}</b></span>
          <span>Durada: <b>{fmtTime(segDur)}</b></span>
        </div>

        <div className="editor-options">
          <label className="editor-check">
            <input
              type="checkbox"
              checked={!!slot.stopOthers}
              onChange={(e) => updateSlotEdit(editingSlot, { stopOthers: e.target.checked })}
            />
            Stop others (talla la resta de cues en disparar)
          </label>
          <label className="editor-check">
            <input
              type="checkbox"
              checked={!slot.useGlobalFades}
              onChange={(e) => updateSlotEdit(editingSlot, { useGlobalFades: !e.target.checked })}
            />
            Fades propis (override dels globals)
          </label>
        </div>

        <div className="editor-colors">
          <span className="editor-colors-label">Color</span>
          <button
            className={`color-swatch none ${!slot.color ? 'active' : ''}`}
            onClick={() => setColor(editingSlot, null)}
            title="Sense color"
          >✕</button>
          {CUE_COLORS.map((c) => (
            <button
              key={c.value}
              className={`color-swatch ${slot.color === c.value ? 'active' : ''}`}
              style={{ background: c.value }}
              onClick={() => setColor(editingSlot, c.value)}
              title={c.name}
            />
          ))}
        </div>

        <div className="editor-fades">
          {slot.useGlobalFades ? (
            <div className="editor-fades-note">
              Usant els <b>fades globals</b>. Activa «Fades propis» per definir-los aquí.
            </div>
          ) : (
            <>
              <label>
                <span>Fade in: {fadeIn.toFixed(2)}s</span>
                <input
                  type="range" min="0" max={Math.max(0.1, segDur)} step="0.05"
                  value={Math.min(fadeIn, segDur)}
                  onChange={(e) => updateSlotEdit(editingSlot, { fadeIn: parseFloat(e.target.value) })}
                />
              </label>
              <label>
                <span>Fade out: {fadeOut.toFixed(2)}s</span>
                <input
                  type="range" min="0" max={Math.max(0.1, segDur)} step="0.05"
                  value={Math.min(fadeOut, segDur)}
                  onChange={(e) => updateSlotEdit(editingSlot, { fadeOut: parseFloat(e.target.value) })}
                />
              </label>
            </>
          )}
        </div>

        <div className="editor-actions">
          <button
            className={`editor-btn toggle ${slot.loop ? 'active' : ''}`}
            onClick={() => setLoop(editingSlot, !slot.loop)}
            title="Repeteix aquest slot en bucle"
          >
            ⟳ Loop
          </button>
          <span className="editor-actions-spacer" />
          <button className="editor-btn primary" onClick={() => playSlot(editingSlot)}>▶ Preview</button>
          <button className="editor-btn" onClick={() => stopSlot(editingSlot, true)}>■ Stop</button>
          <button className="editor-btn" onClick={handleReset}>Reset</button>
          <button className="editor-btn" onClick={handleClose}>Tancar</button>
        </div>
      </div>
    </div>
  );
}
