use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use serde::Serialize;

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
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            read_file_bytes,
            list_audio_outputs,
            detect_asio,
            play_test_tone
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
