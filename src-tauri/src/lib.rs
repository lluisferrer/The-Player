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
    name: String,
    max_channels: u16,
    default_channels: u16,
    default_sample_rate: u32,
    is_default: bool,
}

// Llista els dispositius de sortida natius (WASAPI) amb els seus canals
// REALS — per saber si podem fer routing multicanal / cue de debò.
#[tauri::command]
fn list_audio_outputs() -> Result<Vec<AudioOutput>, String> {
    let host = cpal::default_host();
    let default_name = host
        .default_output_device()
        .and_then(|d| d.name().ok());

    let devices = host.output_devices().map_err(|e| e.to_string())?;
    let mut out = Vec::new();
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
            name,
            max_channels,
            default_channels,
            default_sample_rate,
            is_default,
        });
    }
    Ok(out)
}

// Treu un to sinusoïdal (440 Hz) NOMÉS pel canal indicat (0-based) del
// dispositiu donat, durant `seconds`. Serveix per verificar el routing
// real per canals abans de migrar el motor d'àudio a natiu.
#[tauri::command]
fn play_test_tone(device_name: String, channel: u16, seconds: f32) -> Result<(), String> {
    let host = cpal::default_host();
    let device = host
        .output_devices()
        .map_err(|e| e.to_string())?
        .find(|d| d.name().map(|n| n == device_name).unwrap_or(false))
        .ok_or_else(|| format!("Dispositiu no trobat: {}", device_name))?;

    let supported = device
        .default_output_config()
        .map_err(|e| e.to_string())?;
    let sample_format = supported.sample_format();
    let config: cpal::StreamConfig = supported.into();
    let channels = config.channels as usize;
    let target = channel as usize;
    if target >= channels {
        return Err(format!(
            "El canal {} no existeix (el dispositiu en té {})",
            channel + 1,
            channels
        ));
    }
    let sample_rate = config.sample_rate.0 as f32;
    let dur = seconds.max(0.1);

    std::thread::spawn(move || {
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
        .invoke_handler(tauri::generate_handler![
            read_file_bytes,
            list_audio_outputs,
            play_test_tone
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
