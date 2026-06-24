// Backend de sortida d'àudio NATIU MULTIPLATAFORMA basat en cpal (host per
// defecte: WASAPI a Windows, CoreAudio a Mac). És el motor natiu unificat que ha
// de portar la paritat PC/Mac sense dependre d'ASIO.
//
// INCREMENT 2: multi-veu amb control per veu i telemetria. Diverses veus poden
// sonar alhora (cada una amb el seu `voice_id`); es poden aturar amb fade,
// canviar el gain, fer seek i pausar individualment; i el motor emet events a la
// UI (final natural d'una veu i telemetria de playhead + nivell).
//
// Reutilitza EL MATEIX nucli de veus que el motor ASIO:
//   · `Voice`           — estat d'una reproducció (PCM + paràmetres).
//   · `asio_mix_voice`  — avança i mescla la veu als acumuladors de sortida.
//   · `asio_soft_clip`  — saturació suau abans d'escriure al buffer.
//   · `asio_decode`     — descodificació + resampling a la freqüència del device.
// La mescla, els fades, el release, la pausa i el meter ja són al nucli: aquí NO
// es reimplementa res d'això; només es construeixen i es controlen les `Voice`.
//
// Disciplina de temps real al callback: cap `alloc`, cap IO, cap descodificació,
// cap emissió d'events. Només locks CURTS (la llista de veus i els acumuladors) i,
// quan una veu acaba sola, un `send` barat per un canal mpsc cap a un fil
// notificador (NO cada bloc). La descodificació es fa FORA del callback (al fil de
// la comanda) i el PCM ja arriba resamplejat.
//
// INCREMENT 4: selecció de dispositiu + routing MULTICANAL real. Ara el motor:
//   · Obre cada dispositiu amb TOTS els seus canals (config amb el màxim nombre de
//     canals, no la default estèreo), perquè el routing per canal funcioni de debò.
//   · Manté DIVERSOS dispositius oberts alhora (mapa nom→backend), així cues
//     diferents poden anar a interfícies físiques diferents simultàniament.
//   · `PlayCue` rep el `device_name` (buit = per defecte) i els canals destí.
//
// Limitacions conscients d'aquest increment (queden per a increments POSTERIORS):
//   · No hi ha streaming (decode-ahead) per a pistes llargues: tot el PCM es
//     carrega a memòria.

#![cfg(feature = "native")]

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};

use crate::{
    asio_decode, asio_mix_stream_voice, asio_mix_voice, asio_soft_clip, asio_stream, PcmCache,
    PcmKey, StreamVoice, Voice, VoiceSpec,
};

// Estat persistent d'UN dispositiu cpal obert: l'stream de sortida i la llista de
// veus que el seu callback mescla. Es manté viu mentre hi hagi reproducció.
//
// `stream` cal MANTENIR-LO VIU: si es deixés caure, cpal aturaria el dispositiu.
// `cpal::Stream` NO és Send, per això tot viu en un fil propietari
// (vegeu `native_thread_main`) i mai creua fronteres de fil.
struct NativeBackend {
    // Veus actives compartides amb el callback (fil RT de cpal). Lock curt.
    voices: Arc<Mutex<Vec<Voice>>>,
    // Veus en STREAMING (pistes llargues): llista separada de les veus en memòria.
    // El callback les mescla amb `asio_mix_stream_voice` (decode-ahead al fil de
    // `spawn_stream`; aquí el callback només llegeix el ring, com fa ASIO).
    stream_voices: Arc<Mutex<Vec<StreamVoice>>>,
    // Freqüència real del dispositiu obert (per descodificar al rate correcte).
    sample_rate: u32,
    // Nombre de canals del dispositiu (per validar el routing dels cues).
    channels: usize,
    // L'stream cpal obert. Viu mentre el backend existeix.
    #[allow(dead_code)]
    stream: cpal::Stream,
}

// Mapa de dispositius oberts: clau = nom de cpal del device (string buit "" = el
// dispositiu per defecte). Cada entrada té el seu propi stream, veus i freqüència,
// de manera que cues diferents poden sonar per dispositius físics diferents alhora.
type NativeBackends = HashMap<String, NativeBackend>;

// ── Fil propietari del backend cpal ──────────────────────────────────────────
//
// `cpal::Stream` no és Send, així que NO pot viure en un `static` ni viatjar
// entre fils. Per això el backend viu en un FIL DEDICAT que n'és l'únic
// propietari, igual que el motor ASIO té el seu fil. Les comandes Tauri li
// envien ordres per un canal mpsc i esperen la resposta amb timeout.

