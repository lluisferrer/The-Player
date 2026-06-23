import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { availableMonitors } from '@tauri-apps/api/window';
import { useSoundStore } from '../store/useSoundStore';
import { CUE_COLORS } from '../lib/colors';
import { PlaylistActionToggle } from './PlaylistActionToggle';
import { makeAsioTargetStr, isAsioTarget, targetLabel } from '../lib/outputTarget';

// A partir de la info dels drivers ASIO carregats ({ [name]: {outs, sample_rate} }),
// construeix opcions de routing en PARELLS de canals estèreo (1-2, 3-4, …).
// value = string serialitzat del target ASIO (veure src/lib/outputTarget.js).
function asioStereoOptions(asioInfo) {
  const opts = [];
  for (const [driver, info] of Object.entries(asioInfo || {})) {
    const outs = info?.outs || 0;
    for (let c = 0; c + 1 < outs; c += 2) {
      opts.push({
        value: makeAsioTargetStr(driver, [c, c + 1]),
        label: `${driver} · ch ${c + 1}-${c + 2}`,
      });
    }
    // Canal solitari final si el driver té un nombre senar de sortides
    if (outs % 2 === 1) {
      opts.push({
        value: makeAsioTargetStr(driver, [outs - 1]),
        label: `${driver} · ch ${outs} (mono)`,
      });
    }
  }
  return opts;
}

