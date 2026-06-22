import { useState } from 'react';
import { usePlaylistLibrary } from '../hooks/usePlaylistLibrary';

// Modal de desar/carregar playlists amb nom
export function PlaylistSave({ onClose }) {
  const { lists, saveList, deleteList, loadList } = usePlaylistLibrary();
  const [name, setName] = useState('');
  const names = Object.keys(lists).sort();

  const handleSave = () => {
    const n = name.trim();
    if (!n) return;
    saveList(n);
    setName('');
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
          <span className="editor-title">Saved playlists</span>
          <button className="editor-close" onClick={onClose}>✕</button>
        </div>

        <div className="library-save">
          <input
            type="text"
            placeholder="Playlist name…"
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
            <div className="library-empty">No saved playlists.</div>
          ) : (
            names.map((n) => (
              <div className="library-item" key={n}>
                <div className="library-item-info">
                  <span className="library-item-name">{n}</span>
                  <span className="library-item-meta">
                    {lists[n].tracks.length} tracks · {fmtDate(lists[n].savedAt)}
                  </span>
                </div>
                <button className="editor-btn primary" onClick={() => { loadList(n); onClose(); }}>Load</button>
                <button className="editor-btn" onClick={() => deleteList(n)}>Delete</button>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