// Ordres que el fil natiu sap atendre.
enum NativeCmd {
    // Descodifica `file_path` i registra una veu amb id `voice_id` que el callback
    // reprodueix. NO buida les altres veus (poden sonar-ne diverses alhora);
    // substitueix una veu del mateix id si ja existeix.
    PlayCue {
        voice_id: u64,
        // Nom de cpal del dispositiu de sortida (buit = per defecte).
        device_name: String,
        file_path: String,
        gain: f32,
        fade_in: f32,
        fade_out: f32,
        // Canals de sortida destí (0-based) dins el dispositiu triat.
        channels: Vec<u16>,
        // Segment i loop (només els respecta el camí STREAMING; el camí en memòria
        // encara els ignora, limitació coneguda dels increments 1-5).
        loop_on: bool,
        start_point: f32, // segons dins el fitxer
        stop_point: f32,  // segons (<=0 = fins al final)
        // true = decode-ahead (pistes llargues): no passa per la cau ni decode complet.
        streaming: bool,
        reply: std::sync::mpsc::Sender<Result<(), String>>,
    },
    // Pre-descodifica un fitxer a la freqüència del dispositiu i el deixa a la cau
    // (sense reproduir-lo), perquè el GO posterior sigui instantani. El decode va
    // en un fil a part (CacheStore); aquí només es resol el rate del device.
    Preload {
        device_name: String,
        file_path: String,
        reply: std::sync::mpsc::Sender<Result<(), String>>,
    },
    // Enviada per un fil de DECODE quan acaba de descodificar un fitxer per a un
    // GO: el motor l'insereix a la cau i registra la veu. Així descodificar mai
    // bloqueja el fil del motor. Fire-and-forget (sense reply).
    RegisterDecoded {
        device_name: String,
        rate: u32,
        file_path: String,
        data: Arc<Vec<Vec<f32>>>,
        spec: VoiceSpec,
    },
    // Enviada per un fil de DECODE en pre-càrrega: només desa el PCM a la cau.
    CacheStore {
        rate: u32,
        file_path: String,
        data: Arc<Vec<Vec<f32>>>,
    },
    // Atura una veu pel seu id, amb fade-out opcional (segons). Amb fade 0
    // l'elimina a l'instant; amb fade > 0 n'inicia la rampa de release.
    StopVoice {
        voice_id: u64,
        fade_out: f32,
        reply: std::sync::mpsc::Sender<Result<(), String>>,
    },
    // Canvia el gain (volum lineal) d'una veu activa en calent.
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
    // Pausa o reprèn una veu activa (congela la posició, sense aturar-la).
    SetPaused {
        voice_id: u64,
        paused: bool,
        reply: std::sync::mpsc::Sender<Result<(), String>>,
    },
    // Atura TOTES les veus actives (parada global d'emergència).
    Stop {
        reply: std::sync::mpsc::Sender<Result<(), String>>,
    },
}

// Sender únic cap al fil natiu. S'inicialitza mandrós el primer cop que cal.
static NATIVE_TX: OnceLock<std::sync::mpsc::Sender<NativeCmd>> = OnceLock::new();

// Retorna el sender cap al fil natiu, arrencant-lo mandrós el primer cop.
fn native_sender() -> &'static std::sync::mpsc::Sender<NativeCmd> {
    NATIVE_TX.get_or_init(|| {
        let (tx, rx) = std::sync::mpsc::channel::<NativeCmd>();
        std::thread::Builder::new()
            .name("native-engine".into())
            .spawn(move || native_thread_main(rx))
            .expect("no s'ha pogut arrencar el fil natiu cpal");
        tx
    })
}

// Clon del sender cap al fil natiu (per als fils de decode, que hi tornen el PCM).
// None si el motor encara no ha arrencat. Anàleg a `asio_tx_clone`.
fn native_tx_clone() -> Option<std::sync::mpsc::Sender<NativeCmd>> {
    NATIVE_TX.get().cloned()
}

// Descodifica un fitxer en un FIL DE TREBALL (`native-decode`) i n'envia el
// resultat al fil del motor amb `make_cmd` (RegisterDecoded per reproduir, o
// CacheStore per pre-carregar). El fil del motor MAI queda bloquejat descodificant
// (clau per a pistes llargues). Anàleg a `asio_spawn_decode`.
fn native_spawn_decode<F>(file_path: String, rate: u32, make_cmd: F)
where
    F: FnOnce(Arc<Vec<Vec<f32>>>) -> NativeCmd + Send + 'static,
{
    let tx = match native_tx_clone() {
        Some(t) => t,
        None => return,
    };
    std::thread::Builder::new()
        .name("native-decode".into())
        .spawn(move || match asio_decode::decode_file(&file_path, rate) {
            Ok(d) => {
                let _ = tx.send(make_cmd(Arc::new(d.data)));
            }
            Err(e) => eprintln!("[native-decode] '{}': {}", file_path, e),
        })
        .ok();
}

// ── Notificació de final de veu (callback RT → fil notificador → event Tauri) ──
//
// Canal pel qual el callback RT avisa (sense bloquejar) que una veu ha acabat de
// forma natural (final del segment o release acabat). Un fil notificador amb
// l'`AppHandle` rep l'id i emet l'event `native-voice-ended` a la UI. El callback
// NO pot emetre events ni bloquejar; només fa un `send` barat (només en acabar una
// veu, no cada bloc). El fil notificador s'arrenca a `run()` via
// `native_start_notifier`.
static NATIVE_ENDED_TX: OnceLock<std::sync::mpsc::Sender<u64>> = OnceLock::new();

// Notifica (sense bloquejar) que una veu ha acabat de forma natural. Si encara no
// hi ha fil notificador, l'avís simplement es descarta (no és crític).
fn native_notify_ended(voice_id: u64) {
    if let Some(tx) = NATIVE_ENDED_TX.get() {
        let _ = tx.send(voice_id);
    }
}

// ── Estat compartit per al fil de telemetria ─────────────────────────────────
//
// El fil de telemetria mostreja les llistes de veus actives (les mateixes que els
// callbacks) i la freqüència de cada device per convertir frames a segons. Amb
// multi-dispositiu n'hi ha una entrada per device obert; la telemetria s'agrega
// sobre totes. S'actualitza cada cop que el conjunt de backends canvia. Anàleg a
// `AsioMeterShared`/`ASIO_METER` del motor ASIO.
struct NativeMeterDevice {
    voices: Arc<Mutex<Vec<Voice>>>,
    stream_voices: Arc<Mutex<Vec<StreamVoice>>>,
    sample_rate: u32,
}

static NATIVE_METER: OnceLock<Mutex<Vec<NativeMeterDevice>>> = OnceLock::new();

// Accés mandrós a l'slot compartit de telemetria.
fn native_meter_slot() -> &'static Mutex<Vec<NativeMeterDevice>> {
    NATIVE_METER.get_or_init(|| Mutex::new(Vec::new()))
}

// Reconstrueix la taula de telemetria a partir del mapa de backends. Es crida cada
// cop que s'obre un dispositiu nou (poc freqüent), MAI des del callback RT.
fn native_publish_meter(backends: &NativeBackends) {
    if let Ok(mut g) = native_meter_slot().lock() {
        *g = backends
            .values()
            .map(|b| NativeMeterDevice {
                voices: b.voices.clone(),
                stream_voices: b.stream_voices.clone(),
                sample_rate: b.sample_rate,
            })
            .collect();
    }
}

