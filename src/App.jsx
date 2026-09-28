import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { Maximize, Minimize, Sun, Moon } from 'lucide-react';
import { useSoundStore } from './store/useSoundStore';
import { IS_LINUX } from './lib/outputTarget';
import { useAudioEngine } from './hooks/useAudioEngine';
import { SoundBoard } from './components/SoundBoard';
import { CueTransport } from './components/CueTransport';
import { Playlist } from './components/Playlist';
import { SlotEditor } from './components/SlotEditor';
import { Library } from './components/Library';
import { PlaylistSave } from './components/PlaylistSave';
import { SettingsModal } from './components/SettingsModal';
import { Toast } from './components/Toast';
import { slotForKey } from './lib/keyMap';
import { getInitialTheme, applyTheme } from './lib/theme';
import { hasClip, isVideo } from './lib/slotAudio';
import { toggleOutputWindow, isOutputOpen, getOutputWindow, openOutputWindow, closeOutputWindow, resolveTargetMonitorName, monitorIsPresent, reassertOutputFullscreen } from './lib/videoOutput';
import { listen, emit } from '@tauri-apps/api/event';
import { applyAsioTelemetry, asioPosition } from './lib/asioTelemetry';
import { setMirrorTime } from './lib/videoMirror';
import { plaOnVoiceEnded } from './lib/playlistAsio';
import { plnOnVoiceEnded } from './lib/playlistNative';
import logo from './assets/ezyPlayerMinimalLogo.svg';
import './App.css';

// Extensions acceptades pels cues: àudio, vídeo i imatge (vídeo i imatge van a
// la finestra de sortida; vegeu useAudioEngine + videoOutput.js)
const MEDIA_EXT = /\.(mp3|mpeg|mpg|m4a|aac|wav|ogg|flac|mp4|webm|m4v|mov|jpg|jpeg|png|webp|gif|bmp|pdf)$/i;

