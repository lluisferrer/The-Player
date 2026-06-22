import { SkipBack, SkipForward, Play, Square, MonitorOff } from 'lucide-react';
import { useSoundStore } from '../store/useSoundStore';
import { emitVideoBlack } from '../lib/videoOutput';

// Barra de transport per als cues (sobre la botonera)
export function CueTransport() {
  const selectedSlot   = useSoundStore((s) => s.selectedSlot);
  const activeSlot     = useSoundStore((s) => s.activeSlot);
  const previewingSlot = useSoundStore((s) => s.previewingSlot);
  const slots          = useSoundStore((s) => s.slots);

  const { selectStep, go, stopSlot, stopAll } = useSoundStore.getState();

  const nameOf = (id) => {
    const s = slots.find((x) => x.id === id);
    return s && s.label ? s.label.replace(/\.[^/.]+$/, '') : '';
  };

  const previewName = nameOf(previewingSlot); // cue al bus de preview
  const standbyName = nameOf(selectedSlot);   // cue que dispararà el proper GO
  const playingName = nameOf(activeSlot);      // cue que sona ara

  return (
    <div className="cue-transport">
      <div className="cue-tp-buttons">
        <button onClick={() => selectStep(-1)} title="Cue anterior"><SkipBack size={16} fill="currentColor" /></button>
        <button onClick={() => selectStep(1)} title="Cue següent"><SkipForward size={16} fill="currentColor" /></button>
        <button className="cue-go" onClick={() => go()} title="GO: dispara el cue seleccionat i avança">
          <Play size={16} fill="currentColor" /> GO
        </button>
        <button onClick={() => stopSlot(selectedSlot, true)} title="Stop del cue seleccionat"><Square size={16} fill="currentColor" /></button>
        <button className="cue-stop-all" onClick={() => stopAll()} title="Stop ALL (pànic)">
          <Square size={16} fill="currentColor" /> ALL
        </button>
        <button className="cue-black" onClick={() => emitVideoBlack()} title="Negre: posa la sortida de vídeo en negre">
          <MonitorOff size={16} /> NEGRE
        </button>
      </div>

      {/* Tres camps fixos: Preview (vermell) · Next (verd) · Playing (gris).
          Mantenen la posició encara que no hi hagi cap nom populat. */}
      <div className="cue-now">
        <div className="cue-now-field preview">
          <span className="cue-now-label">PREVIEW</span>
          <span className="cue-now-name">{previewName || '—'}</span>
        </div>
        <div className="cue-now-field next">
          <span className="cue-now-label">NEXT</span>
          <span className="cue-now-name">{standbyName || '—'}</span>
        </div>
        <div className="cue-now-field playing">
          <span className="cue-now-label">PLAYING</span>
          <span className="cue-now-name">{playingName || '—'}</span>
        </div>
      </div>
    </div>
  );
}
