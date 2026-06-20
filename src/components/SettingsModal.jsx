import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useSoundStore } from '../store/useSoundStore';
import { CUE_COLORS } from '../lib/colors';
import { PlaylistActionToggle } from './PlaylistActionToggle';

// Estils inline per a la llista de diagnòstic (evitem dependre de classes CSS
// que, per algun motiu, no es pintaven en aquest context del modal).
const DIAG_LIST_STYLE = { display: 'flex', flexDirection: 'column', gap: 6 };

// Una fila del diagnòstic d'àudio (un dispositiu WASAPI o un driver ASIO).
function DiagRow({ o, onTone }) {
  const isAsio = o.host === 'ASIO';
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', gap: 8,
      padding: '10px 12px', border: '1px solid var(--border)',
      borderRadius: 6, background: 'var(--bg-button)',
    }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)' }}>
          <span style={{
            display: 'inline-block', fontSize: 9, fontWeight: 700, letterSpacing: '0.5px',
            padding: '1px 5px', marginRight: 6, borderRadius: 3, verticalAlign: 'middle',
            background: isAsio ? 'var(--accent)' : 'var(--bg-button-hover)',
            color: isAsio ? '#fff' : 'var(--text-secondary)',
          }}>{o.host}</span>
          {o.name}{o.is_default ? '  (per defecte)' : ''}
        </span>
        {o.max_channels > 0 && (
          <span style={{
            fontSize: 11, whiteSpace: 'nowrap', flexShrink: 0,
            color: o.max_channels > 2 ? 'var(--vu-green)' : 'var(--text-secondary)',
            fontWeight: o.max_channels > 2 ? 600 : 400,
          }}>
            {o.max_channels} canals · {o.default_sample_rate} Hz
          </span>
        )}
      </div>
      {o.max_channels > 0 ? (
        <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 5 }}>
          <span style={{ fontSize: 10, color: 'var(--text-secondary)', marginRight: 4 }}>To de prova:</span>
          {Array.from({ length: o.max_channels }, (_, c) => (
            <button key={c} className="diag-tone-btn" onClick={() => onTone(o.host, o.name, c)}>{c + 1}</button>
          ))}
        </div>
      ) : (
        <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
          Carregar per veure canals i provar (pròximament).
        </div>
      )}
    </div>
  );
}

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
  const cuesStopOthers = useSoundStore((s) => s.cuesStopOthers);
  const cuesDuck = useSoundStore((s) => s.cuesDuck);
  const cuesStopPlaylist = useSoundStore((s) => s.cuesStopPlaylist);
  const setCuesPlaylistAction = useSoundStore((s) => s.setCuesPlaylistAction);
  const setCuesStopOthers = useSoundStore((s) => s.setCuesStopOthers);

  const crossfade = useSoundStore((s) => s.crossfade);
  const setCrossfade = useSoundStore((s) => s.setCrossfade);

  const duckEnabled = useSoundStore((s) => s.duckEnabled);
  const duckAmount  = useSoundStore((s) => s.duckAmount);
  const duckAttack  = useSoundStore((s) => s.duckAttack);
  const duckRelease = useSoundStore((s) => s.duckRelease);
  const duckHold    = useSoundStore((s) => s.duckHold);
  const setDuckSettings = useSoundStore((s) => s.setDuckSettings);

  const [outputs, setOutputs] = useState(null);
  const [diagError, setDiagError] = useState(null);
  const [asioOut, setAsioOut] = useState(null);   // dispositius ASIO detectats
  const [asioMsg, setAsioMsg] = useState(null);   // estat/error de la detecció ASIO

  useEffect(() => {
    if (tab !== 'audio' || outputs) return;
    (async () => {
      try { setOutputs(await invoke('list_audio_outputs')); }
      catch (e) { setDiagError(String(e)); }
    })();
  }, [tab, outputs]);

  // Detecció ASIO sota demanda (carregar drivers ASIO és lent i pot bloquejar-se)
  const detectAsio = async () => {
    setAsioMsg('Detectant dispositius ASIO…');
    setAsioOut(null);
    try {
      const r = await invoke('detect_asio');
      setAsioOut(r);
      setAsioMsg(r.length ? null : 'Cap dispositiu ASIO.');
    } catch (e) {
      setAsioOut([]);
      setAsioMsg(String(e));
    }
  };

  const tone = async (host, name, ch) => {
    try { await invoke('play_test_tone', { host, deviceName: name, channel: ch, seconds: 1.0 }); }
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

              <div className="settings-subtitle">Diagnòstic natiu (cpal · WASAPI + ASIO)</div>
              {diagError && <div className="diag-error">⚠ {diagError}</div>}
              {!outputs && !diagError && <div className="library-empty">Carregant dispositius…</div>}
              <div style={DIAG_LIST_STYLE}>
                {outputs && outputs.map((o, i) => (
                  <DiagRow key={i} o={o} onTone={tone} />
                ))}
              </div>

              <div className="settings-subtitle">Dispositius ASIO (latència baixa)</div>
              <div className="settings-note">
                Carregar els drivers ASIO és lent i es fa sota demanda. Si uses ASIO4ALL,
                deixa la interfície com a dispositiu de Windows per defecte perquè hi enviï el so.
              </div>
              <button className="diag-detect-btn" onClick={detectAsio}>Detectar ASIO</button>
              {asioMsg && <div className="diag-error">⚠ {asioMsg}</div>}
              <div style={DIAG_LIST_STYLE}>
                {asioOut && asioOut.map((o, i) => (
                  <DiagRow key={`asio-${i}`} o={o} onTone={tone} />
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
              <div className="settings-note">Cada cue pot definir el seu fade des de l'editor (✎); si és 0, usa el global.</div>

              <div className="settings-subtitle">Comportament per defecte</div>
              <div className="editor-options">
                <label className="editor-check">
                  <input
                    type="checkbox"
                    checked={cuesStopOthers}
                    onChange={(e) => setCuesStopOthers(e.target.checked)}
                  />
                  Stop Others per defecte (disparar un cue atura la resta)
                </label>
                {/* Acció per defecte sobre la playlist: Ducking o Stop playing */}
                <PlaylistActionToggle
                  action={cuesDuck ? 'duck' : cuesStopPlaylist ? 'stop' : 'none'}
                  onChange={setCuesPlaylistAction}
                />
              </div>
              <div className="settings-note">Els cues nous prenen aquest valor. Cada cue es pot canviar després des de l'editor (✎).</div>
            </>
          )}

          {tab === 'playlist' && (
            <>
              <label className="ps-row">
                <span>Crossfade entre pistes</span>
                <span className="ps-cf">
                  <input type="number" min="0" max="20" step="0.5" value={crossfade}
                    onChange={(e) => setCrossfade(parseFloat(e.target.value) || 0)} /> s
                </span>
              </label>

              <div className="settings-subtitle">Ducking (abaixar la playlist sota els cues)</div>
              <div className="editor-options">
                <label className="editor-check">
                  <input
                    type="checkbox"
                    checked={duckEnabled}
                    onChange={(e) => setDuckSettings({ duckEnabled: e.target.checked })}
                  />
                  Activa el ducking
                </label>
              </div>
              <label className="ps-row">
                <span>Volum sota duck</span>
                <span className="ps-cf">
                  {/* Es mostra en % però es desa com a factor lineal 0..1 */}
                  <input type="number" min="0" max="100" step="5"
                    value={Math.round(duckAmount * 100)}
                    onChange={(e) => {
                      const pct = Math.max(0, Math.min(100, parseFloat(e.target.value) || 0));
                      setDuckSettings({ duckAmount: pct / 100 });
                    }} /> %
                </span>
              </label>
              <label className="ps-row">
                <span>Attack (baixada)</span>
                <span className="ps-cf">
                  <input type="number" min="0" max="10" step="0.1" value={duckAttack}
                    onChange={(e) => setDuckSettings({ duckAttack: Math.max(0, parseFloat(e.target.value) || 0) })} /> s
                </span>
              </label>
              <label className="ps-row">
                <span>Release (recuperació)</span>
                <span className="ps-cf">
                  <input type="number" min="0" max="10" step="0.1" value={duckRelease}
                    onChange={(e) => setDuckSettings({ duckRelease: Math.max(0, parseFloat(e.target.value) || 0) })} /> s
                </span>
              </label>
              <label className="ps-row">
                <span>Hold (espera abans de recuperar)</span>
                <span className="ps-cf">
                  <input type="number" min="0" max="10" step="0.1" value={duckHold}
                    onChange={(e) => setDuckSettings({ duckHold: Math.max(0, parseFloat(e.target.value) || 0) })} /> s
                </span>
              </label>
              <div className="settings-note">Cada cue activa el ducking des del seu editor (✎). La playlist baixa fins al volum indicat mentre soni algun cue de ducking i es recupera quan no en queda cap.</div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