// Un ítem de telemetria per veu activa: id de la veu, posició dins el segment
// (segons) i nivell (pic d'amplitud lineal 0..1). S'emet en bloc cada ~33 ms.
#[derive(serde::Serialize)]
struct NativeTelemetryItem {
    id: u64,
    pos: f32,
    level: f32,
}

// Arrenca els fils auxiliars que reenvien estat del motor natiu a la UI:
//   · `native-notifier`  → final natural de veu (event `native-voice-ended`).
//   · `native-telemetry` → playhead + nivell de cada veu (event `native-telemetry`),
//     mostrejat a ~30 Hz (NO des del callback RT: aquest només deixa el pic a
//     `voice.meter` i la posició a `voice.pos`).
// Es crida un sol cop a `run()` amb l'AppHandle. Idempotent (via NATIVE_ENDED_TX).
pub fn start_notifier(app: tauri::AppHandle) {
    use tauri::Emitter;
    let (tx, rx) = std::sync::mpsc::channel::<u64>();
    if NATIVE_ENDED_TX.set(tx).is_err() {
        return; // ja arrencat
    }

    // Fil notificador de finals de veu.
    let app_ended = app.clone();
    std::thread::Builder::new()
        .name("native-notifier".into())
        .spawn(move || {
            while let Ok(voice_id) = rx.recv() {
                let _ = app_ended.emit("native-voice-ended", voice_id);
            }
        })
        .ok();

    // Fil de telemetria (playhead + VU) a ~30 Hz.
    std::thread::Builder::new()
        .name("native-telemetry".into())
        .spawn(move || loop {
            std::thread::sleep(std::time::Duration::from_millis(33));
            // Snapshot curt sota lock: id, posició (s) i nivell de cada veu activa,
            // AGREGAT sobre tots els dispositius oberts.
            let items: Vec<NativeTelemetryItem> = {
                let guard = match native_meter_slot().lock() {
                    Ok(g) => g,
                    Err(_) => continue,
                };
                let mut out: Vec<NativeTelemetryItem> = Vec::new();
                for dev in guard.iter() {
                    let rate = dev.sample_rate.max(1) as f32;
                    if let Ok(vs) = dev.voices.lock() {
                        out.extend(vs.iter().filter(|v| !v.finished).map(|v| {
                            NativeTelemetryItem {
                                id: v.voice_id,
                                pos: v.seg_pos() as f32 / rate,
                                level: v.meter,
                            }
                        }));
                    }
                    // Veus en streaming: el playhead es deriva dels frames de FONT
                    // consumits. En loop amb out-point el descodificador empeny un
                    // flux continu i src_consumed creix sense parar: plega'l al tram
                    // perquè el playhead torni a l'inici visualment (igual que ASIO).
                    if let Ok(svs) = dev.stream_voices.lock() {
                        out.extend(svs.iter().filter(|s| !s.finished).map(|s| {
                            NativeTelemetryItem {
                                id: s.voice_id,
                                pos: s.telemetry_pos(),
                                level: s.meter,
                            }
                        }));
                    }
                }
                out
            };
            // Només emetem si hi ha veus (la UI esborra per caducitat si calla).
            if !items.is_empty() {
                let _ = app.emit("native-telemetry", &items);
            }
        })
        .ok();
}

// Bucle del fil natiu: rep ordres i les atén una a una, mantenint el backend
// (stream + veus) viu entre cues. Aïllem cada ordre amb `catch_unwind` perquè un
// error d'un device dolent no mati el fil ni deixi el dispositiu en mal estat.
fn native_thread_main(rx: std::sync::mpsc::Receiver<NativeCmd>) {
    // Mapa de dispositius oberts: buit fins al primer cue, després es mantenen
    // oberts (un stream cpal viu per device usat).
    let mut backends: NativeBackends = NativeBackends::new();
    // Cau de PCM descodificat, propietat EXCLUSIVA d'aquest fil (sense locks). Clau
    // (ruta, rate del DISPOSITIU destí). El decode passa en fils de treball i el PCM
    // arriba per RegisterDecoded/CacheStore; el callback RT mai la toca.
    let mut cache = PcmCache::new();
    while let Ok(cmd) = rx.recv() {
        match cmd {
            NativeCmd::PlayCue { voice_id, device_name, file_path, gain, fade_in, fade_out, channels, loop_on, start_point, stop_point, streaming, reply } => {
                let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    native_play_cue_impl(&mut backends, &mut cache, voice_id, &device_name, &file_path, gain, fade_in, fade_out, &channels, loop_on, start_point, stop_point, streaming)
                }))
                .unwrap_or_else(|_| Err("Pànic reproduint el cue natiu.".into()));
                let _ = reply.send(res);
            }
            NativeCmd::Preload { device_name, file_path, reply } => {
                let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    native_preload_impl(&mut backends, &mut cache, &device_name, &file_path)
                }))
                .unwrap_or_else(|_| Err("Pànic pre-descodificant el cue natiu.".into()));
                let _ = reply.send(res);
            }
            NativeCmd::RegisterDecoded { device_name, rate, file_path, data, spec } => {
                // Un fil de decode ha acabat: desa a la cau i registra la veu.
                let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    cache.insert((file_path, rate), data.clone());
                    native_build_and_push_voice(&backends, &device_name, data, rate, spec);
                }));
            }
            NativeCmd::CacheStore { rate, file_path, data } => {
                // Pre-càrrega acabada en un fil: només desa el PCM a la cau.
                let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    cache.insert((file_path, rate), data);
                }));
            }
            NativeCmd::StopVoice { voice_id, fade_out, reply } => {
                let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    native_stop_voice_impl(&backends, voice_id, fade_out)
                }))
                .unwrap_or_else(|_| Err("Pànic aturant la veu nativa.".into()));
                let _ = reply.send(res);
            }
            NativeCmd::SetGain { voice_id, gain, reply } => {
                let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    native_set_gain_impl(&backends, voice_id, gain)
                }))
                .unwrap_or_else(|_| Err("Pànic canviant el gain natiu.".into()));
                let _ = reply.send(res);
            }
            NativeCmd::Seek { voice_id, position, reply } => {
                let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    native_seek_impl(&backends, voice_id, position)
                }))
                .unwrap_or_else(|_| Err("Pànic fent seek natiu.".into()));
                let _ = reply.send(res);
            }
            NativeCmd::SetPaused { voice_id, paused, reply } => {
                let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    native_set_paused_impl(&backends, voice_id, paused)
                }))
                .unwrap_or_else(|_| Err("Pànic pausant la veu nativa.".into()));
                let _ = reply.send(res);
            }
            NativeCmd::Stop { reply } => {
                let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    // Parada global: buida les veus de TOTS els dispositius oberts
                    // (els streams cpal es mantenen vius, escrivint silenci). Per a
                    // les veus en streaming, atura abans els fils descodificadors
                    // (posa ctrl.stop) com fa `asio_teardown_mix`.
                    for b in backends.values() {
                        if let Ok(mut v) = b.voices.lock() {
                            v.clear();
                        }
                        if let Ok(mut svs) = b.stream_voices.lock() {
                            for sv in svs.iter() {
                                sv.ctrl.stop.store(true, std::sync::atomic::Ordering::Relaxed);
                            }
                            svs.clear();
                        }
                    }
                    Ok(())
                }))
                .unwrap_or_else(|_| Err("Pànic aturant el motor natiu.".into()));
                let _ = reply.send(res);
            }
        }
    }
}

