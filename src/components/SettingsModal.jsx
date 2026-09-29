import { useEffect, useState } from 'react';
import { mediaSrc } from '../lib/mediaSrc';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { availableMonitors } from '@tauri-apps/api/window';
import { getVersion } from '@tauri-apps/api/app';
import { useSoundStore } from '../store/useSoundStore';
import { CUE_COLORS } from '../lib/colors';
import { PlaylistActionToggle } from './PlaylistActionToggle';
import { makeAsioTargetStr, makeNativeTargetStr, isAsioTarget, isNativeTarget, targetLabel, IS_LINUX, NATIVE_DEFAULT_TARGET, parseTarget } from '../lib/outputTarget';
import { getAudioPlatform, webAudioLabel } from '../lib/audioPlatform';

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

// Opcions de routing del motor NATIU cpal (P3), en parells de canals estèreo per
// dispositiu. `nativeOutputs` = list_audio_outputs [{ name, max_channels }].
// value = target serialitzat "native:<dev>|<ch0>,<ch1>".
function nativeStereoOptions(nativeOutputs) {
  const opts = [];
  for (const d of nativeOutputs || []) {
    const name = d.name || '';
    const label = d.label || d.name || 'System default';
    const outs = d.max_channels || 2;
    for (let c = 0; c + 1 < outs; c += 2) {
      opts.push({ value: makeNativeTargetStr(name, [c, c + 1]), label: `${label} · ch ${c + 1}-${c + 2}` });
    }
    if (outs % 2 === 1) {
      opts.push({ value: makeNativeTargetStr(name, [outs - 1]), label: `${label} · ch ${outs} (mono)` });
    }
    if (outs < 2) {
      opts.push({ value: makeNativeTargetStr(name, [0]), label: `${label} · ch 1 (mono)` });
    }
  }
  return opts;
}

