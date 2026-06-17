import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useSoundStore } from '../store/useSoundStore';

// Modal global de configuració amb tres pestanyes: Audio, Cues, Playlist
export function SettingsModal({ onClose }) {
  const [tab, setTab] = useState('audio');

  const audioDevices     = useSoundStore((s) => s.audioDevices);
  const selectedDeviceId = useSoundStore((s) => s.selectedDeviceId);
  const setSelectedDevice = useSoundStore((s) => s.setSelectedDevice);
  const outputChannels   = useSoundStore((s) => s.outputChannels);

  const globalFadeIn  = useSoundStore((s) => s.globalFadeIn);
  const globalFadeOut = useSoundStore((s) => s.globalFadeOut);
  const setGlobalFades = useSoundStore((s) => s.setGlobalFades);

  const crossfade = useSoundStore((s) => s.crossfade);
  const repeat    = useSoundStore((s) => s.playlistRepeat);
  const shuffle   = useSoundStore((s) => s.playlistShuffle);
  const setCrossfade          = useSoundStore((s) => s.setCrossfade);
  const togglePlaylistRepeat  = useSoundStore((s) => s.togglePlaylistRepeat);
  const togglePlaylistShuffle = useSoundStore((s) => s.togglePlaylistShuffle);

  const [outputs, setOutputs] = useState(null);
  const [diagError, setDiagError] = useState(null);

  useEffect(() => {
    if (tab !== 'audio' || outputs) return;
    (async () => {
      try { setOutputs(await invoke('list_audio_outputs')); }
      catch (e) { setDiagError(String(e)); }
    })();
  }, [tab, outputs]);

  const tone = async (name, ch) => {
    try { await invoke('play_test_tone', { deviceName: name, channel: ch, seconds: 1.0 }); }
    catch (e) { setDiagError(String(e)); }
  };

  return (
    <div className="editor-overlay" onClick={onClose}>
      <div className="editor-panel settings-panel" onClick={(e) => e.stopPropagation()}>
        <div className="editor-header">
          <span className="editor-title">Settings</span>
          <button className="editor-close" onClick={onClose}>✕</button>
        </div>

        <div className="settings-tabs">
          <button className={`settings-tab ${tab === 'audio' ? 'active' : ''}`} onClick={() => setTab('audio')}>Audio</button>
          <button className={`settings-tab ${tab === 'cues' ? 'active' : ''}`} onClick={() => setTab('cues')}>Cues</button>
          <button className={`settings-tab ${tab === 'playlist' ? 'active' : ''}`} onClick={() => setTab('playlist')}>Playlist</button>
        </div>

        <div className="settings-content">
          {tab === 'audio' && (
            <>
              <div className="settings-row">
                <label htmlFor="settings-device">Sortida</label>
                <select
                  id="settings-device"
                  value={selectedDeviceId}
                  onChange={(e) => setSelectedDevice(e.target.value)}
                >
                  <option value="default">Per defecte</option>
                  {audioDevices.map((d) => (
                    <option key={d.deviceId} value={d.deviceId}>
                      {d.label || `Dispositiu ${d.deviceId.slice(0, 8)}`}
                    </option>
                  ))}
                </select>
                <span className={`channel-info static ${outputChannels > 2 ? 'multi' : ''}`}>
                  {outputChannels} CH {outputChannels > 2 ? '· multicanal' : '· estèreo'}
                </span>
              </div>

              <div className="settings-subtitle">Diagnòstic natiu (cpal / WASAPI)</div>
              {diagError && <div className="diag-error">⚠ {diagError}</div>}
              {!outputs && !diagError && <div className="library-empty">Carregant dispositius…</div>}
              <div className="library-list">
                {outputs && outputs.map((o, i) => (
                  <div className="diag-item" key={i}>
                    <div className="diag-head">
                      <span className="diag-name">{o.name}{o.is_default ? '  (per defecte)' : ''}</span>
                      <span className={`diag-ch ${o.max_channels > 2 ? 'multi' : ''}`}>
                        {o.max_channels} canals · {o.default_sample_rate} Hz
                      </span>
                    </div>
                    {o.max_channels > 0 && (
                      <div className="diag-tones">
                        <span className="diag-tones-label">To de prova:</span>
                        {Array.from({ length: o.max_channels }, (_, c) => (
                          <button key={c} className="diag-tone-btn" onClick={() => tone(o.name, c)}>{c + 1}</button>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </>
          )}

          {tab === 'cues' && (
            <>
              <div className="settings-subtitle">Fades globals dels cues</div>
              <label className="ps-row">
                <span>Fade in</span>
                <span className="ps-cf">
                  <input type="number" min="0" max="30" step="0.1" value={globalFadeIn}
                    onChange={(e) => setGlobalFades({ globalFadeIn: Math.max(0, parseFloat(e.target.value) || 0) })} /> s
                </span>
              </label>
              <label className="ps-row">
                <span>Fade out</span>
                <span className="ps-cf">
                  <input type="number" min="0" max="30" step="0.1" value={globalFadeOut}
                    onChange={(e) => setGlobalFades({ globalFadeOut: Math.max(0, parseFloat(e.target.value) || 0) })} /> s
                </span>
              </label>
              <div className="settings-note">Cada cue pot fer override d'aquests fades des del seu editor (✎).</div>
            </>
          )}

          {tab === 'playlist' && (
            <>
              <div className="editor-options">
                <label className="editor-check">
                  <input type="checkbox" checked={repeat} onChange={togglePlaylistRepeat} /> Repeteix la llista
                </label>
                <label className="editor-check">
                  <input type="checkbox" checked={shuffle} onChange={togglePlaylistShuffle} /> Aleatori (shuffle)
                </label>
              </div>
              <label className="ps-row">
                <span>Crossfade entre pistes</span>
                <span className="ps-cf">
                  <input type="number" min="0" max="20" step="0.5" value={crossfade}
                    onChange={(e) => setCrossfade(parseFloat(e.target.value) || 0)} /> s
                </span>
              </label>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