// Tria la millor config de sortida d'un dispositiu per a routing MULTICANAL: la que
// ofereix el MÀXIM nombre de canals i, a igualtat de canals, una freqüència
// raonable (prefereix 48000, si no 44100, si no la més alta dins el rang). Cada
// `SupportedStreamConfigRange` cobreix un rang [min,max] de freqüència; per a la
// config triada, clampem el rate desitjat al seu rang. Així un dispositiu de 8
// sortides s'obre amb 8 canals i el routing per canal funciona de debò (a
// diferència de `default_output_config()`, que sol donar només 2 canals).
// Rang de preferència d'un format de mostra que el callback SAP escriure (més baix
// = millor qualitat). None = format no convertible: l'evitem (abans es podia triar
// un rang U8 multicanal per davant d'un F32 estèreo i el callback fallava → silenci).
fn native_fmt_rank(sf: cpal::SampleFormat) -> Option<u8> {
    match sf {
        cpal::SampleFormat::F32 => Some(0),
        cpal::SampleFormat::I16 => Some(1),
        cpal::SampleFormat::U16 => Some(2),
        cpal::SampleFormat::U8 => Some(3),
        _ => None,
    }
}

fn native_pick_config(device: &cpal::Device) -> Result<cpal::SupportedStreamConfig, String> {
    let ranges = device
        .supported_output_configs()
        .map_err(|e| format!("supported_output_configs(): {}", e))?;

    // Tria el rang amb MÉS canals i, en empat de canals, el format de MILLOR qualitat
    // que sabem escriure (F32 > I16 > U16 > U8). Descarta els formats no convertibles.
    // La freqüència es resol després (48000 → 44100 → la màxima del rang).
    let mut best: Option<cpal::SupportedStreamConfigRange> = None;
    for r in ranges {
        let rank = match native_fmt_rank(r.sample_format()) {
            Some(k) => k,
            None => continue, // format que el callback no sap escriure: l'ignorem
        };
        let take = match &best {
            None => true,
            Some(b) => {
                r.channels() > b.channels()
                    || (r.channels() == b.channels()
                        && rank < native_fmt_rank(b.sample_format()).unwrap_or(u8::MAX))
            }
        };
        if take {
            best = Some(r);
        }
    }
    let best = best.ok_or_else(|| {
        "El dispositiu no exposa cap config de sortida amb un format suportat.".to_string()
    })?;

    // Freqüència desitjada acotada al rang suportat per la config triada.
    let min = best.min_sample_rate().0;
    let max = best.max_sample_rate().0;
    let pick = |want: u32| want >= min && want <= max;
    let rate = if pick(48000) {
        48000
    } else if pick(44100) {
        44100
    } else {
        max
    };
    Ok(best.with_sample_rate(cpal::SampleRate(rate)))
}

// Resol un dispositiu de sortida pel seu NOM de cpal. Nom buit = dispositiu per
// defecte del host. Si el nom no es troba, retorna error (no recau silenciosament
// al per defecte, per no enviar so a un dispositiu equivocat).
fn native_resolve_device(host: &cpal::Host, device_name: &str) -> Result<cpal::Device, String> {
    if device_name.is_empty() {
        return host
            .default_output_device()
            .ok_or_else(|| "No hi ha cap dispositiu de sortida per defecte.".to_string());
    }
    let mut devices = host
        .output_devices()
        .map_err(|e| format!("output_devices(): {}", e))?;
    devices
        .find(|d| d.name().map(|n| n == device_name).unwrap_or(false))
        .ok_or_else(|| format!("Dispositiu de sortida no trobat: {}", device_name))
}