// Selector de sortida reutilitzable: dispositius WASAPI + (opcional) targets ASIO.
// `extraDefault` és l'opció de capçalera (p. ex. "Bus Cues (per defecte)").
function OutputSelect({ id, value, onChange, audioDevices, asioOptions, defaultValue, defaultLabel }) {
  // Si el valor desat és un target ASIO que no surt a les opcions (driver no
  // carregat en aquesta sessió), l'afegim com a opció "fantasma" perquè el
  // select el mostri i no es perdi en re-renderitzar (React deixaria el select
  // sense selecció si el value no casa amb cap option).
  const orphanAsio =
    isAsioTarget(value) && !asioOptions.some((o) => o.value === value)
      ? { value, label: `${targetLabel(value)} (driver not loaded)` }
      : null;

  return (
    <select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value={defaultValue}>{defaultLabel}</option>
      <optgroup label="WASAPI (Web Audio)">
        {audioDevices.map((d) => (
          <option key={d.deviceId} value={d.deviceId}>{d.label || `Device ${d.deviceId.slice(0, 8)}`}</option>
        ))}
      </optgroup>
      {(asioOptions.length > 0 || orphanAsio) && (
        <optgroup label="ASIO (native)">
          {asioOptions.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
          {orphanAsio && (
            <option key={orphanAsio.value} value={orphanAsio.value}>{orphanAsio.label}</option>
          )}
        </optgroup>
      )}
    </select>
  );
}

// Estils inline per a la llista de diagnòstic (evitem dependre de classes CSS
// que, per algun motiu, no es pintaven en aquest context del modal).
const DIAG_LIST_STYLE = { display: 'flex', flexDirection: 'column', gap: 6 };

// Una fila del diagnòstic d'àudio (un dispositiu WASAPI o un driver ASIO).
// Per ASIO, `info` (si està carregat = ACTIU) porta {outs, sample_rate}; `onLoad`
// el carrega ("Usar") i `onRelease` l'allibera ("Deixar d'usar").
function DiagRow({ o, onTone, info, onLoad, onRelease }) {
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
          {o.name}{o.is_default ? '  (default)' : ''}
        </span>
        {o.max_channels > 0 && (
          <span style={{
            fontSize: 11, whiteSpace: 'nowrap', flexShrink: 0,
            color: o.max_channels > 2 ? 'var(--vu-green)' : 'var(--text-secondary)',
            fontWeight: o.max_channels > 2 ? 600 : 400,
          }}>
            {o.max_channels} ch · {o.default_sample_rate} Hz
          </span>
        )}
      </div>
      {isAsio ? (
        info ? (
          <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 5 }}>
            <span style={{ fontSize: 10, color: 'var(--vu-green)', fontWeight: 600, marginRight: 4 }}>
              ✓ IN USE · {info.outs} ch · {info.sample_rate} Hz · tone:
            </span>
            {Array.from({ length: info.outs }, (_, c) => (
              <button key={c} className="diag-tone-btn" onClick={() => onTone(o.host, o.name, c)}>{c + 1}</button>
            ))}
            {onRelease && (
              <button className="diag-detect-btn" style={{ margin: '0 0 0 6px' }} onClick={onRelease}>Release</button>
            )}
          </div>
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 6 }}>
            <button className="diag-detect-btn" style={{ margin: 0 }} onClick={() => onLoad(o.name)}>Use</button>
            <span style={{ fontSize: 10, color: 'var(--text-secondary)' }}>loads the driver (exclusive: one ASIO at a time)</span>
          </div>
        )
      ) : o.max_channels > 0 ? (
        <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 5 }}>
          <span style={{ fontSize: 10, color: 'var(--text-secondary)', marginRight: 4 }}>Test tone:</span>
          {Array.from({ length: o.max_channels }, (_, c) => (
            <button key={c} className="diag-tone-btn" onClick={() => onTone(o.host, o.name, c)}>{c + 1}</button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

// Modal global de configuració amb tres pestanyes: Audio, Cues, Playlist
export function SettingsModal({ onClose }) {
  const [tab, setTab] = useState('dispositius');

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
  const asioMasterGain   = useSoundStore((s) => s.asioMasterGain);
  const setAsioMasterGain = useSoundStore((s) => s.setAsioMasterGain);
  const enabledOutputs   = useSoundStore((s) => s.enabledOutputs);
  const toggleEnabledOutput = useSoundStore((s) => s.toggleEnabledOutput);

  const globalFadeIn  = useSoundStore((s) => s.globalFadeIn);
  const globalFadeOut = useSoundStore((s) => s.globalFadeOut);
  const setGlobalFades = useSoundStore((s) => s.setGlobalFades);
  const cuesStopOthers = useSoundStore((s) => s.cuesStopOthers);
  const cuesDuck = useSoundStore((s) => s.cuesDuck);
  const cuesStopPlaylist = useSoundStore((s) => s.cuesStopPlaylist);
  const setCuesPlaylistAction = useSoundStore((s) => s.setCuesPlaylistAction);
  const setCuesStopOthers = useSoundStore((s) => s.setCuesStopOthers);
  // Increment 3 (experimental): motor natiu cpal per a cues WASAPI
  const useNativeCueEngine = useSoundStore((s) => s.useNativeCueEngine);
  const setUseNativeCueEngine = useSoundStore((s) => s.setUseNativeCueEngine);
  // Increment 4: routing del motor natiu (dispositiu + canals). SEPARAT del
  // routing WASAPI/ASIO: usa els NOMS de cpal de list_audio_outputs.
  const nativeCueDeviceName = useSoundStore((s) => s.nativeCueDeviceName);
  const setNativeCueDevice = useSoundStore((s) => s.setNativeCueDevice);
  const nativeCueChannels = useSoundStore((s) => s.nativeCueChannels);
  const setNativeCueChannels = useSoundStore((s) => s.setNativeCueChannels);

  const crossfade = useSoundStore((s) => s.crossfade);
  const setCrossfade = useSoundStore((s) => s.setCrossfade);

  const videoMonitorName = useSoundStore((s) => s.videoMonitorName);
  const setVideoMonitorName = useSoundStore((s) => s.setVideoMonitorName);
  const videoIdlePattern = useSoundStore((s) => s.videoIdlePattern);
  const setVideoIdlePattern = useSoundStore((s) => s.setVideoIdlePattern);

  const duckEnabled = useSoundStore((s) => s.duckEnabled);
  const duckAmount  = useSoundStore((s) => s.duckAmount);
  const duckAttack  = useSoundStore((s) => s.duckAttack);
  const duckRelease = useSoundStore((s) => s.duckRelease);
  const duckHold    = useSoundStore((s) => s.duckHold);
  const setDuckSettings = useSoundStore((s) => s.setDuckSettings);

  const [outputs, setOutputs] = useState(null);
  // Increment 4: dispositius natius (noms de cpal) per al selector del motor natiu.
  const [nativeOutputs, setNativeOutputs] = useState(null);
  const [monitors, setMonitors] = useState([]);  // monitors del sistema (sortida de vídeo)
  const [diagError, setDiagError] = useState(null);
  const [asioOut, setAsioOut] = useState(null);   // dispositius ASIO detectats
  const [asioMsg, setAsioMsg] = useState(null);   // estat/error de la detecció ASIO
  // info per driver carregat: { [name]: {outs, sample_rate} } — al STORE perquè no
  // es perdi en reobrir el modal (el driver pot estar carregat per la reproducció).
  const asioInfo = useSoundStore((s) => s.asioInfo);
  const setAsioInfo = useSoundStore((s) => s.setAsioInfo);
  const refreshAsioLoaded = useSoundStore((s) => s.refreshAsioLoaded);

  // Opcions de routing ASIO (parells de canals) dels drivers ASIO carregats.
  const asioOptions = asioStereoOptions(asioInfo);

  // En obrir el modal, refresca quin driver ASIO hi ha carregat ara.
  useEffect(() => { refreshAsioLoaded(); }, [refreshAsioLoaded]);

  // En obrir la pestanya Vídeo, llegeix els monitors disponibles (per al
  // selector de la sortida de vídeo).
  useEffect(() => {
    if (tab !== 'video') return;
    (async () => {
      try { setMonitors(await availableMonitors()); } catch { /* sense API de monitors */ }
    })();
  }, [tab]);

  useEffect(() => {
    if (tab !== 'dispositius' || outputs) return;
    (async () => {
      try { setOutputs(await invoke('list_audio_outputs')); }
      catch (e) { setDiagError(String(e)); }
    })();
  }, [tab, outputs]);

  // Increment 4: carrega els dispositius natius (noms de cpal) quan ets a Cues amb
  // el motor natiu actiu, per poblar el selector de dispositiu i canals de sortida.
  useEffect(() => {
    if (tab !== 'cues' || !useNativeCueEngine || nativeOutputs) return;
    (async () => {
      try { setNativeOutputs(await invoke('list_audio_outputs')); }
      catch { setNativeOutputs([]); }
    })();
  }, [tab, useNativeCueEngine, nativeOutputs]);

  // Detecció ASIO sota demanda (carregar drivers ASIO és lent i pot bloquejar-se)
  const detectAsio = async () => {
    setAsioMsg('Detecting ASIO devices…');
    setAsioOut(null);
    try {
      const r = await invoke('detect_asio');
      setAsioOut(r);
      setAsioMsg(r.length ? null : 'No ASIO devices.');
    } catch (e) {
      setAsioOut([]);
      setAsioMsg(String(e));
    }
  };

  const tone = async (host, name, ch) => {
    try {
      if (host === 'ASIO') {
        await invoke('asio_test_tone', { driverName: name, channel: ch, seconds: 1.0 });
      } else {
        await invoke('play_test_tone', { host, deviceName: name, channel: ch, seconds: 1.0 });
      }
    } catch (e) { setDiagError(String(e)); }
  };

  // Allibera el driver ASIO carregat al fil dedicat, deixant el dispositiu
  // lliure per a WASAPI. El driver es manté viu entre tons (per evitar el hang
  // de recàrrega dels drivers USB ASIO); cal alliberar-lo explícitament.
  const releaseAsio = async () => {
    setAsioMsg('Releasing the ASIO driver…');
    try {
      await invoke('asio_release');
      setAsioInfo({}); // ja no hi ha cap driver carregat
      setAsioMsg('ASIO driver released.');
    } catch (e) {
      setAsioMsg(String(e));
    }
  };

  // Carrega un driver ASIO i en mostra els canals reals (la MixPre, p. ex., en té 4).
  // Carregar-ne un allibera l'anterior (ASIO només en permet un alhora).
  const loadAsio = async (name) => {
    setAsioMsg(`Loading ${name}…`);
    try {
      const info = await invoke('asio_load', { driverName: name });
      setAsioInfo({ [name]: info }); // només un driver carregat alhora
      setAsioMsg(null);
    } catch (e) {
      setAsioMsg(String(e));
    }
  };

  // En obrir la pestanya Dispositius, detecta els ASIO automàticament (llegeix els
  // noms del registre, sense carregar cap driver: ràpid i segur).
  useEffect(() => {
    if (tab === 'dispositius' && asioOut === null) detectAsio();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  // Pool de dispositius WASAPI per al Routing: els marcats "Usar" (llista buida =
  // tots). `devicesFor` hi afegeix el valor actual encara que no estigui marcat,
  // perquè una assignació existent no es perdi del desplegable.
  const enabledDevices = (!enabledOutputs || enabledOutputs.length === 0)
    ? audioDevices
    : audioDevices.filter((d) => enabledOutputs.includes(d.deviceId));
  const devicesFor = (value) => {
    if (!value || isAsioTarget(value) || value === 'default' || value === 'cues') return enabledDevices;
    if (enabledDevices.some((d) => d.deviceId === value)) return enabledDevices;
    const dev = audioDevices.find((d) => d.deviceId === value);
    return dev ? [...enabledDevices, dev] : enabledDevices;
  };
  const isOutputEnabled = (id) => !enabledOutputs || enabledOutputs.length === 0 || enabledOutputs.includes(id);

  return (
    <div className="editor-overlay" onClick={onClose}>
      <div className="editor-panel settings-panel" onClick={(e) => e.stopPropagation()}>
        <div className="editor-header">
          <span className="editor-title">Settings</span>
          <button className="editor-close" onClick={onClose}>✕</button>
        </div>

        <div className="settings-tabs">
          <button className={`settings-tab ${tab === 'dispositius' ? 'active' : ''}`} onClick={() => setTab('dispositius')}>Devices</button>
          <button className={`settings-tab ${tab === 'routing' ? 'active' : ''}`} onClick={() => setTab('routing')}>Routing</button>
          <button className={`settings-tab ${tab === 'video' ? 'active' : ''}`} onClick={() => setTab('video')}>Video</button>
          <button className={`settings-tab ${tab === 'cues' ? 'active' : ''}`} onClick={() => setTab('cues')}>Cues</button>
          <button className={`settings-tab ${tab === 'playlist' ? 'active' : ''}`} onClick={() => setTab('playlist')}>Playlist</button>
        </div>

        <div className="settings-content">
          {tab === 'dispositius' && (
            <>
              <div className="settings-note">
                Pick the hardware you'll use — only enabled devices appear in <b>Routing</b>.
                WASAPI is always available; an <b>ASIO</b> driver gives low latency and real
                channels, but only <b>one</b> can be active at a time (exclusive access).
              </div>

              <div className="settings-subtitle">WASAPI outputs</div>
              <div style={DIAG_LIST_STYLE}>
                {audioDevices.map((d) => (
                  <label key={d.deviceId} className="editor-check" style={{
                    padding: '8px 12px', border: '1px solid var(--border)', borderRadius: 6,
                    background: 'var(--bg-button)', margin: 0,
                  }}>
                    <input
                      type="checkbox"
                      checked={isOutputEnabled(d.deviceId)}
                      onChange={() => toggleEnabledOutput(d.deviceId)}
                    />
                    {d.label || `Device ${d.deviceId.slice(0, 8)}`}
                  </label>
                ))}
                {audioDevices.length === 0 && <div className="library-empty">No WASAPI devices.</div>}
              </div>

              <div className="settings-subtitle">ASIO drivers (low latency)</div>
              {asioMsg && <div className="diag-error">⚠ {asioMsg}</div>}
              {asioOut === null && <div className="library-empty">Detecting ASIO devices…</div>}
              <div style={DIAG_LIST_STYLE}>
                {asioOut && asioOut.map((o, i) => (
                  <DiagRow key={`asio-${i}`} o={o} onTone={tone} info={asioInfo[o.name]} onLoad={loadAsio} onRelease={releaseAsio} />
                ))}
                {asioOut && asioOut.length === 0 && <div className="library-empty">No ASIO drivers.</div>}
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 4 }}>
                <button className="diag-detect-btn" onClick={detectAsio}>Detect again</button>
              </div>

              <div className="settings-subtitle">ASIO master volume</div>
              <div className="settings-row">
                <label htmlFor="asio-master">Level</label>
                <input
                  id="asio-master"
                  type="range" min="0" max="1.5" step="0.01"
                  value={asioMasterGain}
                  onChange={(e) => setAsioMasterGain(parseFloat(e.target.value))}
                  style={{ flex: 1 }}
                />
                <span style={{ fontSize: 11, color: 'var(--text-secondary)', minWidth: 38, textAlign: 'right' }}>
                  {Math.round((asioMasterGain ?? 1) * 100)}%
                </span>
              </div>
              <div className="settings-note">
                Global level of the ASIO bus (before soft clip). Lower it if it clips when
                summing many voices; above 100% is pre-amplification.
              </div>

              <div className="settings-subtitle">Native diagnostics (per-channel test tone)</div>
              <div className="settings-note">Send a tone to check which physical output each channel maps to.</div>
              {diagError && <div className="diag-error">⚠ {diagError}</div>}
              {!outputs && !diagError && <div className="library-empty">Loading devices…</div>}
              <div style={DIAG_LIST_STYLE}>
                {outputs && outputs.map((o, i) => (
                  <DiagRow key={i} o={o} onTone={tone} />
                ))}
              </div>
            </>
          )}

          {tab === 'routing' && (
            <>
              <div className="settings-subtitle">Outputs per bus</div>
              <div className="settings-note">
                Only devices enabled in <b>Devices</b> and the active ASIO driver are shown.
              </div>

              <div className="settings-row">
                <label htmlFor="dev-cues">Cues</label>
                <OutputSelect
                  id="dev-cues"
                  value={cuesDeviceId}
                  onChange={setSelectedDevice}
                  audioDevices={devicesFor(cuesDeviceId)}
                  asioOptions={asioOptions}
                  defaultValue="default"
                  defaultLabel="Default"
                />
              </div>

              <div className="settings-row">
                <label htmlFor="dev-playlist">Playlist</label>
                <OutputSelect
                  id="dev-playlist"
                  value={playlistDeviceId}
                  onChange={setPlaylistDevice}
                  audioDevices={devicesFor(playlistDeviceId)}
                  asioOptions={asioOptions}
                  defaultValue="default"
                  defaultLabel="Default"
                />
              </div>

              <div className="settings-row">
                <label htmlFor="dev-preview">Preview</label>
                <OutputSelect
                  id="dev-preview"
                  value={previewDeviceId}
                  onChange={setPreviewDevice}
                  audioDevices={devicesFor(previewDeviceId)}
                  asioOptions={asioOptions}
                  defaultValue="default"
                  defaultLabel="Default"
                />
              </div>

              <div className="settings-subtitle">Per-color routing (cues)</div>
              <div className="settings-note">
                Cues with no color, or an unassigned color, play through the Cues bus.
                Cues and Playlist on ASIO must share the same driver (only one ASIO active).
              </div>
              {CUE_COLORS.map((c) => (
                <div className="settings-row" key={c.value}>
                  <span className="color-dot" style={{ background: c.value }} />
                  <label htmlFor={`dev-color-${c.value}`}>{c.name}</label>
                  <OutputSelect
                    id={`dev-color-${c.value}`}
                    value={colorOutputs[c.value] || 'cues'}
                    onChange={(v) => setColorOutput(c.value, v)}
                    audioDevices={devicesFor(colorOutputs[c.value])}
                    asioOptions={asioOptions}
                    defaultValue="cues"
                    defaultLabel="Cues bus (default)"
                  />
                </div>
              ))}
            </>
          )}

          {tab === 'video' && (
            <>
              <div className="settings-subtitle">Video output</div>
              <div className="settings-row">
                <label htmlFor="video-monitor">Monitor</label>
                <select
                  id="video-monitor"
                  value={videoMonitorName == null ? 'auto' : videoMonitorName}
                  onChange={(e) => setVideoMonitorName(e.target.value === 'auto' ? null : e.target.value)}
                >
                  <option value="auto">Auto (2nd monitor)</option>
                  {monitors.map((m, i) => (
                    <option key={m.name || i} value={m.name || ''}>
                      {m.name || `Monitor ${i + 1}`}
                      {m.size ? ` · ${Math.round(m.size.width / m.scaleFactor)}×${Math.round(m.size.height / m.scaleFactor)}` : ''}
                    </option>
                  ))}
                  {/* Opció fantasma: el monitor desat no està connectat ara */}
                  {videoMonitorName && !monitors.some((m) => m.name === videoMonitorName) && (
                    <option value={videoMonitorName}>{videoMonitorName} (not connected)</option>
                  )}
                </select>
              </div>
              <div className="settings-note">
                Screen where the video output window opens (VIDEO button), fullscreen.
                <b>Auto</b> picks the first non-primary monitor. Applies next time you open the output.
              </div>

              <div className="settings-subtitle">Blackout screen</div>
              <div className="settings-row">
                <label htmlFor="video-idle">When no video</label>
                <select
                  id="video-idle"
                  value={videoIdlePattern}
                  onChange={(e) => setVideoIdlePattern(e.target.value)}
                >
                  <option value="black">Full black</option>
                  <option value="bars">Color bars</option>
                  <option value="testcard">Test card</option>
                </select>
              </div>
              <div className="settings-note">
                What shows on the output when nothing is playing (blackout). <b>Full black</b> is
                pure black, no text. Applies instantly to the open window.
              </div>
            </>
          )}

          {tab === 'cues' && (
            <>
              <div className="settings-subtitle">Default behavior</div>
              <div className="editor-options">
                <label className="editor-check">
                  <input
                    type="checkbox"
                    checked={cuesStopOthers}
                    onChange={(e) => setCuesStopOthers(e.target.checked)}
                  />
                  Stop others by default (firing a cue stops the rest)
                </label>
                {/* Acció per defecte sobre la playlist: Ducking o Stop playing */}
                <PlaylistActionToggle
                  action={cuesDuck ? 'duck' : cuesStopPlaylist ? 'stop' : 'none'}
                  onChange={setCuesPlaylistAction}
                />
              </div>
              <div className="settings-note">New cues inherit these defaults. Override per cue in its editor (✎).</div>

              <div className="settings-subtitle">Global cue fades</div>
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
              <div className="settings-note">Each cue can set its own fade in the editor (✎); otherwise it uses these.</div>

              <div className="settings-subtitle">Audio engine</div>
              <div className="editor-options">
                <label className="editor-check">
                  <input
                    type="checkbox"
                    checked={useNativeCueEngine}
                    onChange={(e) => setUseNativeCueEngine(e.target.checked)}
                  />
                  Native engine (cpal) for cues — experimental
                </label>
              </div>
              <div className="settings-note">
                Routes WASAPI cues through the native engine instead of Web Audio. ASIO cues are unaffected. Off by default.
              </div>

              {useNativeCueEngine && (() => {
                // Dispositiu natiu seleccionat (per NOM de cpal) i els seus canals.
                const devs = nativeOutputs || [];
                const sel = devs.find((d) => d.name === nativeCueDeviceName);
                // max_channels del dispositiu triat (o per defecte si no n'hi ha).
                const maxCh = sel ? sel.max_channels : (devs.find((d) => d.is_default)?.max_channels || 2);
                // Parells de canals disponibles: 1-2, 3-4, … fins a max_channels.
                const pairs = [];
                for (let c = 0; c + 1 < maxCh; c += 2) pairs.push([c, c + 1]);
                if (pairs.length === 0) pairs.push([0, 1]);
                const curPair = (nativeCueChannels && nativeCueChannels.length === 2)
                  ? `${nativeCueChannels[0]},${nativeCueChannels[1]}` : '';
                return (
                  <>
                    <label className="ps-row">
                      <span>Native output device</span>
                      <span className="ps-cf">
                        <select
                          value={nativeCueDeviceName}
                          onChange={(e) => setNativeCueDevice(e.target.value)}
                        >
                          <option value="">System default</option>
                          {devs.map((d) => (
                            <option key={d.name} value={d.name}>
                              {d.name} ({d.max_channels}ch)
                            </option>
                          ))}
                        </select>
                      </span>
                    </label>
                    <label className="ps-row">
                      <span>Output channels</span>
                      <span className="ps-cf">
                        <select
                          value={curPair}
                          onChange={(e) => {
                            const v = e.target.value;
                            if (!v) { setNativeCueChannels([]); return; }
                            setNativeCueChannels(v.split(',').map((n) => parseInt(n, 10)));
                          }}
                        >
                          <option value="">Default (1-2)</option>
                          {pairs.map(([a, b]) => (
                            <option key={`${a},${b}`} value={`${a},${b}`}>
                              {a + 1}-{b + 1}
                            </option>
                          ))}
                        </select>
                      </span>
                    </label>
                    <div className="settings-note">
                      Native routing uses cpal device names (separate from WASAPI/ASIO routing). Pick a device opened with all its channels, then a channel pair.
                    </div>
                  </>
                );
              })()}
            </>
          )}

          {tab === 'playlist' && (
            <>
              <label className="ps-row">
                <span>Crossfade between tracks</span>
                <span className="ps-cf">
                  <input type="number" min="0" max="20" step="0.5" value={crossfade}
                    onChange={(e) => setCrossfade(parseFloat(e.target.value) || 0)} /> s
                </span>
              </label>

              <div className="settings-subtitle">Ducking (lower the playlist under cues)</div>
              <div className="editor-options">
                <label className="editor-check">
                  <input
                    type="checkbox"
                    checked={duckEnabled}
                    onChange={(e) => setDuckSettings({ duckEnabled: e.target.checked })}
                  />
                  Enable ducking
                </label>
              </div>
              <label className="ps-row">
                <span>Ducked volume</span>
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
                <span>Attack</span>
                <span className="ps-cf">
                  <input type="number" min="0" max="10" step="0.1" value={duckAttack}
                    onChange={(e) => setDuckSettings({ duckAttack: Math.max(0, parseFloat(e.target.value) || 0) })} /> s
                </span>
              </label>
              <label className="ps-row">
                <span>Release</span>
                <span className="ps-cf">
                  <input type="number" min="0" max="10" step="0.1" value={duckRelease}
                    onChange={(e) => setDuckSettings({ duckRelease: Math.max(0, parseFloat(e.target.value) || 0) })} /> s
                </span>
              </label>
              <label className="ps-row">
                <span>Hold (wait before recovering)</span>
                <span className="ps-cf">
                  <input type="number" min="0" max="10" step="0.1" value={duckHold}
                    onChange={(e) => setDuckSettings({ duckHold: Math.max(0, parseFloat(e.target.value) || 0) })} /> s
                </span>
              </label>
              <div className="settings-note">Enable ducking per cue in its editor (✎). The playlist drops to the set volume while any ducking cue plays and recovers once none remain.</div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
