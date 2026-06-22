use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use serde::Serialize;

// Descodificació d'àudio a Rust per al render natiu de cues. Part del nucli
// reutilitzable: disponible amb `native` (i, per implicació, amb `asio`).
#[cfg(feature = "native")]
mod asio_decode;

// Descodificació en STREAMING (decode-ahead) per a pistes llargues. De moment
// només la consumeix el motor ASIO (les veus en streaming són ASIO-específiques);
// el backend cpal de l'increment 1 encara no fa streaming.
#[cfg(feature = "asio")]
mod asio_stream;

// Backend de sortida natiu basat en cpal (host per defecte: WASAPI a Windows,
// CoreAudio a Mac). Reutilitza el nucli de veus (`Voice` + `asio_mix_voice`).
#[cfg(feature = "native")]
mod native_output;

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

// Driver ASIO carregat ARA (nom + info), per refrescar la UI en reobrir Settings.
#[cfg(feature = "asio")]
#[derive(Serialize, Clone)]
struct AsioLoadedInfo {
    name: String,
    outs: u16,
    sample_rate: u32,
}

// Stub sense la feature `asio`: la firma d'asio_loaded_info referencia aquest
// tipus sempre (els tipus de retorn es compilen independentment del cfg del cos),
// així que en builds --no-default-features ha d'existir igualment. Mai s'instancia
// (la branca not(asio) retorna Ok(None)).
#[cfg(not(feature = "asio"))]
#[derive(Serialize, Clone)]
struct AsioLoadedInfo;

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
//
// NUCLI reutilitzable (feature `native`): tant el callback ASIO com el backend
// cpal mesclen aquestes veus amb `asio_mix_voice`. Els camps i la semàntica són
// independents del backend de sortida (els "out_channels" són índexs de canal de
// sortida, els interpreti qui els interpreti).
#[cfg(feature = "native")]
struct Voice {
    // `allow(dead_code)`: el camí ASIO l'usa per identificar/aturar veus; el
    // backend cpal de l'increment 1 (model d'una sola veu) encara no el llegeix.
    #[allow(dead_code)]
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
    // Pausa: la veu es manté viva però el callback escriu silenci i NO avança
    // `pos`, de manera que el resume continua exactament des d'on s'havia pausat.
    paused: bool,
    // Pic d'amplitud (lineal, post gain/fade) de l'últim buffer mesclat. El
    // fil de telemetria el mostreja per alimentar el picòmetre de la UI.
    meter: f32,
}

#[cfg(feature = "native")]
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

// ── Veu en STREAMING (decode-ahead) ──────────────────────────────────────────
// Per a pistes llargues: en comptes de tenir tot el PCM a `data`, llegeix d'un
// ring buffer que un fil descodificador va omplint (asio_stream). El callback
// resampleja al consumidor (interpolació lineal) a la freqüència del driver.
#[cfg(feature = "asio")]
struct StreamVoice {
    voice_id: u64,
    ring: std::sync::Arc<std::sync::Mutex<asio_stream::StreamRing>>,
    ctrl: std::sync::Arc<asio_stream::StreamCtrl>,
    out_channels: Vec<usize>,
    driver_rate: u32,
    gain: f32,
    fade_in_len: usize, // frames de sortida (driver rate)
    played_out: usize,  // frames de sortida consumits (per a fades i telemetria)
    frac: f64,          // posició fraccionària dins el frame de FONT actual
    // Segment (punts d'edició del cue) i loop, en temps de FONT (segons).
    start_secs: f64,    // inici del tram (per re-seek en loop)
    stop_secs: f64,     // out-point (0 = fins al final del fitxer)
    loop_on: bool,
    fade_out_secs: f64, // fade cap a l'out-point (només sense loop)
    src_consumed: usize, // frames de FONT consumits dins el tram actual
    file_rate: u32,     // freqüència del fitxer (0 fins que el callback la sap)
    release_from: Option<usize>,
    release_len: usize,
    paused: bool,
    finished: bool,
    meter: f32,
}

