import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
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
      ? { value, label: `${targetLabel(value)} (driver no carregat)` }
      : null;

  return (
    <select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value={defaultValue}>{defaultLabel}</option>
      <optgroup label="WASAPI (Web Audio)">
        {audioDevices.map((d) => (
          <option key={d.deviceId} value={d.deviceId}>{d.label || `Dispositiu ${d.deviceId.slice(0, 8)}`}</option>
        ))}
      </optgroup>
      {(asioOptions.length > 0 || orphanAsio) && (
        <optgroup label="ASIO (natiu · pendent de render)">
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
// Per ASIO, `info` (si està carregat) porta {outs, sample_rate}; `onLoad` el carrega.
function DiagRow({ o, onTone, info, onLoad }) {
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
      {isAsio ? (
        info ? (
          <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 5 }}>
            <span style={{ fontSize: 10, color: 'var(--text-secondary)', marginRight: 4 }}>
              To de prova · {info.outs} canals · {info.sample_rate} Hz:
            </span>
            {Array.from({ length: info.outs }, (_, c) => (
              <button key={c} className="diag-tone-btn" onClick={() => onTone(o.host, o.name, c)}>{c + 1}</button>
            ))}
          </div>
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 6 }}>
            <button className="diag-detect-btn" style={{ margin: 0 }} onClick={() => onLoad(o.name)}>Carregar</button>
            <span style={{ fontSize: 10, color: 'var(--text-secondary)' }}>per veure els canals (agafa el dispositiu en exclusiva)</span>
          </div>
        )
      ) : o.max_channels > 0 ? (
        <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 5 }}>
          <span style={{ fontSize: 10, color: 'var(--text-secondary)', marginRight: 4 }}>To de prova:</span>
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
  const [asioInfo, setAsioInfo] = useState({});   // info per driver carregat: { [name]: {outs, sample_rate} }

  // Opcions de routing ASIO (parells de canals) dels drivers ASIO carregats.
  // Per oferir-ne, l'usuari ha de carregar el driver a la secció "Dispositius ASIO".
  const asioOptions = asioStereoOptions(asioInfo);

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
    setAsioMsg('Alliberant el driver ASIO…');
    try {
      await invoke('asio_release');
      setAsioInfo({}); // ja no hi ha cap driver carregat
      setAsioMsg('Driver ASIO alliberat.');
    } catch (e) {
      setAsioMsg(String(e));
    }
  };

  // Carrega un driver ASIO i en mostra els canals reals (la MixPre, p. ex., en té 4).
  // Carregar-ne un allibera l'anterior (ASIO només en permet un alhora).
  const loadAsio = async (name) => {
    setAsioMsg(`Carregant ${name}…`);
    try {
      const info = await invoke('asio_load', { driverName: name });
      setAsioInfo({ [name]: info }); // només un driver carregat alhora
      setAsioMsg(null);
    } catch (e) {
      setAsioMsg(String(e));
    }
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
                <OutputSelect
                  id="dev-cues"
                  value={cuesDeviceId}
                  onChange={setSelectedDevice}
                  audioDevices={audioDevices}
                  asioOptions={asioOptions}
                  defaultValue="default"
                  defaultLabel="Per defecte"
                />
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
              <div className="settings-note">
                Els cues sense color, o amb un color sense assignar, sonen pel bus Cues.
                Per assignar una sortida ASIO cal carregar abans el seu driver a «Dispositius ASIO».
                El render ASIO encara és pendent: un color assignat a ASIO de moment NO treu so
                (però tampoc duplica pel bus Cues).
              </div>
              {CUE_COLORS.map((c) => (
                <div className="settings-row" key={c.value}>
                  <span className="color-dot" style={{ background: c.value }} />
                  <label htmlFor={`dev-color-${c.value}`}>{c.name}</label>
                  <OutputSelect
                    id={`dev-color-${c.value}`}
                    value={colorOutputs[c.value] || 'cues'}
                    onChange={(v) => setColorOutput(c.value, v)}
                    audioDevices={audioDevices}
                    asioOptions={asioOptions}
                    defaultValue="cues"
                    defaultLabel="Bus Cues (per defecte)"
                  />
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
                El driver es manté carregat entre tons (i agafa el dispositiu en exclusiva);
                prem «Alliberar ASIO» per tornar-lo a deixar disponible per a Windows/WASAPI.
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button className="diag-detect-btn" onClick={detectAsio}>Detectar ASIO</button>
                {/* Estils inline: les classes del modal no es pinten aquí (patró DiagRow). */}
                <button
                  onClick={releaseAsio}
                  style={{
                    fontSize: 12, fontWeight: 600, padding: '6px 12px', borderRadius: 6,
                    cursor: 'pointer', color: 'var(--text-primary)',
                    background: 'var(--bg-button)', border: '1px solid var(--border)',
                  }}
                >
                  Alliberar ASIO
                </button>
              </div>
              {asioMsg && <div className="diag-error">⚠ {asioMsg}</div>}
              <div style={DIAG_LIST_STYLE}>
                {asioOut && asioOut.map((o, i) => (
                  <DiagRow key={`asio-${i}`} o={o} onTone={tone} info={asioInfo[o.name]} onLoad={loadAsio} />
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
