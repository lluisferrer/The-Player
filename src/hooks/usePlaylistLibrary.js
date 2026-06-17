import { useState, useCallback } from 'react';
import { useSoundStore } from '../store/useSoundStore';

const KEY = 'the-player-playlists';

function read() {
  try { return JSON.parse(localStorage.getItem(KEY)) || {}; }
  catch { return {}; }
}
function write(o) { localStorage.setItem(KEY, JSON.stringify(o)); }

// Llibreria de playlists amb nom (desa només rutes + etiquetes; en carregar
// es tornen a llegir els àudios del disc com fa la playlist normal).
export function usePlaylistLibrary() {
  const [lists, setLists] = useState(() => read());

  const saveList = useCallback((name) => {
    const tracks = useSoundStore.getState().playlist.map((t) => ({
      filePath: t.filePath, label: t.label,
    }));
    const all = read();
    all[name] = { savedAt: Date.now(), tracks };
    write(all);
    setLists({ ...all });
  }, []);

  const deleteList = useCallback((name) => {
    const all = read();
    delete all[name];
    write(all);
    setLists({ ...all });
  }, []);

  const loadList = useCallback((name) => {
    const all = read();
    const l = all[name];
    if (!l) return;
    const st = useSoundStore.getState();
    st.clearPlaylist();
    st.addPlaylistTracks(l.tracks.map((t) => ({ filePath: t.filePath, label: t.label })));
  }, []);

  return { lists, saveList, deleteList, loadList };
}
