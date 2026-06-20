use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use serde::Serialize;

// Descodificació d'àudio a Rust per al render natiu de cues (només amb `asio`).
#[cfg(feature = "asio")]
mod asio_decode;

// Llegeix els bytes d'un fitxer pel seu camí absolut (per carregar àudio
// des de rutes guardades a la Library). Retorna els bytes en brut.
#[tauri::command]
fn read_file_bytes(path: String) -> Result<tauri::ipc::Response, String> {
    std::fs::read(&path)
        .map(tauri::ipc::Response::new)
        .map_err(|e| format!("No s'ha pogut llegir {}: {}", path, e))
}

#[derive(Serialize)]
struct AudioOutput {
    host: String, // "WASAPI" o "ASIO" — el backend que exposa el dispositiu
    name: String,
    max_channels: u16,
    default_channels: u16,
    default_sample_rate: u32,
    is_default: bool,
}

// Info d'un driver ASIO un cop carregat (sortides reals i freqüència).
#[derive(Serialize, Clone, Copy)]
struct AsioInfo {
    outs: u16,
    sample_rate: u32,
}

// Recull els dispositius de sortida d'un host concret i els afegeix a `out`,
// etiquetats amb el nom del backend (host_label). No falla si el host no en té.
fn collect_outputs(host: &cpal::Host, host_label: &str, out: &mut Vec<AudioOutput>) {
    let default_name = host.default_output_device().and_then(|d| d.name().ok());
    let devices = match host.output_devices() {
        Ok(d) => d,
        Err(_) => return,
    };
    for dev in devices {
        let name = dev.name().unwrap_or_else(|_| "?".into());
        let mut max_channels = 0u16;
        if let Ok(configs) = dev.supported_output_configs() {
            for c in configs {
                if c.channels() > max_channels {
                    max_channels = c.channels();
                }
            }
        }
        let (default_channels, default_sample_rate) = match dev.default_output_config() {
            Ok(c) => (c.channels(), c.sample_rate().0),
            Err(_) => (0, 0),
        };
        let is_default = default_name.as_deref() == Some(name.as_str());
        out.push(AudioOutput {
            host: host_label.to_string(),
            name,
            max_channels,
            default_channels,
            default_sample_rate,
            is_default,
        });
    }
}

// Selecciona el host de cpal pel seu nom ("ASIO" → backend ASIO; qualsevol
// altre → host per defecte, que a Windows és WASAPI).
fn select_host(host_name: &str) -> Result<cpal::Host, String> {
    match host_name {
        #[cfg(feature = "asio")]
        "ASIO" => cpal::host_from_id(cpal::HostId::Asio).map_err(|e| e.to_string()),
        _ => Ok(cpal::default_host()),
    }
}

// Llista els dispositius de sortida natius amb els seus canals REALS — per saber
// si podem fer routing multicanal / cue de debò. Inclou WASAPI i, si l'app s'ha
// compilat amb `--features asio`, també els dispositius ASIO (latència baixa).
#[tauri::command]
fn list_audio_outputs() -> Result<Vec<AudioOutput>, String> {
    // Només WASAPI: ràpid. Els dispositius ASIO s'obtenen sota demanda amb
    // `detect_asio` (carregar drivers ASIO és lent i pot bloquejar-se).
    //
    // IMPORTANT: cal enumerar en un FIL NOU. El fil de comandes de Tauri té COM
    // inicialitzat com a STA (pel WebView2) i, sota STA, l'enumeració WASAPI de
    // cpal torna BUIDA. En un fil nou sense COM previ, cpal l'inicialitza com a
    // MTA i els dispositius apareixen (com passa en un binari de consola).
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let mut out = Vec::new();
            let default = cpal::default_host();
            collect_outputs(&default, default.id().name(), &mut out);
            out
        }))
        .map_err(|_| "Pànic enumerant dispositius WASAPI.".to_string());
        let _ = tx.send(res);
    });
    rx.recv_timeout(std::time::Duration::from_secs(5))
        .map_err(|_| "Temps esgotat enumerant dispositius WASAPI.".to_string())?
}

// Llista els NOMS dels drivers ASIO registrats al sistema. Usa
// `Asio::driver_names()`, que llegeix el registre SENSE carregar cap DLL —
// per això és instantani i no es penja (a diferència d'enumerar amb cpal, que
// carrega i inicialitza tots els drivers, i un sol driver problemàtic
// —SoundGrid sense servidor, Dante sense servei, interfície desconnectada—
// bloqueja tota l'enumeració). L'usuari en tria un i només es carrega aquell.
#[tauri::command]
fn detect_asio() -> Result<Vec<AudioOutput>, String> {
    #[cfg(not(feature = "asio"))]
    {
        Err("Aquesta build no inclou ASIO (cal compilar amb --features asio).".into())
    }
    #[cfg(feature = "asio")]
    {
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                let asio = asio_sys::Asio::new();
                asio.driver_names()
            }))
            .map_err(|_| "Pànic llegint els noms dels drivers ASIO.".to_string());
            let _ = tx.send(res);
        });
        match rx.recv_timeout(std::time::Duration::from_secs(5)) {
            Ok(Ok(names)) if names.is_empty() => {
                Err("No hi ha cap driver ASIO registrat al sistema.".into())
            }
            Ok(Ok(names)) => Ok(names
                .into_iter()
                .map(|name| AudioOutput {
                    host: "ASIO".to_string(),
                    name,
                    max_channels: 0, // desconegut fins a carregar el driver
                    default_channels: 0,
                    default_sample_rate: 0,
                    is_default: false,
                })
                .collect()),
            Ok(Err(e)) => Err(e),
            Err(_) => Err("Temps esgotat llegint els noms dels drivers ASIO.".into()),
        }
    }
}

