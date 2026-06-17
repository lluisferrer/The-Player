import { useEffect, useState } from 'react';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { useSoundStore } from './store/useSoundStore';
import { useAudioEngine } from './hooks/useAudioEngine';
import { SoundBoard } from './components/SoundBoard';
import { Playlist } from './components/Playlist';
import { SlotEditor } from './components/SlotEditor';
import { Library } from './components/Library';
import { PlaylistSave } from './components/PlaylistSave';
import { SettingsModal } from './components/SettingsModal';
import { slotForKey } from './lib/keyMap';
import './App.css';

const AUDIO_EXT = /\.(mp3|wav|ogg|flac)$/i;

// Slot (data-slot-id) sota una posició física del drag&drop natiu
function slotAtPosition(position) {
  const dpr = window.devicePixelRatio || 1;
  const el = document.elementFromPoint(position.x / dpr, position.y / dpr);
  const btn = el && el.closest('[data-slot-id]');
  return btn ? Number(btn.dataset.slotId) : null;
}

export default function App() {
  const viewMode        = useSoundStore((s) => s.viewMode);
  const setViewMode     = useSoundStore((s) => s.setViewMode);
  const setAudioDevices = useSoundStore((s) => s.setAudioDevices);
  const setDragOverSlot = useSoundStore((s) => s.setDragOverSlot);
  const { loadFromPath } = useAudioEngine();

  const [showSettings, setShowSettings] = useState(false);
  const [showSave, setShowSave] = useState(false);

  useEffect(() => {
    const loadDevices = async () => {
      try {
        await navigator.mediaDevices.getUserMedia({ audio: true }).catch(() => {});
        const devices = await navigator.mediaDevices.enumerateDevices();
        const outputs = devices.filter((d) => d.kind === 'audiooutput');
        setAudioDevices(outputs);
      } catch (e) {
        console.warn('No s\'han pogut llistar dispositius d\'àudio:', e);
      }
    };

    loadDevices().then(() => useSoundStore.getState().detectOutputChannels());
    navigator.mediaDevices.addEventListener('devicechange', loadDevices);
    return () => navigator.mediaDevices.removeEventListener('devicechange', loadDevices);
  }, [setAudioDevices]);

  // Teclat: transport, selecció i preview (Ctrl)
  useEffect(() => {
    const onKeyDown = (e) => {
      if (e.repeat) return;
      const store = useSoundStore.getState();
      if (store.editingSlot) return;
      const el = document.activeElement;
      const tag = el && el.tagName;
      const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';

      // Ctrl arma el mode preview (contorns vermells)
      if (e.key === 'Control') { store.setPreviewArmed(true); return; }

      // Ctrl + tecla de slot → preview pel bus de preview (sense tocar el main)
      if (e.ctrlKey && !e.altKey && !e.metaKey) {
        if (typing) return;
        const sid = slotForKey(e.key);
        if (sid) {
          const s = store.slots.find((x) => x.id === sid);
          if (s && s.audioBuffer) { e.preventDefault(); store.previewSlot(sid); }
        }
        return;
      }

      if (e.altKey || e.metaKey || typing) return;

      // Fletxes: mou el slot seleccionat
      if (e.key === 'ArrowLeft')  { e.preventDefault(); store.moveSelection('left');  return; }
      if (e.key === 'ArrowRight') { e.preventDefault(); store.moveSelection('right'); return; }
      if (e.key === 'ArrowUp')    { e.preventDefault(); store.moveSelection('up');    return; }
      if (e.key === 'ArrowDown')  { e.preventDefault(); store.moveSelection('down');  return; }

      // Transport: espai = GO · enter = stop seleccionat · esc = stop tot
      if (e.key === ' ')      { e.preventDefault(); store.go(); return; }
      if (e.key === 'Enter')  { e.preventDefault(); store.stopSlot(store.selectedSlot, true); return; }
      if (e.key === 'Escape') { e.preventDefault(); store.stopAll(); return; }

      // Tecla de slot → play (re-dispara des de l'inici)
      const slotId = slotForKey(e.key);
      if (!slotId) return;
      const slot = store.slots.find((s) => s.id === slotId);
      if (slot && slot.audioBuffer) {
        e.preventDefault();
        store.triggerSlot(slotId);
      }
    };
    const onKeyUp = (e) => {
      if (e.key === 'Control') useSoundStore.getState().setPreviewArmed(false);
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, []);

  // Drag&drop natiu de Tauri: carrega fitxers a partir de la ruta i la posició
  useEffect(() => {
    let unlisten;
    (async () => {
      try {
        unlisten = await getCurrentWebview().onDragDropEvent(async (event) => {
          const p = event.payload;
          if (p.type === 'over') {
            setDragOverSlot(slotAtPosition(p.position));
          } else if (p.type === 'drop') {
            setDragOverSlot(null);
            const startSlot = slotAtPosition(p.position);
            if (!startSlot) return;
            const paths = (p.paths || []).filter((p2) => AUDIO_EXT.test(p2));
            for (let i = 0; i < paths.length && startSlot + i <= 32; i++) {
              try { await loadFromPath(startSlot + i, paths[i]); }
              catch (err) { console.warn('Error carregant', paths[i], err); }
            }
          } else {
            setDragOverSlot(null);
          }
        });
      } catch (err) {
        console.warn('Drag&drop natiu no disponible:', err);
      }
    })();
    return () => { if (unlisten) unlisten(); };
  }, [setDragOverSlot, loadFromPath]);

  return (
    <div className="app">
      <header className="app-header">
        <h1 className="app-title">THE PLAYER</h1>

        <div className="header-controls">
          <div className="mode-toggle">
            <button
              className={`mode-btn ${viewMode === 'grid' ? 'active' : ''}`}
              onClick={() => setViewMode('grid')}
            >
              CUES
            </button>
            <button
              className={`mode-btn ${viewMode === 'list' ? 'active' : ''}`}
              onClick={() => setViewMode('list')}
            >
              PLAYLIST
            </button>
          </div>

          <button className="library-btn" onClick={() => setShowSave(true)}>SAVE</button>
          <button className="library-btn" onClick={() => setShowSettings(true)}>SETTINGS</button>
        </div>
      </header>

      <main className="app-main">
        {viewMode === 'list' ? <Playlist /> : <SoundBoard />}
      </main>

      <SlotEditor />
      {showSave && (
        viewMode === 'list'
          ? <PlaylistSave onClose={() => setShowSave(false)} />
          : <Library onClose={() => setShowSave(false)} />
      )}
      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}
    </div>
  );
}