// Selector de sortida reutilitzable: dispositius Web Audio + natius + (opcional) targets ASIO.
// `defaultLabel` és l'opció de capçalera (p. ex. "Bus Cues (per defecte)").
// `webLabel`/`nativeLabel` són els noms dels backends segons el SO.
function OutputSelect({ id, value, onChange, audioDevices, asioOptions, nativeOptions = [], defaultValue, defaultLabel, webLabel, nativeLabel }) {
  // A Linux no hi ha camí Web Audio (vegeu IS_LINUX a outputTarget.js): el
  // "Default" d'un bus és el dispositiu per defecte del motor natiu.
  const defVal = IS_LINUX && defaultValue === 'default' ? NATIVE_DEFAULT_TARGET : defaultValue;
  // Si el valor desat és un target ASIO/natiu que no surt a les opcions (driver no
  // carregat o dispositiu absent en aquesta sessió), l'afegim com a opció "fantasma"
  // perquè el select el mostri i no es perdi en re-renderitzar (React deixaria el
  // select sense selecció si el value no casa amb cap option).
  const orphanAsio =
    isAsioTarget(value) && !asioOptions.some((o) => o.value === value)
      ? { value, label: `${targetLabel(value)} (driver not loaded)` }
      : null;
  const orphanNative =
    isNativeTarget(value) && value !== defVal && !nativeOptions.some((o) => o.value === value)
      ? { value, label: `${targetLabel(value)} (device not found)` }
      : null;

  return (
    <select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value={defVal}>{defaultLabel}</option>
      {!IS_LINUX && audioDevices.length > 0 && (
        <optgroup label={`${webLabel} (Web Audio · stereo)`}>
          {audioDevices.map((d) => (
            <option key={d.deviceId} value={d.deviceId}>{d.label || `Device ${d.deviceId.slice(0, 8)}`}</option>
          ))}
        </optgroup>
      )}
      {(nativeOptions.length > 0 || orphanNative) && (
        <optgroup label={`${nativeLabel} (native · multichannel)`}>
          {nativeOptions.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
          {orphanNative && (
            <option key={orphanNative.value} value={orphanNative.value}>{orphanNative.label}</option>
          )}
        </optgroup>
      )}
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

// Una fila del diagnòstic d'àudio (un dispositiu WASAPI o el driver ASIO connectat).
// Per ASIO, `info` (present = driver connectat) porta {outs, sample_rate} i mostra
// els botons de test tone per canal, igual que WASAPI/CoreAudio. La connexió/
// desconnexió es fa des del desplegable de driver, no des d'aquí.
// `enabled`/`onToggle` (opcionals): casella "Use" de curació (només els marcats
// surten a Routing). Sense onToggle (driver ASIO), no hi ha casella.
function DiagRow({ o, onTone, info, enabled = true, onToggle }) {
  const isAsio = o.host === 'ASIO';
  // Freqüència llegible; 0 = no s'ha pogut llegir (dispositiu exclusiu ocupat per
  // una altra app) → no en mostrem cap en lloc d'un "0 Hz" enganyós.
  const rate = o.default_sample_rate > 0
    ? ` · ${(o.default_sample_rate / 1000).toLocaleString('en', { maximumFractionDigits: 1 })} kHz`
    : '';
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', gap: 8,
      padding: '10px 12px', border: '1px solid var(--border)',
      borderRadius: 6, background: 'var(--bg-button)',
      opacity: enabled ? 1 : 0.55,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: 6 }}>
          {onToggle && (
            <input type="checkbox" checked={enabled} onChange={onToggle}
              title="Use this device (only used devices appear in Routing)" style={{ margin: 0 }} />
          )}
          <span style={{
            display: 'inline-block', fontSize: 9, fontWeight: 700, letterSpacing: '0.5px',
            padding: '1px 5px', marginRight: 6, borderRadius: 3, verticalAlign: 'middle',
            background: isAsio ? 'var(--accent)' : 'var(--bg-button-hover)',
            color: isAsio ? '#fff' : 'var(--text-secondary)',
          }}>{o.host}</span>
          <span>{o.label || o.name}{o.is_default ? '  (default)' : ''}</span>
          {o.open && (
            <span title="ezyPlayer has this device open (playing or preloaded)" style={{
              fontSize: 9, fontWeight: 700, letterSpacing: '0.5px', padding: '1px 5px',
              borderRadius: 3, background: 'var(--accent)', color: '#fff',
            }}>OPEN</span>
          )}
        </span>
        {o.max_channels > 0 && (
          <span style={{ fontSize: 11, whiteSpace: 'nowrap', flexShrink: 0, color: 'var(--text-secondary)' }}>
            {o.max_channels} ch{rate}
          </span>
        )}
      </div>
      {isAsio ? (
        info ? (
          <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 5 }}>
            <span style={{ fontSize: 10, color: 'var(--vu-green)', fontWeight: 600, marginRight: 4 }}>
              ✓ Connected · {info.outs} ch · {info.sample_rate} Hz · tone:
            </span>
            {Array.from({ length: info.outs }, (_, c) => (
              <button key={c} className="diag-tone-btn" onClick={() => onTone(o.host, o.name, c)}>{c + 1}</button>
            ))}
          </div>
        ) : null
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
export function SettingsModal({ onClose, readOnly = false }) {
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
  const nativeBufferSize = useSoundStore((s) => s.nativeBufferSize);
  const setNativeBufferSize = useSoundStore((s) => s.setNativeBufferSize);
  const enabledOutputs   = useSoundStore((s) => s.enabledOutputs);
  const enabledNativeOutputs = useSoundStore((s) => s.enabledNativeOutputs);
  const toggleEnabledNativeOutput = useSoundStore((s) => s.toggleEnabledNativeOutput);
  const toggleEnabledOutput = useSoundStore((s) => s.toggleEnabledOutput);

  const globalFadeIn  = useSoundStore((s) => s.globalFadeIn);
  const globalFadeOut = useSoundStore((s) => s.globalFadeOut);
  const setGlobalFades = useSoundStore((s) => s.setGlobalFades);
  const cuesStopOthers = useSoundStore((s) => s.cuesStopOthers);
  const cuesCrossfade = useSoundStore((s) => s.cuesCrossfade);
  const setCuesCrossfade = useSoundStore((s) => s.setCuesCrossfade);
  const cuesDuck = useSoundStore((s) => s.cuesDuck);
  const cuesStopPlaylist = useSoundStore((s) => s.cuesStopPlaylist);
  const setCuesPlaylistAction = useSoundStore((s) => s.setCuesPlaylistAction);
  const setCuesStopOthers = useSoundStore((s) => s.setCuesStopOthers);
  // P3: el motor de cada bus (WASAPI/ASIO/natiu) es codifica al seu propi target;
  // ja no hi ha un flag global ni selectors "native" separats.

  const crossfade = useSoundStore((s) => s.crossfade);
  const setCrossfade = useSoundStore((s) => s.setCrossfade);

  const videoMonitorName = useSoundStore((s) => s.videoMonitorName);
  const setVideoMonitorName = useSoundStore((s) => s.setVideoMonitorName);
  const videoIdlePattern = useSoundStore((s) => s.videoIdlePattern);
  const videoIdleImage = useSoundStore((s) => s.videoIdleImage);
  const videoIdleImageFit = useSoundStore((s) => s.videoIdleImageFit);
  const setVideoIdleImage = useSoundStore((s) => s.setVideoIdleImage);
  const setVideoIdleImageFit = useSoundStore((s) => s.setVideoIdleImageFit);
  const separateVideoAudio = useSoundStore((s) => s.separateVideoAudio);
  const setSeparateVideoAudio = useSoundStore((s) => s.setSeparateVideoAudio);
  const tileVideoMirror = useSoundStore((s) => s.tileVideoMirror);
  const setTileVideoMirror = useSoundStore((s) => s.setTileVideoMirror);
  const setVideoIdlePattern = useSoundStore((s) => s.setVideoIdlePattern);

  // Tria una imatge de fons personalitzada (patró 'custom') amb el selector natiu.
  const pickIdleImage = async () => {
    try {
      const path = await open({
        multiple: false,
        filters: [{ name: 'Image', extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp'] }],
      });
      if (path) {
        setVideoIdleImage(path);
        // Forma part del show: còpia a la carpeta Media/ (en segon pla).
        useSoundStore.getState().adoptMedia(path);
        // En triar imatge, passa directament al mode 'custom' (comoditat).
        if (videoIdlePattern !== 'custom') setVideoIdlePattern('custom');
      }
    } catch (err) {
      console.warn('No s\'ha pogut obrir la imatge de fons:', err);
    }
  };

  // Nom del fitxer de la imatge de fons (per mostrar-lo, sense la ruta sencera).
  const idleImageName = videoIdleImage ? videoIdleImage.replace(/^.*[\\/]/, '') : null;

  // ── Llicència (L1) ──
  const licenseState = useSoundStore((s) => s.licenseState);
  const activateLicense = useSoundStore((s) => s.activateLicense);
  const deactivateLicense = useSoundStore((s) => s.deactivateLicense);
  const pushNotification = useSoundStore((s) => s.pushNotification);
  const [licenseKeyInput, setLicenseKeyInput] = useState('');
  const [licenseBusy, setLicenseBusy] = useState(false);

  const doActivate = async () => {
    if (!licenseKeyInput.trim()) return;
    setLicenseBusy(true);
    const status = await activateLicense(licenseKeyInput.trim());
    setLicenseBusy(false);
    if (status?.state === 'valid') {
      setLicenseKeyInput('');
      pushNotification({ type: 'info', message: 'License activated. Thank you!' });
    } else {
      pushNotification({ type: 'error', message: status?.message || 'Invalid license key.' });
    }
  };
  const doDeactivate = async () => {
    setLicenseBusy(true);
    await deactivateLicense();
    setLicenseBusy(false);
    pushNotification({ type: 'info', message: 'License removed — back to demo mode.' });
  };

  const duckEnabled = useSoundStore((s) => s.duckEnabled);
  const duckAmount  = useSoundStore((s) => s.duckAmount);
  const duckAttack  = useSoundStore((s) => s.duckAttack);
  const duckRelease = useSoundStore((s) => s.duckRelease);
  const duckHold    = useSoundStore((s) => s.duckHold);
  const setDuckSettings = useSoundStore((s) => s.setDuckSettings);

  // Plataforma d'àudio: noms dels backends i si hi ha ASIO (null fins que arriba).
  const [platform, setPlatform] = useState(null);
  // Versió de l'app (tauri.conf.json), per a suport: es mostra a la pestanya License.
  const [appVersion, setAppVersion] = useState(null);
  useEffect(() => { getVersion().then(setAppVersion).catch(() => {}); }, []);
  useEffect(() => { getAudioPlatform().then(setPlatform); }, []);
  const webLabel = webAudioLabel(platform);
  const nativeLabel = platform?.native_host || 'Native';
  const hasAsio = !!platform?.asio;
  const isLinux = platform?.os === 'linux';

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
  // Opcions de routing del motor natiu cpal (parells de canals per dispositiu).
  // Només els dispositius marcats com a "Use" (Devices), més els que algun bus ja fa
  // servir (perquè una assignació existent no desaparegui del desplegable).
  const usedNative = new Set(
    [cuesDeviceId, playlistDeviceId, previewDeviceId, ...Object.values(colorOutputs || {})]
      .filter(isNativeTarget)
      .map((v) => parseTarget(v).device),
  );
  const isNativeEnabled = (name) =>
    !enabledNativeOutputs || enabledNativeOutputs.length === 0 || enabledNativeOutputs.includes(name);
  const nativeOptions = nativeStereoOptions(
    (nativeOutputs || []).filter((d) => isNativeEnabled(d.name) || usedNative.has(d.name)),
  );

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

  // P3: carrega els dispositius natius (noms de cpal) en obrir la pestanya Routing,
  // per poblar les opcions natives (multicanal) dels selectors únics de cada bus.
  useEffect(() => {
    if (tab !== 'routing' || nativeOutputs) return;
    (async () => {
      try { setNativeOutputs(await invoke('list_audio_outputs')); }
      catch { setNativeOutputs([]); }
    })();
  }, [tab, nativeOutputs]);

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

  // Driver ASIO carregat ARA MATEIX (com a molt un, per l'exclusivitat del host).
  // El selector únic el fa servir com a valor; buit = cap driver connectat.
  const loadedAsioName = Object.keys(asioInfo)[0] || '';
  // Selecció d'un sol driver ASIO des del desplegable: triar-ne un carrega el nou
  // (asio_load ja allibera l'anterior); "None" (buit) els desconnecta tots. Així no
  // calen botons Use/Release separats.
  const selectAsioDriver = (name) => {
    if (name === loadedAsioName) return; // cap canvi
    if (!name) releaseAsio(); else loadAsio(name);
  };

  // En obrir la pestanya Dispositius, detecta els ASIO automàticament (llegeix els
  // noms del registre, sense carregar cap driver: ràpid i segur).
  // Només si la build porta ASIO (a Mac/Linux, o Windows sense `asio`, no n'hi ha).
  useEffect(() => {
    if (tab === 'dispositius' && hasAsio && asioOut === null) detectAsio();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, hasAsio]);

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
          <span className="editor-title">Settings{readOnly ? ' · read-only (LIVE)' : ''}</span>
          <button className="editor-close" onClick={onClose}>✕</button>
        </div>

        <div className="settings-tabs">
          <button className={`settings-tab ${tab === 'dispositius' ? 'active' : ''}`} onClick={() => setTab('dispositius')}>Devices</button>
          <button className={`settings-tab ${tab === 'routing' ? 'active' : ''}`} onClick={() => setTab('routing')}>Routing</button>
          <button className={`settings-tab ${tab === 'video' ? 'active' : ''}`} onClick={() => setTab('video')}>Video</button>
          <button className={`settings-tab ${tab === 'cues' ? 'active' : ''}`} onClick={() => setTab('cues')}>Cues</button>
          <button className={`settings-tab ${tab === 'playlist' ? 'active' : ''}`} onClick={() => setTab('playlist')}>Playlist</button>
          <button className={`settings-tab ${tab === 'license' ? 'active' : ''}`} onClick={() => setTab('license')}>License</button>
        </div>

        <div className="settings-content">
          {/* LIVE: només-lectura. Un fieldset[disabled] deshabilita tots els controls
              interns (inputs/selects/botons) sense afectar el layout (display:contents),
              deixant navegar per les pestanyes i llegir els valors. */}
          <fieldset disabled={readOnly} style={{ display: 'contents', border: 'none', margin: 0, padding: 0 }}>
          {tab === 'dispositius' && (
            <>
              <div className="settings-note">
                {hasAsio ? (
                  <>
                    Pick the hardware you'll use — only enabled devices appear in <b>Routing</b>.
                    {` ${webLabel}`} is always available; an <b>ASIO</b> driver gives low latency and real
                    channels, but only <b>one</b> can be active at a time (exclusive access).
                  </>
                ) : isLinux ? (
                  <>
                    All audio goes through the native <b>ALSA</b> engine. <b>Default</b> plays
                    through the system mixer (shared with other apps); a sound card opens directly
                    with all its channels — exclusive access while ezyPlayer uses it, like a DAW.
                  </>
                ) : (
                  <>
                    Pick the hardware you'll use — only enabled devices appear in <b>Routing</b>.
                    The <b>{nativeLabel}</b> engine gives real multichannel routing.
                  </>
                )}
              </div>

              {/* A Linux no hi ha camí Web Audio (vegeu IS_LINUX a outputTarget.js). */}
              {!isLinux && (<>
              <div className="settings-subtitle">{webLabel} outputs (Web Audio · stereo)</div>
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
                {audioDevices.length === 0 && (
                  <div className="library-empty">{`No ${webLabel} devices.`}</div>
                )}
              </div>
              </>)}

              {hasAsio && (<>
              <div className="settings-subtitle">ASIO driver (low latency)</div>
              <div className="settings-note">
                Only <b>one</b> ASIO driver can be active at a time (exclusive access).
                Pick one to connect it — switching disconnects the previous one; choose
                <b> None</b> to disconnect.
              </div>
              {asioMsg && <div className="diag-error">⚠ {asioMsg}</div>}
              {asioOut === null ? (
                <div className="library-empty">Detecting ASIO devices…</div>
              ) : asioOut.length === 0 ? (
                <div className="library-empty">No ASIO drivers found.</div>
              ) : (
                <div className="settings-row">
                  <label htmlFor="asio-driver">Driver</label>
                  <select
                    id="asio-driver"
                    value={loadedAsioName}
                    onChange={(e) => selectAsioDriver(e.target.value)}
                    style={{ flex: 1 }}
                  >
                    <option value="">None (disconnected)</option>
                    {asioOut.map((o) => (
                      <option key={o.name} value={o.name}>{o.name}</option>
                    ))}
                  </select>
                </div>
              )}
              {loadedAsioName && asioInfo[loadedAsioName] && (
                <div style={{ ...DIAG_LIST_STYLE, marginTop: 6 }}>
                  <DiagRow
                    o={{
                      host: 'ASIO',
                      name: loadedAsioName,
                      max_channels: asioInfo[loadedAsioName].outs,
                      default_sample_rate: asioInfo[loadedAsioName].sample_rate,
                    }}
                    onTone={tone}
                    info={asioInfo[loadedAsioName]}
                  />
                </div>
              )}

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
              </>)}

              <div className="settings-subtitle">Native engine buffer size</div>
              <div className="settings-row">
                <label htmlFor="native-buffer">Buffer</label>
                <select
                  id="native-buffer"
                  value={nativeBufferSize ?? 0}
                  onChange={(e) => setNativeBufferSize(parseInt(e.target.value, 10) || 0)}
                  style={{ flex: 1 }}
                >
                  <option value={0}>Auto (driver default)</option>
                  <option value={256}>256 frames (~5 ms @ 48 kHz)</option>
                  <option value={512}>512 frames (~11 ms @ 48 kHz)</option>
                  <option value={1024}>1024 frames (~21 ms @ 48 kHz)</option>
                  <option value={2048}>2048 frames (~43 ms @ 48 kHz)</option>
                  <option value={4096}>4096 frames (~85 ms @ 48 kHz)</option>
                </select>
              </div>
              <div className="settings-note">
                Buffer for the native ({nativeLabel}) engine. If playback clicks or
                stutters under load (video output, PDF slides), raise it — a bigger buffer
                is more robust at the cost of a little latency. <b>Auto</b> uses the driver's
                default. Some shared-mode drivers ignore a fixed size and keep their own.
                Applies when a device reopens (idle now, playing ones on their next cue).
              </div>

              <div className="settings-subtitle">{nativeLabel} outputs · native (per-channel test tone)</div>
              <div className="settings-note">
                Tick the devices you'll use — only those appear in <b>Routing</b>. Send a tone to
                check which physical output each channel maps to. <b>OPEN</b> = ezyPlayer is using it now.
              </div>
              {diagError && <div className="diag-error">⚠ {diagError}</div>}
              {!outputs && !diagError && <div className="library-empty">Loading devices…</div>}
              <div style={DIAG_LIST_STYLE}>
                {outputs && outputs.map((o, i) => (
                  <DiagRow key={i} o={o} onTone={tone}
                    enabled={isNativeEnabled(o.name)}
                    onToggle={() => toggleEnabledNativeOutput(o.name, outputs.map((x) => x.name))} />
                ))}
              </div>

              <div className="settings-subtitle">Diagnostics</div>
              <div className="settings-note">
                ezyPlayer keeps a rotating log of engine and device events. If something goes
                wrong during a show, send us the latest log file.
              </div>
              <div className="settings-row">
                <button className="editor-btn" type="button"
                  onClick={() => invoke('open_log_dir').catch((e) => console.warn('[logs] open_log_dir:', e))}>
                  Open logs folder
                </button>
              </div>
            </>
          )}

          {tab === 'routing' && (
            <>
              <div className="settings-subtitle">Outputs per bus</div>
              <div className="settings-note">
                {IS_LINUX
                  ? <>One output per bus, all through the native engine (<b>{nativeLabel}</b>) with real multichannel routing.</>
                  : <>One output per bus. <b>{webLabel}</b> is stereo via Web Audio; <b>{nativeLabel}</b>
                    {hasAsio ? <> and <b>ASIO</b> give</> : ' gives'} real multichannel routing.</>}
                {hasAsio && ' Connect an ASIO driver in Devices to see its channels.'}
              </div>

              <div className="settings-row">
                <label htmlFor="dev-cues">Cues</label>
                <OutputSelect
                  id="dev-cues"
                  value={cuesDeviceId}
                  onChange={setSelectedDevice}
                  audioDevices={devicesFor(cuesDeviceId)}
                  asioOptions={asioOptions}
                  nativeOptions={nativeOptions}
                  webLabel={webLabel}
                  nativeLabel={nativeLabel}
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
                  nativeOptions={nativeOptions}
                  webLabel={webLabel}
                  nativeLabel={nativeLabel}
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
                  nativeOptions={nativeOptions}
                  webLabel={webLabel}
                  nativeLabel={nativeLabel}
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
                    nativeOptions={nativeOptions}
                  webLabel={webLabel}
                  nativeLabel={nativeLabel}
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
                  <option value="custom">Custom image</option>
                </select>
              </div>
              <div className="settings-note">
                What shows on the output when nothing is playing (blackout). <b>Full black</b> is
                pure black, no text. Applies instantly to the open window.
              </div>

              {videoIdlePattern === 'custom' && (
                <>
                  <div className="settings-row">
                    <label>Background image</label>
                    <div className="settings-idle-image">
                      {videoIdleImage && (
                        <img className="settings-idle-thumb" src={mediaSrc(videoIdleImage)} alt="" />
                      )}
                      <button type="button" onClick={pickIdleImage}>
                        {idleImageName ? 'Change…' : 'Choose…'}
                      </button>
                      {videoIdleImage && (
                        <button type="button" onClick={() => setVideoIdleImage(null)}>Clear</button>
                      )}
                    </div>
                  </div>
                  {idleImageName && (
                    <div className="settings-note settings-idle-name">{idleImageName}</div>
                  )}
                  <div className="settings-row">
                    <label htmlFor="video-idle-fit">Fit</label>
                    <select
                      id="video-idle-fit"
                      value={videoIdleImageFit}
                      onChange={(e) => setVideoIdleImageFit(e.target.value)}
                    >
                      <option value="cover">Cover (fill, crop)</option>
                      <option value="contain">Contain (fit, black bars)</option>
                    </select>
                  </div>
                </>
              )}

              <div className="settings-subtitle">Tiles</div>
              <div className="editor-options">
                <label className="editor-check">
                  <input
                    type="checkbox"
                    checked={tileVideoMirror}
                    onChange={(e) => setTileVideoMirror(e.target.checked)}
                  />
                  Live video in tiles
                </label>
              </div>
              <div className="settings-note">
                While a video cue plays, its tile shows the moving picture (a second decode of the
                video). Turn it off on slower computers: the tile then shows the still thumbnail with
                the playhead. Off by default on Linux.
              </div>

              <div className="settings-subtitle">Video audio</div>
              <div className="editor-options">
                <label className="editor-check">
                  <input
                    type="checkbox"
                    checked={separateVideoAudio}
                    onChange={(e) => setSeparateVideoAudio(e.target.checked)}
                  />
                  Route video audio through the hardware engine
                </label>
              </div>
              <div className="settings-note">
                Plays the video’s sound through the hardware engine (routing, fades, ducking,
                multichannel) while the output shows muted video, kept in sync. Takes effect
                when the cue’s bus routes to an <b>ASIO</b> or <b>Native</b> output. Off by default.
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

              <label className="ps-row">
                <span>Crossfade between cues</span>
                <span className="ps-cf">
                  <input type="number" min="0" max="30" step="0.1" value={cuesCrossfade}
                    onChange={(e) => setCuesCrossfade(Math.max(0, parseFloat(e.target.value) || 0))} /> s
                </span>
              </label>
              <div className="settings-note">When a cue with “stop others” fires, outgoing cues fade out over this time while the new one fades in. 0 = hard cut.</div>
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

          {tab === 'license' && (
            <>
              <div className="settings-note">
                ezyPlayer {appVersion ? <b>v{appVersion}</b> : null} · {platform?.os || ''} · audio engine: {nativeLabel}{hasAsio ? ' + ASIO' : ''}
              </div>
              {licenseState?.state === 'valid' ? (
                <>
                  <div className="settings-subtitle">License active</div>
                  <div className="settings-note">
                    Thanks for supporting ezyPlayer. Your license runs fully offline —
                    no internet needed to start a show.
                  </div>
                  <div style={DIAG_LIST_STYLE}>
                    {licenseState.name && <div><b>Licensed to:</b> {licenseState.name}</div>}
                    {licenseState.email && <div><b>Email:</b> {licenseState.email}</div>}
                    {licenseState.tier && <div><b>Tier:</b> {licenseState.tier}</div>}
                    {licenseState.covers && <div><b>Covers version:</b> {licenseState.covers}</div>}
                  </div>
                  <div className="settings-row" style={{ marginTop: 12 }}>
                    <button className="editor-btn" disabled={licenseBusy} onClick={doDeactivate}>
                      Remove license from this computer
                    </button>
                  </div>
                  <div className="settings-note">
                    Removing the license returns the app to demo mode on this machine (use
                    it to move the license to another computer).
                  </div>
                </>
              ) : (
                <>
                  <div className="settings-subtitle">Demo mode</div>
                  <div className="settings-note">
                    The app is fully functional in demo mode, with an occasional short mute
                    and a watermark on the video output. Paste your license key below to
                    activate — it's stored locally and works offline afterwards.
                  </div>
                  <textarea
                    className="license-key-input"
                    placeholder="Paste your license key here…"
                    value={licenseKeyInput}
                    onChange={(e) => setLicenseKeyInput(e.target.value)}
                    rows={4}
                    style={{
                      width: '100%', resize: 'vertical', marginTop: 8,
                      fontFamily: 'inherit', fontSize: 12, padding: 8,
                      background: 'var(--bg-button)', color: 'var(--text-primary)',
                      border: '1px solid var(--border)', borderRadius: 6,
                    }}
                  />
                  <div className="settings-row" style={{ marginTop: 8 }}>
                    <button
                      className="editor-btn"
                      disabled={licenseBusy || !licenseKeyInput.trim()}
                      onClick={doActivate}
                    >
                      {licenseBusy ? 'Activating…' : 'Activate'}
                    </button>
                  </div>
                  {licenseState?.message && (
                    <div className="diag-error">⚠ {licenseState.message}</div>
                  )}
                </>
              )}
            </>
          )}
          </fieldset>
        </div>
      </div>
    </div>
  );
}