// Mescla una veu de streaming als acumuladors de sortida. Llegeix del ring amb
// interpolació lineal (resample file_rate → driver_rate). Marca `finished` en
// arribar al final (eof i buit) o en acabar el release; aleshores atura el fil
// descodificador. Underrun (buffer buit sense eof) → silenci sense avançar.
#[cfg(feature = "asio")]
fn asio_mix_stream_voice(v: &mut StreamVoice, acc: &mut [Vec<f32>], buffer_size: usize) {
    use std::sync::atomic::Ordering;
    if v.finished {
        return;
    }
    if v.paused {
        v.meter = 0.0;
        return;
    }
    let mut ring = match v.ring.lock() {
        Ok(r) => r,
        Err(_) => return,
    };
    let ch = ring.channels;
    let file_rate = ring.file_rate;
    v.file_rate = file_rate; // el seek el necessita per reposicionar src_consumed
    if ch == 0 || file_rate == 0 {
        // Encara no hi ha dades (probe en marxa). Si ja és eof i buit → fitxer dolent.
        if ring.eof && ring.samples.is_empty() {
            v.finished = true;
            v.ctrl.stop.store(true, Ordering::Relaxed);
        }
        v.meter = 0.0;
        return;
    }
    let step = file_rate as f64 / v.driver_rate.max(1) as f64;
    // Llargada del tram en frames de FONT (0 = fins al final del fitxer).
    let seg_frames = if v.stop_secs > 0.0 {
        (((v.stop_secs - v.start_secs).max(0.0)) * file_rate as f64) as usize
    } else {
        0
    };
    let fade_out_src = (v.fade_out_secs.max(0.0) * file_rate as f64) as usize;
    let mut peak = 0.0f32;

    for i in 0..buffer_size {
        let avail = ring.avail_frames();
        let at_eof = ring.eof && avail == 0;

        // Loop: el fil descodificador empeny un flux continu (gapless), així que el
        // callback NO gestiona l'out-point; només acaba per release o, com a
        // defensa, si arribés un eof real. Sense loop: acaba a l'out-point o eof.
        if v.loop_on {
            if at_eof {
                v.finished = true;
                v.ctrl.stop.store(true, Ordering::Relaxed);
                break;
            }
        } else {
            let at_outpoint = seg_frames > 0 && v.src_consumed >= seg_frames;
            if at_outpoint || at_eof {
                v.finished = true;
                v.ctrl.stop.store(true, Ordering::Relaxed);
                break;
            }
        }

        if avail < 2 && !ring.eof {
            break; // underrun: silenci la resta del buffer
        }

        // Envolupant: fade-in + fade-out cap a l'out-point (sense loop) + release.
        let mut env = 1.0f32;
        if v.fade_in_len > 0 && v.played_out < v.fade_in_len {
            env *= v.played_out as f32 / v.fade_in_len as f32;
        }
        if !v.loop_on && seg_frames > 0 && fade_out_src > 0 {
            let from = seg_frames.saturating_sub(fade_out_src);
            if v.src_consumed >= from {
                let into = v.src_consumed - from;
                env *= 1.0 - (into as f32 / fade_out_src as f32).min(1.0);
            }
        }
        if let Some(rfrom) = v.release_from {
            if v.played_out >= rfrom {
                let into = v.played_out - rfrom;
                if v.release_len == 0 || into >= v.release_len {
                    v.finished = true;
                    v.ctrl.stop.store(true, Ordering::Relaxed);
                    break;
                }
                env *= 1.0 - into as f32 / v.release_len as f32;
            }
        }

        let g = v.gain * env;
        let frac = v.frac as f32;
        for (di, &out_ch) in v.out_channels.iter().enumerate() {
            if out_ch >= acc.len() {
                continue;
            }
            let sc = if ch == 1 { 0 } else { di % ch };
            let s0 = ring.sample(0, sc);
            let s1 = if avail >= 2 { ring.sample(1, sc) } else { s0 };
            let out = (s0 + (s1 - s0) * frac) * g;
            let a = out.abs();
            if a > peak {
                peak = a;
            }
            acc[out_ch][i] += out;
        }

        v.played_out += 1;
        v.frac += step;
        // Consumeix frames de font segons avança la posició fraccionària.
        while v.frac >= 1.0 {
            let a2 = ring.avail_frames();
            if a2 <= 1 {
                if ring.eof {
                    ring.pop_frames(a2);
                    v.src_consumed += a2;
                }
                break;
            }
            ring.pop_frames(1);
            v.src_consumed += 1;
            v.frac -= 1.0;
        }
    }

    v.meter = peak;
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
//
// NUCLI reutilitzable (feature `native`): la fa servir el motor ASIO; el backend
// cpal encara descodifica directe (la cau de pre-decode hi arriba en l'increment 2).
#[cfg(feature = "native")]
type PcmKey = (String, u32);

// Pressupost de memòria de la cau (~1,5 GB de PCM f32). En una màquina d'àudio
// pro és assumible; acota cues molt llargs i evita créixer sense límit.
#[cfg(feature = "native")]
const PCM_CACHE_BUDGET_BYTES: usize = 1_500_000_000;

// `allow(dead_code)`: amb la feature `native` sola (sense ASIO) la cau encara no
// es construeix (el backend cpal de l'increment 1 descodifica directe). El camí
// ASIO sí que la usa. Es manté al nucli per a l'increment 2 (pre-decode a cpal).
#[cfg(feature = "native")]
#[allow(dead_code)]
struct PcmCache {
    map: std::collections::HashMap<PcmKey, std::sync::Arc<Vec<Vec<f32>>>>,
    // Ordre d'ús (front = menys usat recentment, back = més recent).
    order: std::collections::VecDeque<PcmKey>,
    bytes: usize,
}

// Bytes aproximats que ocupa un PCM planar f32.
#[cfg(feature = "native")]
#[allow(dead_code)]
fn pcm_bytes(data: &[Vec<f32>]) -> usize {
    data.iter().map(|c| c.len() * 4).sum()
}

#[cfg(feature = "native")]
#[allow(dead_code)]
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

// Paràmetres d'una veu a registrar (tot menys el PCM): es porten des de la
// comanda fins al moment de construir la `Voice` (potser després d'un decode
// en un fil a part). Send perquè pugui viatjar a un fil de treball.
// NUCLI reutilitzable (feature `native`). `allow(dead_code)`: el backend cpal de
// l'increment 1 construeix la `Voice` directament; `VoiceSpec` (decode diferit en
// un fil) el consumeix el camí ASIO i hi arribarà al backend cpal a l'increment 2.
#[cfg(feature = "native")]
#[allow(dead_code)]
struct VoiceSpec {
    voice_id: u64,
    out_channels: Vec<usize>,
    gain: f32,
    fade_in: f32,
    fade_out: f32,
    loop_on: bool,
    start_point: f32,
    stop_point: f32,
}

// Clon del sender cap al fil del motor (per als fils de decode, que hi tornen el
// PCM). None si el motor encara no ha arrencat.
#[cfg(feature = "asio")]
fn asio_tx_clone() -> Option<std::sync::mpsc::Sender<AsioCmd>> {
    ASIO_TX.get().cloned()
}

// Descodifica un fitxer en un FIL DE TREBALL i n'envia el resultat al motor amb
// `make_cmd` (RegisterDecoded per reproduir, o CacheStore per pre-carregar). El
// fil del motor no queda mai bloquejat descodificant (clau per a pistes llargues).
#[cfg(feature = "asio")]
fn asio_spawn_decode<F>(file_path: String, rate: u32, make_cmd: F)
where
    F: FnOnce(std::sync::Arc<Vec<Vec<f32>>>) -> AsioCmd + Send + 'static,
{
    let tx = match asio_tx_clone() {
        Some(t) => t,
        None => return,
    };
    std::thread::Builder::new()
        .name("asio-decode".into())
        .spawn(move || match asio_decode::decode_file(&file_path, rate) {
            Ok(d) => {
                let _ = tx.send(make_cmd(std::sync::Arc::new(d.data)));
            }
            Err(e) => eprintln!("[asio-decode] '{}': {}", file_path, e),
        })
        .ok();
}

// Construeix una `Voice` a partir del PCM ja descodificat + els paràmetres i
// l'afegeix a la mescla (substituint qualsevol veu amb el mateix id). Si entre
// la petició i ara el mix s'ha desmuntat, no fa res.
#[cfg(feature = "asio")]
fn asio_build_and_push_voice(
    loaded: &mut Option<AsioLoaded>,
    data: std::sync::Arc<Vec<Vec<f32>>>,
    rate: u32,
    spec: VoiceSpec,
) {
    let mix = match loaded.as_ref().and_then(|l| l.mix.as_ref()) {
        Some(m) => m,
        None => {
            eprintln!("[asio-voice] voice={} SENSE MIX → descartada", spec.voice_id);
            return;
        }
    };
    let total = data.iter().map(|c| c.len()).max().unwrap_or(0);
    let src_channels = data.len();
    let sr = rate as f32;
    let start_frame = (((spec.start_point.max(0.0)) * sr) as usize).min(total);
    let stop_frame = if spec.stop_point > 0.0 {
        ((spec.stop_point * sr) as usize).min(total)
    } else {
        total
    };
    let stop_frame = stop_frame.max(start_frame + 1).min(total.max(start_frame + 1));
    let seg_len = stop_frame.saturating_sub(start_frame);
    let fade_in_len = ((spec.fade_in.max(0.0) * sr) as usize).min(seg_len);
    let fade_out_len = ((spec.fade_out.max(0.0) * sr) as usize).min(seg_len);

    let voice = Voice {
        voice_id: spec.voice_id,
        data,
        src_channels,
        out_channels: spec.out_channels,
        pos: start_frame,
        start_frame,
        stop_frame,
        gain: spec.gain.max(0.0),
        loop_on: spec.loop_on,
        fade_in_len,
        fade_out_len,
        release_from: None,
        release_len: 0,
        finished: false,
        paused: false,
        meter: 0.0,
    };

    if let Ok(mut voices) = mix.voices.lock() {
        voices.retain(|v| v.voice_id != spec.voice_id);
        voices.push(voice);
    }
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
        streaming: bool,    // true = decode-ahead (pistes llargues)
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
    // Enviat per un fil de DECODE quan acaba de descodificar un fitxer: el motor
    // l'insereix a la cau i registra la veu. Així descodificar mai bloqueja el
    // fil del motor (clau per a pistes llargues de la Playlist). Fire-and-forget.
    RegisterDecoded {
        file_path: String,
        rate: u32,
        data: std::sync::Arc<Vec<Vec<f32>>>,
        spec: VoiceSpec,
    },
    // Enviat per un fil de DECODE en pre-càrrega: només desa el PCM a la cau.
    CacheStore {
        file_path: String,
        rate: u32,
        data: std::sync::Arc<Vec<Vec<f32>>>,
    },
    // Canvia el gain (volum) d'una veu activa en calent.
    SetGain {
        voice_id: u64,
        gain: f32,
        reply: std::sync::mpsc::Sender<Result<(), String>>,
    },
    // Reposiciona el playhead d'una veu activa (segons dins el segment).
    Seek {
        voice_id: u64,
        position: f32,
        reply: std::sync::mpsc::Sender<Result<(), String>>,
    },
    // Pausa/reprèn una veu activa (congela la posició, sense aturar-la).
    SetPaused {
        voice_id: u64,
        paused: bool,
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
    // Quin driver hi ha carregat ARA (nom + info), o None. Per refrescar la UI.
    LoadedInfo {
        reply: std::sync::mpsc::Sender<Result<Option<AsioLoadedInfo>, String>>,
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
    stream_voices: std::sync::Arc<std::sync::Mutex<Vec<StreamVoice>>>,
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
                        let mut v: Vec<TelemetryItem> = match sh.voices.lock() {
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
                        };
                        if let Ok(svs) = sh.stream_voices.lock() {
                            v.extend(svs.iter().filter(|s| !s.finished).map(|s| {
                                // En loop amb out-point, el descodificador fa un flux
                                // continu i src_consumed creix sense parar: plega'l al
                                // tram perquè el playhead torni a l'inici visualment.
                                let mut consumed = s.src_consumed;
                                if s.loop_on && s.stop_secs > 0.0 && s.file_rate > 0 {
                                    let seg = (((s.stop_secs - s.start_secs).max(0.0)) * s.file_rate as f64) as usize;
                                    if seg > 0 { consumed %= seg; }
                                }
                                TelemetryItem {
                                    id: s.voice_id,
                                    pos: if s.file_rate > 0 { consumed as f32 / s.file_rate as f32 } else { 0.0 },
                                    level: s.meter,
                                }
                            }));
                        }
                        v
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
    // Veus en STREAMING (pistes llargues): llista separada de les veus en memòria.
    stream_voices: std::sync::Arc<std::sync::Mutex<Vec<StreamVoice>>>,
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
        // Atura els fils descodificadors de les veus en streaming i buida-les.
        if let Ok(mut svs) = mix.stream_voices.lock() {
            for sv in svs.iter() {
                sv.ctrl.stop.store(true, std::sync::atomic::Ordering::Relaxed);
            }
            svs.clear();
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

// Info del driver carregat ARA (sense carregar-ne cap), o None si no n'hi ha.
#[cfg(feature = "asio")]
fn asio_do_loaded_info(loaded: &Option<AsioLoaded>) -> Result<Option<AsioLoadedInfo>, String> {
    let l = match loaded.as_ref() {
        Some(l) => l,
        None => return Ok(None),
    };
    let outs = l.driver.channels().map_err(|e| format!("channels(): {:?}", e))?.outs as u16;
    let sample_rate = l.driver.sample_rate().map_err(|e| format!("sample_rate(): {:?}", e))? as u32;
    Ok(Some(AsioLoadedInfo { name: l.name.clone(), outs, sample_rate }))
}

// Gain mestre del bus ASIO (bits f32 dins un AtomicU32). El callback el llegeix
// cada buffer; la UI el canvia amb `asio_set_master_gain`. Inicialitzat a 1.0.
#[cfg(feature = "asio")]
static ASIO_MASTER_GAIN: std::sync::atomic::AtomicU32 =
    std::sync::atomic::AtomicU32::new(0x3f80_0000); // 1.0f32

#[cfg(feature = "asio")]
fn asio_master_gain() -> f32 {
    f32::from_bits(ASIO_MASTER_GAIN.load(std::sync::atomic::Ordering::Relaxed))
}

// Saturació SUAU: lineal (transparent) fins a ±0.7 i, per sobre, saturació amb
// tanh cap a ±1. Evita la distorsió aspra del clip dur quan sumen moltes veus.
// C1-continu al colze (mateix pendent), així no introdueix discontinuïtats.
// NUCLI reutilitzable (feature `native`): tant `asio_write_mix` com el backend
// cpal hi passen les mostres abans d'escriure-les al buffer de sortida.
#[cfg(feature = "native")]
#[inline]
fn asio_soft_clip(x: f32) -> f32 {
    const T: f32 = 0.7;
    let a = x.abs();
    if a <= T {
        x
    } else {
        let over = a - T;
        let sat = T + (1.0 - T) * (over / (1.0 - T)).tanh();
        sat.copysign(x)
    }
}

// Escriu un buffer f32 mesclat al buffer d'un canal ASIO, aplicant el gain
// mestre i la saturació suau, i convertint al tipus de mostra natiu del driver.
// `mix` ha de tenir exactament `n` mostres. Complementa `asio_write_sine`.
#[cfg(feature = "asio")]
unsafe fn asio_write_mix(
    ptr: *mut std::ffi::c_void,
    mix: &[f32],
    dt: &asio_sys::AsioSampleType,
    master: f32,
) {
    use asio_sys::AsioSampleType as T;
    let n = mix.len();
    let cl = |x: f32| asio_soft_clip(x * master);
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
    let stream_voices: Arc<Mutex<Vec<StreamVoice>>> = Arc::new(Mutex::new(Vec::new()));

    let cb_streams = streams.clone();
    let cb_voices = voices.clone();
    let cb_stream_voices = stream_voices.clone();
    // Acumuladors pre-allocats (num × buffer_size): el callback RT els reutilitza
    // zerant-los cada cop, sense assignar memòria al fil d'àudio.
    let cb_acc: Arc<Mutex<Vec<Vec<f32>>>> = Arc::new(Mutex::new(vec![vec![0.0f32; buffer_size]; outs]));
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

        // Acumuladors pre-allocats: zera cada canal (sense reassignar memòria).
        let mut acc_guard = match cb_acc.lock() { Ok(a) => a, Err(_) => return };
        let acc = &mut *acc_guard;
        for ch in acc.iter_mut() {
            ch.fill(0.0);
        }

        if let Ok(mut voices) = cb_voices.lock() {
            for voice in voices.iter_mut() {
                asio_mix_voice(voice, acc, buffer_size);
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

        // Veus en STREAMING (pistes llargues).
        if let Ok(mut svs) = cb_stream_voices.lock() {
            for sv in svs.iter_mut() {
                asio_mix_stream_voice(sv, acc, buffer_size);
            }
            for sv in svs.iter() {
                if sv.finished {
                    asio_notify_ended(sv.voice_id);
                }
            }
            svs.retain(|sv| !sv.finished);
        }

        // Bolca els acumuladors als buffers ASIO natius (gain mestre + soft clip).
        let master = asio_master_gain();
        unsafe {
            for ch in 0..num {
                let ptr = stream.buffer_infos[ch].buffers[bi];
                asio_write_mix(ptr, &acc[ch], &cb_dt, master);
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
        *g = Some(AsioMeterShared {
            voices: voices.clone(),
            stream_voices: stream_voices.clone(),
            sample_rate,
        });
    }

    l.mix = Some(AsioMix {
        streams,
        voices,
        stream_voices,
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
// NUCLI reutilitzable (feature `native`): la criden tant el callback ASIO com el
// backend cpal. No fa cap `alloc` ni IO: apte per al fil RT d'àudio.
#[cfg(feature = "native")]
fn asio_mix_voice(voice: &mut Voice, acc: &mut [Vec<f32>], buffer_size: usize) {
    if voice.finished {
        return;
    }
    // Pausada: silenci i posició congelada (no avança `pos`).
    if voice.paused {
        voice.meter = 0.0;
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
    streaming: bool,
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

    // ── Camí STREAMING (pistes llargues): decode-ahead, sense carregar tot a RAM.
    if streaming {
        let start_secs = start_point.max(0.0) as f64;
        let stop_secs = if stop_point > 0.0 { stop_point as f64 } else { 0.0 };
        // Si fa loop, el fil descodificador fa el loop del tram (flux continu,
        // gapless); el callback no l'ha de gestionar.
        let handle = asio_stream::spawn_stream(file_path.to_string(), start_secs, stop_secs, loop_on);
        let fade_in_len = (fade_in.max(0.0) * sample_rate as f32) as usize;
        let sv = StreamVoice {
            voice_id,
            ring: handle.ring,
            ctrl: handle.ctrl,
            out_channels,
            driver_rate: sample_rate,
            gain: gain.max(0.0),
            fade_in_len,
            played_out: 0,
            frac: 0.0,
            start_secs,
            stop_secs: if stop_point > 0.0 { stop_point as f64 } else { 0.0 },
            loop_on,
            fade_out_secs: fade_out.max(0.0) as f64,
            src_consumed: 0,
            file_rate: 0,
            release_from: None,
            release_len: 0,
            paused: false,
            finished: false,
            meter: 0.0,
        };
        if let Some(mix) = loaded.as_ref().and_then(|l| l.mix.as_ref()) {
            if let Ok(mut svs) = mix.stream_voices.lock() {
                // Re-disparo del mateix id: atura el fil antic abans de substituir.
                for old in svs.iter().filter(|x| x.voice_id == voice_id) {
                    old.ctrl.stop.store(true, std::sync::atomic::Ordering::Relaxed);
                }
                svs.retain(|x| x.voice_id != voice_id);
                svs.push(sv);
            }
        }
        return Ok(());
    }

    let spec = VoiceSpec {
        voice_id,
        out_channels,
        gain,
        fade_in,
        fade_out,
        loop_on,
        start_point,
        stop_point,
    };

    // Si el PCM ja és a la cau (p. ex. pre-carregat), registra la veu A L'INSTANT.
    let key: PcmKey = (file_path.to_string(), sample_rate);
    if let Some(data) = cache.get(&key) {
        asio_build_and_push_voice(loaded, data, sample_rate, spec);
        return Ok(());
    }

    // Si no, descodifica en un FIL a part i registra la veu quan arribi el PCM
    // (RegisterDecoded). El fil del motor no es bloqueja descodificant: un fitxer
    // llarg o problemàtic no penja la reproducció ni els cues.
    let path = file_path.to_string();
    asio_spawn_decode(path.clone(), sample_rate, move |data| AsioCmd::RegisterDecoded {
        file_path: path,
        rate: sample_rate,
        data,
        spec,
    });
    Ok(())
}

// Pre-descodifica un fitxer i el deixa a la cau, SENSE reproduir-lo. Carrega el
// driver demanat (si cal) només per conèixer-ne la freqüència; el decode va en un
// fil a part (CacheStore). El GO posterior trobarà el PCM a la cau i serà instantani.
#[cfg(feature = "asio")]
fn asio_preload_impl(
    loaded: &mut Option<AsioLoaded>,
    cache: &mut PcmCache,
    driver_name: &str,
    file_path: &str,
) -> Result<(), String> {
    // Necessitem la freqüència del driver per descodificar al rate definitiu.
    let info = asio_do_info(loaded, driver_name)?;
    let rate = info.sample_rate;
    let key: PcmKey = (file_path.to_string(), rate);
    if cache.get(&key).is_some() {
        return Ok(()); // ja a la cau
    }
    let path = file_path.to_string();
    asio_spawn_decode(path.clone(), rate, move |data| AsioCmd::CacheStore {
        file_path: path,
        rate,
        data,
    });
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
    let rel = (fade_out.max(0.0) * sr) as usize;
    if let Ok(mut voices) = mix.voices.lock() {
        if fade_out > 0.0 {
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
    }
    // Veus en streaming: release amb fade, o atura el fil i elimina si fade 0.
    if let Ok(mut svs) = mix.stream_voices.lock() {
        if fade_out > 0.0 {
            for sv in svs.iter_mut() {
                if sv.voice_id == voice_id && sv.release_from.is_none() {
                    sv.release_from = Some(sv.played_out);
                    sv.release_len = rel.max(1);
                }
            }
        } else {
            for sv in svs.iter().filter(|x| x.voice_id == voice_id) {
                sv.ctrl.stop.store(true, std::sync::atomic::Ordering::Relaxed);
            }
            svs.retain(|sv| sv.voice_id != voice_id);
        }
    }
    Ok(())
}

// Canvia el gain (volum lineal) d'una veu activa en calent. El callback ja
// multiplica per `voice.gain` a cada frame, així que el canvi és immediat.
#[cfg(feature = "asio")]
fn asio_set_gain_impl(
    loaded: &mut Option<AsioLoaded>,
    voice_id: u64,
    gain: f32,
) -> Result<(), String> {
    let mix = match loaded.as_ref().and_then(|l| l.mix.as_ref()) {
        Some(m) => m,
        None => return Ok(()),
    };
    if let Ok(mut voices) = mix.voices.lock() {
        for v in voices.iter_mut() {
            if v.voice_id == voice_id {
                v.gain = gain.max(0.0);
            }
        }
    }
    if let Ok(mut svs) = mix.stream_voices.lock() {
        for sv in svs.iter_mut() {
            if sv.voice_id == voice_id {
                sv.gain = gain.max(0.0);
            }
        }
    }
    Ok(())
}

// Reposiciona el playhead d'una veu activa: `position` són segons dins el
// segment (0 = inici del tram). Es limita a [start_frame, stop_frame).
#[cfg(feature = "asio")]
fn asio_seek_impl(
    loaded: &mut Option<AsioLoaded>,
    voice_id: u64,
    position: f32,
) -> Result<(), String> {
    let mix = match loaded.as_ref().and_then(|l| l.mix.as_ref()) {
        Some(m) => m,
        None => return Ok(()),
    };
    let rate = mix.sample_rate as f32;
    // `position` és ABSOLUT (segons dins el fitxer), igual per a veus en memòria i
    // streaming, perquè cues i playlist no interpretin el seek de manera diferent.
    if let Ok(mut voices) = mix.voices.lock() {
        for v in voices.iter_mut() {
            if v.voice_id == voice_id {
                let target = (position.max(0.0) * rate) as usize;
                let max = v.stop_frame.saturating_sub(1).max(v.start_frame);
                v.pos = target.clamp(v.start_frame, max);
            }
        }
    }
    // Veus en streaming: `position` són segons dins el TRAM (0 = start_secs). Demana
    // el seek absolut al fil (start_secs + position) i ajusta posició/consum perquè
    // la telemetria i l'out-point hi quadrin. Buida el ring per no sentir el tram vell.
    if let Ok(mut svs) = mix.stream_voices.lock() {
        for sv in svs.iter_mut() {
            if sv.voice_id == voice_id {
                let abs = position.max(0.0) as f64;            // posició absoluta dins el fitxer
                let rel = (abs - sv.start_secs).max(0.0);      // dins el tram actual
                sv.ctrl.seek_ms.store((abs * 1000.0) as i64, std::sync::atomic::Ordering::Relaxed);
                sv.played_out = (rel * rate as f64) as usize;
                sv.frac = 0.0;
                sv.src_consumed = if sv.file_rate > 0 { (rel * sv.file_rate as f64) as usize } else { 0 };
                if let Ok(mut r) = sv.ring.lock() { r.samples.clear(); r.eof = false; }
            }
        }
    }
    Ok(())
}

// Pausa o reprèn una veu activa. La veu es manté a la mescla; pausada, el
// callback escriu silenci i no avança la posició.
#[cfg(feature = "asio")]
fn asio_set_paused_impl(
    loaded: &mut Option<AsioLoaded>,
    voice_id: u64,
    paused: bool,
) -> Result<(), String> {
    let mix = match loaded.as_ref().and_then(|l| l.mix.as_ref()) {
        Some(m) => m,
        None => return Ok(()),
    };
    if let Ok(mut voices) = mix.voices.lock() {
        for v in voices.iter_mut() {
            if v.voice_id == voice_id {
                v.paused = paused;
            }
        }
    }
    if let Ok(mut svs) = mix.stream_voices.lock() {
        for sv in svs.iter_mut() {
            if sv.voice_id == voice_id {
                sv.paused = paused;
            }
        }
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
        paused: false,
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
                fade_in, fade_out, loop_on, start_point, stop_point, streaming, reply,
            } => {
                let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    asio_play_voice_impl(
                        &mut loaded, &mut cache, voice_id, &driver_name, &file_path, &channels,
                        gain, fade_in, fade_out, loop_on, start_point, stop_point, streaming,
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
            AsioCmd::RegisterDecoded { file_path, rate, data, spec } => {
                // Un fil de decode ha acabat: desa a la cau i registra la veu.
                let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    cache.insert((file_path, rate), data.clone());
                    asio_build_and_push_voice(&mut loaded, data, rate, spec);
                }));
            }
            AsioCmd::CacheStore { file_path, rate, data } => {
                // Pre-càrrega acabada en un fil: només desa el PCM a la cau.
                let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    cache.insert((file_path, rate), data);
                }));
            }
            AsioCmd::StopVoice { voice_id, fade_out, reply } => {
                let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    asio_stop_voice_impl(&mut loaded, voice_id, fade_out)
                }))
                .unwrap_or_else(|_| Err("Pànic aturant la veu ASIO.".into()));
                let _ = reply.send(res);
            }
            AsioCmd::SetGain { voice_id, gain, reply } => {
                let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    asio_set_gain_impl(&mut loaded, voice_id, gain)
                }))
                .unwrap_or_else(|_| Err("Pànic canviant el gain ASIO.".into()));
                let _ = reply.send(res);
            }
            AsioCmd::Seek { voice_id, position, reply } => {
                let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    asio_seek_impl(&mut loaded, voice_id, position)
                }))
                .unwrap_or_else(|_| Err("Pànic fent seek ASIO.".into()));
                let _ = reply.send(res);
            }
            AsioCmd::SetPaused { voice_id, paused, reply } => {
                let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    asio_set_paused_impl(&mut loaded, voice_id, paused)
                }))
                .unwrap_or_else(|_| Err("Pànic pausant la veu ASIO.".into()));
                let _ = reply.send(res);
            }
            AsioCmd::Release { reply } => {
                let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    asio_release_loaded(&mut loaded)
                }))
                .unwrap_or_else(|_| Err("Pànic alliberant el driver ASIO.".into()));
                let _ = reply.send(res);
            }
            AsioCmd::LoadedInfo { reply } => {
                let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    asio_do_loaded_info(&loaded)
                }))
                .unwrap_or_else(|_| Err("Pànic consultant el driver carregat.".into()));
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
    streaming: bool,
) -> Result<(), String> {
    #[cfg(not(feature = "asio"))]
    {
        let _ = (voice_id, driver, file_path, channels, gain, fade_in, fade_out, loop_on, start_point, stop_point, streaming);
        Err("Aquesta build no inclou ASIO (cal compilar amb --features asio).".into())
    }
    #[cfg(feature = "asio")]
    {
        let (reply_tx, reply_rx) = std::sync::mpsc::channel();
        asio_sender()
            .send(AsioCmd::PlayVoice {
                voice_id, driver_name: driver, file_path, channels, gain,
                fade_in, fade_out, loop_on, start_point, stop_point, streaming, reply: reply_tx,
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

// Canvia el volum (gain lineal) d'una veu ASIO activa en calent.
#[tauri::command]
fn asio_set_gain(voice_id: u64, gain: f32) -> Result<(), String> {
    #[cfg(not(feature = "asio"))]
    {
        let _ = (voice_id, gain);
        Err("Aquesta build no inclou ASIO (cal compilar amb --features asio).".into())
    }
    #[cfg(feature = "asio")]
    {
        let (reply_tx, reply_rx) = std::sync::mpsc::channel();
        asio_sender()
            .send(AsioCmd::SetGain { voice_id, gain, reply: reply_tx })
            .map_err(|_| "El fil ASIO no està disponible.".to_string())?;
        match reply_rx.recv_timeout(std::time::Duration::from_secs(5)) {
            Ok(res) => res,
            Err(_) => Err("Temps esgotat o error canviant el volum ASIO.".into()),
        }
    }
}

// Estableix el gain mestre del bus ASIO (0..1+; aplicat abans del soft clip).
// No passa pel fil del motor: només actualitza un àtom que el callback llegeix.
#[tauri::command]
fn asio_set_master_gain(gain: f32) -> Result<(), String> {
    #[cfg(not(feature = "asio"))]
    {
        let _ = gain;
        Ok(())
    }
    #[cfg(feature = "asio")]
    {
        ASIO_MASTER_GAIN.store(gain.max(0.0).to_bits(), std::sync::atomic::Ordering::Relaxed);
        Ok(())
    }
}

// Reposiciona el playhead d'una veu ASIO activa (segons dins el segment).
#[tauri::command]
fn asio_seek(voice_id: u64, position: f32) -> Result<(), String> {
    #[cfg(not(feature = "asio"))]
    {
        let _ = (voice_id, position);
        Err("Aquesta build no inclou ASIO (cal compilar amb --features asio).".into())
    }
    #[cfg(feature = "asio")]
    {
        let (reply_tx, reply_rx) = std::sync::mpsc::channel();
        asio_sender()
            .send(AsioCmd::Seek { voice_id, position, reply: reply_tx })
            .map_err(|_| "El fil ASIO no està disponible.".to_string())?;
        match reply_rx.recv_timeout(std::time::Duration::from_secs(5)) {
            Ok(res) => res,
            Err(_) => Err("Temps esgotat o error fent seek ASIO.".into()),
        }
    }
}

// Pausa o reprèn una veu ASIO activa (congela la posició, sense aturar-la).
#[tauri::command]
fn asio_set_paused(voice_id: u64, paused: bool) -> Result<(), String> {
    #[cfg(not(feature = "asio"))]
    {
        let _ = (voice_id, paused);
        Err("Aquesta build no inclou ASIO (cal compilar amb --features asio).".into())
    }
    #[cfg(feature = "asio")]
    {
        let (reply_tx, reply_rx) = std::sync::mpsc::channel();
        asio_sender()
            .send(AsioCmd::SetPaused { voice_id, paused, reply: reply_tx })
            .map_err(|_| "El fil ASIO no està disponible.".to_string())?;
        match reply_rx.recv_timeout(std::time::Duration::from_secs(5)) {
            Ok(res) => res,
            Err(_) => Err("Temps esgotat o error pausant la veu ASIO.".into()),
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

// Quin driver ASIO hi ha carregat ARA (nom + canals + freqüència), o null. Per
// refrescar la UI del routing en reobrir Settings (el driver pot estar carregat
// pel botó «Carregar» o per la reproducció).
#[tauri::command]
fn asio_loaded_info() -> Result<Option<AsioLoadedInfo>, String> {
    #[cfg(not(feature = "asio"))]
    {
        Ok(None)
    }
    #[cfg(feature = "asio")]
    {
        let (reply_tx, reply_rx) = std::sync::mpsc::channel();
        asio_sender()
            .send(AsioCmd::LoadedInfo { reply: reply_tx })
            .map_err(|_| "El fil ASIO no està disponible.".to_string())?;
        match reply_rx.recv_timeout(std::time::Duration::from_secs(5)) {
            Ok(res) => res,
            Err(_) => Err("Temps esgotat consultant el driver carregat.".into()),
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

// ── Comandes del motor NATIU (cpal) ──────────────────────────────────────────
//
// Increment 1 del motor unificat: disparar UNA veu pel dispositiu de sortida per
// defecte (WASAPI/CoreAudio) amb gain i fades. Disponible amb la feature `native`
// (i, per tant, també amb `asio`). Sense `native` retornen un error explicatiu.

// Reprodueix un cue (fitxer en memòria) pel dispositiu de sortida per defecte via
// cpal, amb gain i fades. La veu s'acaba sola.
#[tauri::command]
fn native_play_cue(
    file_path: String,
    gain: f32,
    fade_in: f32,
    fade_out: f32,
    channels: Vec<u16>,
) -> Result<(), String> {
    #[cfg(not(feature = "native"))]
    {
        let _ = (file_path, gain, fade_in, fade_out, channels);
        Err("Aquesta build no inclou el motor natiu (cal la feature `native`).".into())
    }
    #[cfg(feature = "native")]
    {
        native_output::play_cue(file_path, gain, fade_in, fade_out, channels)
    }
}

// Atura la reproducció del motor natiu (totes les veus actives, de moment).
#[tauri::command]
fn native_stop() -> Result<(), String> {
    #[cfg(not(feature = "native"))]
    {
        Err("Aquesta build no inclou el motor natiu (cal la feature `native`).".into())
    }
    #[cfg(feature = "native")]
    {
        native_output::stop()
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
            asio_set_gain,
            asio_set_master_gain,
            asio_loaded_info,
            asio_seek,
            asio_set_paused,
            asio_load,
            asio_release,
            native_play_cue,
            native_stop
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
