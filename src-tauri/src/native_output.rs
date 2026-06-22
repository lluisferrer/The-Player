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
// Limitacions conscients d'aquest increment (queden per a increments POSTERIORS):
//   · No hi ha streaming (decode-ahead) per a pistes llargues: tot el PCM es
//     carrega a memòria. El routing multicanal real per canal + la selecció de
//     dispositiu i la integració amb la UI React vénen després.
//   · El WebView només dóna estèreo; aquest motor natiu és la via cap a multicanal
//     de debò, però aquí encara fem servir el dispositiu de sortida per defecte tal
//     com cpal el reporta (sovint 2 canals).

#![cfg(feature = "native")]

use std::sync::{Arc, Mutex, OnceLock};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};

use crate::{asio_decode, asio_soft_clip, asio_mix_voice, Voice};

// Estat persistent del backend cpal: l'stream de sortida obert i la llista de
// veus que el callback mescla. Es manté viu mentre hi hagi reproducció.
//
// `stream` cal MANTENIR-LO VIU: si es deixés caure, cpal aturaria el dispositiu.
// `cpal::Stream` NO és Send, per això tot el backend viu en un fil propietari
// (vegeu `native_thread_main`) i mai creua fronteres de fil.
struct NativeBackend {
    // Veus actives compartides amb el callback (fil RT de cpal). Lock curt.
    voices: Arc<Mutex<Vec<Voice>>>,
    // Freqüència real del dispositiu obert (per descodificar al rate correcte).
    sample_rate: u32,
    // Nombre de canals del dispositiu (per validar el routing dels cues).
    channels: usize,
    // L'stream cpal obert. Viu mentre el backend existeix.
    #[allow(dead_code)]
    stream: cpal::Stream,
}

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
        file_path: String,
        gain: f32,
        fade_in: f32,
        fade_out: f32,
        channels: Vec<u16>,
        reply: std::sync::mpsc::Sender<Result<(), String>>,
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
// El fil de telemetria mostreja la llista de veus activa (la mateixa que el
// callback) i la freqüència del device per convertir frames a segons. S'estableix
// quan s'obre el backend. Anàleg a `AsioMeterShared`/`ASIO_METER` del motor ASIO.
struct NativeMeterShared {
    voices: Arc<Mutex<Vec<Voice>>>,
    sample_rate: u32,
}

static NATIVE_METER: OnceLock<Mutex<Option<NativeMeterShared>>> = OnceLock::new();