// Treu un to sinusoïdal (440 Hz) NOMÉS pel canal indicat (0-based) del
// dispositiu donat, durant `seconds`. Serveix per verificar el routing
// real per canals abans de migrar el motor d'àudio a natiu. `host` tria el
// backend ("ASIO" o WASAPI per defecte).
#[tauri::command]
fn play_test_tone(
    host: String,
    device_name: String,
    channel: u16,
    seconds: f32,
) -> Result<(), String> {
    // Tota la feina de cpal (resolució del dispositiu + stream) va en un FIL NOU:
    // el fil de comandes de Tauri és STA i l'enumeració WASAPI hi falla; en un
    // fil nou cpal inicialitza COM com a MTA. El to és "dispara i oblida"; els
    // errors es registren per stderr.
    std::thread::spawn(move || {
        let host = match select_host(&host) {
            Ok(h) => h,
            Err(e) => return eprintln!("To de prova: {}", e),
        };
        let device = match host.output_devices().map(|mut devs| {
            devs.find(|d| d.name().map(|n| n == device_name).unwrap_or(false))
        }) {
            Ok(Some(d)) => d,
            Ok(None) => return eprintln!("To de prova: dispositiu no trobat: {}", device_name),
            Err(e) => return eprintln!("To de prova: {}", e),
        };
        let supported = match device.default_output_config() {
            Ok(c) => c,
            Err(e) => return eprintln!("To de prova: {}", e),
        };
        let sample_format = supported.sample_format();
        let config: cpal::StreamConfig = supported.into();
        let channels = config.channels as usize;
        let target = channel as usize;
        if target >= channels {
            return eprintln!(
                "To de prova: el canal {} no existeix (el dispositiu en té {})",
                channel + 1,
                channels
            );
        }
        let sample_rate = config.sample_rate.0 as f32;
        let dur = seconds.max(0.1);

        let mut phase: f32 = 0.0;
        let step = 2.0 * std::f32::consts::PI * 440.0 / sample_rate;

        let err_fn = |e| eprintln!("Error stream de prova: {}", e);

        // Generador: omple frames interleaved, sinus només al canal `target`
        macro_rules! build {
            ($sample:ty, $to:expr) => {{
                let mut next = move |data: &mut [$sample]| {
                    for frame in data.chunks_mut(channels) {
                        let v = (phase.sin()) * 0.25;
                        phase += step;
                        if phase > std::f32::consts::TAU {
                            phase -= std::f32::consts::TAU;
                        }
                        for (i, s) in frame.iter_mut().enumerate() {
                            *s = $to(if i == target { v } else { 0.0 });
                        }
                    }
                };
                device.build_output_stream(
                    &config,
                    move |data: &mut [$sample], _| next(data),
                    err_fn,
                    None,
                )
            }};
        }

        let stream = match sample_format {
            cpal::SampleFormat::F32 => build!(f32, |x: f32| x),
            cpal::SampleFormat::I16 => build!(i16, |x: f32| (x * i16::MAX as f32) as i16),
            cpal::SampleFormat::U16 => {
                build!(u16, |x: f32| ((x * 0.5 + 0.5) * u16::MAX as f32) as u16)
            }
            other => {
                eprintln!("Format de mostra no suportat: {:?}", other);
                return;
            }
        };

        match stream {
            Ok(s) => {
                if let Err(e) = s.play() {
                    eprintln!("No s'ha pogut iniciar el to: {}", e);
                    return;
                }
                std::thread::sleep(std::time::Duration::from_secs_f32(dur));
                // en sortir d'aquí, `s` es destrueix i atura el so
            }
            Err(e) => eprintln!("No s'ha pogut crear l'stream: {}", e),
        }
    });

    Ok(())
}

// ───────────────────────── Motor ASIO persistent ─────────────────────────
//
// Molts drivers USB ASIO (MixPre inclòs) NO toleren un load/unload ràpid
// repetit: el segon ASIOInit es penja. Per evitar-ho, carreguem el driver UN
// sol cop i el mantenim viu en un FIL DEDICAT que n'és l'ÚNIC propietari
// (els drivers ASIO exigeixen que totes les crides vinguin del mateix fil).
// Per cada so només encenem/apaguem streams (prepare/start/stop/dispose),
// sense tornar a load/init. Per alliberar el dispositiu (i deixar-lo a WASAPI)
// cal una ordre `Release` explícita que fa destroy() del driver.

// ── Model de VEUS no bloquejant ──────────────────────────────────────────────
//
// Una `Voice` és una reproducció activa: PCM ja descodificat i resamplejat a la
// freqüència del DRIVER, planar (un Vec per canal de FONT), més els paràmetres
// de reproducció (canals destí ASIO, gain, fades, loop, segment start/stop).
// El callback `buffer_switch` (fil RT del driver) avança totes les veus i les
// mescla als canals de sortida. Les veus que acaben (i no fan loop) s'eliminen
// soles dins el callback. PlayVoice afegeix i RETORNA immediatament (no bloca).
//
// El driver es manté `start()` mentre estigui carregat (encara que no hi hagi
// veus): és el més robust amb drivers USB que no toleren start/stop repetits, i
// el cost d'un callback que escriu silenci és negligible.

// Punts d'inici/stop i fades es porten en MOSTRES (frames) a la freqüència del
// driver, perquè el callback no hagi de fer cap conversió de temps.
#[cfg(feature = "asio")]
struct Voice {
    voice_id: u64,
    // PCM planar per canal de FONT (data[ch][frame]), a la freqüència del driver.
    data: std::sync::Arc<Vec<Vec<f32>>>,
    src_channels: usize,
    // Canals de sortida ASIO destí (índexs 0-based). El mapeig font→destí és:
    //   - mono  → es replica a tots els canals destí.
    //   - estèreo (o més) → canal i de la font va a out_channels[i] (round-robin
    //     si hi ha més canals font que destí; normalment 2→2).
    out_channels: Vec<usize>,
    pos: usize,            // posició de lectura (frames), relativa a start_frame..stop_frame
    start_frame: usize,    // primer frame del segment
    stop_frame: usize,     // últim frame (exclusiu) del segment
    gain: f32,
    loop_on: bool,
    // Fades en frames. fade_in_len: rampa 0→1 des de start. fade_out_len: rampa
    // 1→0 cap al final del segment (només si no fa loop).
    fade_in_len: usize,
    fade_out_len: usize,
    // Stop amb fade-out demanat en calent: a partir de `releasing_from` (frames
    // de posició absoluta dins segment) baixem a 0 en `release_len` frames i,
    // en arribar, la veu s'elimina. None = no s'està alliberant.
    release_from: Option<usize>,
    release_len: usize,
    finished: bool,        // marcada per eliminar al final del callback
    // Pic d'amplitud (lineal, post gain/fade) de l'últim buffer mesclat. El
    // fil de telemetria el mostreja per alimentar el picòmetre de la UI.
    meter: f32,
}

#[cfg(feature = "asio")]
impl Voice {
    // Frame actual dins el segment (0 = start_frame).
    fn seg_pos(&self) -> usize {
        self.pos.saturating_sub(self.start_frame)
    }
    // Llargada del segment en frames.
    fn seg_len(&self) -> usize {
        self.stop_frame.saturating_sub(self.start_frame)
    }
}

// ── Cau de PCM descodificat (pre-decode per a dispar instantani) ─────────────
//
// Descodificar un MP3 de 2 min triga ~2 s; fer-ho a l'hora de DISPARAR introdueix
// aquesta latència al GO. La cau guarda el PCM ja descodificat i resamplejat a la
// freqüència del DRIVER, indexat per (ruta, freqüència). Així el segon cop (i el
// preload) el `PlayVoice` només clona un `Arc` i registra la veu: GO instantani.
//
// Clau = (ruta, freqüència del driver) perquè un canvi de driver amb una altra
// freqüència no reutilitzi PCM resamplejat a la freqüència anterior.
//
// Acotació: el PCM f32 ocupa molt (un cue estèreo de 2 min ≈ 42 MB). Limitem la
// cau per BYTES amb desallotjament LRU (el menys usat recentment surt primer).
// Desallotjar de la cau és SEMPRE segur encara que la veu soni: les veus actives
// tenen el seu propi clone de l'`Arc` i continuen reproduint-se.
#[cfg(feature = "asio")]
type PcmKey = (String, u32);

