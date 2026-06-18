import { SkipBack, SkipForward, Play, Square } from 'lucide-react';
import { useSoundStore } from '../store/useSoundStore';

// Barra de transport per als cues (sobre la botonera)
export function CueTransport() {
  const selectedSlot = useSoundStore((s) => s.selectedSlot);
  const activeSlot   = useSoundStore((s) => s.activeSlot);
  const slots        = useSoundStore((s) => s.slots);

  const { selectStep, go, stopSlot, stopAll } = useSoundStore.getState();

  const active = slots.find((s) => s.id === activeSlot);
  const playingName = active && active.label
    ? active.label.replace(/\.[^/.]+$/, '')
    : '—';

  // Cue en espera (standby): el que es dispararà amb el proper GO
  const standby = slots.find((s) => s.id === selectedSlot);
  const standbyName = standby && standby.label
    ? standby.label.replace(/\.[^/.]+$/, '')
    : '—';

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
      </div>

      <div className="cue-now">
        <span className="cue-now-label standby">EN ESPERA</span>
        <span className="cue-now-name">{standbyName}</span>
        <span className="cue-now-label">SONANT</span>
        <span className="cue-now-name">{playingName}</span>
      </div>
    </div>
  );
}
