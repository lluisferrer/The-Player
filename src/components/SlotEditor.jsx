import { useEffect, useRef, useState } from 'react';
import { convertFileSrc } from '@tauri-apps/api/core';
import { useSoundStore } from '../store/useSoundStore';
import { drawWavePathRange } from '../lib/waveformDraw';
import { CUE_COLORS } from '../lib/colors';
import { hasClip, isVideo, isImage, slotDuration } from '../lib/slotAudio';
import { usePlaybackTime, fmtTime } from '../hooks/usePlaybackTime';
import { PlaylistActionToggle } from './PlaylistActionToggle';

const BG          = '#141416';
const WAVE_COLOR  = '#6b7280';
const ACCENT      = '#3b82f6';
const DIM         = 'rgba(10, 10, 12, 0.6)';
const HANDLE_HIT  = 8;     // marge en px per agafar un marcador
const MAX_ZOOM    = 512;   // amplia molt (viewport, sense ampliar el canvas)
const FADE_MAX    = 30;    // sostre del slider de fade (s); el camp numèric cobreix valors majors

export function SlotEditor() {
  const editingSlot    = useSoundStore((s) => s.editingSlot);
  const slot           = useSoundStore((s) =>
    s.editingSlot ? s.slots.find((x) => x.id === s.editingSlot) : null
  );
  const globalFadeIn   = useSoundStore((s) => s.globalFadeIn);
  const globalFadeOut  = useSoundStore((s) => s.globalFadeOut);
  const setEditingSlot = useSoundStore((s) => s.setEditingSlot);
  const updateSlotEdit = useSoundStore((s) => s.updateSlotEdit);
  const setLoop        = useSoundStore((s) => s.setLoop);
  const setColor       = useSoundStore((s) => s.setColor);
  const setPlaylistAction = useSoundStore((s) => s.setPlaylistAction);
  const duckEnabled    = useSoundStore((s) => s.duckEnabled);
  const seekSlot       = useSoundStore((s) => s.seekSlot);
  const playSlot       = useSoundStore((s) => s.playSlot);
  const stopSlot       = useSoundStore((s) => s.stopSlot);

  const canvasRef = useRef(null);
  const wrapRef   = useRef(null);
  const rulerRef  = useRef(null);
  const videoRef  = useRef(null);   // <video> de previsualització (cues de vídeo)
  const [dragging, setDragging] = useState(null); // 'start' | 'stop' | 'playhead' | null
  const [playScrub, setPlayScrub] = useState(null);
  const playScrubRef = useRef(null);
  // Previsualització del vídeo a l'editor (independent de la sortida)
  const [vidPlaying, setVidPlaying] = useState(false);
  const [vidTime, setVidTime] = useState(0); // segon actual del <video> de preview
  // Evita que el click sintètic en deixar anar el playhead fora del panell tanqui l'editor
  const suppressCloseRef = useRef(false);

  // Zoom de viewport: 'zoom' = factor, 'view' = rati (0..1) del marge esquerre
  const [zoom, setZoom] = useState(1);
  const [view, setView] = useState(0);

  const { progress } = usePlaybackTime(slot);

  const hasAudio = hasClip(slot);
  const isVid    = isVideo(slot);
  const isImg    = isImage(slot);
  const total    = hasAudio ? slotDuration(slot) : 0;
  const start    = hasAudio ? Math.max(0, slot.startPoint || 0) : 0;
  const stop     = hasAudio ? (slot.stopPoint ?? total) : 0;
  // Override propi del fade (null = segueix el global). Distingim null de 0
  // perquè es pugui forçar un tall sec (0 s) encara que el global no sigui 0.
  const fadeInOv  = hasAudio ? (slot.fadeIn ?? null) : null;
  const fadeOutOv = hasAudio ? (slot.fadeOut ?? null) : null;
  // Valor efectiu: el propi si està definit, si no el global
  const fadeIn   = fadeInOv  != null ? fadeInOv  : globalFadeIn;
  const fadeOut  = fadeOutOv != null ? fadeOutOv : globalFadeOut;
  const segDur   = Math.max(0, stop - start);
  // Límit dels fades: el segment per a àudio/vídeo; per a imatge (sense durada)
  // no hi ha segment, així que es permet fins a FADE_MAX.
  const fadeCap  = isImg ? FADE_MAX : segDur;

  // Finestra visible (en ratis del fitxer sencer)
  const span     = Math.min(1, 1 / zoom);
  const viewMax  = Math.max(0, 1 - span);
  const viewClamped = Math.min(view, viewMax);

  // Conversió temps ↔ x (px dins el canvas, segons la finestra visible)
  const tToX = (t, w) => ((t / total) - viewClamped) * zoom * w;

  // ─── Dibuix de la forma d'ona ───
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
      if (w === 0 || h === 0 || total === 0) return;
      canvas.width  = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      if (isVid || isImg) {
        // Cue visual: el canvas és transparent (només marcadors/fades). El vídeo
        // mostra el <video> de previsualització a sota; la imatge no té timeline.
      } else {
        ctx.fillStyle = BG;
        ctx.fillRect(0, 0, w, h);

        const data = slot.audioBuffer ? slot.audioBuffer.getChannelData(0) : slot.peaks;
        if (data && data.length) {
          const len = data.length;
          const a = viewClamped * len;
          const b = (viewClamped + span) * len;
          drawWavePathRange(ctx, data, a, b, w, h, WAVE_COLOR);
        } else {
          // Streaming sense pics encara
          ctx.strokeStyle = WAVE_COLOR;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(0, h / 2 + 0.5); ctx.lineTo(w, h / 2 + 0.5);
          ctx.stroke();
          ctx.fillStyle = '#52525b';
          ctx.font = '11px "JetBrains Mono", monospace';
          ctx.textBaseline = 'middle';
          ctx.fillText('STREAMING — generating waveform…', 10, h / 2 - 12);
        }
      }

      const xStart = tToX(start, w);
      const xStop  = tToX(stop, w);

      // Enfosqueix fora del segment (clampat a la finestra)
      ctx.fillStyle = DIM;
      const xs = Math.max(0, Math.min(xStart, w));
      const xe = Math.max(0, Math.min(xStop, w));
      if (xs > 0) ctx.fillRect(0, 0, xs, h);
      if (xe < w) ctx.fillRect(xe, 0, w - xe, h);

      // Rampes de fade efectives (ja calculades amunt: pròpia o global)
      const effIn  = fadeIn;
      const effOut = fadeOut;
      ctx.strokeStyle = 'rgba(59, 130, 246, 0.8)';
      ctx.lineWidth = 1.5;
      if (effIn > 0) {
        const xIn = tToX(start + Math.min(effIn, segDur), w);
        ctx.beginPath(); ctx.moveTo(xStart, h); ctx.lineTo(xIn, 0); ctx.stroke();
      }
      if (effOut > 0) {
        const xOut = tToX(stop - Math.min(effOut, segDur), w);
        ctx.beginPath(); ctx.moveTo(xOut, 0); ctx.lineTo(xStop, h); ctx.stroke();
      }

      // Marcadors inici/stop (si són dins la finestra)
      ctx.strokeStyle = ACCENT;
      ctx.lineWidth = 2;
      ctx.beginPath();
      if (xStart >= 0 && xStart <= w) { ctx.moveTo(xStart, 0); ctx.lineTo(xStart, h); }
      if (xStop >= 0 && xStop <= w)   { ctx.moveTo(xStop, 0);  ctx.lineTo(xStop, h); }
      ctx.stroke();
      ctx.fillStyle = ACCENT;
      if (xStart >= 0 && xStart <= w) ctx.fillRect(xStart - 3, 0, 6, 8);
      if (xStop >= 0 && xStop <= w)   ctx.fillRect(xStop - 3, 0, 6, 8);
    };

    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [hasAudio, isVid, slot, total, start, stop, fadeIn, fadeOut, segDur, zoom, viewClamped, span, globalFadeIn, globalFadeOut]);

  // ─── Regla de temps (finestra visible) ───
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

      const t0 = viewClamped * total;
      const t1 = (viewClamped + span) * total;
      const visDur = Math.max(1e-6, t1 - t0);
      const pxPerSec = w / visDur;
      const candidates = [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
      let interval = candidates[candidates.length - 1];
      for (const c of candidates) { if (c * pxPerSec >= 55) { interval = c; break; } }

      ctx.strokeStyle = 'rgba(244, 244, 245, 0.22)';
      ctx.fillStyle = '#71717a';
      ctx.font = '9px "JetBrains Mono", monospace';
      ctx.textBaseline = 'bottom';
      ctx.lineWidth = 1;
      const first = Math.ceil(t0 / interval) * interval;
      for (let t = first; t <= t1 + 1e-6; t += interval) {
        const x = ((t - t0) / visDur) * w;
        ctx.beginPath();
        ctx.moveTo(x + 0.5, h - 6);
        ctx.lineTo(x + 0.5, h);
        ctx.stroke();
        const lbl = interval < 1 ? `${t.toFixed(2)}s` : fmtTime(t);
        ctx.fillText(lbl, x + 3, h - 5);
      }
    };

    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(host);
    return () => ro.disconnect();
  }, [hasAudio, total, slot, zoom, viewClamped, span]);

  // ─── Accions ───
  const handleClose = () => {
    if (suppressCloseRef.current) return;
    // No aturem el cue en tancar l'editor: si sonava (preview), continua sonant.
    useSoundStore.getState().persistSlots();
    setEditingSlot(null);
  };

  const handleReset = () => {
    // fadeIn/fadeOut a null = tornen a seguir el fade global
    updateSlotEdit(editingSlot, { startPoint: 0, stopPoint: null, fadeIn: null, fadeOut: null });
  };

  const xToTime = (clientX) => {
    const wrap = wrapRef.current;
    if (!wrap) return 0;
    const rect = wrap.getBoundingClientRect();
    const f = (clientX - rect.left) / rect.width;       // 0..1 dins la finestra
    const ratio = viewClamped + f * span;               // rati del fitxer sencer
    return Math.min(1, Math.max(0, ratio)) * total;
  };

  // Zoom centrat en un punt (rati 0..1 del fitxer)
  const zoomAt = (factor, anchorRatio) => {
    const nz = Math.min(MAX_ZOOM, Math.max(1, zoom * factor));
    const nspan = Math.min(1, 1 / nz);
    let nview = anchorRatio - (anchorRatio - viewClamped) * (nspan / span);
    nview = Math.min(Math.max(0, nview), Math.max(0, 1 - nspan));
    setZoom(nz);
    setView(nview);
  };

  const handleWheel = (e) => {
    if (!hasAudio) return;
    e.preventDefault();
    const wrap = wrapRef.current;
    const rect = wrap.getBoundingClientRect();
    const f = (e.clientX - rect.left) / rect.width;
    const anchor = viewClamped + f * span;
    zoomAt(e.deltaY < 0 ? 1.3 : 1 / 1.3, anchor);
  };

  const fitZoom = () => { setZoom(1); setView(0); };

  // ─── Tancar amb Escape ───
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') handleClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingSlot]);

  // ─── Drag dels marcadors i del playhead ───
  useEffect(() => {
    if (!dragging) return;
    const onMove = (e) => {
      const t = xToTime(e.clientX);
      if (dragging === 'start') {
        const ns = Math.max(0, Math.min(t, stop - 0.05));
        updateSlotEdit(editingSlot, { startPoint: ns });
        // Scrub del vídeo: mostra el fotograma del punt d'inici mentre s'arrossega
        if (isVid && videoRef.current) { try { videoRef.current.currentTime = Math.min(total, ns); } catch { /* res */ } }
      } else if (dragging === 'stop') {
        const ne = Math.min(total, Math.max(t, start + 0.05));
        updateSlotEdit(editingSlot, { stopPoint: ne });
        if (isVid && videoRef.current) { try { videoRef.current.currentTime = ne; } catch { /* res */ } }
      } else if (dragging === 'playhead') {
        const r = segDur > 0 ? Math.min(1, Math.max(0, (t - start) / segDur)) : 0;
        playScrubRef.current = r;
        setPlayScrub(r);
        // Scrubbing del vídeo de previsualització: mou el currentTime en directe
        if (isVid && videoRef.current) {
          try { videoRef.current.currentTime = Math.min(total, Math.max(0, t)); }
          catch { /* el vídeo encara no està a punt */ }
        }
      }
    };
    const onUp = (e) => {
      if (dragging === 'playhead') {
        // Només fa el salt si es deixa anar dins del rectangle de l'ona;
        // si es deixa anar fora, cancel·la (no salta ni atura)
        const wrap = wrapRef.current;
        let inside = false;
        if (wrap) {
          const r = wrap.getBoundingClientRect();
          inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
        }
        const v = playScrubRef.current;
        playScrubRef.current = null;
        setPlayScrub(null);
        if (inside && v != null) seekSlot(editingSlot, v);
        // Bloqueja el click que l'overlay rebria en deixar anar fora del panell
        suppressCloseRef.current = true;
        setTimeout(() => { suppressCloseRef.current = false; }, 0);
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
  }, [dragging, isVid, start, stop, total, segDur, editingSlot, viewClamped, span, zoom]);

  // ─── Sincronització del <video> de previsualització ───
  useEffect(() => {
    if (!isVid) return;
    const v = videoRef.current;
    if (!v) return;
    const onTime  = () => {
      setVidTime(v.currentTime || 0);
      // Atura la previsualització en arribar al punt de stop del clip
      if (!v.paused && v.currentTime >= stop) { try { v.pause(); } catch { /* res */ } }
    };
    const onPlay  = () => setVidPlaying(true);
    const onPause = () => setVidPlaying(false);
    v.addEventListener('timeupdate', onTime);
    v.addEventListener('play', onPlay);
    v.addEventListener('pause', onPause);
    v.addEventListener('ended', onPause);
    return () => {
      v.removeEventListener('timeupdate', onTime);
      v.removeEventListener('play', onPlay);
      v.removeEventListener('pause', onPause);
      v.removeEventListener('ended', onPause);
    };
  }, [isVid, editingSlot, start, stop]);

  // En canviar de slot, reseteja l'estat del playhead del vídeo (evita que es
  // dibuixi a la posició del slot anterior) i atura la previsualització.
  useEffect(() => {
    setVidTime(0);
    setVidPlaying(false);
    return () => { try { videoRef.current && videoRef.current.pause(); } catch { /* res */ } };
  }, [editingSlot]);

  // Mou el <video> de previsualització a un temps (per fer scrub en ajustar fades)
  const seekEditorVideo = (t) => {
    if (isVid && videoRef.current) {
      try { videoRef.current.currentTime = Math.max(0, Math.min(total, t)); } catch { /* res */ }
    }
  };

  const toggleVideoPreview = () => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) {
      // Comença pel punt d'inici si estem fora del segment (o al final)
      if (v.currentTime < start || v.currentTime >= stop - 0.05) {
        try { v.currentTime = start; } catch { /* res */ }
      }
      v.play().catch(() => { /* autoplay bloquejat */ });
    } else v.pause();
  };

  if (!editingSlot || !hasAudio) return null;

  const handlePointerDown = (e) => {
    const rect = wrapRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const w = rect.width;
    const xStart = tToX(start, w);
    const xStop  = tToX(stop, w);
    if (Math.abs(x - xStart) <= HANDLE_HIT) setDragging('start');
    else if (Math.abs(x - xStop) <= HANDLE_HIT) setDragging('stop');
    else if (x < xStart) setDragging('start');
    else if (x > xStop) setDragging('stop');
    else setDragging(Math.abs(x - xStart) < Math.abs(x - xStop) ? 'start' : 'stop');
  };

  const label = slot.label || `Slot ${editingSlot}`;
  // Nom de fitxer (fallback si no hi ha nom custom)
  const fileName = slot.filePath ? slot.filePath.split(/[\\/]/).pop() : '';

  // Posició del playhead. Per a vídeo es deriva del temps real del <video> de
  // preview (segons absoluts); per a àudio, del progrés dins el segment.
  const headRatio = playScrub != null ? playScrub : progress;
  const playheadTime = isVid
    ? (playScrub != null ? start + Math.min(1, Math.max(0, playScrub)) * segDur : vidTime)
    : start + Math.min(1, Math.max(0, headRatio)) * segDur;
  const playheadPct = total ? (((playheadTime / total) - viewClamped) / span) * 100 : 0;
  const showPlayhead = isVid
    ? (vidPlaying || playScrub != null) && playheadPct >= 0 && playheadPct <= 100
    : (slot.isPlaying || playScrub != null) && playheadPct >= 0 && playheadPct <= 100;

  // Posició del scrollbar de pan (0..1)
  const scrollPos = viewMax > 0 ? viewClamped / viewMax : 0;

  return (
    <div className="editor-overlay" onClick={handleClose}>
      <div className="editor-panel" onClick={(e) => e.stopPropagation()}>
        <div className="editor-header">
          <input
            className="editor-title-input"
            value={slot.label || ''}
            placeholder={fileName || 'Cue name'}
            onChange={(e) => updateSlotEdit(editingSlot, { label: e.target.value })}
            onBlur={(e) => { if (!e.target.value.trim() && fileName) updateSlotEdit(editingSlot, { label: fileName }); }}
            title="Cue name (empty = file name)"
          />
          <button className="editor-close" onClick={handleClose}>✕</button>
        </div>

        <div className="editor-wave-toolbar">
          <span className="editor-zoom-label">
            Zoom {zoom < 10 ? zoom.toFixed(1) : Math.round(zoom)}× · window {fmtTime(span * total)}
          </span>
          <button className="editor-zoom-btn" onClick={() => zoomAt(1 / 2, viewClamped + span / 2)} disabled={zoom <= 1} title="Zoom out">−</button>
          <button className="editor-zoom-btn" onClick={() => zoomAt(2, viewClamped + span / 2)} disabled={zoom >= MAX_ZOOM} title="Zoom in">+</button>
          <button className="editor-zoom-btn" onClick={fitZoom} disabled={zoom === 1} title="Fit all">Fit</button>
        </div>

        <div className="editor-ruler">
          <canvas ref={rulerRef} className="editor-ruler-canvas" />
        </div>
        <div
          ref={wrapRef}
          className="editor-wave"
          onPointerDown={handlePointerDown}
          onWheel={handleWheel}
        >
          {/* Cue de vídeo: <video> de previsualització a la zona de l'ona.
              Pot tenir so (és la finestra principal, no la sortida). */}
          {isVid && slot.filePath && (
            <video
              ref={videoRef}
              className="editor-video"
              src={convertFileSrc(slot.filePath)}
              preload="auto"
              playsInline
            />
          )}
          <canvas ref={canvasRef} className="editor-canvas" />
          {showPlayhead && (
            <div
              className="editor-playhead"
              style={{ left: `${playheadPct}%` }}
              onPointerDown={(e) => { e.stopPropagation(); setDragging('playhead'); }}
            />
          )}
        </div>

        {zoom > 1 && (
          <input
            className="editor-scroll"
            type="range" min="0" max="1" step="0.0005"
            value={scrollPos}
            onChange={(e) => setView(parseFloat(e.target.value) * viewMax)}
            title="Pan the view"
          />
        )}

        <div className="editor-times">
          <span>In: <b>{fmtTime(start)}</b></span>
          <span>Out: <b>{fmtTime(stop)}</b></span>
          <span>Length: <b>{fmtTime(segDur)}</b></span>
        </div>

        <div className="editor-options">
          <label className="editor-check">
            <input
              type="checkbox"
              checked={!!slot.stopOthers}
              onChange={(e) => updateSlotEdit(editingSlot, { stopOthers: e.target.checked })}
            />
            Stop others (cut the other cues when fired)
          </label>

          {/* Auto-continue + Pre-wait a la mateixa fila */}
          <div className="editor-opt-row">
            <label className="editor-check">
              <input
                type="checkbox"
                checked={slot.continueMode === 'auto'}
                onChange={(e) => updateSlotEdit(editingSlot, { continueMode: e.target.checked ? 'auto' : 'none' })}
              />
              Auto-continue (fire the next cue right after)
            </label>
            <label className="editor-prewait">
              <span>Pre-wait (s)</span>
              <input
                className="editor-fade-num"
                type="number" min="0" step="0.1"
                value={slot.preWait || 0}
                onChange={(e) => {
                  const v = parseFloat(e.target.value);
                  updateSlotEdit(editingSlot, { preWait: Math.max(0, isNaN(v) ? 0 : v) });
                }}
              />
            </label>
          </div>

          {/* Acció sobre la playlist: Ducking o Stop playing */}
          <PlaylistActionToggle
            action={slot.duck ? 'duck' : slot.stopPlaylist ? 'stop' : 'none'}
            onChange={(a) => setPlaylistAction(editingSlot, a)}
          />
          {slot.duck && !duckEnabled && (
            <div className="settings-note">Ducking is disabled globally (Settings → Playlist).</div>
          )}
        </div>

        <div className="editor-colors">
          <span className="editor-colors-label">Color</span>
          <button
            className={`color-swatch none ${!slot.color ? 'active' : ''}`}
            onClick={() => setColor(editingSlot, null)}
            title="No color"
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
          <label>
            <span className="editor-fade-label">
              Fade in: {fadeInOv != null ? `${fadeInOv.toFixed(2)}s (custom)` : `${globalFadeIn.toFixed(2)}s (global)`}
              {fadeInOv != null && (
                <button
                  type="button"
                  className="editor-fade-clear"
                  onClick={(e) => { e.preventDefault(); updateSlotEdit(editingSlot, { fadeIn: null }); }}
                  title="Back to global fade"
                >↺ global</button>
              )}
            </span>
            <div className="editor-fade-row">
              <input
                type="range" min="0" max={Math.min(FADE_MAX, fadeCap)} step="0.1"
                value={Math.min(fadeIn, FADE_MAX, fadeCap)}
                onChange={(e) => { const v = parseFloat(e.target.value); updateSlotEdit(editingSlot, { fadeIn: v }); seekEditorVideo(start + (v || 0)); }}
              />
              {/* Camp numèric per escriure valors exactes, independent de la durada de l'arxiu */}
              <input
                className="editor-fade-num"
                type="number" min="0" step="0.1" max={fadeCap}
                value={Math.min(fadeIn, fadeCap)}
                onChange={(e) => {
                  const v = parseFloat(e.target.value);
                  const clamped = Math.min(Math.max(0, isNaN(v) ? 0 : v), fadeCap);
                  updateSlotEdit(editingSlot, { fadeIn: clamped });
                  seekEditorVideo(start + clamped);
                }}
              />
            </div>
          </label>
          <label>
            <span className="editor-fade-label">
              Fade out: {fadeOutOv != null ? `${fadeOutOv.toFixed(2)}s (custom)` : `${globalFadeOut.toFixed(2)}s (global)`}
              {fadeOutOv != null && (
                <button
                  type="button"
                  className="editor-fade-clear"
                  onClick={(e) => { e.preventDefault(); updateSlotEdit(editingSlot, { fadeOut: null }); }}
                  title="Back to global fade"
                >↺ global</button>
              )}
            </span>
            <div className="editor-fade-row">
              <input
                type="range" min="0" max={Math.min(FADE_MAX, fadeCap)} step="0.1"
                value={Math.min(fadeOut, FADE_MAX, fadeCap)}
                onChange={(e) => { const v = parseFloat(e.target.value); updateSlotEdit(editingSlot, { fadeOut: v }); seekEditorVideo(stop - (v || 0)); }}
              />
              {/* Camp numèric per escriure valors exactes, independent de la durada de l'arxiu */}
              <input
                className="editor-fade-num"
                type="number" min="0" step="0.1" max={fadeCap}
                value={Math.min(fadeOut, fadeCap)}
                onChange={(e) => {
                  const v = parseFloat(e.target.value);
                  const clamped = Math.min(Math.max(0, isNaN(v) ? 0 : v), fadeCap);
                  updateSlotEdit(editingSlot, { fadeOut: clamped });
                  seekEditorVideo(stop - clamped);
                }}
              />
            </div>
          </label>
        </div>

        <div className="editor-actions">
          <button
            className={`editor-btn toggle ${slot.loop ? 'active' : ''}`}
            onClick={() => setLoop(editingSlot, !slot.loop)}
            title="Loop this cue"
          >
            ⟳ Loop
          </button>
          <span className="editor-actions-spacer" />
          {isVid ? (
            /* Vídeo: preview a la pròpia finestra (el <video> de l'editor),
               no a la sortida. Play/pausa i reinici al punt d'inici. */
            <>
              <button className="editor-btn primary" onClick={toggleVideoPreview}>
                {vidPlaying ? '❚❚ Pause' : '▶ Preview'}
              </button>
              <button
                className="editor-btn"
                onClick={() => {
                  const v = videoRef.current;
                  if (!v) return;
                  v.pause();
                  try { v.currentTime = start; } catch { /* res */ }
                }}
              >
                ■ Stop
              </button>
            </>
          ) : (
            <>
              <button className="editor-btn primary" onClick={() => playSlot(editingSlot)}>▶ Preview</button>
              <button className="editor-btn" onClick={() => stopSlot(editingSlot, true)}>■ Stop</button>
            </>
          )}
          <button className="editor-btn" onClick={handleReset}>Reset</button>
          <button className="editor-btn" onClick={handleClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