// Assegura que hi ha un backend cpal obert per al dispositiu `device_name` (buit =
// per defecte): stream de sortida amb TOTS els canals + llista de veus + callback
// de mescla. Idempotent: si el device ja és obert, el reutilitza. Retorna la
// freqüència i el nombre de canals d'aquell dispositiu. En obrir-ne un de nou,
// republica la taula de telemetria (un sol cop, fora del callback RT).
fn native_ensure_backend(
    backends: &mut NativeBackends,
    device_name: &str,
) -> Result<(u32, usize), String> {
    if let Some(b) = backends.get(device_name) {
        return Ok((b.sample_rate, b.channels));
    }

    let host = cpal::default_host();
    let device = native_resolve_device(&host, device_name)?;
    // Config MULTICANAL: el màxim de canals del dispositiu (no la default estèreo).
    let supported = native_pick_config(&device)?;
    let sample_format = supported.sample_format();
    let config: cpal::StreamConfig = supported.into();
    let channels = config.channels as usize;
    let sample_rate = config.sample_rate.0;

    // Llista de veus compartida amb el callback (fil RT de cpal).
    let voices: Arc<Mutex<Vec<Voice>>> = Arc::new(Mutex::new(Vec::new()));
    // Llista de veus en streaming (pistes llargues), separada de les de memòria.
    let stream_voices: Arc<Mutex<Vec<StreamVoice>>> = Arc::new(Mutex::new(Vec::new()));
    // Acumuladors pre-allocats (un Vec per canal): el callback els reutilitza
    // zerant-los cada bloc, sense assignar memòria al fil d'àudio.
    let acc: Arc<Mutex<Vec<Vec<f32>>>> = Arc::new(Mutex::new(Vec::new()));

    let err_fn = |e| eprintln!("[native] error stream de sortida: {}", e);

    // Construeix el callback per al tipus de mostra del dispositiu. La mescla és
    // SEMPRE en f32 (al nucli); aquí només convertim l'acumulador al format natiu.
    macro_rules! build {
        ($sample:ty, $to:expr) => {{
            let cb_voices = voices.clone();
            let cb_stream_voices = stream_voices.clone();
            let cb_acc = acc.clone();
            device.build_output_stream(
                &config,
                move |data: &mut [$sample], _: &cpal::OutputCallbackInfo| {
                    native_mix_callback(data, channels, &cb_voices, &cb_stream_voices, &cb_acc, &$to);
                },
                err_fn,
                None,
            )
        }};
    }

    let stream = match sample_format {
        cpal::SampleFormat::F32 => build!(f32, |x: f32| x),
        cpal::SampleFormat::I16 => build!(i16, |x: f32| (x * i16::MAX as f32) as i16),
        cpal::SampleFormat::U16 => build!(u16, |x: f32| ((x * 0.5 + 0.5) * u16::MAX as f32) as u16),
        cpal::SampleFormat::U8 => build!(u8, |x: f32| ((x * 0.5 + 0.5) * u8::MAX as f32) as u8),
        other => return Err(format!("Format de mostra no suportat: {:?}", other)),
    }
    .map_err(|e| format!("build_output_stream(): {}", e))?;

    stream.play().map_err(|e| format!("play(): {}", e))?;

    backends.insert(
        device_name.to_string(),
        NativeBackend { voices, stream_voices, sample_rate, channels, stream },
    );

    // Republica la taula de telemetria amb tots els dispositius oberts (un sol cop,
    // fora del callback RT).
    native_publish_meter(backends);

    Ok((sample_rate, channels))
}

// Callback de mescla (fil RT de cpal). Per cada bloc de `data` (interleaved):
//   1. assegura/zera els acumuladors per canal (mida = frames del bloc).
//   2. avança i mescla cada veu activa amb el nucli `asio_mix_voice`.
//   3. notifica el final natural de cada veu acabada i les elimina.
//   4. entrellaça els acumuladors a `data`, amb soft-clip i conversió de format.
//
// `to_native` converteix una mostra f32 (post clip) al tipus de mostra del device.
// Disciplina RT: cap alloc en estat estacionari (els acumuladors només creixen el
// primer bloc o si la mida puja), cap IO, cap emissió d'events (només un `send`
// barat al canal de notificació quan una veu acaba), locks curts.
fn native_mix_callback<S>(
    data: &mut [S],
    channels: usize,
    voices: &Arc<Mutex<Vec<Voice>>>,
    stream_voices: &Arc<Mutex<Vec<StreamVoice>>>,
    acc: &Arc<Mutex<Vec<Vec<f32>>>>,
    to_native: &impl Fn(f32) -> S,
) where
    S: Copy,
{
    let frames = if channels > 0 { data.len() / channels } else { 0 };

    let mut acc_guard = match acc.lock() {
        Ok(a) => a,
        Err(_) => return,
    };
    // Ajusta la forma dels acumuladors al bloc actual (normalment només el 1r cop).
    if acc_guard.len() != channels {
        acc_guard.resize_with(channels, Vec::new);
    }
    for ch in acc_guard.iter_mut() {
        if ch.len() != frames {
            ch.resize(frames, 0.0);
        }
        ch.fill(0.0);
    }

    // Mescla totes les veus actives als acumuladors, notifica les acabades i
    // treu-les. La notificació és un `send` barat (només en acabar, no cada bloc).
    if let Ok(mut vs) = voices.lock() {
        for v in vs.iter_mut() {
            asio_mix_voice(v, &mut acc_guard, frames);
        }
        for v in vs.iter() {
            if v.finished {
                native_notify_ended(v.voice_id);
            }
        }
        vs.retain(|v| !v.finished);
    }

    // Veus en STREAMING: mateix patró dual que `asio_ensure_mix`. El decode-ahead
    // corre al fil de `spawn_stream`; aquí el callback només llegeix del ring (cap
    // alloc/IO/decode). `asio_mix_stream_voice` ja marca `finished` i atura el fil
    // descodificador en acabar (eof o release).
    if let Ok(mut svs) = stream_voices.lock() {
        for sv in svs.iter_mut() {
            asio_mix_stream_voice(sv, &mut acc_guard, frames);
        }
        for sv in svs.iter() {
            if sv.finished {
                native_notify_ended(sv.voice_id);
            }
        }
        svs.retain(|sv| !sv.finished);
    }

    // Entrellaça: data[frame*channels + ch] = clip(acc[ch][frame]).
    for f in 0..frames {
        for ch in 0..channels {
            let s = asio_soft_clip(acc_guard[ch][f]);
            data[f * channels + ch] = to_native(s);
        }
    }
}