// Pressupost de memòria de la cau (~1,5 GB de PCM f32). En una màquina d'àudio
// pro és assumible; acota cues molt llargs i evita créixer sense límit.
#[cfg(feature = "asio")]
const PCM_CACHE_BUDGET_BYTES: usize = 1_500_000_000;

#[cfg(feature = "asio")]
struct PcmCache {
    map: std::collections::HashMap<PcmKey, std::sync::Arc<Vec<Vec<f32>>>>,
    // Ordre d'ús (front = menys usat recentment, back = més recent).
    order: std::collections::VecDeque<PcmKey>,
    bytes: usize,
}

// Bytes aproximats que ocupa un PCM planar f32.
#[cfg(feature = "asio")]
fn pcm_bytes(data: &[Vec<f32>]) -> usize {
    data.iter().map(|c| c.len() * 4).sum()
}

#[cfg(feature = "asio")]
impl PcmCache {
    fn new() -> Self {
        PcmCache {
            map: std::collections::HashMap::new(),
            order: std::collections::VecDeque::new(),
            bytes: 0,
        }
    }

    // Mou una clau al final de l'ordre (marca com a usada ara mateix).
    fn touch(&mut self, key: &PcmKey) {
        if let Some(pos) = self.order.iter().position(|k| k == key) {
            if let Some(k) = self.order.remove(pos) {
                self.order.push_back(k);
            }
        }
    }

    // Recupera (i marca com a recent) el PCM si hi és.
    fn get(&mut self, key: &PcmKey) -> Option<std::sync::Arc<Vec<Vec<f32>>>> {
        if let Some(v) = self.map.get(key).cloned() {
            self.touch(key);
            Some(v)
        } else {
            None
        }
    }

    // Insereix un PCM nou i desallotja els menys usats fins a cabre al pressupost.
    fn insert(&mut self, key: PcmKey, val: std::sync::Arc<Vec<Vec<f32>>>) {
        if self.map.contains_key(&key) {
            self.touch(&key);
            return;
        }
        self.bytes += pcm_bytes(&val);
        self.map.insert(key.clone(), val);
        self.order.push_back(key);
        self.evict();
    }

    // Desallotja des del front (LRU) mentre se superi el pressupost. Conserva
    // sempre almenys una entrada (la que s'acaba d'inserir).
    fn evict(&mut self) {
        while self.bytes > PCM_CACHE_BUDGET_BYTES && self.order.len() > 1 {
            if let Some(k) = self.order.pop_front() {
                if let Some(v) = self.map.remove(&k) {
                    self.bytes = self.bytes.saturating_sub(pcm_bytes(&v));
                }
            } else {
                break;
            }
        }
    }
}

// Obté el PCM d'un fitxer a la freqüència del driver, descodificant-lo només si
// no és a la cau. Retorna un `Arc` compartit (barat de clonar per a cada veu).
#[cfg(feature = "asio")]
fn asio_get_pcm(
    cache: &mut PcmCache,
    file_path: &str,
    rate: u32,
) -> Result<std::sync::Arc<Vec<Vec<f32>>>, String> {
    let key: PcmKey = (file_path.to_string(), rate);
    if let Some(v) = cache.get(&key) {
        return Ok(v);
    }
    let decoded = asio_decode::decode_file(file_path, rate)?;
    let arc = std::sync::Arc::new(decoded.data);
    cache.insert(key, arc.clone());
    Ok(arc)
}

// Ordres que el fil ASIO dedicat sap atendre. Cada una porta un canal de
// resposta perquè la comanda Tauri pugui esperar el resultat amb timeout.
#[cfg(feature = "asio")]
enum AsioCmd {
    // Treu un to sinus transitori pel canal indicat durant `seconds` (auto-stop).
    // Internament és una VEU generada (no bloqueja el fil).
    Tone {
        driver_name: String,
        channel: u16,
        seconds: f32,
        reply: std::sync::mpsc::Sender<Result<(), String>>,
    },
    // Reprodueix un cue real: descodifica el fitxer i registra una VEU activa.
    // No bloqueja: retorna tan bon punt la veu queda enregistrada.
    PlayVoice {
        voice_id: u64,
        driver_name: String,
        file_path: String,
        channels: Vec<u16>, // canals ASIO destí (0-based)
        gain: f32,
        fade_in: f32,       // segons
        fade_out: f32,      // segons
        loop_on: bool,
        start_point: f32,   // segons dins el fitxer
        stop_point: f32,    // segons (<=0 = fins al final)
        reply: std::sync::mpsc::Sender<Result<(), String>>,
    },
    // Atura una veu pel seu id, amb fade-out opcional (segons).
    StopVoice {
        voice_id: u64,
        fade_out: f32,
        reply: std::sync::mpsc::Sender<Result<(), String>>,
    },
    // Pre-descodifica un fitxer a la freqüència del driver i el deixa a la cau
    // (sense reproduir-lo), perquè el GO posterior sigui instantani.
    Preload {
        driver_name: String,
        file_path: String,
        reply: std::sync::mpsc::Sender<Result<(), String>>,
    },
    // Allibera completament el driver carregat (stop + dispose + destroy) i
    // deixa el dispositiu lliure perquè WASAPI hi pugui treure so.
    Release {
        reply: std::sync::mpsc::Sender<Result<(), String>>,
    },
    // Carrega el driver (si cal) i retorna les seves sortides reals i freqüència,
    // mantenint-lo carregat (per saber quants canals oferir a la UI).
    Info {
        driver_name: String,
        reply: std::sync::mpsc::Sender<Result<AsioInfo, String>>,
    },
}

// Sender únic cap al fil ASIO dedicat. S'inicialitza mandrós el primer cop
// que es demana un to o un release (arrencar el fil no carrega cap driver).
#[cfg(feature = "asio")]
static ASIO_TX: std::sync::OnceLock<std::sync::mpsc::Sender<AsioCmd>> = std::sync::OnceLock::new();

// Canal per notificar el FINAL NATURAL d'una veu (id) des del callback RT cap a
// un fil notificador que emet l'event Tauri `asio-voice-ended` a la UI. El
// callback NO pot emetre events ni bloquejar; només fa un `send` barat (només en
// acabar una veu, no cada buffer). El fil notificador (amb l'AppHandle) s'arrenca
// a `run()` via `asio_start_notifier`.
#[cfg(feature = "asio")]
static ASIO_ENDED_TX: std::sync::OnceLock<std::sync::mpsc::Sender<u64>> = std::sync::OnceLock::new();

// Notifica (sense bloquejar) que una veu ha acabat de forma natural. Si encara no
// hi ha fil notificador, l'avís simplement es descarta (no és crític).
#[cfg(feature = "asio")]
fn asio_notify_ended(voice_id: u64) {
    if let Some(tx) = ASIO_ENDED_TX.get() {
        let _ = tx.send(voice_id);
    }
}

// Un ítem de telemetria per veu activa: id del slot, posició dins el segment
// (segons) i nivell (pic d'amplitud lineal 0..1). S'emet en bloc cada ~33 ms.
#[cfg(feature = "asio")]
#[derive(Serialize)]
struct TelemetryItem {
    id: u64,
    pos: f32,
    level: f32,
}

