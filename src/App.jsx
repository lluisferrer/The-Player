import { useEffect } from 'react';
import { useSoundStore } from './store/useSoundStore';
import { SoundBoard } from './components/SoundBoard';
import { SlotEditor } from './components/SlotEditor';
import { slotForKey } from './lib/keyMap';
import './App.css';

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

    loadDevices();
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
    </div>
  );
}