// Resol els canals destí: els demanats que càpiguen al dispositiu; si no n'hi ha
// cap de vàlid, per defecte els 2 PRIMERS canals (estèreo a 1-2) — NO tots, perquè
// en un dispositiu de 8 sortides no es dupliqui el so a totes elles.
fn native_resolve_out_channels(channels: &[u16], dev_channels: usize) -> Vec<usize> {
    let out: Vec<usize> = channels
        .iter()
        .map(|&c| c as usize)
        .filter(|&c| c < dev_channels)
        .collect();
    if out.is_empty() {
        (0..dev_channels.min(2)).collect()
    } else {
        out
    }
}

// Construeix una `Voice` a partir del PCM ja descodificat + el `VoiceSpec` i
// l'afegeix a la mescla del dispositiu destí (substituint qualsevol veu amb el
// mateix id a QUALSEVOL device, perquè el slot pot haver canviat de sortida). Si
// entre la petició i ara el device s'ha tancat, descarta la veu. La descodificació
// ja s'ha fet fora; aquí només es clona l'Arc del PCM i s'omple la `Voice`.
fn native_build_and_push_voice(
    backends: &NativeBackends,
    device_name: &str,
    data: Arc<Vec<Vec<f32>>>,
    rate: u32,
    spec: VoiceSpec,
) {
    let total = data.iter().map(|c| c.len()).max().unwrap_or(0);
    if total == 0 {
        eprintln!("[native-voice] voice={} sense mostres → descartada", spec.voice_id);
        return;
    }
    let src_channels = data.len().max(1);
    let sr = rate as f32;
    let start_frame = ((spec.start_point.max(0.0) * sr) as usize).min(total);
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

    // Re-disparo del mateix slot: treu qualsevol veu anterior amb el mateix id de
    // TOTS els dispositius (pot haver canviat de device entre dispars), i després
    // afegeix la nova al device destí. Així no en queda una de penjada a un altre
    // dispositiu i en poden sonar de diferents alhora (ids diferents).
    for back in backends.values() {
        if let Ok(mut vs) = back.voices.lock() {
            vs.retain(|v| v.voice_id != spec.voice_id);
        }
    }
    match backends.get(device_name) {
        Some(b) => {
            if let Ok(mut vs) = b.voices.lock() {
                vs.push(voice);
            }
        }
        None => eprintln!("[native-voice] voice={} sense backend → descartada", spec.voice_id),
    }
}

// Arrenca un fil descodificador (`spawn_stream`) i registra una `StreamVoice` al
// dispositiu destí, perquè soni tan aviat com el ring té el primer tros (sense la
// latència del decode complet). Substitueix qualsevol veu del mateix id (de QUALSEVOL
// de les dues llistes, a QUALSEVOL device): el slot pot haver canviat de sortida o de
// memòria↔streaming entre dispars. Per a streaming SÍ que respectem start/stop/loop:
// `spawn_stream` ja els accepta (si loop, fa el flux continu gapless al fil).
#[allow(clippy::too_many_arguments)]
fn native_build_and_push_stream_voice(
    backends: &NativeBackends,
    device_name: &str,
    voice_id: u64,
    file_path: &str,
    sample_rate: u32,
    out_channels: Vec<usize>,
    gain: f32,
    fade_in: f32,
    fade_out: f32,
    loop_on: bool,
    start_point: f32,
    stop_point: f32,
) {
    let start_secs = start_point.max(0.0) as f64;
    let stop_secs = if stop_point > 0.0 { stop_point as f64 } else { 0.0 };
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
        stop_secs,
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

    // Re-disparo del mateix slot: treu qualsevol veu anterior amb el mateix id de
    // TOTS els dispositius, en AMBDUES llistes (memòria i streaming). Per a les
    // stream voices, atura abans el fil descodificador (ctrl.stop) per no deixar-lo
    // penjat. Després afegeix la nova al device destí.
    for back in backends.values() {
        if let Ok(mut vs) = back.voices.lock() {
            vs.retain(|v| v.voice_id != voice_id);
        }
        if let Ok(mut svs) = back.stream_voices.lock() {
            for old in svs.iter().filter(|x| x.voice_id == voice_id) {
                old.ctrl.stop.store(true, std::sync::atomic::Ordering::Relaxed);
            }
            svs.retain(|x| x.voice_id != voice_id);
        }
    }
    match backends.get(device_name) {
        Some(b) => {
            if let Ok(mut svs) = b.stream_voices.lock() {
                svs.push(sv);
            }
        }
        None => {
            // El device s'ha tancat entremig: atura el fil que acabem d'arrencar.
            sv.ctrl.stop.store(true, std::sync::atomic::Ordering::Relaxed);
            eprintln!("[native-voice] stream voice={} sense backend → descartada", voice_id);
        }
    }
}