// Estat compartit que el fil de telemetria mostreja: la llista de veus activa
// (la mateixa que el callback) i la freqüència del driver per convertir frames
// a segons. S'estableix en crear el mix i es buida en desmuntar-lo.
#[cfg(feature = "asio")]
struct AsioMeterShared {
    voices: std::sync::Arc<std::sync::Mutex<Vec<Voice>>>,
    sample_rate: u32,
}

#[cfg(feature = "asio")]
static ASIO_METER: std::sync::OnceLock<std::sync::Mutex<Option<AsioMeterShared>>> =
    std::sync::OnceLock::new();

// Accés mandrós a l'slot compartit de telemetria.
#[cfg(feature = "asio")]
fn asio_meter_slot() -> &'static std::sync::Mutex<Option<AsioMeterShared>> {
    ASIO_METER.get_or_init(|| std::sync::Mutex::new(None))
}

// Arrenca els fils auxiliars que reenvien estat del motor ASIO a la UI:
//   · `asio-notifier`  → final natural de veu (event `asio-voice-ended`).
//   · `asio-telemetry` → playhead + nivell de cada veu (event `asio-telemetry`),
//     mostrejat a ~30 Hz (NO des del callback RT: aquest només deixa el pic a
//     `voice.meter` i la posició a `voice.pos`).
// Es crida un sol cop a `run()` amb l'AppHandle. Idempotent (via ASIO_ENDED_TX).
#[cfg(feature = "asio")]
fn asio_start_notifier(app: tauri::AppHandle) {
    use tauri::Emitter;
    let (tx, rx) = std::sync::mpsc::channel::<u64>();
    if ASIO_ENDED_TX.set(tx).is_err() {
        return; // ja arrencat
    }

    // Fil notificador de finals de veu.
    let app_ended = app.clone();
    std::thread::Builder::new()
        .name("asio-notifier".into())
        .spawn(move || {
            while let Ok(voice_id) = rx.recv() {
                let _ = app_ended.emit("asio-voice-ended", voice_id);
            }
        })
        .ok();

    // Fil de telemetria (playhead + VU) a ~30 Hz.
    std::thread::Builder::new()
        .name("asio-telemetry".into())
        .spawn(move || loop {
            std::thread::sleep(std::time::Duration::from_millis(33));
            // Snapshot curt sota lock: id, posició (s) i nivell de cada veu real.
            let items: Vec<TelemetryItem> = {
                let guard = match asio_meter_slot().lock() {
                    Ok(g) => g,
                    Err(_) => continue,
                };
                match guard.as_ref() {
                    Some(sh) => {
                        let rate = sh.sample_rate.max(1) as f32;
                        match sh.voices.lock() {
                            Ok(vs) => vs
                                .iter()
                                .filter(|v| v.voice_id != u64::MAX && !v.finished)
                                .map(|v| TelemetryItem {
                                    id: v.voice_id,
                                    pos: v.seg_pos() as f32 / rate,
                                    level: v.meter,
                                })
                                .collect(),
                            Err(_) => continue,
                        }
                    }
                    None => Vec::new(),
                }
            };
            // Només emetem si hi ha veus (la UI esborra per caducitat si calla).
            if !items.is_empty() {
                let _ = app.emit("asio-telemetry", &items);
            }
        })
        .ok();
}

// Estat de l'STREAM de mescla actiu: l'AsioStreams (buffers de sortida), el
// tipus de mostra del driver, la mida de buffer, el nombre de canals preparats,
// la freqüència, l'id del callback i la llista de VEUS actives compartida amb el
// callback. Tot dins Arc/Mutex perquè el callback (fil RT) hi pugui accedir.
#[cfg(feature = "asio")]
struct AsioMix {
    // `streams` cal MANTENIR-LO VIU aquí: el callback en té un clone de l'Arc,
    // però si aquest handle es deixés caure abans del teardown, el Mutex podria
    // alliberar-se mentre el driver encara crida el callback. No s'hi llegeix
    // directament des d'aquí (per això l'allow), però la seva propietat importa.
    #[allow(dead_code)]
    streams: std::sync::Arc<std::sync::Mutex<asio_sys::AsioStreams>>,
    voices: std::sync::Arc<std::sync::Mutex<Vec<Voice>>>,
    callback_id: asio_sys::CallbackId,
    // Guardats per a depuració/futur (telemetria, re-prepare): el callback ja en
    // té còpies pròpies, així que aquí no es llegeixen.
    #[allow(dead_code)]
    data_type: asio_sys::AsioSampleType,
    #[allow(dead_code)]
    buffer_size: usize,
    num_channels: usize, // canals de sortida preparats (= sortides del driver)
    sample_rate: u32,
}

// Estat propietari del fil ASIO: el driver carregat (si n'hi ha), amb el seu
// `Asio` i el nom. Mantenir `Asio` viu evita que el seu `Weak<DriverInner>`
// es perdi; mantenir el `Driver` original (sense clonar-lo) garanteix que
// `destroy()` pugui consumir l'únic `Arc` i cridar ASIOExit de debò.
// `mix` és l'stream de mescla persistent (None fins que s'arrenca).
#[cfg(feature = "asio")]
struct AsioLoaded {
    asio: asio_sys::Asio,
    driver: asio_sys::Driver,
    name: String,
    mix: Option<AsioMix>,
}

// Atura i desmunta l'stream de mescla d'un driver (stop + remove_callback +
// dispose_buffers). Deixa el driver en estat Initialized, llest per re-preparar.
#[cfg(feature = "asio")]
fn asio_teardown_mix(l: &mut AsioLoaded) {
    if let Some(mix) = l.mix.take() {
        // Deixa de publicar telemetria d'aquest mix abans de desmuntar-lo.
        if let Ok(mut g) = asio_meter_slot().lock() {
            *g = None;
        }
        let _ = l.driver.stop();
        l.driver.remove_callback(mix.callback_id);
        let _ = l.driver.dispose_buffers();
        // Buida les veus (l'Arc del callback ja no s'invocarà).
        if let Ok(mut v) = mix.voices.lock() {
            v.clear();
        }
    }
}

// Allibera el driver carregat (si n'hi ha) des del fil ASIO. Torna el resultat
// del destroy per informar-ne. És idempotent: si no hi ha res, no fa res.
#[cfg(feature = "asio")]
fn asio_release_loaded(loaded: &mut Option<AsioLoaded>) -> Result<(), String> {
    if let Some(mut l) = loaded.take() {
        asio_teardown_mix(&mut l);
        let _ = l.driver.stop();
        let _ = l.driver.dispose_buffers();
        match l.driver.destroy() {
            // false → encara queda un altre handle del driver viu (no hauria
            // de passar: no en clonem cap). Ho reportem perquè es vegi.
            Ok(true) => {}
            Ok(false) => {
                drop(l.asio);
                return Err("El driver no s'ha pogut destruir (encara hi ha un handle viu).".into());
            }
            Err(e) => {
                drop(l.asio);
                return Err(format!("destroy(): {:?}", e));
            }
        }
        drop(l.asio);
    }
    Ok(())
}

