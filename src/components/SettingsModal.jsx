import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useSoundStore } from '../store/useSoundStore';
import { CUE_COLORS } from '../lib/colors';

// Modal global de configuració amb tres pestanyes: Audio, Cues, Playlist
export function SettingsModal({ onClose }) {
  const [tab, setTab] = useState('audio');

  const audioDevices     = useSoundStore((s) => s.audioDevices);
  const cuesDeviceId     = useSoundStore((s) => s.selectedDeviceId);
  const playlistDeviceId = useSoundStore((s) => s.playlistDeviceId);
  const previewDeviceId  = useSoundStore((s) => s.previewDeviceId);
  const setSelectedDevice = useSoundStore((s) => s.setSelectedDevice);
  const setPlaylistDevice = useSoundStore((s) => s.setPlaylistDevice);
  const setPreviewDevice  = useSoundStore((s) => s.setPreviewDevice);
  const colorOutputs     = useSoundStore((s) => s.colorOutputs);
  const setColorOutput   = useSoundStore((s) => s.setColorOutput);
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
              <div className="settings-subtitle">Sortides (un dispositiu estèreo per bus)</div>

              <div className="settings-row">
                <label htmlFor="dev-cues">Cues</label>
                <select id="dev-cues" value={cuesDeviceId} onChange={(e) => setSelectedDevice(e.target.value)}>
                  <option value="default">Per defecte</option>
                  {audioDevices.map((d) => (
                    <option key={d.deviceId} value={d.deviceId}>{d.label || `Dispositiu ${d.deviceId.slice(0, 8)}`}</option>
                  ))}
                </select>
              </div>

              <div className="settings-row">
                <label htmlFor="dev-playlist">Playlist</label>
                <select id="dev-playlist" value={playlistDeviceId} onChange={(e) => setPlaylistDevice(e.target.value)}>
                  <option value="default">Per defecte</option>
                  {audioDevices.map((d) => (
                    <option key={d.deviceId} value={d.deviceId}>{d.label || `Dispositiu ${d.deviceId.slice(0, 8)}`}</option>
                  ))}
                </select>
              </div>

              <div className="settings-row">
                <label htmlFor="dev-preview">Preview</label>
                <select id="dev-preview" value={previewDeviceId} onChange={(e) => setPreviewDevice(e.target.value)}>
                  <option value="default">Per defecte</option>
                  {audioDevices.map((d) => (
                    <option key={d.deviceId} value={d.deviceId}>{d.label || `Dispositiu ${d.deviceId.slice(0, 8)}`}</option>
                  ))}
                </select>
              </div>

              <div className="settings-subtitle">Routing per color (cues)</div>
              <div className="settings-note">Els cues sense color, o amb un color sense assignar, sonen pel bus Cues.</div>
              {CUE_COLORS.map((c) => (
                <div className="settings-row" key={c.value}>
                  <span className="color-dot" style={{ background: c.value }} />
                  <label htmlFor={`dev-color-${c.value}`}>{c.name}</label>
                  <select
                    id={`dev-color-${c.value}`}
                    value={colorOutputs[c.value] || 'cues'}
                    onChange={(e) => setColorOutput(c.value, e.target.value)}
                  >
                    <option value="cues">Bus Cues (per defecte)</option>
                    {audioDevices.map((d) => (
                      <option key={d.deviceId} value={d.deviceId}>{d.label || `Dispositiu ${d.deviceId.slice(0, 8)}`}</option>
                    ))}
                  </select>
                </div>
              ))}

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