// Dispara un cue SENSE BLOQUEJAR el fil del motor descodificant. Resol el device
// (per saber-ne el rate i els canals) i mira la cau:
//   · HIT  → construeix la `Voice` i la registra a l'INSTANT (només clona un Arc).
//   · MISS → llança el decode en un fil (`native-decode`); quan acaba, RegisterDecoded
//            desa el PCM a la cau i registra la veu. El GO retorna immediatament.
// Per a un cue ja pre-carregat (HIT) el so és instantani; mai hi ha decode síncron
// al fil del motor (eliminant els ~4 s de latència que tenia abans).
#[allow(clippy::too_many_arguments)]
fn native_play_cue_impl(
    backends: &mut NativeBackends,
    cache: &mut PcmCache,
    voice_id: u64,
    device_name: &str,
    file_path: &str,
    gain: f32,
    fade_in: f32,
    fade_out: f32,
    channels: &[u16],
    loop_on: bool,
    start_point: f32,
    stop_point: f32,
    streaming: bool,
) -> Result<(), String> {
    let (sample_rate, dev_channels) = native_ensure_backend(backends, device_name)?;
    let out_channels = native_resolve_out_channels(channels, dev_channels);

    // ── Camí STREAMING (pistes llargues): decode-ahead, sense carregar tot a RAM ──
    // No passa per la cau ni per un decode complet: arrenca el fil descodificador i
    // registra una StreamVoice que sona tan aviat com el ring té el primer tros →
    // sense la latència del decode complet. Reutilitza el mateix mecanisme d'ASIO.
    if streaming {
        native_build_and_push_stream_voice(
            backends, device_name, voice_id, file_path, sample_rate, out_channels, gain, fade_in,
            fade_out, loop_on, start_point, stop_point,
        );
        return Ok(());
    }

    // Paràmetres de la veu (sense PCM). El camí en memòria ja respecta loop i
    // segment start/stop: `native_build_and_push_voice` els tradueix a frames
    // (start_frame/stop_frame/fade) igual que ASIO. La cau guarda el fitxer
    // SENCER a la freqüència del driver; el segment només limita la lectura.
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

    // HIT de cau (p. ex. pre-carregat): registra la veu A L'INSTANT.
    let key: PcmKey = (file_path.to_string(), sample_rate);
    if let Some(data) = cache.get(&key) {
        native_build_and_push_voice(backends, device_name, data, sample_rate, spec);
        return Ok(());
    }

    // MISS: descodifica en un FIL a part i registra la veu quan arribi el PCM
    // (RegisterDecoded). El fil del motor no es bloqueja descodificant.
    let dev = device_name.to_string();
    let path = file_path.to_string();
    native_spawn_decode(path.clone(), sample_rate, move |data| NativeCmd::RegisterDecoded {
        device_name: dev,
        rate: sample_rate,
        file_path: path,
        data,
        spec,
    });
    Ok(())
}

// Pre-descodifica un fitxer i el deixa a la cau, SENSE reproduir-lo. Obre el device
// demanat (si cal) només per conèixer-ne la freqüència; el decode va en un fil a
// part (CacheStore). El GO posterior trobarà el PCM a la cau i serà instantani.
fn native_preload_impl(
    backends: &mut NativeBackends,
    cache: &mut PcmCache,
    device_name: &str,
    file_path: &str,
) -> Result<(), String> {
    let (sample_rate, _dev_channels) = native_ensure_backend(backends, device_name)?;
    let key: PcmKey = (file_path.to_string(), sample_rate);
    if cache.get(&key).is_some() {
        return Ok(()); // ja a la cau
    }
    let path = file_path.to_string();
    native_spawn_decode(path.clone(), sample_rate, move |data| NativeCmd::CacheStore {
        rate: sample_rate,
        file_path: path,
        data,
    });
    Ok(())
}