// Assegura que el driver demanat està carregat (canviant-lo si cal) i el manté.
// Centralitza la lògica de càrrega que comparteixen el to i la info.
#[cfg(feature = "asio")]
fn asio_ensure_loaded(loaded: &mut Option<AsioLoaded>, driver_name: &str) -> Result<(), String> {
    if let Some(l) = loaded.as_ref() {
        if l.name != driver_name {
            asio_release_loaded(loaded)?;
        }
    }
    if loaded.is_none() {
        let asio = asio_sys::Asio::new();
        let driver = asio
            .load_driver(driver_name)
            .map_err(|e| format!("No s'ha pogut carregar '{}': {}", driver_name, e))?;
        *loaded = Some(AsioLoaded {
            asio,
            driver,
            name: driver_name.to_string(),
            mix: None,
        });
    }
    Ok(())
}

// Carrega el driver (si cal) i retorna les seves sortides reals i freqüència.
#[cfg(feature = "asio")]
fn asio_do_info(loaded: &mut Option<AsioLoaded>, driver_name: &str) -> Result<AsioInfo, String> {
    asio_ensure_loaded(loaded, driver_name)?;
    let driver = &loaded.as_ref().unwrap().driver;
    let outs = driver.channels().map_err(|e| format!("channels(): {:?}", e))?.outs as u16;
    let sample_rate = driver.sample_rate().map_err(|e| format!("sample_rate(): {:?}", e))? as u32;
    Ok(AsioInfo { outs, sample_rate })
}

// Escriu un buffer f32 mesclat [-1,1] al buffer d'un canal ASIO, limitant
// (clip) i convertint al tipus de mostra natiu del driver. `mix` ha de tenir
// exactament `n` mostres. Complementa `asio_write_sine` (mateixos tipus).
#[cfg(feature = "asio")]
unsafe fn asio_write_mix(
    ptr: *mut std::ffi::c_void,
    mix: &[f32],
    dt: &asio_sys::AsioSampleType,
) {
    use asio_sys::AsioSampleType as T;
    let n = mix.len();
    let cl = |x: f32| x.clamp(-1.0, 1.0);
    match dt {
        T::ASIOSTInt32LSB => {
            let s = std::slice::from_raw_parts_mut(ptr as *mut i32, n);
            for (d, &v) in s.iter_mut().zip(mix) {
                *d = (cl(v) * 2_147_483_647.0) as i32;
            }
        }
        T::ASIOSTInt16LSB => {
            let s = std::slice::from_raw_parts_mut(ptr as *mut i16, n);
            for (d, &v) in s.iter_mut().zip(mix) {
                *d = (cl(v) * 32_767.0) as i16;
            }
        }
        T::ASIOSTFloat32LSB => {
            let s = std::slice::from_raw_parts_mut(ptr as *mut f32, n);
            for (d, &v) in s.iter_mut().zip(mix) {
                *d = cl(v);
            }
        }
        T::ASIOSTInt24LSB => {
            let b = std::slice::from_raw_parts_mut(ptr as *mut u8, n * 3);
            for (i, &v) in mix.iter().enumerate() {
                let q = (cl(v) * 8_388_607.0) as i32;
                b[i * 3] = (q & 0xff) as u8;
                b[i * 3 + 1] = ((q >> 8) & 0xff) as u8;
                b[i * 3 + 2] = ((q >> 16) & 0xff) as u8;
            }
        }
        _ => {}
    }
}

// Assegura que l'STREAM de mescla persistent està arrencat per al driver
// carregat. Prepara TOTS els canals de sortida del driver un sol cop, registra
// el callback de mescla (que consumeix la llista de veus compartida) i fa
// start(). Idempotent: si ja hi ha mix, no fa res. Retorna (sample_rate, outs).
#[cfg(feature = "asio")]
fn asio_ensure_mix(loaded: &mut Option<AsioLoaded>, driver_name: &str) -> Result<(u32, usize), String> {
    use asio_sys::AsioSampleType as T;
    use std::sync::{Arc, Mutex};

    asio_ensure_loaded(loaded, driver_name)?;
    let l = loaded.as_mut().unwrap();

    if let Some(mix) = l.mix.as_ref() {
        return Ok((mix.sample_rate, mix.num_channels));
    }

    let driver = &l.driver;
    let outs = driver.channels().map_err(|e| format!("channels(): {:?}", e))?.outs as usize;
    if outs == 0 {
        return Err("El driver no té canals de sortida.".into());
    }
    let sample_rate = driver.sample_rate().map_err(|e| format!("sample_rate(): {:?}", e))? as u32;
    let data_type = driver.output_data_type().map_err(|e| format!("output_data_type(): {:?}", e))?;
    match data_type {
        T::ASIOSTInt32LSB | T::ASIOSTInt16LSB | T::ASIOSTFloat32LSB | T::ASIOSTInt24LSB => {}
        other => return Err(format!("Tipus de mostra ASIO no suportat (de moment): {:?}", other)),
    }

    // Preparem TOTS els canals de sortida (perquè qualsevol routing hi càpiga).
    let streams = driver
        .prepare_output_stream(None, outs, None)
        .map_err(|e| format!("prepare_output_stream(): {:?}", e))?;
    let buffer_size = match streams.output.as_ref() {
        Some(o) => o.buffer_size as usize,
        None => return Err("El driver no ha donat stream de sortida.".into()),
    };
    let streams = Arc::new(Mutex::new(streams));
    let voices: Arc<Mutex<Vec<Voice>>> = Arc::new(Mutex::new(Vec::new()));

    let cb_streams = streams.clone();
    let cb_voices = voices.clone();
    // `AsioSampleType` no és Copy/Clone: en demanem una còpia pròpia per al
    // callback (consulta barata) i deixem `data_type` per guardar a `AsioMix`.
    let cb_dt = driver.output_data_type().map_err(|e| format!("output_data_type(): {:?}", e))?;
    let num = outs;

    // Callback de mescla (fil RT del driver). Per cada buffer:
    //   1. zera un buffer acumulador per canal de sortida (num × buffer_size).
    //   2. avança i mescla cada veu activa (gain · fade) als seus canals destí.
    //   3. escriu cada acumulador al buffer ASIO natiu (amb clip + conversió).
    // Locks curts (Mutex de veus i de streams), acceptable a aquesta escala.
    let callback_id = driver.add_callback(move |info: &asio_sys::CallbackInfo| {
        let bi = info.buffer_index as usize;
        let mut lock = match cb_streams.lock() { Ok(l) => l, Err(_) => return };
        let stream = match lock.output { Some(ref mut s) => s, None => return };

        // Acumuladors per canal de sortida (planar).
        let mut acc: Vec<Vec<f32>> = vec![vec![0.0f32; buffer_size]; num];

        if let Ok(mut voices) = cb_voices.lock() {
            for voice in voices.iter_mut() {
                asio_mix_voice(voice, &mut acc, buffer_size);
            }
            // Notifica el final natural de cada veu acabada (id real, no el to de
            // prova u64::MAX) abans d'eliminar-la, perquè la UI reseteji el tile.
            for v in voices.iter() {
                if v.finished && v.voice_id != u64::MAX {
                    asio_notify_ended(v.voice_id);
                }
            }
            // Elimina les veus acabades (final natural sense loop, o release fet).
            voices.retain(|v| !v.finished);
        }

        // Bolca els acumuladors als buffers ASIO natius.
        unsafe {
            for ch in 0..num {
                let ptr = stream.buffer_infos[ch].buffers[bi];
                asio_write_mix(ptr, &acc[ch], &cb_dt);
            }
        }
    });

    if let Err(e) = driver.start() {
        driver.remove_callback(callback_id);
        let _ = driver.dispose_buffers();
        return Err(format!("start(): {:?}", e));
    }

    // Publica la llista de veus i la freqüència perquè el fil de telemetria les
    // mostregi (playhead + VU) sense tocar el callback RT.
    if let Ok(mut g) = asio_meter_slot().lock() {
        *g = Some(AsioMeterShared { voices: voices.clone(), sample_rate });
    }

    l.mix = Some(AsioMix {
        streams,
        voices,
        callback_id,
        data_type,
        buffer_size,
        num_channels: outs,
        sample_rate,
    });
    Ok((sample_rate, outs))
}

