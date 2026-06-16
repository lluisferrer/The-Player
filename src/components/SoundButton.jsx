import { useEffect, useRef, useState } from 'react';
import { useSoundStore } from '../store/useSoundStore';
import { useAudioEngine } from '../hooks/useAudioEngine';
import { usePlaybackTime, fmtTime } from '../hooks/usePlaybackTime';
import { keyForSlot } from '../lib/keyMap';
import { VuMeter } from './VuMeter';
import { Waveform } from './Waveform';

const ACCEPTED_TYPES = ['audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/flac', 'audio/x-flac', 'audio/mp3'];

export function SoundButton({ slotId }) {
  const slot           = useSoundStore((s) => s.slots.find((sl) => sl.id === slotId));
  const playSlot       = useSoundStore((s) => s.playSlot);
  const setVolume      = useSoundStore((s) => s.setVolume);
  const seekSlot       = useSoundStore((s) => s.seekSlot);
  const clearSlot      = useSoundStore((s) => s.clearSlot);
  const setLoop        = useSoundStore((s) => s.setLoop);
  const setEditingSlot = useSoundStore((s) => s.setEditingSlot);
  const { decodeAndLoad } = useAudioEngine();

  const [isDragOver, setIsDragOver] = useState(false);
  const [showHover, setShowHover]   = useState(false);
  const [scrub, setScrub]   = useState(null);  // posició (ratio dins segment) mentre s'arrossega el playhead
  const [seeking, setSeeking] = useState(false);
  const scrubRef = useRef(null);
  const suppressClickRef = useRef(false); // evita que el click post-drag faci play/stop
  const fileInputRef = useRef(null);
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

  const handleDragOver = (e) => {
    e.preventDefault();
    setIsDragOver(true);
  };

  const handleDragLeave = () => setIsDragOver(false);

  const handleDrop = async (e) => {
    e.preventDefault();
    setIsDragOver(false);
    const file = e.dataTransfer.files[0];
    if (!file) return;
    if (!ACCEPTED_TYPES.includes(file.type) && !file.name.match(/\.(mp3|wav|ogg|flac)$/i)) return;
    await decodeAndLoad(slotId, file);
  };

  const handleClick = () => {
    // Ignora el click immediatament posterior a arrossegar el playhead
    if (suppressClickRef.current) return;
    if (slot.audioBuffer) playSlot(slotId);
  };

  const handleContextMenu = (e) => {
    e.preventDefault();
    fileInputRef.current?.click();
  };

  const handleFileChange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    await decodeAndLoad(slotId, file);
    e.target.value = '';
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

  // Mentre sona mostra el temps transcorregut; aturat, la durada total
  const timeLabel = hasAudio ? fmtTime(isPlaying ? elapsed : duration) : '';

  const occupied = hasAudio || Boolean(slot.label);

  let stateClass = 'slot-empty';
  if (hasAudio && !isPlaying) stateClass = 'slot-loaded';
  if (isPlaying) stateClass = 'slot-playing';

  const truncatedLabel = slot.label ? slot.label.replace(/\.[^/.]+$/, '') : '';
  const keyLabel = keyForSlot(slotId).toUpperCase();

  return (
    <div
      className={`sound-button ${stateClass} ${isDragOver ? 'drag-over' : ''}`}
      onClick={handleClick}
      onContextMenu={handleContextMenu}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      onMouseEnter={() => setShowHover(true)}
      onMouseLeave={() => setShowHover(false)}
      title={hasAudio ? slot.label : 'Arrossega un fitxer d\'àudio o clic dret per obrir'}
    >
      <input
        ref={fileInputRef}
        type="file"
        accept=".mp3,.wav,.ogg,.flac,audio/*"
        style={{ display: 'none' }}
        onChange={handleFileChange}
      />

      {/* Capçalera: nom (esq) + loop + eliminar + tecla + número (dre) */}
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
              {/* Playhead interactiu (apareix mentre sona) */}
              {isPlaying && (
                <div
                  className="slot-playhead"
                  style={{ left: `${playheadPct}%` }}
                  onPointerDown={handlePlayheadDown}
                  title="Arrossega per moure la posició"
                />
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
