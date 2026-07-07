import { useEffect, useRef, useState } from 'react';
import { SkipBack, SkipForward, Play, Square, MonitorOff, Check } from 'lucide-react';
import { useSoundStore } from '../store/useSoundStore';

// Hint que es mostra al camp Preview quan no hi ha res en preview
const PREVIEW_HINT = 'Ctrl + Tile to preview';

// Modes de blackout que ofereix el menú contextual del botó Black (clic dret).
const IDLE_MODES = [
  { value: 'black',    label: 'Full black' },
  { value: 'bars',     label: 'Color bars' },
  { value: 'testcard', label: 'Test card' },
  { value: 'custom',   label: 'Custom image' },
];

// Barra de transport per als cues (sobre la botonera)
export function CueTransport() {
  const selectedSlot   = useSoundStore((s) => s.selectedSlot);
  const activeSlot     = useSoundStore((s) => s.activeSlot);
  const previewingSlot = useSoundStore((s) => s.previewingSlot);
  const slots          = useSoundStore((s) => s.slots);
  const idlePattern    = useSoundStore((s) => s.videoIdlePattern); // patró de blackout (Settings → Video)
  const idleImage      = useSoundStore((s) => s.videoIdleImage);   // imatge del mode 'custom'

  // Etiqueta del botó de blackout segons el patró seleccionat a Settings → Video.
  const blackoutLabel = idlePattern === 'bars' ? 'BARS'
    : idlePattern === 'testcard' ? 'CARD'
    : idlePattern === 'custom' ? 'IMG'
    : 'BLACK';

  const { selectStep, go, stopSlot, stopAll, goToBlack, setVideoIdlePattern } = useSoundStore.getState();

  // Menú contextual (clic dret sobre el botó Black) per canviar el mode en viu.
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef(null);

  // Tanca el menú en clicar fora o prémer Escape.
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e) => { if (menuRef.current && !menuRef.current.contains(e.target)) setMenuOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setMenuOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [menuOpen]);

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
        <div className="cue-black-wrap" ref={menuRef}>
          <button
            className="cue-black"
            onClick={() => goToBlack()}
            onContextMenu={(e) => { e.preventDefault(); setMenuOpen((v) => !v); }}
            title={`Go to black: stop any playing video and show the idle screen (${blackoutLabel}). Right-click to change mode.`}
          >
            <MonitorOff size={16} /> {blackoutLabel}
          </button>
          {menuOpen && (
            <div className="cue-black-menu" role="menu">
              {IDLE_MODES.map((m) => (
                <button
                  key={m.value}
                  role="menuitemradio"
                  aria-checked={idlePattern === m.value}
                  className={idlePattern === m.value ? 'active' : ''}
                  onClick={() => { setVideoIdlePattern(m.value); setMenuOpen(false); }}
                >
                  <span className="cue-black-menu-check">{idlePattern === m.value ? <Check size={13} /> : null}</span>
                  {m.label}
                  {m.value === 'custom' && !idleImage ? <span className="cue-black-menu-hint"> (no image)</span> : null}
                </button>
              ))}
            </div>
          )}
        </div>
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
