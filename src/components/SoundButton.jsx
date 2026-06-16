import { useRef, useState } from 'react';
import { useSoundStore } from '../store/useSoundStore';
import { useAudioEngine } from '../hooks/useAudioEngine';
import { VuMeter } from './VuMeter';
import { Waveform } from './Waveform';

const ACCEPTED_TYPES = ['audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/flac', 'audio/x-flac', 'audio/mp3'];

export function SoundButton({ slotId }) {
  const slot       = useSoundStore((s) => s.slots.find((sl) => sl.id === slotId));
  const playSlot   = useSoundStore((s) => s.playSlot);
  const setVolume  = useSoundStore((s) => s.setVolume);
  const { decodeAndLoad } = useAudioEngine();

  const [isDragOver, setIsDragOver] = useState(false);
  const [showVolume, setShowVolume] = useState(false);
  const fileInputRef = useRef(null);

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
    if (slot.audioBuffer) {
      playSlot(slotId);
    }
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

  const hasAudio  = Boolean(slot.audioBuffer);
  const isPlaying = slot.isPlaying;

  let stateClass = 'slot-empty';
  if (hasAudio && !isPlaying) stateClass = 'slot-loaded';
  if (isPlaying) stateClass = 'slot-playing';

  const truncatedLabel = slot.label
    ? slot.label.replace(/\.[^/.]+$/, '')
    : '';

  return (
    <div
      className={`sound-button ${stateClass} ${isDragOver ? 'drag-over' : ''}`}
      onClick={handleClick}
      onContextMenu={handleContextMenu}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      onMouseEnter={() => setShowVolume(true)}
      onMouseLeave={() => setShowVolume(false)}
      title={hasAudio ? slot.label : 'Arrossega un fitxer d\'àudio o clic dret per obrir'}
    >
      <input
        ref={fileInputRef}
        type="file"
        accept=".mp3,.wav,.ogg,.flac,audio/*"
        style={{ display: 'none' }}
        onChange={handleFileChange}
      />

      {/* Capçalera: nom del fitxer (esquerra) + número de slot (dreta) */}
      <div className="slot-header">
        <span className="slot-name">{truncatedLabel}</span>
        <span className="slot-id">{slotId}</span>
      </div>

      {hasAudio ? (
        <>
          {/* Cos: forma d'ona al centre + picòmetre vertical a la dreta */}
          <div className="slot-body">
            <div className="slot-waveform">
              <Waveform audioBuffer={slot.audioBuffer} active={isPlaying} />
            </div>
            <div className="slot-vu">
              <VuMeter analyserNode={slot.analyserNode} isPlaying={isPlaying} />
            </div>
          </div>

          {/* Slider de volum a la part inferior */}
          <div className="slot-volume" onClick={(e) => e.stopPropagation()}>
            <input
              type="range"
              min="0"
              max="1"
              step="0.01"
              value={slot.volume}
              onChange={handleVolumeChange}
              title={`Volum: ${Math.round(slot.volume * 100)}%`}
            />
            <span className={`volume-value ${showVolume ? 'visible' : ''}`}>
              {Math.round(slot.volume * 100)}%
            </span>
          </div>
        </>
      ) : (
        <div className="slot-empty-hint">
          {isDragOver ? 'Deixa aquí' : ''}
        </div>
      )}
    </div>
  );
}