// Guard perquè la restauració de cues a l'arrencada s'executi UNA sola vegada. En
// dev, React.StrictMode munta l'efecte dues vegades → sense guard, cada cue es
// carregava dos cops concurrentment i la cursa sobre `loading` deixava tiles amb
// spinner encallat (sobretot els missing). Flag de mòdul (sobreviu el doble
// muntatge de StrictMode; es reinicia en una recàrrega real de la pàgina).
let bootRestoreRan = false;

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
  const appMode         = useSoundStore((s) => s.appMode);
  const setAppMode      = useSoundStore((s) => s.setAppMode);
  const isLive          = appMode === 'live';
  const setAudioDevices = useSoundStore((s) => s.setAudioDevices);
  const setDragOverSlot = useSoundStore((s) => s.setDragOverSlot);
  const { loadFromPath } = useAudioEngine();

  const [showSettings, setShowSettings] = useState(false);
  // Tema Dia/Nit (botó manual a la capçalera; es recorda entre sessions).
  const [theme, setTheme] = useState(getInitialTheme);
  const toggleTheme = () => setTheme(applyTheme(theme === 'dark' ? 'light' : 'dark'));
  const [showSave, setShowSave] = useState(false);
  // EDIT ↔ LIVE. Entrar a Live és directe; SORTIR de Live demana confirmació amb un
  // diàleg PROPI (a Tauri v2, window.confirm està interceptat pel plugin dialog i
  // no està habilitat → "dialog.confirm not allowed").
  const [confirmExitLive, setConfirmExitLive] = useState(false);
  const toggleAppMode = () => {
    if (isLive) setConfirmExitLive(true);
    else setAppMode('live');
  };
  const [outputOpen, setOutputOpen] = useState(false); // estat de la finestra de sortida
  const [isFullscreen, setIsFullscreen] = useState(false); // pantalla completa de la finestra principal
  // Flag: l'app s'està tancant. Mentre val true, no persistim videoOutputOpen=false
  // en destruir-se la sortida (volem que es recordi oberta per la pròxima arrencada).
  const appClosingRef = useRef(false);

  // Commuta pantalla completa real (amaga la barra de títol de Windows i la
  // taskbar). El comparteixen la tecla F11 i el botó de la capçalera.
  const toggleFullscreen = async () => {
    try {
      const w = getCurrentWindow();
      const next = !(await w.isFullscreen());
      await w.setFullscreen(next);
      setIsFullscreen(next);
    } catch { /* fora de Tauri */ }
  };

  useEffect(() => {
    // `navigator.mediaDevices` no existeix al WKWebView de macOS Mojave (Safari 12)
    // ni en contextos no segurs: a Mac la selecció de dispositius va pel motor natiu
    // (Rust list_audio_outputs), així que aquí simplement ho ometem si no hi és.
    // A Linux no hi ha camí Web Audio (tot va pel motor natiu, vegeu IS_LINUX a
    // outputTarget.js): no demanem micròfon ni creem cap AudioContext, que obriria
    // PulseAudio (i, amb RAVENNA com a sortida per defecte, a un rate incorrecte).
    const md = (typeof navigator !== 'undefined' && !IS_LINUX) ? navigator.mediaDevices : null;
    const loadDevices = async () => {
      if (!md) return;
      try {
        // getUserMedia només per desbloquejar les ETIQUETES dels dispositius: aturem
        // el stream de seguida (si no, el micròfon quedava capturant tota la sessió).
        await md.getUserMedia({ audio: true })
          .then((stream) => stream.getTracks().forEach((t) => t.stop()))
          .catch(() => {});
        const devices = await md.enumerateDevices();
        const outputs = devices.filter((d) => d.kind === 'audiooutput');
        setAudioDevices(outputs);
      } catch (e) {
        console.warn('No s\'han pogut llistar dispositius d\'àudio:', e);
      }
    };

    if (!md) return;
    loadDevices().then(() => useSoundStore.getState().detectOutputChannels());
    if (md && md.addEventListener) {
      md.addEventListener('devicechange', loadDevices);
      return () => md.removeEventListener('devicechange', loadDevices);
    }
  }, [setAudioDevices]);

  // Aplica el gain mestre ASIO desat al motor natiu en arrencar.
  useEffect(() => { useSoundStore.getState().initAsioMaster(); }, []);

  // Llicència (L1): consulta l'estat real al Rust en arrencar (OFFLINE). El Rust és
  // la font de veritat valid/demo; aquí només el pintem (banner + Settings).
  const licenseState = useSoundStore((s) => s.licenseState);
  useEffect(() => { useSoundStore.getState().refreshLicense(); }, []);
  const openLicenseSettings = () => setShowSettings(true);

  // Difon l'estat demo cap a la finestra de sortida de vídeo (context/store a part):
  // el seu watermark s'actualitza en viu en arrencar i en activar/desactivar, encara
  // que la sortida ja estigui oberta (no depèn de tornar-la a muntar).
  useEffect(() => {
    emit('license-demo', licenseState?.state !== 'valid').catch(() => {});
  }, [licenseState?.state]);

  // Persistència de sessió: si la sortida de vídeo estava oberta en tancar l'app,
  // es torna a obrir en arrencar. També en sincronitzem l'estat inicial del botó.
  useEffect(() => {
    (async () => {
      try {
        if (await isOutputOpen()) { setOutputOpen(true); return; }
        if (useSoundStore.getState().videoOutputOpen) {
          await openOutputWindow(useSoundStore.getState().videoMonitorName);
          setOutputOpen(true);
          const w = await getOutputWindow();
          if (w) w.once('tauri://destroyed', () => {
            setOutputOpen(false);
            if (!appClosingRef.current) useSoundStore.getState().setVideoOutputOpen(false);
            useSoundStore.getState().clearVideoCues();
          });
        }
      } catch { /* res */ }
    })();
  }, []);

  // En tancar la finestra principal, tanca també la de sortida de vídeo (si no,
  // quedaria orfe i l'app no acabaria de tancar-se).
  useEffect(() => {
    let unlisten;
    (async () => {
      try {
        unlisten = await getCurrentWindow().onCloseRequested(async (event) => {
          if (appClosingRef.current) return; // ja estem tancant
          appClosingRef.current = true;      // no esborris la preferència en sortir
          // Tanca primer la sortida de vídeo (si no, quedaria orfe i el procés no
          // acabaria). Aturem el tancament per fer-ho de forma determinista i
          // després destruïm la finestra principal.
          event.preventDefault();
          try { await closeOutputWindow(); } catch { /* res */ }
          try { await getCurrentWindow().destroy(); } catch { /* res */ }
        });
      } catch { /* fora de Tauri */ }
    })();
    return () => { if (unlisten) unlisten(); };
  }, []);

  // F11: commuta pantalla completa real de la finestra principal (amaga la barra
  // de títol de Windows i la taskbar). Funciona sempre, també escrivint o editant.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'F11') return;
      e.preventDefault();
      toggleFullscreen();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Sincronitza l'estat inicial (per si s'arrenca ja en pantalla completa).
  useEffect(() => {
    (async () => {
      try { setIsFullscreen(await getCurrentWindow().isFullscreen()); } catch { /* res */ }
    })();
  }, []);

  // Obre/tanca la finestra de sortida de vídeo i en sincronitza l'estat del botó.
  // El monitor de destí és la preferència desada a Settings (per nom; null = auto).
  const handleToggleOutput = async () => {
    try {
      const open = await toggleOutputWindow(useSoundStore.getState().videoMonitorName);
      setOutputOpen(open);
      useSoundStore.getState().setVideoOutputOpen(open); // recorda l'estat per la pròxima arrencada
      // Si s'ha tancat (o l'usuari la tanca des de la pròpia finestra),
      // reflecteix-ho i reseteja els cues de vídeo que quedessin marcats
      const w = await getOutputWindow();
      if (w) {
        w.once('tauri://destroyed', () => {
          setOutputOpen(false);
          if (!appClosingRef.current) useSoundStore.getState().setVideoOutputOpen(false);
          useSoundStore.getState().clearVideoCues();
        });
      }

    } catch (e) {
      console.warn('No s\'ha pogut commutar la finestra de sortida:', e);
    }
  };

  // C2 (resiliència de vídeo): watchdog del monitor de sortida. Mentre la sortida
  // és oberta i té un monitor de destí, vigila cada 2,5 s que segueixi connectat.
  // Si desapareix (desendollat a mitja funció) → negre + avís (no la movem, per no
  // fer aparèixer vídeo al monitor principal per sorpresa). Si segueix present,
  // re-assegura el fullscreen (un canvi de resolució pot treure'l). Un sol monitor
  // (dev) no té destí → no es vigila (la sortida és una finestra normal).
  useEffect(() => {
    if (!outputOpen) return;
    let cancelled = false;
    let timer = null;
    let watchName = null;   // nom del monitor de destí a vigilar (null = no vigilar)
    let lost = false;       // ja s'ha avisat de la pèrdua? (debounce; es rearma al tornar)
    (async () => {
      try { watchName = await resolveTargetMonitorName(useSoundStore.getState().videoMonitorName); }
      catch { watchName = null; }
      if (cancelled) return;
      timer = setInterval(async () => {
        if (!watchName) return;
        const present = await monitorIsPresent(watchName);
        if (cancelled) return;
        if (!present) {
          if (!lost) { lost = true; useSoundStore.getState().handleOutputMonitorLost(watchName); }
        } else {
          if (lost) lost = false; // el monitor ha tornat: rearma l'avís
          reassertOutputFullscreen();
        }
      }, 2500);
    })();
    return () => { cancelled = true; if (timer) clearInterval(timer); };
  }, [outputOpen]);

  // Pantalla sempre encesa (sense salvapantalles ni repòs de pantalla) en mode
  // LIVE o amb la sortida de vídeo oberta. El repòs del SISTEMA ja el bloqueja el
  // Rust mentre l'app és oberta (power.rs).
  const keepDisplayAwake = isLive || outputOpen;
  useEffect(() => {
    invoke('set_keep_display_awake', { on: keepDisplayAwake }).catch(() => {});
  }, [keepDisplayAwake]);

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

  // La finestra de sortida informa el nombre de pàgines d'un PDF en carregar-lo
  // (per clampar la navegació de slides i mostrar "3/24" al tile).
  useEffect(() => {
    let un;
    (async () => {
      try {
        un = await listen('slide-pages', (e) => {
          const { slotId, pages } = e.payload || {};
          if (slotId != null) useSoundStore.getState().setSlidePages(slotId, pages);
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
          // Pot ser un cue (id = slot), el preview (id rotatiu) o una pista de la playlist.
          const st = useSoundStore.getState();
          if (id === st.previewVoiceId) { st.previewEnded(); return; }
          st.handleEnded(id);
          plaOnVoiceEnded(id);
        });
      } catch { /* fora de Tauri */ }
    })();
    return () => { if (un) un(); };
  }, []);

  // C1: el motor ASIO informa quan una veu NO arriba a materialitzar-se (error de
  // decode, sense mix...). Sense això el tile quedaria blau "reproduint" per sempre
  // i la playlist duckejada indefinidament (mai arriba `asio-voice-ended` perquè la
  // veu no ha existit). Mateix reset que el final natural + avança/atura la playlist.
  useEffect(() => {
    let un;
    (async () => {
      try {
        un = await listen('asio-voice-failed', (e) => {
          const p = e.payload || {};
          const id = p.voiceId;
          if (id == null) return;
          console.warn('[asio-voice-failed] voice', id, '-', p.message);
          const st = useSoundStore.getState();
          // Vídeo sense pista d'àudio (o àudio no descodificable): el motor és
          // best-effort; la imatge es reprodueix pel seu camí (finestra de sortida /
          // <video> del tile). No és un error per a l'operador i NO s'ha de desmuntar
          // la reproducció ni el preview.
          const targetId = id === st.previewVoiceId ? st.previewingSlot : id;
          const failedSlot = st.slots.find((s) => s.id === targetId);
          if (failedSlot && isVideo(failedSlot)) return;
          // P1: fa l'error visible a l'operador (ningú mira la consola en un show)
          st.pushNotification({ type: 'error', message: p.message || 'Audio engine error (ASIO)' });
          // Mateix ordre que `asio-voice-ended`: el preview (voice id rotatiu, no és
          // un id de slot) es tanca a part i RETORNA, per no cridar handleEnded ni
          // avançar la playlist amb un id que no li pertoca.
          if (id === st.previewVoiceId) { st.previewEnded(); return; }
          st.handleEnded(id); // reset del tile + duckRemove + clearAsioTelemetry
          // Marca visible i PERSISTENT al tile (no només el toast fugaç): un cue
          // carregat que ha petat en disparar-se queda en vermell fins a un nou
          // dispar amb èxit o recàrrega. Només si és un cue (no una pista de playlist).
          if (failedSlot) st.setSlotError(id, p.message || 'Audio engine error (ASIO)');
          plaOnVoiceEnded(id); // la playlist avança/para si era una pista seva
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
        un = await listen('asio-telemetry', (e) => {
          applyAsioTelemetry(e.payload);
          // P4-lite: la 1a telemetria confirma que la veu ha arrencat → treu "armant"
          if (Array.isArray(e.payload) && e.payload.length) {
            useSoundStore.getState().confirmArming(e.payload.map((it) => it && it.id));
          }
        });
      } catch { /* fora de Tauri */ }
    })();
    return () => { if (un) un(); };
  }, []);

  // Posició del vídeo de la sortida → Map de mòdul (videoMirror), perquè el mirall
  // del tile (un <video> mut, no rate-locked) segueixi la sortida i no derivi en loop.
  useEffect(() => {
    let un;
    (async () => {
      try {
        un = await listen('video-mirror', (e) => {
          const p = e.payload || {};
          setMirrorTime(p.slotId, p.time);
        });
      } catch { /* fora de Tauri */ }
    })();
    return () => { if (un) un(); };
  }, []);

  // Increment 3: el motor natiu cpal informa quan una veu (cue) acaba sola →
  // reseteja el tile (el voiceId coincideix amb l'id del slot).
  useEffect(() => {
    let un;
    (async () => {
      try {
        un = await listen('native-voice-ended', (e) => {
          const id = e.payload;
          if (id == null) return;
          // Pot ser un cue (id = slot), el preview (id rotatiu) o la playlist nativa.
          const st = useSoundStore.getState();
          if (id === st.previewVoiceId) { st.previewEnded(); return; }
          st.handleEnded(id);
          plnOnVoiceEnded(id);
        });
      } catch { /* fora de Tauri */ }
    })();
    return () => { if (un) un(); };
  }, []);

  // C1: el motor natiu cpal informa quan una veu NO arriba a materialitzar-se
  // (error de decode, fitxer sense mostres, sense dispositiu...). Simètric al camí
  // ASIO: sense això el tile quedaria blau i la playlist duckejada per sempre.
  useEffect(() => {
    let un;
    (async () => {
      try {
        un = await listen('native-voice-failed', (e) => {
          const p = e.payload || {};
          const id = p.voiceId;
          if (id == null) return;
          console.warn('[native-voice-failed] voice', id, '-', p.message);
          const st = useSoundStore.getState();
          // Vídeo sense pista d'àudio (o àudio no descodificable): benigne (vegeu el
          // handler asio-voice-failed). La imatge es reprodueix igualment; ni toast ni
          // desmuntatge de la reproducció / preview.
          const targetId = id === st.previewVoiceId ? st.previewingSlot : id;
          const failedSlot = st.slots.find((s) => s.id === targetId);
          if (failedSlot && isVideo(failedSlot)) return;
          // P1: fa l'error visible a l'operador (ningú mira la consola en un show)
          st.pushNotification({ type: 'error', message: p.message || 'Audio engine error (native)' });
          // Mateix ordre que `native-voice-ended`: el preview (voice id rotatiu) es
          // tanca a part i RETORNA, per no cridar handleEnded ni avançar la playlist
          // amb un id que no li pertoca.
          if (id === st.previewVoiceId) { st.previewEnded(); return; }
          st.handleEnded(id); // reset del tile + duckRemove + clearAsioTelemetry
          // Marca d'error PERSISTENT al tile (vegeu el handler ASIO). Només si és un cue.
          if (failedSlot) st.setSlotError(id, p.message || 'Audio engine error (native)');
          plnOnVoiceEnded(id); // la playlist nativa avança/para si era una pista seva
        });
      } catch { /* fora de Tauri */ }
    })();
    return () => { if (un) un(); };
  }, []);

  // C2: el motor natiu informa que un dispositiu de sortida ha desaparegut a mitja
  // funció (interfície USB desendollada, default que marxa...). Fa visible la pèrdua
  // en lloc de deixar el so mort en silenci.
  useEffect(() => {
    let un;
    (async () => {
      try {
        un = await listen('native-device-lost', (e) => {
          const dev = typeof e.payload === 'string' ? e.payload : '';
          useSoundStore.getState().handleNativeDeviceLost(dev);
        });
      } catch { /* fora de Tauri */ }
    })();
    return () => { if (un) un(); };
  }, []);

  // C2: el motor ASIO informa que el dispositiu s'ha perdut a mitja funció (callback
  // del driver congelat, típicament USB desendollada). Fa visible la pèrdua.
  useEffect(() => {
    let un;
    (async () => {
      try {
        un = await listen('asio-device-lost', (e) => {
          const drv = typeof e.payload === 'string' ? e.payload : '';
          useSoundStore.getState().handleAsioDeviceLost(drv);
        });
      } catch { /* fora de Tauri */ }
    })();
    return () => { if (un) un(); };
  }, []);

  // C2: el motor ASIO informa que el dispositiu ha TORNAT (callback reprèn) → neteja
  // l'estat d'error dels cues ASIO i avisa (sense tornar a sonar res sol).
  useEffect(() => {
    let un;
    (async () => {
      try {
        un = await listen('asio-device-recovered', () => {
          useSoundStore.getState().handleAsioDeviceRecovered();
        });
      } catch { /* fora de Tauri */ }
    })();
    return () => { if (un) un(); };
  }, []);

  // Increment 3: telemetria del motor natiu cpal (~30 Hz). Mateix format
  // { id, pos, level } que l'ASIO; es desa al MATEIX Map (applyAsioTelemetry) i el
  // consulten playhead i picòmetre dels slots nativeActive.
  useEffect(() => {
    let un;
    (async () => {
      try {
        un = await listen('native-telemetry', (e) => {
          applyAsioTelemetry(e.payload);
          // P4-lite: la 1a telemetria confirma que la veu ha arrencat → treu "armant"
          if (Array.isArray(e.payload) && e.payload.length) {
            useSoundStore.getState().confirmArming(e.payload.map((it) => it && it.id));
          }
        });
      } catch { /* fora de Tauri */ }
    })();
    return () => { if (un) un(); };
  }, []);

  // P4-lite — Reconciliador de l'estat del motor (salvavides anti-deriva).
  // Els cues ASIO/natiu marquen isPlaying de manera OPTIMISTA en disparar-se.
  // Normalment el motor corregeix l'estat amb `*-voice-ended`/`*-voice-failed`,
  // però si es perd un d'aquests events (o un play falla de manera silenciosa) el
  // tile quedaria blau "reproduint" per sempre i la Playlist duckejada.
  //
  // Aquest watchdog corregeix la deriva: una veu SANA emet telemetria a ~30 Hz, així
  // que si un cue actiu no rep telemetria fresca durant RECONCILE_MS —i NO està
  // pausat (una veu pausada es congela a posta i deixa d'emetre)— el donem per
  // acabat i l'aturem (stopSlot és un no-op al motor si la veu ja no existeix, o la
  // mata si era un zombi). NOMÉS actua sobre deriva real; no toca el camí feliç.
  useEffect(() => {
    const RECONCILE_MS = 2000;
    const lastSeen = new Map(); // id -> performance.now() de l'última telemetria fresca
    const iv = setInterval(() => {
      const st = useSoundStore.getState();
      const now = performance.now();
      for (const s of st.slots) {
        if (!(s.asioActive || s.nativeActive)) { lastSeen.delete(s.id); continue; }
        if (s.pausedAt != null) { lastSeen.set(s.id, now); continue; } // pausat: sense telemetria a posta
        if (asioPosition(s.id) != null) { lastSeen.set(s.id, now); continue; } // veu sana
        // Telemetria absent: arrenca el compte des de l'última dada fresca o, si no
        // n'hi ha hagut mai, des de l'instant de dispar (startedAt, en segons).
        if (!lastSeen.has(s.id)) lastSeen.set(s.id, s.startedAt ? s.startedAt * 1000 : now);
        if (now - lastSeen.get(s.id) > RECONCILE_MS) {
          console.warn('[reconcile] cue', s.id, `sense telemetria >${RECONCILE_MS}ms → reset`);
          lastSeen.delete(s.id);
          st.stopSlot(s.id, false);
        }
      }
    }, 500);
    return () => clearInterval(iv);
  }, []);

  // En arrencar: recarrega els cues des de disc (per la ruta desada) i neteja
  // els fantasmes vells (nom sense ruta) perquè no quedin noms penjats.
  useEffect(() => {
    if (bootRestoreRan) return; // no repetir amb el doble muntatge de StrictMode
    bootRestoreRan = true;
    const slots = useSoundStore.getState().slots;
    (async () => {
      for (const s of slots) {
        if (s.filePath && !s.audioBuffer) {
          const cfg = { ...s };
          try {
            await loadFromPath(s.id, s.filePath);
            useSoundStore.getState().applySlotConfig(s.id, cfg);
          } catch {
            // C2: NO esborrem ni persistim. Marquem el slot com a "missing" per
            // indicar que el fitxer no s'ha pogut localitzar en arrencar (disc no
            // connectat, USB desendollat, NAS fora de línia...). Tota la config
            // del show (labels, volums, punts in/out, fades, colors, rutes) queda
            // intacta a localStorage fins que l'usuari torni a connectar el disc.
            useSoundStore.getState().setSlotMissing(s.id, true);
          }
        } else if (s.label && !s.filePath && !s.audioBuffer) {
          useSoundStore.getState().clearSlot(s.id); // fantasma antic sense ruta (residu buit legítim)
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

      // Canvi de vista global: 9 = CUES (grid) · 0 = Playlist (list).
      if (e.key === '9') { e.preventDefault(); store.setViewMode('grid'); return; }
      if (e.key === '0') { e.preventDefault(); store.setViewMode('list'); return; }

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

      // Slides (PDF): passa pàgina del cue de slides ACTIU a la sortida (si no sona
      // cap PDF, no fan res). Tecles directes al teclat ES/CAT, sense AltGr.
      // «.» = endarrere · «-» = endavant (acordat amb l'usuari).
      if (e.key === '.') { e.preventDefault(); store.slidePage(-1); return; }
      if (e.key === '-') { e.preventDefault(); store.slidePage(1);  return; }

      // Transport: espai = GO · enter = stop seleccionat · esc = stop tot
      if (e.key === ' ')      { e.preventDefault(); store.go(); return; }
      if (e.key === 'Enter')  { e.preventDefault(); store.stopSlot(store.selectedSlot, true); return; }
      if (e.key === 'Escape') { e.preventDefault(); store.stopAll(); return; }

      // P = pausa/reprèn el cue seleccionat (només si sona o està en pausa; no
      // engega un cue aturat, que és feina del GO / la seva tecla).
      if (e.key === 'p' || e.key === 'P') {
        const sel = store.slots.find((s) => s.id === store.selectedSlot);
        if (sel && (sel.isPlaying || sel.pausedAt != null)) {
          e.preventDefault();
          store.togglePlayPause(store.selectedSlot);
        }
        return;
      }

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
          // LIVE: carregar fitxers és una mutació → ignora el drop natiu (i el marcador).
          if (useSoundStore.getState().appMode === 'live') { setDragOverSlot(null); return; }
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
              catch (err) {
                console.warn('Error carregant', paths[i], err);
                // Fes l'error visible (abans només anava a consola): en un show ningú
                // mira la consola i un fitxer que no carrega passaria desapercebut.
                const name = (paths[i] || '').split(/[\\/]/).pop() || paths[i];
                useSoundStore.getState().pushNotification({
                  type: 'error',
                  message: `No s'ha pogut carregar «${name}»`,
                });
              }
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
    <div className={`app ${isLive ? 'live-mode' : ''}`}>
      <header className="app-header">
        {/* Brand logo: (e^P) monogram + wordmark, idèntic a ezyRider */}
        <h1 className="app-brand">
          <img src={logo} alt="ezyPlayer logo" className="brand-logo" />
          <span className="brand-name"><span className="brand-ezy">ezy</span><span className="brand-app">Player</span></span>
        </h1>

        {/* Centered view switcher */}
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

        <div className="header-controls">
          {/* EDIT ↔ LIVE (Show Mode). En LIVE, badge vermell i edició bloquejada. */}
          <button
            className={`library-btn mode-lock-btn ${isLive ? 'live' : ''}`}
            onClick={toggleAppMode}
            title={isLive ? 'LIVE — click to unlock editing' : 'Lock into LIVE mode (playback only)'}
          >
            {isLive ? '● LIVE' : 'EDIT'}
          </button>

          <button
            className={`library-btn ${outputOpen ? 'active' : ''}`}
            onClick={handleToggleOutput}
            title="Open/close the video output window"
          >
            VIDEO
          </button>

          <button className="library-btn" onClick={() => setShowSave(true)} disabled={isLive} title={isLive ? 'Locked in LIVE' : 'Files'}>FILES</button>
          <button className="library-btn" onClick={() => setShowSettings(true)}>SETTINGS</button>
          <button
            className="library-btn icon-btn"
            onClick={toggleTheme}
            title={theme === 'dark' ? 'Day mode (light)' : 'Night mode (dark)'}
          >
            {theme === 'dark' ? <Sun size={15} /> : <Moon size={15} />}
          </button>
          <button
            className={`library-btn icon-btn ${isFullscreen ? 'active' : ''}`}
            onClick={toggleFullscreen}
            title="Toggle fullscreen (F11)"
          >
            {isFullscreen ? <Minimize size={15} /> : <Maximize size={15} />}
          </button>
        </div>
      </header>

      {/* Banner demo suau: només quan el Rust reporta demo. No bloqueja res. */}
      {licenseState?.state === 'demo' && (
        <div className="demo-banner">
          <span>
            <b>Demo mode</b> — fully functional, with an occasional short mute and a
            video-output watermark.
          </span>
          <button className="demo-banner-btn" onClick={openLicenseSettings}>
            Activate license
          </button>
        </div>
      )}

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
      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} readOnly={isLive} />}

      {/* Confirmació per SORTIR de LIVE (diàleg propi; window.confirm no va a Tauri) */}
      {confirmExitLive && (
        <div className="editor-overlay" onClick={() => setConfirmExitLive(false)}>
          <div className="editor-panel" style={{ maxWidth: 380 }} onClick={(e) => e.stopPropagation()}>
            <div className="editor-header">
              <span className="editor-title">Exit LIVE mode?</span>
              <button className="editor-close" onClick={() => setConfirmExitLive(false)}>✕</button>
            </div>
            <div style={{ padding: '14px 16px' }}>
              <p style={{ marginBottom: 16, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
                Editing will be unlocked — you'll be able to move, edit, delete cues and load files again.
              </p>
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                <button className="library-btn" onClick={() => setConfirmExitLive(false)}>Stay in LIVE</button>
                <button
                  className="library-btn mode-lock-btn live"
                  onClick={() => { setAppMode('edit'); setConfirmExitLive(false); }}
                >
                  Exit LIVE
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
      <Toast />
    </div>
  );
}