// Avança una veu `buffer_size` frames i la mescla als acumuladors de sortida.
// Aplica gain, fade in/out i, si s'està alliberant (release), la rampa de stop.
// Marca `finished` si la veu arriba al final (i no fa loop) o acaba el release.
#[cfg(feature = "asio")]
fn asio_mix_voice(voice: &mut Voice, acc: &mut [Vec<f32>], buffer_size: usize) {
    if voice.finished {
        return;
    }
    let seg_len = voice.seg_len();
    if seg_len == 0 {
        voice.finished = true;
        return;
    }
    let data = voice.data.clone();
    let src_ch = voice.src_channels.max(1);
    let mut peak = 0.0f32; // pic d'amplitud d'aquest buffer (per al picòmetre)

    for i in 0..buffer_size {
        // Final del segment?
        if voice.pos >= voice.stop_frame {
            if voice.loop_on && voice.release_from.is_none() {
                voice.pos = voice.start_frame; // reinicia el segment
            } else {
                voice.finished = true;
                break;
            }
        }

        let seg_pos = voice.seg_pos();

        // Envolupant de fade (multiplicador 0..1).
        let mut env = 1.0f32;
        if voice.fade_in_len > 0 && seg_pos < voice.fade_in_len {
            env *= seg_pos as f32 / voice.fade_in_len as f32;
        }
        if !voice.loop_on && voice.fade_out_len > 0 {
            let from = seg_len.saturating_sub(voice.fade_out_len);
            if seg_pos >= from {
                let into = seg_pos - from;
                env *= 1.0 - (into as f32 / voice.fade_out_len as f32).min(1.0);
            }
        }
        // Release (stop amb fade en calent): rampa addicional cap a 0.
        if let Some(rfrom) = voice.release_from {
            if seg_pos >= rfrom {
                let into = seg_pos - rfrom;
                if voice.release_len == 0 || into >= voice.release_len {
                    voice.finished = true;
                    break;
                }
                env *= 1.0 - into as f32 / voice.release_len as f32;
            }
        }

        let g = voice.gain * env;
        let frame = voice.pos;

        // Mescla la font cap als canals destí.
        for (di, &out_ch) in voice.out_channels.iter().enumerate() {
            if out_ch >= acc.len() {
                continue;
            }
            // Mono → replica a tots; multicanal → canal di (round-robin sobre src).
            let s = if src_ch == 1 {
                data[0].get(frame).copied().unwrap_or(0.0)
            } else {
                let sc = di % src_ch;
                data[sc].get(frame).copied().unwrap_or(0.0)
            };
            let out = s * g;
            let a = out.abs();
            if a > peak {
                peak = a;
            }
            acc[out_ch][i] += out;
        }

        voice.pos += 1;
    }

    voice.meter = peak;
}

// Construeix i registra una VEU a partir d'un fitxer descodificat. No bloca.
#[cfg(feature = "asio")]
#[allow(clippy::too_many_arguments)]
fn asio_play_voice_impl(
    loaded: &mut Option<AsioLoaded>,
    cache: &mut PcmCache,
    voice_id: u64,
    driver_name: &str,
    file_path: &str,
    channels: &[u16],
    gain: f32,
    fade_in: f32,
    fade_out: f32,
    loop_on: bool,
    start_point: f32,
    stop_point: f32,
) -> Result<(), String> {
    let (sample_rate, outs) = asio_ensure_mix(loaded, driver_name)?;

    // Canals destí vàlids (descarta els que excedeixen les sortides del driver).
    let out_channels: Vec<usize> = channels
        .iter()
        .map(|&c| c as usize)
        .filter(|&c| c < outs)
        .collect();
    if out_channels.is_empty() {
        return Err(format!(
            "Cap canal destí vàlid (el driver té {} sortides).",
            outs
        ));
    }

    // PCM de la cau (pre-descodificat) o descodifica+resampleja si no hi és.
    let data = asio_get_pcm(cache, file_path, sample_rate)?;
    let total = data.iter().map(|c| c.len()).max().unwrap_or(0);
    let src_channels = data.len();

    // Segment en frames.
    let sr = sample_rate as f32;
    let start_frame = ((start_point.max(0.0)) * sr) as usize;
    let start_frame = start_frame.min(total);
    let stop_frame = if stop_point > 0.0 {
        ((stop_point * sr) as usize).min(total)
    } else {
        total
    };
    let stop_frame = stop_frame.max(start_frame + 1).min(total.max(start_frame + 1));

    let seg_len = stop_frame.saturating_sub(start_frame);
    let fade_in_len = ((fade_in.max(0.0) * sr) as usize).min(seg_len);
    let fade_out_len = ((fade_out.max(0.0) * sr) as usize).min(seg_len);

    let voice = Voice {
        voice_id,
        data,
        src_channels,
        out_channels,
        pos: start_frame,
        start_frame,
        stop_frame,
        gain: gain.max(0.0),
        loop_on,
        fade_in_len,
        fade_out_len,
        release_from: None,
        release_len: 0,
        finished: false,
        meter: 0.0,
    };

    let mix = loaded.as_ref().unwrap().mix.as_ref().unwrap();
    let mut voices = mix.voices.lock().map_err(|_| "lock de veus enverinat")?;
    // Si ja hi havia una veu amb aquest id (re-disparo), la substituïm.
    voices.retain(|v| v.voice_id != voice_id);
    voices.push(voice);
    Ok(())
}

