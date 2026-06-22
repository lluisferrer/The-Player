// Control compacte de l'acció d'un cue sobre la Playlist.
// Forma: [x] Playlist:  Ducking  [switch]  Stop playing
//  - El checkbox activa/desactiva la interacció amb la playlist.
//  - L'interruptor commuta entre "Ducking" (abaixa) i "Stop playing" (atura).
// action: 'none' | 'duck' | 'stop'  ·  onChange(nextAction)
export function PlaylistActionToggle({ action, onChange }) {
  const enabled = action !== 'none';
  const isStop = action === 'stop';

  return (
    <div className="pl-action">
      <label className="editor-check pl-action-enable">
        <input
          type="checkbox"
          checked={enabled}
          // En activar parteix de Ducking; en desactivar, cap acció
          onChange={(e) => onChange(e.target.checked ? 'duck' : 'none')}
        />
        Playlist:
      </label>
      <div className={`pl-action-modes ${enabled ? '' : 'disabled'}`}>
        <span className={enabled && !isStop ? 'active' : ''}>Ducking</span>
        <button
          type="button"
          className={`pl-switch ${isStop ? 'on' : ''}`}
          disabled={!enabled}
          onClick={() => onChange(isStop ? 'duck' : 'stop')}
          title="Toggle between Ducking and Stop playing"
          aria-label="Playlist action"
        >
          <span className="pl-switch-knob" />
        </button>
        <span className={enabled && isStop ? 'active' : ''}>Stop playing</span>
      </div>
    </div>
  );
}
