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

  return (
    <div className="cue-transport">
      <div className="cue-tp-buttons">
        <button onClick={() => selectStep(-1)} title="Cue anterior">⏮ Prev</button>
        <button onClick={() => selectStep(1)} title="Cue següent">Next ⏭</button>
        <button className="cue-go" onClick={() => go()} title="GO: dispara el cue seleccionat i avança">GO</button>
        <button onClick={() => stopSlot(selectedSlot, true)} title="Stop del cue seleccionat">■ Stop</button>
        <button className="cue-stop-all" onClick={() => stopAll()} title="Stop ALL (pànic)">■ Stop all</button>
      </div>

      <div className="cue-now">
        <span className="cue-now-label">SONANT</span>
        <span className="cue-now-name">{playingName}</span>
      </div>
    </div>
  );
}
