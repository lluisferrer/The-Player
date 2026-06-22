import { useState } from 'react';
import { useLibrary } from '../hooks/useLibrary';

// Modal de la Set Library: desar/carregar/eliminar soundboards
export function Library({ onClose }) {
  const { sets, saveSet, loadSet, deleteSet } = useLibrary();
  const [name, setName] = useState('');

  const names = Object.keys(sets).sort();

  const handleSave = () => {
    const n = name.trim();
    if (!n) return;
    saveSet(n);
    setName('');
  };

  const handleLoad = async (n) => {
    await loadSet(n);
    onClose();
  };

  const fmtDate = (ts) => {
    if (!ts) return '';
    const d = new Date(ts);
    return d.toLocaleDateString() + ' ' + d.toLocaleTimeString().slice(0, 5);
  };

  return (
    <div className="editor-overlay" onClick={onClose}>
      <div className="editor-panel library-panel" onClick={(e) => e.stopPropagation()}>
        <div className="editor-header">
          <span className="editor-title">Saved cue sets</span>
          <button className="editor-close" onClick={onClose}>✕</button>
        </div>

        <div className="library-save">
          <input
            type="text"
            placeholder="Set name…"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleSave(); }}
          />
          <button className="editor-btn primary" onClick={handleSave} disabled={!name.trim()}>
            Save current
          </button>
        </div>

        <div className="library-list">
          {names.length === 0 ? (
            <div className="library-empty">No saved sets yet.</div>
          ) : (
            names.map((n) => (
              <div className="library-item" key={n}>
                <div className="library-item-info">
                  <span className="library-item-name">{n}</span>
                  <span className="library-item-meta">
                    {sets[n].slots.length} slots · {fmtDate(sets[n].savedAt)}
                  </span>
                </div>
                <button className="editor-btn primary" onClick={() => handleLoad(n)}>Load</button>
                <button className="editor-btn" onClick={() => deleteSet(n)}>Delete</button>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