// Pre-descodifica un fitxer i el deixa a la cau, SENSE reproduir-lo. Carrega el
// driver demanat (si cal) només per conèixer-ne la freqüència i descodificar-hi
// al rate correcte; no engega cap stream de mescla. El GO posterior d'aquest cue
// trobarà el PCM a la cau i serà instantani.
#[cfg(feature = "asio")]
fn asio_preload_impl(
    loaded: &mut Option<AsioLoaded>,
    cache: &mut PcmCache,
    driver_name: &str,
    file_path: &str,
) -> Result<(), String> {
    // Necessitem la freqüència del driver per descodificar al rate definitiu.
    let info = asio_do_info(loaded, driver_name)?;
    asio_get_pcm(cache, file_path, info.sample_rate)?;
    Ok(())
}

// Atura una veu pel seu id. Amb fade_out > 0, n'inicia la rampa de release des
// de la posició actual; amb 0, l'elimina immediatament.
#[cfg(feature = "asio")]
fn asio_stop_voice_impl(
    loaded: &mut Option<AsioLoaded>,
    voice_id: u64,
    fade_out: f32,
) -> Result<(), String> {
    let l = match loaded.as_ref() {
        Some(l) => l,
        None => return Ok(()), // res carregat: res a aturar
    };
    let mix = match l.mix.as_ref() {
        Some(m) => m,
        None => return Ok(()),
    };
    let sr = mix.sample_rate as f32;
    let mut voices = mix.voices.lock().map_err(|_| "lock de veus enverinat")?;
    if fade_out > 0.0 {
        let rel = (fade_out * sr) as usize;
        for v in voices.iter_mut() {
            if v.voice_id == voice_id && v.release_from.is_none() {
                v.release_from = Some(v.seg_pos());
                v.release_len = rel.max(1);
                v.loop_on = false; // un release acaba la veu encara que fes loop
            }
        }
    } else {
        voices.retain(|v| v.voice_id != voice_id);
    }
    Ok(())
}

// To de prova com a VEU transitòria (sinus 440 Hz generat, auto-stop després de
// `seconds`). NO bloqueja el fil: genera un PCM curt i el registra com a veu.
#[cfg(feature = "asio")]
fn asio_do_tone(
    loaded: &mut Option<AsioLoaded>,
    driver_name: &str,
    channel: u16,
    seconds: f32,
) -> Result<(), String> {
    let (sample_rate, outs) = asio_ensure_mix(loaded, driver_name)?;
    let target = channel as usize;
    if target >= outs {
        return Err(format!("El canal {} no existeix (el driver té {} sortides)", channel + 1, outs));
    }
    let sr = sample_rate as f32;
    let frames = (seconds.max(0.1) * sr) as usize;
    let step = 2.0 * std::f32::consts::PI * 440.0 / sr;
    let mut buf = Vec::with_capacity(frames);
    for i in 0..frames {
        buf.push((step * i as f32).sin() * 0.2);
    }
    let data = std::sync::Arc::new(vec![buf]);
    let voice = Voice {
        voice_id: u64::MAX, // id reservat per als tons de prova
        data,
        src_channels: 1,
        out_channels: vec![target],
        pos: 0,
        start_frame: 0,
        stop_frame: frames,
        gain: 1.0,
        loop_on: false,
        fade_in_len: 0,
        fade_out_len: (0.01 * sr) as usize, // micro-fade out per evitar el clic final
        release_from: None,
        release_len: 0,
        finished: false,
        meter: 0.0,
    };
    let mix = loaded.as_ref().unwrap().mix.as_ref().unwrap();
    let mut voices = mix.voices.lock().map_err(|_| "lock de veus enverinat")?;
    voices.retain(|v| v.voice_id != u64::MAX);
    voices.push(voice);
    Ok(())
}

// Bucle del fil ASIO dedicat: rep ordres pel canal i les atén una a una,
// mantenint el driver carregat entre tons. En sortir el bucle (canal tancat),
// allibera el driver. Aïllem cada ordre amb `catch_unwind` perquè un driver
// dolent no mati el fil i deixi el dispositiu segrestat.
#[cfg(feature = "asio")]
fn asio_thread_main(rx: std::sync::mpsc::Receiver<AsioCmd>) {
    let mut loaded: Option<AsioLoaded> = None;
    // Cau de PCM descodificat, propietat exclusiva d'aquest fil (sense locks).
    let mut cache = PcmCache::new();
    while let Ok(cmd) = rx.recv() {
        match cmd {
            AsioCmd::Tone { driver_name, channel, seconds, reply } => {
                let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    asio_do_tone(&mut loaded, &driver_name, channel, seconds)
                }))
                .unwrap_or_else(|_| Err("Pànic processant el to ASIO.".into()));
                let _ = reply.send(res);
            }
            AsioCmd::PlayVoice {
                voice_id, driver_name, file_path, channels, gain,
                fade_in, fade_out, loop_on, start_point, stop_point, reply,
            } => {
                let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    asio_play_voice_impl(
                        &mut loaded, &mut cache, voice_id, &driver_name, &file_path, &channels,
                        gain, fade_in, fade_out, loop_on, start_point, stop_point,
                    )
                }))
                .unwrap_or_else(|_| Err("Pànic reproduint la veu ASIO.".into()));
                let _ = reply.send(res);
            }
            AsioCmd::Preload { driver_name, file_path, reply } => {
                let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    asio_preload_impl(&mut loaded, &mut cache, &driver_name, &file_path)
                }))
                .unwrap_or_else(|_| Err("Pànic pre-descodificant la veu ASIO.".into()));
                let _ = reply.send(res);
            }
            AsioCmd::StopVoice { voice_id, fade_out, reply } => {
                let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    asio_stop_voice_impl(&mut loaded, voice_id, fade_out)
                }))
                .unwrap_or_else(|_| Err("Pànic aturant la veu ASIO.".into()));
                let _ = reply.send(res);
            }
            AsioCmd::Release { reply } => {
                let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    asio_release_loaded(&mut loaded)
                }))
                .unwrap_or_else(|_| Err("Pànic alliberant el driver ASIO.".into()));
                let _ = reply.send(res);
            }
            AsioCmd::Info { driver_name, reply } => {
                let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    asio_do_info(&mut loaded, &driver_name)
                }))
                .unwrap_or_else(|_| Err("Pànic carregant el driver ASIO.".into()));
                let _ = reply.send(res);
            }
        }
    }
    // Canal tancat: alliberem el driver abans de morir el fil.
    let _ = asio_release_loaded(&mut loaded);
}

// Retorna el sender cap al fil ASIO, arrencant-lo mandrós el primer cop.
#[cfg(feature = "asio")]
fn asio_sender() -> &'static std::sync::mpsc::Sender<AsioCmd> {
    ASIO_TX.get_or_init(|| {
        let (tx, rx) = std::sync::mpsc::channel::<AsioCmd>();
        std::thread::Builder::new()
            .name("asio-engine".into())
            .spawn(move || asio_thread_main(rx))
            .expect("no s'ha pogut arrencar el fil ASIO");
        tx
    })
}

