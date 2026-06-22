// Backend de sortida d'àudio NATIU MULTIPLATAFORMA basat en cpal (host per
// defecte: WASAPI a Windows, CoreAudio a Mac). És el primer increment del motor
// natiu unificat: dispara UNA veu (cue en memòria) pel dispositiu de sortida per
// defecte, amb gain i fades, i la veu s'acaba sola.
//
// Reutilitza EL MATEIX nucli de veus que el motor ASIO:
//   · `Voice`           — estat d'una reproducció (PCM + paràmetres).
//   · `asio_mix_voice`  — avança i mescla la veu als acumuladors de sortida.
//   · `asio_soft_clip`  — saturació suau abans d'escriure al buffer.
//   · `asio_decode`     — descodificació + resampling a la freqüència del device.
//
// Disciplina de temps real al callback: cap `alloc`, cap IO, cap descodificació.
// Només locks CURTS (la llista de veus), com fa el callback ASIO. La descodificació
// es fa FORA del callback (al fil de la comanda) i el PCM ja arriba resamplejat.
//
// Limitacions conscients d'aquest increment (queden per a increments POSTERIORS):
//   · Una sola veu activa (no hi ha id ni cua de veus encara — `native_stop` les
//     buida totes). Multicanal real, routing per canal, streaming, telemetria i
//     la integració amb la UI vénen després.
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
    // Descodifica `file_path` i registra una veu que el callback reprodueix.
    PlayCue {
        file_path: String,
        gain: f32,
        fade_in: f32,
        fade_out: f32,
        channels: Vec<u16>,
        reply: std::sync::mpsc::Sender<Result<(), String>>,
    },
    // Atura TOTES les veus actives (aquest increment encara no porta ids).
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

// Bucle del fil natiu: rep ordres i les atén una a una, mantenint el backend
// (stream + veus) viu entre cues. Aïllem cada ordre amb `catch_unwind` perquè un
// error d'un device dolent no mati el fil ni deixi el dispositiu en mal estat.
fn native_thread_main(rx: std::sync::mpsc::Receiver<NativeCmd>) {
    // Backend persistent: None fins al primer cue, després es manté obert.
    let mut backend: Option<NativeBackend> = None;
    while let Ok(cmd) = rx.recv() {
        match cmd {
            NativeCmd::PlayCue { file_path, gain, fade_in, fade_out, channels, reply } => {
                let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    native_play_cue_impl(&mut backend, &file_path, gain, fade_in, fade_out, &channels)
                }))
                .unwrap_or_else(|_| Err("Pànic reproduint el cue natiu.".into()));
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

    *backend = Some(NativeBackend { voices, sample_rate, channels, stream });
    Ok((sample_rate, channels))
}

// Callback de mescla (fil RT de cpal). Per cada bloc de `data` (interleaved):
//   1. assegura/zera els acumuladors per canal (mida = frames del bloc).
//   2. avança i mescla cada veu activa amb el nucli `asio_mix_voice`.
//   3. elimina les veus acabades (final natural o release).
//   4. entrellaça els acumuladors a `data`, amb soft-clip i conversió de format.
//
// `to_native` converteix una mostra f32 (post clip) al tipus de mostra del device.
// Disciplina RT: cap alloc en estat estacionari (els acumuladors només creixen el
// primer bloc o si la mida puja), cap IO, locks curts.
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

    // Mescla totes les veus actives als acumuladors i treu les acabades.
    if let Ok(mut vs) = voices.lock() {
        for v in vs.iter_mut() {
            asio_mix_voice(v, &mut acc_guard, frames);
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
// + resampling) es fa AQUÍ, al fil natiu, MAI dins el callback RT. Aquest
// increment substitueix qualsevol veu prèvia (model d'una sola veu): buida la
// llista abans d'afegir la nova.
fn native_play_cue_impl(
    backend: &mut Option<NativeBackend>,
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
        voice_id: 1, // un sol cue actiu en aquest increment
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
        vs.clear(); // model d'una sola veu en aquest increment
        vs.push(voice);
    }
    Ok(())
}

// ── API pública del mòdul (la criden els wrappers `#[tauri::command]` de lib.rs) ─

// Reprodueix un cue (fitxer descodificat a memòria) pel dispositiu de sortida per
// defecte via cpal, amb gain i fades. La veu s'acaba sola. La descodificació passa
// al fil natiu; aquí s'hi espera resposta amb timeout ampli.
pub fn play_cue(
    file_path: String,
    gain: f32,
    fade_in: f32,
    fade_out: f32,
    channels: Vec<u16>,
) -> Result<(), String> {
    let (reply_tx, reply_rx) = std::sync::mpsc::channel();
    native_sender()
        .send(NativeCmd::PlayCue { file_path, gain, fade_in, fade_out, channels, reply: reply_tx })
        .map_err(|_| "El fil natiu no està disponible.".to_string())?;
    // Marge ampli: inclou descodificar + resamplejar el fitxer.
    match reply_rx.recv_timeout(std::time::Duration::from_secs(30)) {
        Ok(res) => res,
        Err(_) => Err("Temps esgotat o error reproduint el cue natiu.".into()),
    }
}

// Atura la reproducció natiu (buida totes les veus actives). En increments
// posteriors aturarà una veu concreta pel seu id.
pub fn stop() -> Result<(), String> {
    let (reply_tx, reply_rx) = std::sync::mpsc::channel();
    native_sender()
        .send(NativeCmd::Stop { reply: reply_tx })
        .map_err(|_| "El fil natiu no està disponible.".to_string())?;
    match reply_rx.recv_timeout(std::time::Duration::from_secs(5)) {
        Ok(res) => res,
        Err(_) => Err("Temps esgotat o error aturant el motor natiu.".into()),
    }
}
