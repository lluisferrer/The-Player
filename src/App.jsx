import { useEffect, useState } from 'react';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { useSoundStore } from './store/useSoundStore';
import { useAudioEngine } from './hooks/useAudioEngine';
import { SoundBoard } from './components/SoundBoard';
import { CueTransport } from './components/CueTransport';
import { Playlist } from './components/Playlist';
import { SlotEditor } from './components/SlotEditor';
import { Library } from './components/Library';
import { PlaylistSave } from './components/PlaylistSave';
import { SettingsModal } from './components/SettingsModal';
import { slotForKey } from './lib/keyMap';
import { hasClip } from './lib/slotAudio';
import { toggleOutputWindow, isOutputOpen, getOutputWindow } from './lib/videoOutput';
import { availableMonitors } from '@tauri-apps/api/window';
import { listen } from '@tauri-apps/api/event';
import { applyAsioTelemetry } from './lib/asioTelemetry';
import { plaOnVoiceEnded } from './lib/playlistAsio';
import { PREVIEW_VOICE_ID } from './lib/asioIds';
import './App.css';

// Extensions acceptades pels cues: àudio i vídeo (els de vídeo van a la
// finestra de sortida; vegeu useAudioEngine + videoOutput.js)
const MEDIA_EXT = /\.(mp3|wav|ogg|flac|mp4|webm|m4v|mov)$/i;

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
  const [outputOpen, setOutputOpen] = useState(false); // estat de la finestra de sortida
  const [monitors, setMonitors] = useState([]);        // monitors disponibles (per al selector)
  const [monitorIdx, setMonitorIdx] = useState(null);  // monitor de destí escollit (null = auto)

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

  // Monitors disponibles (per al selector de la finestra de sortida) i estat
  // inicial de la finestra output (per si ja estigués oberta).
  useEffect(() => {
    (async () => {
      try { setMonitors(await availableMonitors()); } catch { /* sense API de monitors */ }
      try { setOutputOpen(await isOutputOpen()); } catch { /* res */ }
    })();
  }, []);

  // Obre/tanca la finestra de sortida de vídeo i en sincronitza l'estat del botó
  const handleToggleOutput = async () => {
    try {
      const open = await toggleOutputWindow(monitorIdx);
      setOutputOpen(open);
      // Si s'ha tancat (o l'usuari la tanca des de la pròpia finestra),
      // reflecteix-ho i reseteja els cues de vídeo que quedessin marcats
      const w = await getOutputWindow();
      if (w) {
        w.once('tauri://destroyed', () => {
          setOutputOpen(false);
          useSoundStore.getState().clearVideoCues();
        });
      }
    } catch (e) {
      console.warn('No s\'ha pogut commutar la finestra de sortida:', e);
    }
  };

  // La finestra de sortida informa quan un vídeo acaba sol → reseteja el cue
  useEffect(() => {
    let un;
    (async () => {
      try {
        un = await listen('video-ended', (e) => {
          const id = e.payload && e.payload.slotId;
          if (id != null) useSoundStore.getState().handleVideoEnded(id);
        });
      } catch { /* fora de Tauri */ }
    })();
    return () => { if (un) un(); };
  }, []);

  // El motor ASIO natiu informa quan una veu (cue) acaba sola → reseteja el tile
  // (el voiceId coincideix amb l'id del slot).
  useEffect(() => {
    let un;
    (async () => {
      try {
        un = await listen('asio-voice-ended', (e) => {
          const id = e.payload;
          if (id == null) return;
          // Pot ser un cue (id = slot), el preview, o una pista de la playlist.
          if (id === PREVIEW_VOICE_ID) { useSoundStore.getState().previewEnded(); return; }
          useSoundStore.getState().handleEnded(id);
          plaOnVoiceEnded(id);
        });
      } catch { /* fora de Tauri */ }
    })();
    return () => { if (un) un(); };
  }, []);

  // Telemetria del motor ASIO (~30 Hz): playhead + nivell de cada veu activa.
  // Es desa en un Map de mòdul (fora de React) i el consulten el playhead i el
  // picòmetre cada frame, sense provocar re-renders del store.
  useEffect(() => {
    let un;
    (async () => {
      try {
        un = await listen('asio-telemetry', (e) => applyAsioTelemetry(e.payload));
      } catch { /* fora de Tauri */ }
    })();
    return () => { if (un) un(); };
  }, []);

  // En arrencar: recarrega els cues des de disc (per la ruta desada) i neteja
  // els fantasmes vells (nom sense ruta) perquè no quedin noms penjats.
  useEffect(() => {
    const slots = useSoundStore.getState().slots;
    (async () => {
      for (const s of slots) {
        if (s.filePath && !s.audioBuffer) {
          const cfg = { ...s };
          try {
            await loadFromPath(s.id, s.filePath);
            useSoundStore.getState().applySlotConfig(s.id, cfg);
          } catch {
            useSoundStore.getState().clearSlot(s.id); // fitxer no trobat
          }
        } else if (s.label && !s.filePath && !s.audioBuffer) {
          useSoundStore.getState().clearSlot(s.id); // fantasma antic sense ruta
        }
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

      const pageBase = store.currentPage * 32;

      // Ctrl + tecla de slot → preview pel bus de preview (sense tocar el main)
      if (e.ctrlKey && !e.altKey && !e.metaKey) {
        if (typing) return;
        const local = slotForKey(e.key);
        if (local) {
          const id = pageBase + local;
          const s = store.slots.find((x) => x.id === id);
          if (s && hasClip(s)) { e.preventDefault(); store.previewSlot(id); }
        }
        return;
      }

      if (e.altKey || e.metaKey || typing) return;

      // Mode llista (Playlist): fletxes mouen la selecció, Enter reprodueix,
      // espai play/pausa. No s'apliquen les tecles de cues.
      if (store.viewMode === 'list') {
        if (e.key === 'ArrowUp')   { e.preventDefault(); store.movePlaylistSelection(-1); return; }
        if (e.key === 'ArrowDown') { e.preventDefault(); store.movePlaylistSelection(1);  return; }
        if (e.key === 'Enter')     { e.preventDefault(); store.playlistPlaySelected();     return; }
        if (e.key === ' ')         { e.preventDefault(); store.playlistPlayPause();        return; }
        if (e.key === 'Escape')    { e.preventDefault(); store.playlistStop();             return; }
        return;
      }

      // Canvi de pàgina
      if (e.key === 'PageUp')   { e.preventDefault(); store.setPage(store.currentPage - 1); return; }
      if (e.key === 'PageDown') { e.preventDefault(); store.setPage(store.currentPage + 1); return; }

      // Fletxes: mou el slot seleccionat
      if (e.key === 'ArrowLeft')  { e.preventDefault(); store.moveSelection('left');  return; }
      if (e.key === 'ArrowRight') { e.preventDefault(); store.moveSelection('right'); return; }
      if (e.key === 'ArrowUp')    { e.preventDefault(); store.moveSelection('up');    return; }
      if (e.key === 'ArrowDown')  { e.preventDefault(); store.moveSelection('down');  return; }

      // Transport: espai = GO · enter = stop seleccionat · esc = stop tot
      if (e.key === ' ')      { e.preventDefault(); store.go(); return; }
      if (e.key === 'Enter')  { e.preventDefault(); store.stopSlot(store.selectedSlot, true); return; }
      if (e.key === 'Escape') { e.preventDefault(); store.stopAll(); return; }

      // Tecla de slot → play (re-dispara des de l'inici), a la pàgina activa
      const local = slotForKey(e.key);
      if (!local) return;
      const slotId = pageBase + local;
      const slot = store.slots.find((s) => s.id === slotId);
      if (slot && hasClip(slot)) {
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
            const paths = (p.paths || []).filter((p2) => MEDIA_EXT.test(p2));
            const pageEnd = (Math.floor((startSlot - 1) / 32) + 1) * 32; // no vessar de pàgina
            for (let i = 0; i < paths.length && startSlot + i <= pageEnd; i++) {
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

          {/* Selector de monitor de destí (només si n'hi ha més d'un) */}
          {monitors.length > 1 && (
            <select
              className="monitor-select"
              value={monitorIdx == null ? 'auto' : String(monitorIdx)}
              onChange={(e) => setMonitorIdx(e.target.value === 'auto' ? null : Number(e.target.value))}
              title="Monitor de sortida de vídeo"
            >
              <option value="auto">Monitor auto</option>
              {monitors.map((m, i) => (
                <option key={i} value={i}>{m.name || `Monitor ${i + 1}`}</option>
              ))}
            </select>
          )}
          <button
            className={`library-btn ${outputOpen ? 'active' : ''}`}
            onClick={handleToggleOutput}
            title="Obre/tanca la finestra de sortida de vídeo"
          >
            VÍDEO
          </button>

          <button className="library-btn" onClick={() => setShowSave(true)}>FILES</button>
          <button className="library-btn" onClick={() => setShowSettings(true)}>SETTINGS</button>
        </div>
      </header>

      <main className="app-main">
        {viewMode === 'list' ? (
          <Playlist />
        ) : (
          <div className="cues-view">
            <CueTransport />
            <SoundBoard />
          </div>
        )}
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