// Treu un to de prova per un driver ASIO concret. El driver es carrega un sol
// cop i es manté viu al fil dedicat; les crides successives només encenen
// streams (sense re-load), cosa que evita el hang dels drivers USB ASIO.
#[tauri::command]
fn asio_test_tone(driver_name: String, channel: u16, seconds: f32) -> Result<(), String> {
    #[cfg(not(feature = "asio"))]
    {
        let _ = (driver_name, channel, seconds);
        Err("Aquesta build no inclou ASIO (cal compilar amb --features asio).".into())
    }
    #[cfg(feature = "asio")]
    {
        let (reply_tx, reply_rx) = std::sync::mpsc::channel();
        asio_sender()
            .send(AsioCmd::Tone { driver_name, channel, seconds, reply: reply_tx })
            .map_err(|_| "El fil ASIO no està disponible.".to_string())?;
        // El to ara és una veu transitòria: el fil respon de seguida (no bloca
        // `seconds`). Esperem només el registre de la veu.
        match reply_rx.recv_timeout(std::time::Duration::from_secs(10)) {
            Ok(res) => res,
            Err(_) => Err("Temps esgotat o error processant el to ASIO.".into()),
        }
    }
}

// Reprodueix un cue real pel motor ASIO: descodifica el fitxer a Rust i registra
// una VEU activa que el callback mescla cap als canals destí. No bloca: torna tan
// bon punt la veu queda registrada (la descodificació passa al fil ASIO).
#[tauri::command]
#[allow(clippy::too_many_arguments)]
fn asio_play_voice(
    voice_id: u64,
    driver: String,
    file_path: String,
    channels: Vec<u16>,
    gain: f32,
    fade_in: f32,
    fade_out: f32,
    loop_on: bool,
    start_point: f32,
    stop_point: f32,
) -> Result<(), String> {
    #[cfg(not(feature = "asio"))]
    {
        let _ = (voice_id, driver, file_path, channels, gain, fade_in, fade_out, loop_on, start_point, stop_point);
        Err("Aquesta build no inclou ASIO (cal compilar amb --features asio).".into())
    }
    #[cfg(feature = "asio")]
    {
        let (reply_tx, reply_rx) = std::sync::mpsc::channel();
        asio_sender()
            .send(AsioCmd::PlayVoice {
                voice_id, driver_name: driver, file_path, channels, gain,
                fade_in, fade_out, loop_on, start_point, stop_point, reply: reply_tx,
            })
            .map_err(|_| "El fil ASIO no està disponible.".to_string())?;
        // Marge ampli: inclou descodificar + resamplejar el fitxer.
        match reply_rx.recv_timeout(std::time::Duration::from_secs(30)) {
            Ok(res) => res,
            Err(_) => Err("Temps esgotat o error reproduint la veu ASIO.".into()),
        }
    }
}

// Pre-descodifica un cue a la cau del motor ASIO (sense reproduir-lo), perquè el
// GO posterior sigui instantani. S'hi crida en carregar/armar un cue amb routing
// ASIO. És idempotent: si ja és a la cau, no fa res costós.
#[tauri::command]
fn asio_preload(driver: String, file_path: String) -> Result<(), String> {
    #[cfg(not(feature = "asio"))]
    {
        let _ = (driver, file_path);
        Err("Aquesta build no inclou ASIO (cal compilar amb --features asio).".into())
    }
    #[cfg(feature = "asio")]
    {
        let (reply_tx, reply_rx) = std::sync::mpsc::channel();
        asio_sender()
            .send(AsioCmd::Preload { driver_name: driver, file_path, reply: reply_tx })
            .map_err(|_| "El fil ASIO no està disponible.".to_string())?;
        // Marge ampli: inclou descodificar + resamplejar el fitxer sencer.
        match reply_rx.recv_timeout(std::time::Duration::from_secs(60)) {
            Ok(res) => res,
            Err(_) => Err("Temps esgotat o error pre-descodificant la veu ASIO.".into()),
        }
    }
}

// Atura una veu ASIO pel seu id, amb fade-out opcional (segons).
#[tauri::command]
fn asio_stop_voice(voice_id: u64, fade_out: f32) -> Result<(), String> {
    #[cfg(not(feature = "asio"))]
    {
        let _ = (voice_id, fade_out);
        Err("Aquesta build no inclou ASIO (cal compilar amb --features asio).".into())
    }
    #[cfg(feature = "asio")]
    {
        let (reply_tx, reply_rx) = std::sync::mpsc::channel();
        asio_sender()
            .send(AsioCmd::StopVoice { voice_id, fade_out, reply: reply_tx })
            .map_err(|_| "El fil ASIO no està disponible.".to_string())?;
        match reply_rx.recv_timeout(std::time::Duration::from_secs(10)) {
            Ok(res) => res,
            Err(_) => Err("Temps esgotat o error aturant la veu ASIO.".into()),
        }
    }
}

// Allibera el driver ASIO carregat (stop + dispose + destroy) i deixa el
// dispositiu lliure perquè WASAPI hi pugui treure so. Cal cridar-la quan es
// vol tornar a fer servir la interfície fora d'ASIO.
// Carrega un driver ASIO (mantenint-lo viu al fil) i retorna les seves sortides
// reals i freqüència, per oferir a la UI tots els canals (p. ex. la MixPre en té 4).
#[tauri::command]
fn asio_load(driver_name: String) -> Result<AsioInfo, String> {
    #[cfg(not(feature = "asio"))]
    {
        let _ = driver_name;
        Err("Aquesta build no inclou ASIO (cal compilar amb --features asio).".into())
    }
    #[cfg(feature = "asio")]
    {
        let (reply_tx, reply_rx) = std::sync::mpsc::channel();
        asio_sender()
            .send(AsioCmd::Info { driver_name, reply: reply_tx })
            .map_err(|_| "El fil ASIO no està disponible.".to_string())?;
        match reply_rx.recv_timeout(std::time::Duration::from_secs(10)) {
            Ok(res) => res,
            Err(_) => Err("Temps esgotat carregant el driver ASIO.".into()),
        }
    }
}

#[tauri::command]
fn asio_release() -> Result<(), String> {
    #[cfg(not(feature = "asio"))]
    {
        Err("Aquesta build no inclou ASIO (cal compilar amb --features asio).".into())
    }
    #[cfg(feature = "asio")]
    {
        let (reply_tx, reply_rx) = std::sync::mpsc::channel();
        asio_sender()
            .send(AsioCmd::Release { reply: reply_tx })
            .map_err(|_| "El fil ASIO no està disponible.".to_string())?;
        match reply_rx.recv_timeout(std::time::Duration::from_secs(10)) {
            Ok(res) => res,
            Err(_) => Err("Temps esgotat alliberant el driver ASIO.".into()),
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            use tauri::Manager;
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.set_min_size(Some(tauri::LogicalSize::new(1000.0, 640.0)));
                // Arrenca maximitzada (ocupa tota la pantalla, sense retalls)
                let _ = win.maximize();
            }
            // Fil notificador de finals de veu ASIO → events Tauri cap a la UI.
            #[cfg(feature = "asio")]
            asio_start_notifier(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            read_file_bytes,
            list_audio_outputs,
            detect_asio,
            play_test_tone,
            asio_test_tone,
            asio_play_voice,
            asio_preload,
            asio_stop_voice,
            asio_load,
            asio_release
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