// Accés mandrós a l'slot compartit de telemetria.
fn native_meter_slot() -> &'static Mutex<Option<NativeMeterShared>> {
    NATIVE_METER.get_or_init(|| Mutex::new(None))
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
            // Snapshot curt sota lock: id, posició (s) i nivell de cada veu activa.
            let items: Vec<NativeTelemetryItem> = {
                let guard = match native_meter_slot().lock() {
                    Ok(g) => g,
                    Err(_) => continue,
                };
                match guard.as_ref() {
                    Some(sh) => {
                        let rate = sh.sample_rate.max(1) as f32;
                        match sh.voices.lock() {
                            Ok(vs) => vs
                                .iter()
                                .filter(|v| !v.finished)
                                .map(|v| NativeTelemetryItem {
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
                let _ = app.emit("native-telemetry", &items);
            }
        })
        .ok();
}

// Bucle del fil natiu: rep ordres i les atén una a una, mantenint el backend
// (stream + veus) viu entre cues. Aïllem cada ordre amb `catch_unwind` perquè un
// error d'un device dolent no mati el fil ni deixi el dispositiu en mal estat.
fn native_thread_main(rx: std::sync::mpsc::Receiver<NativeCmd>) {
    // Backend persistent: None fins al primer cue, després es manté obert.
    let mut backend: Option<NativeBackend> = None;
    while let Ok(cmd) = rx.recv() {
        match cmd {
            NativeCmd::PlayCue { voice_id, file_path, gain, fade_in, fade_out, channels, reply } => {
                let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    native_play_cue_impl(&mut backend, voice_id, &file_path, gain, fade_in, fade_out, &channels)
                }))
                .unwrap_or_else(|_| Err("Pànic reproduint el cue natiu.".into()));
                let _ = reply.send(res);
            }
            NativeCmd::StopVoice { voice_id, fade_out, reply } => {
                let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    native_stop_voice_impl(&backend, voice_id, fade_out)
                }))
                .unwrap_or_else(|_| Err("Pànic aturant la veu nativa.".into()));
                let _ = reply.send(res);
            }
            NativeCmd::SetGain { voice_id, gain, reply } => {
                let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    native_set_gain_impl(&backend, voice_id, gain)
                }))
                .unwrap_or_else(|_| Err("Pànic canviant el gain natiu.".into()));
                let _ = reply.send(res);
            }
            NativeCmd::Seek { voice_id, position, reply } => {
                let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    native_seek_impl(&backend, voice_id, position)
                }))
                .unwrap_or_else(|_| Err("Pànic fent seek natiu.".into()));
                let _ = reply.send(res);
            }
            NativeCmd::SetPaused { voice_id, paused, reply } => {
                let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    native_set_paused_impl(&backend, voice_id, paused)
                }))
                .unwrap_or_else(|_| Err("Pànic pausant la veu nativa.".into()));
                let _ = reply.send(res);
            }
            NativeCmd::Stop { reply } => {
                let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    if let Some(b) = backend.as_ref() {
                        if let Ok(mut v) = b.voices.lock() {
                            v.clear();
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

// Assegura que hi ha un backend cpal obert (stream de sortida del dispositiu per
// defecte + llista de veus + callback de mescla). Idempotent: si ja n'hi ha, el
// reutilitza. Retorna la freqüència i el nombre de canals del dispositiu.
fn native_ensure_backend(backend: &mut Option<NativeBackend>) -> Result<(u32, usize), String> {
    if let Some(b) = backend.as_ref() {
        return Ok((b.sample_rate, b.channels));
    }

    let host = cpal::default_host();
    let device = host
        .default_output_device()
        .ok_or_else(|| "No hi ha cap dispositiu de sortida per defecte.".to_string())?;
    let supported = device
        .default_output_config()
        .map_err(|e| format!("default_output_config(): {}", e))?;
    let sample_format = supported.sample_format();
    let config: cpal::StreamConfig = supported.into();
    let channels = config.channels as usize;
    let sample_rate = config.sample_rate.0;

    // Llista de veus compartida amb el callback (fil RT de cpal).
    let voices: Arc<Mutex<Vec<Voice>>> = Arc::new(Mutex::new(Vec::new()));
    // Acumuladors pre-allocats (un Vec per canal): el callback els reutilitza
    // zerant-los cada bloc, sense assignar memòria al fil d'àudio.
    let acc: Arc<Mutex<Vec<Vec<f32>>>> = Arc::new(Mutex::new(Vec::new()));

    let err_fn = |e| eprintln!("[native] error stream de sortida: {}", e);

    // Construeix el callback per al tipus de mostra del dispositiu. La mescla és
    // SEMPRE en f32 (al nucli); aquí només convertim l'acumulador al format natiu.
    macro_rules! build {
        ($sample:ty, $to:expr) => {{
            let cb_voices = voices.clone();
            let cb_acc = acc.clone();
            device.build_output_stream(
                &config,
                move |data: &mut [$sample], _: &cpal::OutputCallbackInfo| {
                    native_mix_callback(data, channels, &cb_voices, &cb_acc, &$to);
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
        other => return Err(format!("Format de mostra no suportat: {:?}", other)),
    }
    .map_err(|e| format!("build_output_stream(): {}", e))?;

    stream.play().map_err(|e| format!("play(): {}", e))?;

    // Publica la llista de veus i la freqüència perquè el fil de telemetria les
    // mostregi (playhead + VU) sense tocar el callback RT.
    if let Ok(mut g) = native_meter_slot().lock() {
        *g = Some(NativeMeterShared { voices: voices.clone(), sample_rate });
    }

    *backend = Some(NativeBackend { voices, sample_rate, channels, stream });
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

    // Entrellaça: data[frame*channels + ch] = clip(acc[ch][frame]).
    for f in 0..frames {
        for ch in 0..channels {
            let s = asio_soft_clip(acc_guard[ch][f]);
            data[f * channels + ch] = to_native(s);
        }
    }
}

// Descodifica el cue i registra una veu al backend. La descodificació (symphonia
// + resampling) es fa AQUÍ, al fil natiu, MAI dins el callback RT. NO buida les
// altres veus: poden sonar-ne diverses alhora. Si ja existeix una veu amb el
// mateix `voice_id`, la substitueix (re-disparo del mateix slot).
fn native_play_cue_impl(
    backend: &mut Option<NativeBackend>,
    voice_id: u64,
    file_path: &str,
    gain: f32,
    fade_in: f32,
    fade_out: f32,
    channels: &[u16],
) -> Result<(), String> {
    let (sample_rate, dev_channels) = native_ensure_backend(backend)?;

    // Canals destí: els demanats que càpiguen al dispositiu; si no n'hi ha cap
    // de vàlid, per defecte tots els canals del dispositiu (estèreo habitual).
    let out_channels: Vec<usize> = channels
        .iter()
        .map(|&c| c as usize)
        .filter(|&c| c < dev_channels)
        .collect();
    let out_channels = if out_channels.is_empty() {
        (0..dev_channels).collect()
    } else {
        out_channels
    };

    // Descodifica + resampleja a la freqüència REAL del dispositiu.
    let decoded = asio_decode::decode_file(file_path, sample_rate)?;
    let data = Arc::new(decoded.data);
    let src_channels = data.len().max(1);
    let total = data.iter().map(|c| c.len()).max().unwrap_or(0);
    if total == 0 {
        return Err("El fitxer no té cap mostra reproduïble.".into());
    }

    // Fades en frames a la freqüència del dispositiu (acotats a la durada).
    let sr = sample_rate as f32;
    let fade_in_len = ((fade_in.max(0.0) * sr) as usize).min(total);
    let fade_out_len = ((fade_out.max(0.0) * sr) as usize).min(total);

    let voice = Voice {
        voice_id,
        data,
        src_channels,
        out_channels,
        pos: 0,
        start_frame: 0,
        stop_frame: total,
        gain: gain.max(0.0),
        loop_on: false,
        fade_in_len,
        fade_out_len,
        release_from: None,
        release_len: 0,
        finished: false,
        paused: false,
        meter: 0.0,
    };

    let b = backend.as_ref().ok_or("Backend natiu no disponible.")?;
    if let Ok(mut vs) = b.voices.lock() {
        // Multi-veu: substitueix només la veu del mateix id (re-disparo) i conserva
        // la resta, perquè en puguin sonar diverses alhora.
        vs.retain(|v| v.voice_id != voice_id);
        vs.push(voice);
    }
    Ok(())
}

// Atura una veu pel seu id. Amb fade_out > 0, n'inicia la rampa de release des de
// la posició actual (el callback hi aplica el fade i l'elimina en arribar a 0);
// amb 0, l'elimina immediatament. Reutilitza `release_from`/`release_len` del nucli.
fn native_stop_voice_impl(
    backend: &Option<NativeBackend>,
    voice_id: u64,
    fade_out: f32,
) -> Result<(), String> {
    let b = match backend.as_ref() {
        Some(b) => b,
        None => return Ok(()), // res obert: res a aturar
    };
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
    Ok(())
}

// Canvia el gain (volum lineal) d'una veu activa en calent. El callback ja
// multiplica per `voice.gain` a cada frame, així que el canvi és immediat.
fn native_set_gain_impl(
    backend: &Option<NativeBackend>,
    voice_id: u64,
    gain: f32,
) -> Result<(), String> {
    let b = match backend.as_ref() {
        Some(b) => b,
        None => return Ok(()),
    };
    if let Ok(mut vs) = b.voices.lock() {
        for v in vs.iter_mut() {
            if v.voice_id == voice_id {
                v.gain = gain.max(0.0);
            }
        }
    }
    Ok(())
}

// Reposiciona el playhead d'una veu activa: `position` són segons dins el segment
// (0 = inici del tram). Es limita a [start_frame, stop_frame).
fn native_seek_impl(
    backend: &Option<NativeBackend>,
    voice_id: u64,
    position: f32,
) -> Result<(), String> {
    let b = match backend.as_ref() {
        Some(b) => b,
        None => return Ok(()),
    };
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
    Ok(())
}

// Pausa o reprèn una veu activa. La veu es manté a la mescla; pausada, el callback
// escriu silenci i no avança la posició (el resume continua des d'on era).
fn native_set_paused_impl(
    backend: &Option<NativeBackend>,
    voice_id: u64,
    paused: bool,
) -> Result<(), String> {
    let b = match backend.as_ref() {
        Some(b) => b,
        None => return Ok(()),
    };
    if let Ok(mut vs) = b.voices.lock() {
        for v in vs.iter_mut() {
            if v.voice_id == voice_id {
                v.paused = paused;
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

// Reprodueix un cue (fitxer descodificat a memòria) pel dispositiu de sortida per
// defecte via cpal, amb gain i fades. La veu (identificada per `voice_id`) sona
// junt amb les altres i s'acaba sola. La descodificació passa al fil natiu; aquí
// s'hi espera resposta amb timeout ampli (inclou descodificar + resamplejar).
pub fn play_cue(
    voice_id: u64,
    file_path: String,
    gain: f32,
    fade_in: f32,
    fade_out: f32,
    channels: Vec<u16>,
) -> Result<(), String> {
    send_and_wait(
        |reply| NativeCmd::PlayCue { voice_id, file_path, gain, fade_in, fade_out, channels, reply },
        std::time::Duration::from_secs(30),
        "Temps esgotat o error reproduint el cue natiu.",
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
