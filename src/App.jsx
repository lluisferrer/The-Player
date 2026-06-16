import { useEffect, useState } from 'react';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { useSoundStore } from './store/useSoundStore';
import { useAudioEngine } from './hooks/useAudioEngine';
import { SoundBoard } from './components/SoundBoard';
import { SlotEditor } from './components/SlotEditor';
import { Library } from './components/Library';
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
  const mode              = useSoundStore((s) => s.mode);
  const setMode           = useSoundStore((s) => s.setMode);
  const viewMode          = useSoundStore((s) => s.viewMode);
  const setViewMode       = useSoundStore((s) => s.setViewMode);
  const audioDevices      = useSoundStore((s) => s.audioDevices);
  const selectedDeviceId  = useSoundStore((s) => s.selectedDeviceId);
  const setAudioDevices   = useSoundStore((s) => s.setAudioDevices);
  const setSelectedDevice = useSoundStore((s) => s.setSelectedDevice);
  const initAudioContext  = useSoundStore((s) => s.initAudioContext);
  const setDragOverSlot   = useSoundStore((s) => s.setDragOverSlot);
  const outputChannels    = useSoundStore((s) => s.outputChannels);
  const { loadFromPath }  = useAudioEngine();

  const [showLibrary, setShowLibrary] = useState(false);

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

  // Disparar slots des del teclat (graella QWERTY)
  useEffect(() => {
    const onKeyDown = (e) => {
      if (e.repeat || e.ctrlKey || e.altKey || e.metaKey) return;
      const el = document.activeElement;
      const tag = el && el.tagName;
      // Ignora si s'escriu en un camp o si l'editor és obert
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (useSoundStore.getState().editingSlot) return;

      const slotId = slotForKey(e.key);
      if (!slotId) return;
      const { slots, playSlot } = useSoundStore.getState();
      const slot = slots.find((s) => s.id === slotId);
      if (slot && slot.audioBuffer) {
        e.preventDefault();
        playSlot(slotId);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
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
            setDragOverSlot(null); // leave / cancel
          }
        });
      } catch (err) {
        console.warn('Drag&drop natiu no disponible:', err);
      }
    })();
    return () => { if (unlisten) unlisten(); };
  }, [setDragOverSlot, loadFromPath]);

  const handleDeviceChange = (e) => {
    setSelectedDevice(e.target.value);
  };

  const handleModeChange = (newMode) => {
    initAudioContext();
    setMode(newMode);
  };

  return (
    <div className="app">
      <header className="app-header">
        <h1 className="app-title">THE PLAYER</h1>

        <div className="header-controls">
          <div className="mode-toggle">
            <button
              className={`mode-btn ${mode === 'single' ? 'active' : ''}`}
              onClick={() => handleModeChange('single')}
            >
              SINGLE
            </button>
            <button
              className={`mode-btn ${mode === 'continuous' ? 'active' : ''}`}
              onClick={() => handleModeChange('continuous')}
            >
              CONTINUOUS
            </button>
          </div>

          <div className="mode-toggle">
            <button
              className={`mode-btn ${viewMode === 'grid' ? 'active' : ''}`}
              onClick={() => setViewMode('grid')}
            >
              GRID
            </button>
            <button
              className={`mode-btn ${viewMode === 'list' ? 'active' : ''}`}
              onClick={() => setViewMode('list')}
            >
              LLISTA
            </button>
          </div>

          <div
            className={`channel-info ${outputChannels > 2 ? 'multi' : ''}`}
            title={outputChannels > 2
              ? `El dispositiu exposa ${outputChannels} canals: routing multicanal i cue possibles via Web Audio`
              : 'El dispositiu només exposa estèreo (2 canals)'}
          >
            {outputChannels} CH {outputChannels > 2 ? '· multicanal' : '· estèreo'}
          </div>

          <button className="library-btn" onClick={() => setShowLibrary(true)}>
            LIBRARY
          </button>

          {audioDevices.length > 0 && (
            <div className="device-selector">
              <label htmlFor="audio-device">SORTIDA</label>
              <select
                id="audio-device"
                value={selectedDeviceId}
                onChange={handleDeviceChange}
              >
                {audioDevices.map((d) => (
                  <option key={d.deviceId} value={d.deviceId}>
                    {d.label || `Dispositiu ${d.deviceId.slice(0, 8)}`}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>
      </header>

      <main className="app-main">
        <SoundBoard />
      </main>

      <SlotEditor />
      {showLibrary && <Library onClose={() => setShowLibrary(false)} />}
    </div>
  );
}