// Atura una veu pel seu id. Amb fade_out > 0, n'inicia la rampa de release des de
// la posició actual (el callback hi aplica el fade i l'elimina en arribar a 0);
// amb 0, l'elimina immediatament. Reutilitza `release_from`/`release_len` del nucli.
// Les comandes per veu cerquen el `voice_id` a TOTS els dispositius oberts (els ids
// són únics per slot, però el slot pot estar enrutat a qualsevol device).
fn native_stop_voice_impl(
    backends: &NativeBackends,
    voice_id: u64,
    fade_out: f32,
) -> Result<(), String> {
    for b in backends.values() {
        let sr = b.sample_rate as f32;
        let rel = (fade_out.max(0.0) * sr) as usize;
        if let Ok(mut vs) = b.voices.lock() {
            if fade_out > 0.0 {
                for v in vs.iter_mut() {
                    if v.voice_id == voice_id && v.release_from.is_none() {
                        v.release_from = Some(v.seg_pos());
                        v.release_len = rel.max(1);
                        v.loop_on = false; // un release acaba la veu encara que fes loop
                    }
                }
            } else {
                vs.retain(|v| v.voice_id != voice_id);
            }
        }
        // Veus en streaming: release amb fade (sobre played_out, frames de sortida),
        // o atura el fil i elimina si fade 0. Mateix patró que el camí ASIO.
        if let Ok(mut svs) = b.stream_voices.lock() {
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
    }
    Ok(())
}

// Canvia el gain (volum lineal) d'una veu activa en calent. El callback ja
// multiplica per `voice.gain` a cada frame, així que el canvi és immediat.
fn native_set_gain_impl(
    backends: &NativeBackends,
    voice_id: u64,
    gain: f32,
) -> Result<(), String> {
    for b in backends.values() {
        if let Ok(mut vs) = b.voices.lock() {
            for v in vs.iter_mut() {
                if v.voice_id == voice_id {
                    v.gain = gain.max(0.0);
                }
            }
        }
        if let Ok(mut svs) = b.stream_voices.lock() {
            for sv in svs.iter_mut() {
                if sv.voice_id == voice_id {
                    sv.gain = gain.max(0.0);
                }
            }
        }
    }
    Ok(())
}

// Reposiciona el playhead d'una veu activa: `position` són segons dins el segment
// (0 = inici del tram). Es limita a [start_frame, stop_frame).
fn native_seek_impl(
    backends: &NativeBackends,
    voice_id: u64,
    position: f32,
) -> Result<(), String> {
    for b in backends.values() {
        let rate = b.sample_rate as f32;
        if let Ok(mut vs) = b.voices.lock() {
            for v in vs.iter_mut() {
                if v.voice_id == voice_id {
                    let target = v.start_frame + (position.max(0.0) * rate) as usize;
                    let max = v.stop_frame.saturating_sub(1).max(v.start_frame);
                    v.pos = target.clamp(v.start_frame, max);
                }
            }
        }
        // Veus en streaming: `position` és ABSOLUT (segons dins el fitxer), igual que
        // ASIO. Demana el seek absolut al fil descodificador i ajusta posició/consum
        // perquè telemetria i out-point hi quadrin. Buida el ring per no sentir el
        // tram vell. Mateixa lògica que `asio_seek_impl`.
        if let Ok(mut svs) = b.stream_voices.lock() {
            for sv in svs.iter_mut() {
                if sv.voice_id == voice_id {
                    let abs = position.max(0.0) as f64;
                    let rel = (abs - sv.start_secs).max(0.0);
                    sv.ctrl.seek_ms.store((abs * 1000.0) as i64, std::sync::atomic::Ordering::Relaxed);
                    sv.played_out = (rel * rate as f64) as usize;
                    sv.frac = 0.0;
                    sv.src_consumed = if sv.file_rate > 0 { (rel * sv.file_rate as f64) as usize } else { 0 };
                    if let Ok(mut r) = sv.ring.lock() {
                        r.samples.clear();
                        r.eof = false;
                    }
                }
            }
        }
    }
    Ok(())
}

// Pausa o reprèn una veu activa. La veu es manté a la mescla; pausada, el callback
// escriu silenci i no avança la posició (el resume continua des d'on era).
fn native_set_paused_impl(
    backends: &NativeBackends,
    voice_id: u64,
    paused: bool,
) -> Result<(), String> {
    for b in backends.values() {
        if let Ok(mut vs) = b.voices.lock() {
            for v in vs.iter_mut() {
                if v.voice_id == voice_id {
                    v.paused = paused;
                }
            }
        }
        if let Ok(mut svs) = b.stream_voices.lock() {
            for sv in svs.iter_mut() {
                if sv.voice_id == voice_id {
                    sv.paused = paused;
                }
            }
        }
    }
    Ok(())
}

// ── API pública del mòdul (la criden els wrappers `#[tauri::command]` de lib.rs) ─
//
// Patró comú: cada funció empaqueta una `NativeCmd`, l'envia al fil natiu i espera
// la resposta amb un timeout adient. Petit ajudant per no repetir-ho.
fn send_and_wait(
    make: impl FnOnce(std::sync::mpsc::Sender<Result<(), String>>) -> NativeCmd,
    timeout: std::time::Duration,
    timeout_msg: &str,
) -> Result<(), String> {
    let (reply_tx, reply_rx) = std::sync::mpsc::channel();
    native_sender()
        .send(make(reply_tx))
        .map_err(|_| "El fil natiu no està disponible.".to_string())?;
    match reply_rx.recv_timeout(timeout) {
        Ok(res) => res,
        Err(_) => Err(timeout_msg.into()),
    }
}

// Reprodueix un cue via cpal pel dispositiu `device_name` (buit = per defecte) i
// els canals destí indicats, amb gain i fades. La veu (identificada per `voice_id`)
// sona junt amb les altres i s'acaba sola. El fil del motor NO descodifica de forma
// síncrona: amb el PCM a la cau registra la veu a l'instant; si no, llança el decode
// en un fil i retorna de seguida. Per això el timeout pot ser curt (només esperem
// que el motor accepti la comanda, no que descodifiqui).
#[allow(clippy::too_many_arguments)]
pub fn play_cue(
    voice_id: u64,
    device_name: String,
    file_path: String,
    gain: f32,
    fade_in: f32,
    fade_out: f32,
    channels: Vec<u16>,
    loop_on: bool,
    start_point: f32,
    stop_point: f32,
    streaming: bool,
) -> Result<(), String> {
    send_and_wait(
        |reply| NativeCmd::PlayCue {
            voice_id, device_name, file_path, gain, fade_in, fade_out, channels,
            loop_on, start_point, stop_point, streaming, reply,
        },
        std::time::Duration::from_secs(5),
        "Temps esgotat o error reproduint el cue natiu.",
    )
}

// Pre-descodifica un cue i el deixa a la cau del motor natiu, perquè el seu GO sigui
// instantani (sense la latència de descodificar). No reprodueix res. El decode va en
// un fil a part; aquí només esperem que el motor obri el device i accepti la feina.
pub fn preload(device_name: String, file_path: String) -> Result<(), String> {
    send_and_wait(
        |reply| NativeCmd::Preload { device_name, file_path, reply },
        std::time::Duration::from_secs(10),
        "Temps esgotat o error pre-descodificant el cue natiu.",
    )
}

// Atura una veu nativa pel seu id, amb fade-out opcional (segons).
pub fn stop_voice(voice_id: u64, fade_out: f32) -> Result<(), String> {
    send_and_wait(
        |reply| NativeCmd::StopVoice { voice_id, fade_out, reply },
        std::time::Duration::from_secs(5),
        "Temps esgotat o error aturant la veu nativa.",
    )
}

// Canvia el volum (gain lineal) d'una veu nativa activa en calent.
pub fn set_gain(voice_id: u64, gain: f32) -> Result<(), String> {
    send_and_wait(
        |reply| NativeCmd::SetGain { voice_id, gain, reply },
        std::time::Duration::from_secs(5),
        "Temps esgotat o error canviant el volum natiu.",
    )
}

// Reposiciona el playhead d'una veu nativa activa (segons dins el segment).
pub fn seek(voice_id: u64, position: f32) -> Result<(), String> {
    send_and_wait(
        |reply| NativeCmd::Seek { voice_id, position, reply },
        std::time::Duration::from_secs(5),
        "Temps esgotat o error fent seek natiu.",
    )
}

// Pausa o reprèn una veu nativa activa (congela la posició, sense aturar-la).
pub fn set_paused(voice_id: u64, paused: bool) -> Result<(), String> {
    send_and_wait(
        |reply| NativeCmd::SetPaused { voice_id, paused, reply },
        std::time::Duration::from_secs(5),
        "Temps esgotat o error pausant la veu nativa.",
    )
}

// Atura la reproducció natiu (buida totes les veus actives). Parada global.
pub fn stop() -> Result<(), String> {
    send_and_wait(
        |reply| NativeCmd::Stop { reply },
        std::time::Duration::from_secs(5),
        "Temps esgotat o error aturant el motor natiu.",
    )
}
