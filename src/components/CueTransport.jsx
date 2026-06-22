import { SkipBack, SkipForward, Play, Square, MonitorOff } from 'lucide-react';
import { useSoundStore } from '../store/useSoundStore';
import { emitVideoBlack } from '../lib/videoOutput';

// Hint que es mostra al camp Preview quan no hi ha res en preview
const PREVIEW_HINT = 'Ctrl + Tile to preview';

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
        <button onClick={() => selectStep(-1)} title="Previous cue"><SkipBack size={16} fill="currentColor" /></button>
        <button onClick={() => selectStep(1)} title="Next cue"><SkipForward size={16} fill="currentColor" /></button>
        <button className="cue-go" onClick={() => go()} title="GO: fire the selected cue and advance">
          <Play size={16} fill="currentColor" /> GO
        </button>
        <button onClick={() => stopSlot(selectedSlot, true)} title="Stop the selected cue"><Square size={16} fill="currentColor" /></button>
        <button className="cue-stop-all" onClick={() => stopAll()} title="Stop all (panic)">
          <Square size={16} fill="currentColor" /> ALL
        </button>
        <button className="cue-black" onClick={() => emitVideoBlack()} title="Black: cut the video output to black">
          <MonitorOff size={16} /> BLACK
        </button>
      </div>

      {/* Tres camps fixos: Preview (vermell) · Next (verd) · Playing (gris).
          Mantenen la posició encara que no hi hagi cap nom populat. */}
      <div className="cue-now">
        <div className={`cue-now-field preview ${previewName ? '' : 'hint'}`}>
          <span className="cue-now-label">PREVIEW</span>
          <span className="cue-now-name">{previewName || PREVIEW_HINT}</span>
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
