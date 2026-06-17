import { useEffect, useRef, useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { useSoundStore } from '../store/useSoundStore';
import { useAudioEngine } from '../hooks/useAudioEngine';
import { usePlaybackTime, fmtTime } from '../hooks/usePlaybackTime';
import { keyForSlot } from '../lib/keyMap';
import { VuMeter } from './VuMeter';
import { Waveform } from './Waveform';

export function SoundButton({ slotId }) {
  const slot           = useSoundStore((s) => s.slots.find((sl) => sl.id === slotId));
  const playSlot       = useSoundStore((s) => s.playSlot);
  const setVolume      = useSoundStore((s) => s.setVolume);
  const seekSlot       = useSoundStore((s) => s.seekSlot);
  const clearSlot      = useSoundStore((s) => s.clearSlot);
  const setLoop        = useSoundStore((s) => s.setLoop);
  const setEditingSlot = useSoundStore((s) => s.setEditingSlot);
  const setSelectedSlot = useSoundStore((s) => s.setSelectedSlot);
  const previewSlot    = useSoundStore((s) => s.previewSlot);
  const isDragOver     = useSoundStore((s) => s.dragOverSlot === slotId);
  const isSelected     = useSoundStore((s) => s.selectedSlot === slotId);
  const previewArmed   = useSoundStore((s) => s.previewArmed);
  const isPreviewing   = useSoundStore((s) => s.previewingSlot === slotId);
  const { loadFromPath } = useAudioEngine();

  const [showHover, setShowHover]   = useState(false);
  const [scrub, setScrub]   = useState(null);  // posició (ratio dins segment) mentre s'arrossega el playhead
  const [seeking, setSeeking] = useState(false);
  const [previewProg, setPreviewProg] = useState(0); // progrés del preview (0..1)
  const scrubRef = useRef(null);
  const suppressClickRef = useRef(false); // evita que el click post-drag faci play/stop
  const waveRef = useRef(null);

  const hasAudio  = Boolean(slot.audioBuffer);
  const isPlaying = slot.isPlaying;

  const { elapsed, duration, progress } = usePlaybackTime(slot);

  // Tram retallat i durada del segment
  const total      = hasAudio ? slot.audioBuffer.duration : 0;
  const startSec   = hasAudio ? Math.max(0, slot.startPoint || 0) : 0;
  const stopSec    = hasAudio ? (slot.stopPoint ?? total) : 0;
  const segDur     = Math.max(0, stopSec - startSec);
  const startRatio = total ? startSec / total : 0;
  const stopRatio  = total ? stopSec / total : 1;

  // Posició del playhead (fracció del buffer sencer)
  const headRatio  = scrub != null ? scrub : progress;
  const playheadPct = total ? ((startSec + headRatio * segDur) / total) * 100 : 0;

  // Drag del playhead (salt en deixar anar)
  useEffect(() => {
    if (!seeking) return;
    const onMove = (e) => {
      const wrap = waveRef.current;
      if (!wrap) return;
      const rect = wrap.getBoundingClientRect();
      const bufRatio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
      const segRatio = segDur > 0
        ? Math.min(1, Math.max(0, (bufRatio * total - startSec) / segDur))
        : 0;
      scrubRef.current = segRatio;
      setScrub(segRatio);
    };
    const onUp = () => {
      const v = scrubRef.current;
      setSeeking(false);
      setScrub(null);
      scrubRef.current = null;
      if (v != null) seekSlot(slotId, v);
      // Neteja el flag després que s'hagi disparat (i ignorat) el click del botó
      setTimeout(() => { suppressClickRef.current = false; }, 0);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [seeking, segDur, total, startSec, slotId, seekSlot]);

  // Progrés del preview (per al playhead vermell), llegint el context de preview
  useEffect(() => {
    if (!isPreviewing) { setPreviewProg(0); return; }
    let raf;
    const tick = () => {
      const st = useSoundStore.getState();
      const ctx = st.previewCtx;
      if (ctx && segDur > 0) {
        let pos = ctx.currentTime - st.previewStartedAt;
        if (slot.loop) pos = pos % segDur;
        pos = Math.max(0, Math.min(pos, segDur));
        setPreviewProg(pos / segDur);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [isPreviewing, segDur, slot.loop]);

  const previewPlayheadPct = total ? ((startSec + previewProg * segDur) / total) * 100 : 0;

  const handleClick = (e) => {
    // Ignora el click immediatament posterior a arrossegar el playhead
    if (suppressClickRef.current) return;
    // Ctrl+clic → preview pel bus de preview
    if (e.ctrlKey && slot.audioBuffer) { previewSlot(slotId); return; }
    setSelectedSlot(slotId);
    if (slot.audioBuffer) playSlot(slotId);
  };

  // Clic dret: obre el selector natiu de fitxers (retorna la ruta)
  const handleContextMenu = async (e) => {
    e.preventDefault();
    try {
      const path = await open({
        multiple: false,
        filters: [{ name: 'Àudio', extensions: ['mp3', 'wav', 'ogg', 'flac'] }],
      });
      if (path) await loadFromPath(slotId, path);
    } catch (err) {
      console.warn('No s\'ha pogut obrir el fitxer:', err);
    }
  };

  const handleVolumeChange = (e) => {
    e.stopPropagation();
    setVolume(slotId, parseFloat(e.target.value));
  };

  const handleEdit = (e) => {
    e.stopPropagation();
    setEditingSlot(slotId);
  };

  const handleDelete = (e) => {
    e.stopPropagation();
    clearSlot(slotId);
  };

  const handleLoopToggle = (e) => {
    e.stopPropagation();
    setLoop(slotId, !slot.loop);
  };

  const handlePlayheadDown = (e) => {
    e.stopPropagation();
    e.preventDefault();
    suppressClickRef.current = true;
    scrubRef.current = progress;
    setScrub(progress);
    setSeeking(true);
  };

  const paused = hasAudio && slot.pausedAt != null;
  // Reproduint o pausat: temps transcorregut; aturat: durada total
  const timeLabel = hasAudio ? fmtTime((isPlaying || paused) ? elapsed : duration) : '';

  const occupied = hasAudio || Boolean(slot.label);

  let stateClass = 'slot-empty';
  if (hasAudio) stateClass = 'slot-loaded';
  if (paused) stateClass = 'slot-paused';
  if (isPlaying) stateClass = 'slot-playing';

  const truncatedLabel = slot.label ? slot.label.replace(/\.[^/.]+$/, '') : '';
  const keyLabel = keyForSlot(slotId).toUpperCase();

  return (
    <div
      className={`sound-button ${stateClass} ${isDragOver ? 'drag-over' : ''} ${isSelected ? 'selected' : ''} ${(previewArmed && hasAudio) ? 'preview-armed' : ''} ${isPreviewing ? 'previewing' : ''}`}
      data-slot-id={slotId}
      onClick={handleClick}
      onContextMenu={handleContextMenu}
      onMouseEnter={() => setShowHover(true)}
      onMouseLeave={() => setShowHover(false)}
      title={hasAudio ? slot.label : 'Arrossega un fitxer d\'àudio o clic dret per obrir'}
    >
      {slot.color && <div className="slot-color-bar" style={{ background: slot.color }} />}

      {/* Capçalera: nom (esq) + loop + eliminar + tecla (dre) */}
      <div className="slot-header">
        <span className="slot-name">{truncatedLabel}</span>
        {hasAudio && (
          <button
            className={`slot-loop-btn ${slot.loop ? 'active' : ''}`}
            onClick={handleLoopToggle}
            title="Loop (repeteix aquest slot)"
          >
            ⟳
          </button>
        )}
        {occupied && (
          <button
            className={`slot-del-btn ${showHover ? 'visible' : ''}`}
            onClick={handleDelete}
            title="Eliminar clip"
          >
            ✕
          </button>
        )}
        {keyLabel && <span className="slot-key" title={`Tecla: ${keyLabel}`}>{keyLabel}</span>}
      </div>

      {hasAudio ? (
        <>
          {/* Cos: forma d'ona (amb playhead) al centre + picòmetre a la dreta */}
          <div className="slot-body">
            <div className="slot-waveform" ref={waveRef}>
              <Waveform
                audioBuffer={slot.audioBuffer}
                active={isPlaying}
                startRatio={startRatio}
                stopRatio={stopRatio}
              />
              {/* Visualitzador de temps (dalt-dreta) */}
              <span className="slot-time">{timeLabel}</span>
              {/* Playhead interactiu (mentre sona o en pausa) */}
              {(isPlaying || paused) && (
                <div
                  className="slot-playhead"
                  style={{ left: `${playheadPct}%` }}
                  onPointerDown={handlePlayheadDown}
                  title="Arrossega per moure la posició"
                />
              )}
              {/* Playhead vermell del preview */}
              {isPreviewing && (
                <div className="slot-playhead preview" style={{ left: `${previewPlayheadPct}%` }} />
              )}
              {/* Botó d'edició (hover) */}
              <button
                className={`slot-edit-btn ${showHover ? 'visible' : ''}`}
                onClick={handleEdit}
                title="Editar slot (inici/stop, fades)"
              >
                ✎
              </button>
            </div>
            <div className="slot-vu">
              <VuMeter analyserNode={slot.analyserNode} isPlaying={isPlaying} />
            </div>
          </div>

          {/* Slider de volum */}
          <div className="slot-volume" onClick={(e) => e.stopPropagation()}>
            <input
              type="range"
              min="0"
              max="1"
              step="0.01"
              value={slot.volume}
              onChange={handleVolumeChange}
              title={`Volum: ${Math.round(slot.volume * 100)}%`}
              style={{
                background: `linear-gradient(to right, var(--accent) ${slot.volume * 100}%, var(--border) ${slot.volume * 100}%)`,
              }}
            />
            <span className={`volume-value ${showHover ? 'visible' : ''}`}>
              {Math.round(slot.volume * 100)}%
            </span>
          </div>
        </>
      ) : (
        <div className="slot-empty-hint">
          {isDragOver ? 'Deixa aquí' : (slot.label ? 'reassignar' : '')}
        </div>
      )}
    </div>
  );
}
