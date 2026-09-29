use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use serde::Serialize;

// Sistema de llicències L1 (offline, Ed25519). Sempre compilat (no depèn de cap
// feature d'àudio): l'app ha de poder verificar la llicència en qualsevol build.
pub mod license;
// Canonicalització del payload (compartida amb tools/ezykeygen per ruta).
mod license_canon;

// Inhibició del repòs del sistema / pantalla durant un show (sempre compilat).
mod power;

// Shows com a carpeta autocontinguda (crear carpeta, copiar mèdia a Media/).
mod show;

// Servidor de mèdia local per HTTP (només s'arrenca a Linux: el <video> de
// WebKitGTK no reprodueix des del protocol asset://).
mod media_server;

// Descodificació d'àudio a Rust per al render natiu de cues. Part del nucli
// reutilitzable: disponible amb `native` (i, per implicació, amb `asio`).
#[cfg(feature = "native")]
mod asio_decode;

// Descodificació en STREAMING (decode-ahead) per a pistes llargues. La consumeixen
// tant el motor ASIO com el backend cpal natiu (les veus en streaming són nucli
// reutilitzable). Disponible amb `native` (i, per implicació, amb `asio`).
#[cfg(feature = "native")]
mod asio_stream;

// Càlcul de forma d'ona (pics) i durada via symphonia, en STREAMING (memòria
// O(buckets), no O(durada)). Evita descodificar cues llargs al WebView (A5/B5).
// Disponible amb `native`.
#[cfg(feature = "native")]
mod waveform;

// Backend de sortida natiu basat en cpal (host per defecte: WASAPI a Windows,
// CoreAudio a Mac). Reutilitza el nucli de veus (`Voice` + `asio_mix_voice`).
#[cfg(feature = "native")]
mod native_output;

// Extensions de mèdia que l'app accepta (coincideix amb MEDIA_EXT a src/App.jsx).
// Qualsevol altra extensió és rebutjada per evitar que un XSS pugui llegir
// fitxers arbitraris del sistema (secrets, configuració, etc.) via aquesta comanda.
const ALLOWED_EXTENSIONS: &[&str] = &[
    "mp3", "mpeg", "mpg", "m4a", "aac", "wav", "ogg", "flac",
    "mp4", "webm", "m4v", "mov",
    "jpg", "jpeg", "png", "webp", "gif", "bmp",
    "pdf",
];

// Llegeix els bytes d'un fitxer de mèdia pel seu camí absolut (per carregar àudio
// des de rutes guardades a la Library). Rebutja extensió no mèdia per seguretat.
#[tauri::command]
fn read_file_bytes(path: String) -> Result<tauri::ipc::Response, String> {
    // Extrau l'extensió en minúscules per comparar amb la llista permesa
    let ext = std::path::Path::new(&path)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_lowercase())
        .unwrap_or_default();

    if !ALLOWED_EXTENSIONS.contains(&ext.as_str()) {
        return Err(format!(
            "Extensió «{}» no permesa: només s'accepten fitxers de mèdia.",
            ext
        ));
    }

    std::fs::read(&path)
        .map(tauri::ipc::Response::new)
        .map_err(|e| format!("No s'ha pogut llegir {}: {}", path, e))
}

#[derive(Serialize)]
struct AudioOutput {
    host: String, // "WASAPI", "CoreAudio", "ALSA" o "ASIO" — el backend que exposa el dispositiu
    name: String, // nom intern de cpal (és el que s'usa per tornar-lo a obrir)
    label: String, // nom llegible per a la UI (a Linux, el de la targeta en comptes de "hw:CARD=…")
    max_channels: u16,
    default_channels: u16,
    default_sample_rate: u32,
    is_default: bool,
    // El motor natiu el té OBERT ara mateix (sonant o precarregat). Un dispositiu
    // exclusiu obert no es pot sondejar; en aquest cas la freqüència ve del motor.
    open: bool,
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

// Plataforma d'àudio, perquè la UI anomeni bé els backends (a Linux no hi ha
// WASAPI ni ASIO: el Web Audio va per PulseAudio i el motor natiu per ALSA).
#[derive(Serialize)]
struct AudioPlatform {
    os: &'static str,
    native_host: &'static str,
    asio: bool,
}

#[tauri::command]
fn audio_platform() -> AudioPlatform {
    let native_host = match std::env::consts::OS {
        "windows" => "WASAPI",
        "macos" => "CoreAudio",
        "linux" => "ALSA",
        other => other,
    };
    AudioPlatform {
        os: std::env::consts::OS,
        native_host,
        asio: cfg!(feature = "asio"),
    }
}

// Recull els dispositius de sortida d'un host concret i els afegeix a `out`,
// etiquetats amb el nom del backend (host_label). No falla si el host no en té.
// (A Linux NO s'usa: vegeu `collect_alsa_outputs`.)
#[cfg_attr(target_os = "linux", allow(dead_code))]
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
            label: name.clone(),
            name,
            max_channels,
            default_channels,
            default_sample_rate,
            is_default,
            open: false,
        });
    }
}

// PCM que ALSA defineix de sèrie (connectors de conversió, mescladors, ponts a
// servidors…): no són sortides per si mateixos, així que no els mostrem.
#[cfg(target_os = "linux")]
const ALSA_BUILTIN_PCMS: &[&str] = &[
    "null", "lavrate", "samplerate", "speexrate", "speex", "upmix", "vdownmix",
    "jack", "oss", "pulse", "pipewire",
];

// Llista les sortides ALSA SENSE obrir-les amb cpal. L'enumeració de cpal 0.15
// obre tots els PCM, i un `dmix` sobre una targeta ocupada es penja ~25 s; aquí
// llegim els noms dels hints (instantani) i només sondegem els que mostrem, en
// mode no bloquejant (una targeta ocupada torna EBUSY a l'acte).
//
// Què mostrem:
//   - `default` (el mesclador del sistema).
//   - Els PCM definits per l'usuari o un driver amb descripció (p. ex. `aes67` i
//     `ravenna_out` de /etc/alsa/conf.d/60-aes67-driver.conf, fixats a 48 kHz).
//   - L'accés directe a cada targeta (`hw:CARD=X,DEV=N`), llevat de RAVENNA: el
//     driver segueix la freqüència amb què s'obre i obrir-lo a ≠48 kHz fa que el
//     dimoni AES67 publiqui un SDP incorrecte; per a RAVENNA només els PCM de 48 kHz.
#[cfg(target_os = "linux")]
fn collect_alsa_outputs(out: &mut Vec<AudioOutput>) {
    let hints = match alsa::device_name::HintIter::new_str(None, "pcm") {
        Ok(h) => h,
        Err(_) => return,
    };
    for hint in hints {
        let Some(name) = hint.name else { continue };
        if hint.direction == Some(alsa::Direction::Capture) {
            continue;
        }
        // Primera línia de la descripció (la segona sol ser un detall tècnic).
        let desc = hint
            .desc
            .as_deref()
            .and_then(|d| d.lines().next())
            .map(|d| d.trim().to_string())
            .filter(|d| !d.is_empty());

        let label = if name == "default" {
            "System default".to_string()
        } else if let Some(rest) = name.strip_prefix("hw:CARD=") {
            let (card, dev) = rest.split_once(",DEV=").unwrap_or((rest, "0"));
            if card == "RAVENNA" {
                continue;
            }
            alsa_friendly_name(card, dev).unwrap_or_else(|| name.clone())
        } else if name.contains(':') || ALSA_BUILTIN_PCMS.contains(&name.as_str()) {
            // plughw:, dmix:, sysdefault:, surround51:… són variants del maquinari.
            continue;
        } else {
            match desc.as_deref() {
                // PCM només de captura (p. ex. "AES67 Driver (input 48 kHz)").
                Some(d) if d.to_lowercase().contains("(input") => continue,
                Some(d) => d.to_string(),
                None => name.clone(),
            }
        };

        let (probed_channels, rate) = probe_alsa_output(&name);
        let channels = alsa_channels_rule(&name, desc.as_deref(), probed_channels);

        out.push(AudioOutput {
            host: "ALSA".to_string(),
            is_default: name == "default",
            open: false,
            label,
            name,
            max_channels: channels,
            default_channels: channels.min(2),
            default_sample_rate: rate,
        });
    }
}

// Canals REALS d'una sortida ALSA (els que mostra Settings i amb què l'obre el motor
// natiu). Un PCM `plug` accepta qualsevol nombre de canals (en reporta milers), i una
// targeta ocupada no es pot sondejar: en aquests casos manen els canals que declara
// la descripció ("48 ch", "stereo"). El `default` sol ser PulseAudio: estèreo,
// encara que en reporti més.
#[cfg(target_os = "linux")]
fn alsa_channels_rule(name: &str, desc: Option<&str>, probed_channels: u16) -> u16 {
    if name == "default" {
        2
    } else {
        channels_from_desc(desc)
            .filter(|_| probed_channels == 0 || probed_channels > 64)
            .unwrap_or(probed_channels.min(64))
    }
}

// Mateixa regla per a UN sol PCM pel nom (la fa servir el motor natiu en obrir-lo,
// perquè cpal 0.15 retalla a 32 i els `plug` en declaren milers). Busca la
// descripció als hints (instantani) i sondeja el PCM. None = no es pot saber.
#[cfg(target_os = "linux")]
pub(crate) fn alsa_output_channels(name: &str) -> Option<u16> {
    let name = if name.is_empty() { "default" } else { name };
    let desc = alsa::device_name::HintIter::new_str(None, "pcm").ok().and_then(|hints| {
        hints
            .filter(|h| h.name.as_deref() == Some(name))
            .find_map(|h| h.desc)
            .and_then(|d| d.lines().next().map(|l| l.trim().to_string()))
    });
    let (probed, _) = probe_alsa_output(name);
    let ch = alsa_channels_rule(name, desc.as_deref(), probed);
    if ch == 0 { None } else { Some(ch) }
}

// Obre el PCM en mode no bloquejant i en llegeix els canals màxims i la
// freqüència (48 kHz si l'admet). (0, 0) si està ocupat o no es pot obrir.
#[cfg(target_os = "linux")]
fn probe_alsa_output(name: &str) -> (u16, u32) {
    let Ok(pcm) = alsa::pcm::PCM::new(name, alsa::Direction::Playback, true) else {
        return (0, 0);
    };
    let Ok(hwp) = alsa::pcm::HwParams::any(&pcm) else {
        return (0, 0);
    };
    let channels = hwp.get_channels_max().unwrap_or(0).min(u16::MAX as u32) as u16;
    let rate = if hwp.test_rate(48000).is_ok() {
        48000
    } else {
        hwp.get_rate_max().unwrap_or(0)
    };
    (channels, rate)
}

// Canals declarats a la descripció d'un PCM: "(48 ch)" → 48, "stereo" → 2.
#[cfg(target_os = "linux")]
fn channels_from_desc(desc: Option<&str>) -> Option<u16> {
    let d = desc?.to_lowercase();
    let words: Vec<&str> = d
        .split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|w| !w.is_empty())
        .collect();
    for pair in words.windows(2) {
        if pair[1] == "ch" || pair[1] == "channels" {
            if let Ok(n) = pair[0].parse::<u16>() {
                return Some(n);
            }
        }
    }
    if d.contains("stereo") {
        return Some(2);
    }
    None
}

// Nom llegible d'una sortida ALSA a partir de /proc/asound: el nom de la
// targeta ("HDA Intel PCH") i, si és diferent, el del PCM ("CS4206 Analog").
#[cfg(target_os = "linux")]
fn alsa_friendly_name(card: &str, dev: &str) -> Option<String> {
    // /proc/asound/cards: " 1 [PCH            ]: HDA-Intel - HDA Intel PCH"
    let cards = std::fs::read_to_string("/proc/asound/cards").ok()?;
    let card_name = cards.lines().find_map(|l| {
        let (id, tail) = l.split_once('[')?.1.split_once(']')?;
        if id.trim() != card {
            return None;
        }
        Some(tail.split_once(" - ")?.1.trim().to_string())
    })?;
    // /proc/asound/<ID> és un enllaç a cardN; pcm<dev>p/info porta "name: …".
    let pcm_name = std::fs::read_to_string(format!("/proc/asound/{}/pcm{}p/info", card, dev))
        .ok()
        .and_then(|info| {
            info.lines()
                .find_map(|l| l.strip_prefix("name: ").map(|n| n.trim().to_string()))
        });
    Some(match pcm_name {
        Some(p) if !p.is_empty() && p != card_name => format!("{} · {}", card_name, p),
        _ => card_name,
    })
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
            #[cfg(target_os = "linux")]
            collect_alsa_outputs(&mut out);
            #[cfg(not(target_os = "linux"))]
            {
                let default = cpal::default_host();
                collect_outputs(&default, default.id().name(), &mut out);
            }
            // Marca els dispositius que el motor natiu té oberts i, si el sondeig no
            // n'ha pogut llegir la freqüència (exclusiu i ocupat per nosaltres, p. ex.
            // RAVENNA), fes servir la del stream obert.
            #[cfg(feature = "native")]
            for (name, rate) in native_output::open_devices() {
                for o in out.iter_mut() {
                    let same = o.name == name
                        || (name.is_empty() && o.is_default)
                        || (cfg!(target_os = "linux") && name == "default" && o.is_default);
                    if same {
                        o.open = true;
                        if o.default_sample_rate == 0 {
                            o.default_sample_rate = rate;
                        }
                    }
                }
            }
            out
        }))
        .map_err(|_| "Pànic enumerant els dispositius d'àudio.".to_string());
        let _ = tx.send(res);
    });
    rx.recv_timeout(std::time::Duration::from_secs(5))
        .map_err(|_| "Temps esgotat enumerant els dispositius d'àudio.".to_string())?
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
                    label: name.clone(),
                    name,
                    max_channels: 0, // desconegut fins a carregar el driver
                    default_channels: 0,
                    default_sample_rate: 0,
                    is_default: false,
                    open: false,
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
            Err(e) => return log::warn!("To de prova: {}", e),
        };
        let device = match host.output_devices().map(|mut devs| {
            devs.find(|d| d.name().map(|n| n == device_name).unwrap_or(false))
        }) {
            Ok(Some(d)) => d,
            Ok(None) => return log::warn!("To de prova: dispositiu no trobat: {}", device_name),
            Err(e) => return log::warn!("To de prova: {}", e),
        };
        let supported = match device.default_output_config() {
            Ok(c) => c,
            Err(e) => return log::warn!("To de prova: {}", e),
        };
        let sample_format = supported.sample_format();
        let config: cpal::StreamConfig = supported.into();
        let channels = config.channels as usize;
        let target = channel as usize;
        if target >= channels {
            return log::warn!(
                "To de prova: el canal {} no existeix (el dispositiu en té {})",
                channel + 1,
                channels
            );
        }
        let sample_rate = config.sample_rate.0 as f32;
        let dur = seconds.max(0.1);

        let mut phase: f32 = 0.0;
        let step = 2.0 * std::f32::consts::PI * 440.0 / sample_rate;

        let err_fn = |e| log::warn!("Error stream de prova: {}", e);

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
                log::warn!("Format de mostra no suportat: {:?}", other);
                return;
            }
        };

        match stream {
            Ok(s) => {
                if let Err(e) = s.play() {
                    log::warn!("No s'ha pogut iniciar el to: {}", e);
                    return;
                }
                std::thread::sleep(std::time::Duration::from_secs_f32(dur));
                // en sortir d'aquí, `s` es destrueix i atura el so
            }
            Err(e) => log::warn!("No s'ha pogut crear l'stream: {}", e),
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
// Declick global del motor natiu (P3): fins i tot un stop "sec" (fade_out=0)
// aplica una rampa de release d'aquesta durada mínima per evitar un tall a mitja
// mostra (clic) — igual que el declick per defecte de QLab. ~5 ms és inaudible en
// timing però suficient per eliminar la discontinuïtat. El comparteixen el camí
// ASIO (lib.rs) i el backend cpal (native_output.rs) via `crate::DECLICK_MS`.
pub(crate) const DECLICK_MS: f32 = 5.0;

// Declick de la VOLTA del loop: a cada volta, la mostra final del segment i la
// inicial gairebé mai coincideixen → salt = clic audible a cada volta. Hi apliquem
// una micro-osca (fade-out els últims N frames + fade-in els primers N) al voltant
// de la costura. En FRAMES fixos (no ms) perquè el nucli de mescla no ha de conèixer
// la freqüència; ~192 frames són ~4 ms a 44,1/48 kHz: inaudible però suficient per
// eliminar la discontinuïtat. El comparteixen el camí en memòria (`asio_mix_voice`)
// i el descodificador en streaming (`asio_stream`, costura gapless).
pub(crate) const LOOP_DECLICK_FRAMES: usize = 192;

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
    // Frames TOTALS reproduïts des de l'inici de la veu; NO es reinicia mai en
    // loop (a diferència de `seg_pos`, que es plega cada volta). S'usa per al
    // fade-in "només a l'inici" (estàndard QLab): un cop passats `fade_in_len`
    // frames, el fade no es torna a aplicar encara que el loop reiniciï `pos`.
    played_total: usize,
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
//
// NUCLI reutilitzable (feature `native`): tant el callback ASIO com el backend
// cpal mesclen aquestes veus amb `asio_mix_stream_voice`. Independent d'ASIO.
#[cfg(feature = "native")]
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

#[cfg(feature = "native")]
impl StreamVoice {
    // Posició del playhead (segons dins el fitxer) per a la telemetria. Es deriva
    // dels frames de FONT consumits. En loop amb out-point el descodificador empeny
    // un flux continu i `src_consumed` creix sense parar: el pleguem al tram perquè
    // el playhead torni a l'inici visualment. Compartit pels dos backends (cpal i
    // ASIO) per no duplicar el càlcul.
    fn telemetry_pos(&self) -> f32 {
        if self.file_rate == 0 {
            return 0.0;
        }
        let mut consumed = self.src_consumed;
        if self.loop_on && self.stop_secs > 0.0 {
            let seg = (((self.stop_secs - self.start_secs).max(0.0)) * self.file_rate as f64) as usize;
            if seg > 0 {
                consumed %= seg;
            }
        }
        // Posició DINS el tram (igual que les veus en memòria reporten seg_pos);
        // la UI hi suma l'start_point si li cal la posició absoluta.
        consumed as f32 / self.file_rate as f32
    }
}

// Mescla una veu de streaming als acumuladors de sortida. Llegeix del ring amb
// interpolació lineal (resample file_rate → driver_rate). Marca `finished` en
// arribar al final (eof i buit) o en acabar el release; aleshores atura el fil
// descodificador. Underrun (buffer buit sense eof) → silenci sense avançar.
#[cfg(feature = "native")]
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
// Clau de la cau de PCM. Inclou la IDENTITAT DEL CONTINGUT del fitxer (mtime en
// segons + mida en bytes) a més de la ruta i el rate del dispositiu. Motiu: si
// l'usuari reemplaça el fitxer a disc (versió nova del tema, mateix nom/ruta), la
// clau canvia i el GO descodifica la versió nova en lloc de servir el PCM VELL de
// la cau fins que surti per LRU o es reiniciï l'app. Si el `stat` falla (fitxer
// mogut, permisos), s'usa (0, 0) perquè segueixi funcionant (com abans, per ruta+rate).
#[cfg(feature = "native")]
type PcmKey = (String, u32, u64, u64);

// Construeix la clau de la cau fent `stat` del fitxer per capturar-ne mtime i mida.
// S'ha d'usar EL MATEIX helper tant per inserir com per consultar, o mai hi hauria
// HIT. Si el stat falla, (mtime, mida) = (0, 0): la cau segueix indexant per ruta+rate.
#[cfg(feature = "native")]
fn pcm_key(path: &str, rate: u32) -> PcmKey {
    let (mtime, size) = match std::fs::metadata(path) {
        Ok(m) => {
            let mtime = m
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0);
            (mtime, m.len())
        }
        Err(_) => (0, 0),
    };
    (path.to_string(), rate, mtime, size)
}

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
//
// `voice_id`: Some(id) al camí de PLAY (una veu concreta espera aquest PCM), None
// al camí de PRELOAD. Si el decode falla i era una veu de play, s'emet
// `asio-voice-failed` perquè el frontend no deixi el tile blau ni la playlist
// duckejada per sempre. Simètric a `native_spawn_decode`.
#[cfg(feature = "asio")]
fn asio_spawn_decode<F>(file_path: String, rate: u32, voice_id: Option<u64>, make_cmd: F)
where
    F: FnOnce(std::sync::Arc<Vec<Vec<f32>>>) -> AsioCmd + Send + 'static,
{
    let tx = match asio_tx_clone() {
        Some(t) => t,
        None => {
            // El motor no està disponible: si algú esperava la veu, avisa'l.
            if let Some(vid) = voice_id {
                asio_notify_failed(vid, "El motor ASIO no està disponible.".into());
            }
            return;
        }
    };
    std::thread::Builder::new()
        .name("asio-decode".into())
        .spawn(move || match asio_decode::decode_file(&file_path, rate) {
            Ok(d) => {
                let _ = tx.send(make_cmd(std::sync::Arc::new(d.data)));
            }
            Err(e) => {
                log::warn!("[asio-decode] '{}': {}", file_path, e);
                // Descart silenciós si no avisem: notifica la fallada al frontend.
                if let Some(vid) = voice_id {
                    asio_notify_failed(vid, format!("No s'ha pogut descodificar: {}", e));
                }
            }
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
            log::warn!("[asio-voice] voice={} SENSE MIX → descartada", spec.voice_id);
            // El mix s'ha desmuntat entre la petició i ara: avisa el frontend perquè
            // no deixi el tile blau ni la playlist duckejada.
            asio_notify_failed(spec.voice_id, "El motor ASIO no té cap mix actiu.".into());
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
        played_total: 0, // fade-in "només a l'inici" (no es reinicia en loop)
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

// ── Notificació de FALLADA de veu (motor → fil notificador → event Tauri) ─────
//
// Simètric al camí natiu: quan una veu ASIO NO arriba a materialitzar-se (error de
// decode, sense mix, etc.), el frontend ja ha marcat el tile "reproduint" i ha fet
// duck. Sense aquest avís quedaria blau per sempre i la playlist duckejada (mai
// arriba `asio-voice-ended` perquè la veu no ha existit). Canal paral·lel al
// d'`ended` que porta l'id + un missatge en català; un fil notificador emet
// `asio-voice-failed` a la UI.
#[cfg(feature = "asio")]
static ASIO_FAILED_TX: std::sync::OnceLock<std::sync::mpsc::Sender<(u64, String)>> =
    std::sync::OnceLock::new();

// Payload serialitzable de l'event `asio-voice-failed` (id de la veu + missatge).
#[cfg(feature = "asio")]
#[derive(Serialize, Clone)]
struct AsioVoiceFailed {
    #[serde(rename = "voiceId")]
    voice_id: u64,
    message: String,
}

// Notifica (sense bloquejar) que una veu ASIO ha FALLAT en materialitzar-se. Si
// encara no hi ha fil notificador, l'avís es descarta. NO es crida des del callback
// RT, sinó des dels camins de construcció/decode on el `voice_id` és conegut.
#[cfg(feature = "asio")]
fn asio_notify_failed(voice_id: u64, msg: String) {
    if let Some(tx) = ASIO_FAILED_TX.get() {
        let _ = tx.send((voice_id, msg));
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

// Heartbeat del callback ASIO (C2, resiliència). El callback `buffer_switch` corre
// en CONTINU mentre el driver està arrencat (és el rellotge d'àudio), tant si sonen
// veus com si no. Aquest comptador s'incrementa a cada crida; el fil de telemetria
// detecta si es CONGELA (no avança) mentre el mix és actiu → el dispositiu s'ha perdut
// (interfície USB desendollada). Increment atòmic barat, apte per al fil RT del driver.
#[cfg(feature = "asio")]
static ASIO_CB_HEARTBEAT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

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

    // Fil notificador de FALLADES de veu (event `asio-voice-failed`). Simètric al
    // camí natiu: payload { voiceId, message }. Així el tile no queda blau ni la
    // playlist duckejada si la veu no arriba a existir.
    let (failed_tx, failed_rx) = std::sync::mpsc::channel::<(u64, String)>();
    let _ = ASIO_FAILED_TX.set(failed_tx);
    let app_failed = app.clone();
    std::thread::Builder::new()
        .name("asio-notifier-failed".into())
        .spawn(move || {
            while let Ok((voice_id, message)) = failed_rx.recv() {
                let _ = app_failed.emit(
                    "asio-voice-failed",
                    AsioVoiceFailed { voice_id, message },
                );
            }
        })
        .ok();

    // Fil de telemetria (playhead + VU) a ~30 Hz + watchdog de pèrdua de dispositiu.
    std::thread::Builder::new()
        .name("asio-telemetry".into())
        .spawn(move || {
          // Estat del watchdog (C2): últim heartbeat vist, ticks consecutius sense
          // avançar i si ja s'ha avisat (debounce, un sol avís per congelació).
          let mut last_hb: u64 = 0;
          let mut stall_ticks: u32 = 0;
          let mut lost_reported = false;
          loop {
            std::thread::sleep(std::time::Duration::from_millis(33));

            // Watchdog de pèrdua de dispositiu ASIO: el callback buffer_switch corre en
            // continu mentre el driver està arrencat. Si el mix és ACTIU però el heartbeat
            // no avança durant ~500 ms (15 ticks), el callback s'ha congelat → el dispositiu
            // s'ha perdut (USB desendollada). Avisa la UI un sol cop; es rearma quan el
            // heartbeat torna a avançar o el mix es desmunta (stop normal, sense fals avís).
            {
                let mix_active = asio_meter_slot().lock().map(|g| g.is_some()).unwrap_or(false);
                let hb = ASIO_CB_HEARTBEAT.load(std::sync::atomic::Ordering::Relaxed);
                if mix_active && hb == last_hb {
                    stall_ticks += 1;
                    if stall_ticks >= 15 && !lost_reported {
                        lost_reported = true;
                        log::error!("[asio] callback congelat ~500ms → dispositiu perdut (device-lost)");
                        let _ = app.emit("asio-device-lost", "");
                    }
                } else {
                    // El heartbeat avança (o el mix està inactiu). Si veníem d'una pèrdua
                    // AVISADA i el mix segueix actiu (→ el callback ha REPRÈS), el dispositiu
                    // ha tornat: avisa la UI de la recuperació (neteja errors + toast). Si el
                    // mix és inactiu (stop/teardown normal) no és cap recuperació.
                    if lost_reported && mix_active {
                        log::info!("[asio] callback reprèn → dispositiu recuperat (device-recovered)");
                        let _ = app.emit("asio-device-recovered", "");
                    }
                    stall_ticks = 0;
                    lost_reported = false;
                }
                last_hb = hb;
            }

            // Snapshot curt sota lock: id, posició (s) i nivell de cada veu real.
            let items: Vec<TelemetryItem> = {
                // Recuperació de poisoning: si el callback RT enverinés algun d'aquests
                // locks amb un panic, rendir-se aquí deixaria la telemetria (playhead +
                // picòmetre) morta per sempre. Recuperem el guard amb `into_inner()`.
                let guard = asio_meter_slot().lock().unwrap_or_else(|e| e.into_inner());
                match guard.as_ref() {
                    Some(sh) => {
                        let rate = sh.sample_rate.max(1) as f32;
                        let mut v: Vec<TelemetryItem> = {
                            let vs = sh.voices.lock().unwrap_or_else(|e| e.into_inner());
                            vs.iter()
                                .filter(|v| v.voice_id != u64::MAX && !v.finished)
                                .map(|v| TelemetryItem {
                                    id: v.voice_id,
                                    pos: v.seg_pos() as f32 / rate,
                                    level: v.meter,
                                })
                                .collect()
                        };
                        {
                            // Recuperació de poisoning (vegeu el lock de veus a dalt).
                            let svs = sh.stream_voices.lock().unwrap_or_else(|e| e.into_inner());
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
          } // fi del loop
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
        // Heartbeat (C2): senyala que el callback segueix viu. Si es congela (dispositiu
        // desconnectat), el fil de telemetria ho detecta. Atòmic barat, sense lock.
        ASIO_CB_HEARTBEAT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let bi = info.buffer_index as usize;
        // Recuperació de poisoning: si un buffer anterior hagués fet panic amb algun
        // d'aquests locks agafat, `lock()` retornaria Err per sempre i el callback RT
        // quedaria MUT permanentment (silenci fins a reiniciar l'app). Recuperem el
        // guard amb `into_inner()` perquè un panic aïllat no mati el motor.
        let mut lock = cb_streams.lock().unwrap_or_else(|e| e.into_inner());
        let stream = match lock.output { Some(ref mut s) => s, None => return };

        // Acumuladors pre-allocats: zera cada canal (sense reassignar memòria).
        let mut acc_guard = cb_acc.lock().unwrap_or_else(|e| e.into_inner());
        let acc = &mut *acc_guard;
        for ch in acc.iter_mut() {
            ch.fill(0.0);
        }

        // Recuperació de poisoning (vegeu a dalt): no rendir-se davant un lock
        // enverinat, o el callback deixaria de mesclar veus per sempre.
        {
            let mut voices = cb_voices.lock().unwrap_or_else(|e| e.into_inner());
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

        // Veus en STREAMING (pistes llargues). Recuperació de poisoning (vegeu a dalt).
        {
            let mut svs = cb_stream_voices.lock().unwrap_or_else(|e| e.into_inner());
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
        // El multiplicador demo (1.0 amb llicència vàlida) aplica el silenci
        // intermitent del mode demo aquí, al motor, no al JS (difícil de parxejar).
        let master = asio_master_gain() * license::demo_master_multiplier();
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
        // Fade-in NOMÉS a l'inici de la veu: es compta sobre `played_total`
        // (frames totals reproduïts, que NO es reinicien en loop), no sobre
        // `seg_pos` (que es plega cada volta). Així el cue no "respira" cada
        // volta; el fade-in queda alineat amb els camins streaming i Web Audio.
        if voice.fade_in_len > 0 && voice.played_total < voice.fade_in_len {
            env *= voice.played_total as f32 / voice.fade_in_len as f32;
        }
        if !voice.loop_on && voice.fade_out_len > 0 {
            let from = seg_len.saturating_sub(voice.fade_out_len);
            if seg_pos >= from {
                let into = seg_pos - from;
                env *= 1.0 - (into as f32 / voice.fade_out_len as f32).min(1.0);
            }
        }
        // Declick de la volta del loop: micro fade-out als últims frames del segment i
        // fade-in als primers de cada nova volta, per no sentir el salt a la costura.
        // El fade-in NO s'aplica al primer arranc (played_total == seg_pos): allà la
        // veu ja surt de silenci (o del fade-in del cue). Vegeu `LOOP_DECLICK_FRAMES`.
        if voice.loop_on {
            let d = crate::LOOP_DECLICK_FRAMES.min(seg_len / 2);
            if d > 0 {
                if seg_pos >= seg_len - d {
                    env *= (seg_len - seg_pos) as f32 / d as f32;
                } else if seg_pos < d && voice.played_total != seg_pos {
                    env *= seg_pos as f32 / d as f32;
                }
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
        // Comptador de frames totals (per al fade-in "només a l'inici"): no es
        // reinicia mai en loop, a diferència de `pos`/`seg_pos`.
        voice.played_total += 1;
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
        } else {
            // El mix ha desaparegut entre la petició i ara: atura el fil que acabem
            // d'arrencar i avisa el frontend perquè no deixi el tile blau ni la
            // playlist duckejada (simètric al camí natiu de streaming).
            sv.ctrl.stop.store(true, std::sync::atomic::Ordering::Relaxed);
            log::warn!("[asio-voice] stream voice={} SENSE MIX → descartada", voice_id);
            asio_notify_failed(voice_id, "El motor ASIO no té cap mix actiu.".into());
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
    // La clau inclou mtime+mida (via `pcm_key`), així un fitxer reemplaçat a disc
    // no serveix el PCM vell (fa MISS i re-descodifica la versió nova).
    let key: PcmKey = pcm_key(file_path, sample_rate);
    if let Some(data) = cache.get(&key) {
        asio_build_and_push_voice(loaded, data, sample_rate, spec);
        return Ok(());
    }

    // Si no, descodifica en un FIL a part i registra la veu quan arribi el PCM
    // (RegisterDecoded). El fil del motor no es bloqueja descodificant: un fitxer
    // llarg o problemàtic no penja la reproducció ni els cues.
    let path = file_path.to_string();
    // Camí de PLAY: passem el voice_id perquè un decode fallit avisi el frontend.
    asio_spawn_decode(path.clone(), sample_rate, Some(voice_id), move |data| AsioCmd::RegisterDecoded {
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
    let key: PcmKey = pcm_key(file_path, rate);
    if cache.get(&key).is_some() {
        return Ok(()); // ja a la cau
    }
    let path = file_path.to_string();
    // Camí de PRELOAD: cap tile espera aquest PCM, per tant None (sense avís).
    asio_spawn_decode(path.clone(), rate, None, move |data| AsioCmd::CacheStore {
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
    // Declick: fins i tot un stop "sec" (fade_out=0) aplica una rampa de release
    // mínima (DECLICK_MS) en lloc de treure la veu a mitja mostra (clic). El nucli
    // del mix marca `finished` i atura el fil de decode en completar la rampa.
    let declick = (crate::DECLICK_MS / 1000.0 * sr) as usize;
    let rel = ((fade_out.max(0.0) * sr) as usize).max(declick).max(1);
    if let Ok(mut voices) = mix.voices.lock() {
        for v in voices.iter_mut() {
            if v.voice_id == voice_id && v.release_from.is_none() && !v.paused {
                v.release_from = Some(v.seg_pos());
                v.release_len = rel;
                v.loop_on = false; // un release acaba la veu encara que fes loop
            }
        }
        // Una veu PAUSADA no avança al mix: no se li pot aplicar la rampa (quedaria
        // encallada). Treu-la de cop, com abans (el frontend ja l'ha marcada aturada).
        voices.retain(|v| !(v.voice_id == voice_id && v.paused));
    }
    // Veus en streaming: release amb fade (o rampa mínima de declick si stop sec).
    // No aturem el fil aquí: el mix ho farà en completar la rampa (té prou mostres
    // al ring per als ~5 ms de release).
    if let Ok(mut svs) = mix.stream_voices.lock() {
        for sv in svs.iter_mut() {
            if sv.voice_id == voice_id && sv.release_from.is_none() && !sv.paused {
                sv.release_from = Some(sv.played_out);
                sv.release_len = rel;
            }
        }
        // Pausada: atura el fil descodificador i treu-la de cop (no pot fer rampa).
        for sv in svs.iter().filter(|x| x.voice_id == voice_id && x.paused) {
            sv.ctrl.stop.store(true, std::sync::atomic::Ordering::Relaxed);
        }
        svs.retain(|sv| !(sv.voice_id == voice_id && sv.paused));
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
        played_total: 0, // fade-in "només a l'inici" (irrellevant aquí: fade_in_len=0)
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
                // Un fil de decode ha acabat: desa a la cau i registra la veu. La
                // clau es construeix amb `pcm_key` (mateix helper que la consulta) per
                // capturar mtime+mida i que un HIT posterior sigui coherent.
                let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    cache.insert(pcm_key(&file_path, rate), data.clone());
                    asio_build_and_push_voice(&mut loaded, data, rate, spec);
                }));
            }
            AsioCmd::CacheStore { file_path, rate, data } => {
                // Pre-càrrega acabada en un fil: només desa el PCM a la cau (clau amb
                // mtime+mida via `pcm_key`, coherent amb la consulta del GO posterior).
                let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    cache.insert(pcm_key(&file_path, rate), data);
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
        if !preload_allowed(&file_path) {
            return Ok(()); // massa llarg per a la cau (vegeu preload_allowed)
        }
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
        // Clamp a [0, 1.5]: harmonitza amb el límit de la UI (setAsioMasterGain).
        // Sense el màxim, una crida directa o un valor corrupte rebentaria el bus.
        ASIO_MASTER_GAIN.store(gain.max(0.0).min(1.5).to_bits(), std::sync::atomic::Ordering::Relaxed);
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

// Alliberament d'ASIO en TANCAR l'app: envia `AsioCmd::Release` (que fa ASIOExit
// via `asio_release_loaded`) al fil `asio-engine` amb una espera ACOTADA i CURTA
// (2 s, com el shutdown natiu). NO usa la comanda pública `asio_release()`, que
// espera 10 s (massa per a un tancament). Amb drivers USB ASIO delicats (MixPre),
// sortir sense ASIOExit pot deixar el dispositiu segrestat o penjar el teardown.
// Si el fil ASIO no s'ha arrencat mai (mai carregat cap driver), és un no-op: no
// volem arrencar-lo just per tancar-lo. El timeout garanteix que no bloqueja el
// tancament més enllà de 2 s encara que el driver es pengi.
#[cfg(feature = "asio")]
fn asio_release_on_close() {
    // Només si el motor ASIO ja existeix; si no, res a alliberar.
    let tx = match ASIO_TX.get() {
        Some(t) => t,
        None => return,
    };
    let (reply_tx, reply_rx) = std::sync::mpsc::channel();
    if tx.send(AsioCmd::Release { reply: reply_tx }).is_err() {
        return; // el fil ja no hi és
    }
    // Espera acotada a 2 s: si el driver es pengia alliberant, el procés sortirà
    // igualment (l'exit(0) posterior no depèn d'aquesta resposta).
    let _ = reply_rx.recv_timeout(std::time::Duration::from_secs(2));
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
// Increment 2 del motor unificat: MULTI-VEU pel dispositiu de sortida per defecte
// (WASAPI/CoreAudio). Diverses veus alhora (cada una amb el seu `voice_id`), amb
// control per veu (stop amb fade, gain, seek, pausa) i telemetria + notificació de
// final cap a la UI (events `native-telemetry` i `native-voice-ended`). Disponible
// amb la feature `native` (i, per tant, també amb `asio`). Sense `native` retornen
// un error explicatiu.

// Reprodueix un cue (fitxer en memòria) via cpal pel dispositiu `device_name`
// (buit = per defecte) i els canals destí indicats (buit = els 2 primers), amb
// gain i fades. La veu (identificada per `voice_id`) sona junt amb les altres i
// s'acaba sola; substitueix una veu del mateix id si ja existia (a qualsevol device).
#[tauri::command]
#[allow(clippy::too_many_arguments)]
fn native_play_cue(
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
    #[cfg(not(feature = "native"))]
    {
        let _ = (voice_id, device_name, file_path, gain, fade_in, fade_out, channels, loop_on, start_point, stop_point, streaming);
        Err("Aquesta build no inclou el motor natiu (cal la feature `native`).".into())
    }
    #[cfg(feature = "native")]
    {
        native_output::play_cue(voice_id, device_name, file_path, gain, fade_in, fade_out, channels, loop_on, start_point, stop_point, streaming)
    }
}

// Atura una veu nativa pel seu id, amb fade-out opcional (segons).
#[tauri::command]
fn native_stop_voice(voice_id: u64, fade_out: f32) -> Result<(), String> {
    #[cfg(not(feature = "native"))]
    {
        let _ = (voice_id, fade_out);
        Err("Aquesta build no inclou el motor natiu (cal la feature `native`).".into())
    }
    #[cfg(feature = "native")]
    {
        native_output::stop_voice(voice_id, fade_out)
    }
}

// Estableix el gain mestre del bus natiu (0..1+; aplicat abans del soft clip a
// tots els dispositius oberts). No passa pel fil del motor: només un àtom.
#[tauri::command]
fn native_set_master_gain(gain: f32) -> Result<(), String> {
    #[cfg(not(feature = "native"))]
    {
        let _ = gain;
        Ok(())
    }
    #[cfg(feature = "native")]
    {
        native_output::set_master_gain(gain);
        Ok(())
    }
}

// Fixa la mida de buffer (frames per callback) del motor natiu cpal. 0 = Auto
// (període del driver). Un buffer més gran dona marge davant pics de CPU i sol
// eliminar els clics/microtalls per underrun, a canvi d'una mica més de latència.
// Reobre els dispositius ociosos perquè agafin la mida nova al proper GO.
#[tauri::command]
fn native_set_buffer_size(frames: u32) -> Result<(), String> {
    #[cfg(not(feature = "native"))]
    {
        let _ = frames;
        Ok(())
    }
    #[cfg(feature = "native")]
    {
        native_output::set_buffer_size(frames);
        Ok(())
    }
}

// Allibera els dispositius natius oberts que no estiguin a `keep` i no sonin
// (en canviar de dispositiu de sortida, perquè el vell quedi lliure).
#[tauri::command]
fn native_close_unused(keep: Vec<String>) -> Result<(), String> {
    #[cfg(not(feature = "native"))]
    {
        let _ = keep;
        Ok(())
    }
    #[cfg(feature = "native")]
    {
        native_output::close_unused(keep)
    }
}

// Canvia el volum (gain lineal) d'una veu nativa activa en calent.
#[tauri::command]
fn native_set_gain(voice_id: u64, gain: f32) -> Result<(), String> {
    #[cfg(not(feature = "native"))]
    {
        let _ = (voice_id, gain);
        Err("Aquesta build no inclou el motor natiu (cal la feature `native`).".into())
    }
    #[cfg(feature = "native")]
    {
        native_output::set_gain(voice_id, gain)
    }
}

// Reposiciona el playhead d'una veu nativa activa (segons dins el segment).
#[tauri::command]
fn native_seek(voice_id: u64, position: f32) -> Result<(), String> {
    #[cfg(not(feature = "native"))]
    {
        let _ = (voice_id, position);
        Err("Aquesta build no inclou el motor natiu (cal la feature `native`).".into())
    }
    #[cfg(feature = "native")]
    {
        native_output::seek(voice_id, position)
    }
}

// Pausa o reprèn una veu nativa activa (congela la posició, sense aturar-la).
#[tauri::command]
fn native_set_paused(voice_id: u64, paused: bool) -> Result<(), String> {
    #[cfg(not(feature = "native"))]
    {
        let _ = (voice_id, paused);
        Err("Aquesta build no inclou el motor natiu (cal la feature `native`).".into())
    }
    #[cfg(feature = "native")]
    {
        native_output::set_paused(voice_id, paused)
    }
}

// Pre-descodifica un cue i el deixa a la cau del motor natiu (sense reproduir-lo),
// perquè el seu GO sigui instantani. `device_name` buit = dispositiu per defecte.
#[tauri::command]
fn native_preload(device_name: String, file_path: String) -> Result<(), String> {
    #[cfg(not(feature = "native"))]
    {
        let _ = (device_name, file_path);
        Err("Aquesta build no inclou el motor natiu (cal la feature `native`).".into())
    }
    #[cfg(feature = "native")]
    {
        if !preload_allowed(&file_path) {
            return Ok(()); // massa llarg per a la cau: es reproduirà en streaming
        }
        native_output::preload(device_name, file_path)
    }
}

// Pre-descodificar (preload) posa el fitxer SENCER a la cau de PCM (f32). Per a
// fitxers llargs no té sentit (es reprodueixen en streaming, que no usa la cau) i
// és perillós: 1 h d'estèreo ≈ 1,4 GB; un set de 3 h faria petar la memòria. Es va
// veure a la prova de càrrega: la playlist pre-descodificava la pista següent (un
// drone d'1 h) i el procés pujava a 2,5 GB. Mateix llindar que el frontend usa per
// separar cues en memòria i en streaming (60 s). Si les metadades no donen la
// durada, es decideix per la mida del fitxer (≤ 20 MB).
#[cfg(feature = "native")]
const PRELOAD_MAX_SECS: f64 = 60.0;
#[cfg(feature = "native")]
fn preload_allowed(path: &str) -> bool {
    match waveform::probe_duration(path) {
        Ok(d) => d <= PRELOAD_MAX_SECS,
        Err(_) => std::fs::metadata(path).map(|m| m.len() <= 20_000_000).unwrap_or(false),
    }
}

// Atura la reproducció del motor natiu (totes les veus actives). Parada global.
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

// ── Tancament de l'app ───────────────────────────────────────────────────────

use std::sync::atomic::{AtomicBool, Ordering};

// La UI té canvis sense desar al show: en clicar la X, preguntar abans de sortir.
static CLOSE_GUARD: AtomicBool = AtomicBool::new(false);
// S'ha avisat la UI d'un tancament i encara no ha respost (close_ack).
static CLOSE_PENDING: AtomicBool = AtomicBool::new(false);

#[tauri::command]
fn set_close_guard(on: bool) {
    CLOSE_GUARD.store(on, Ordering::SeqCst);
}

// La UI ha rebut `app-close-requested` i està preguntant a l'usuari.
#[tauri::command]
fn close_ack() {
    CLOSE_PENDING.store(false, Ordering::SeqCst);
}

// Surt de l'app alliberant els motors d'àudio.
fn quit_app(app: &tauri::AppHandle) {
    // Allibera també el driver ASIO (ASIOExit) abans de sortir: amb drivers USB
    // delicats, sortir sense alliberar pot deixar el dispositiu segrestat o penjar
    // el teardown. Espera acotada a 2 s.
    #[cfg(feature = "asio")]
    asio_release_on_close();
    #[cfg(feature = "native")]
    let _ = native_output::shutdown();
    app.exit(0);
}

// La UI confirma el tancament (desat fet o "Don't save").
#[tauri::command]
fn app_quit(app: tauri::AppHandle) {
    quit_app(&app);
}

// ── Fitxers de sessió (.ezyshow / .json) ─────────────────────────────────────
//
// `read_file_bytes` és restringit a extensions de MÈDIA (A3), de manera que no
// es pot usar per a fitxers JSON. Aquestes dues comandes noves cobreixen
// exclusivament les extensions .ezyshow i .json (fitxers de sessió exportats per
// l'app). Qualsevol altra extensió és rebutjada per seguretat.

// Extensions permeses per a fitxers de sessió (text JSON)
const SESSION_EXTENSIONS: &[&str] = &["ezyshow", "json"];

// Escriu un fitxer de text (contingut JSON) a la ruta absoluta indicada.
// Retorna error si l'extensió no és .ezyshow o .json, o si l'escriptura falla.
#[tauri::command]
fn write_text_file(path: String, contents: String) -> Result<(), String> {
    let ext = std::path::Path::new(&path)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_lowercase())
        .unwrap_or_default();

    if !SESSION_EXTENSIONS.contains(&ext.as_str()) {
        return Err(format!(
            "Extensió «{}» no permesa: només s'accepten .ezyshow o .json.",
            ext
        ));
    }

    // Escriptura ATÒMICA: primer a un fitxer temporal al costat i després
    // reanomenat. Si l'app o l'ordinador cauen a mig desar, el show anterior queda
    // intacte (mai un .ezyshow a mitges).
    let tmp = format!("{path}.tmp");
    let write = || -> std::io::Result<()> {
        use std::io::Write;
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(contents.as_bytes())?;
        f.sync_all()?;
        drop(f);
        std::fs::rename(&tmp, &path)
    };
    match write() {
        Ok(()) => {
            log::info!("[show] desat {path}");
            Ok(())
        }
        Err(e) => {
            let _ = std::fs::remove_file(&tmp);
            log::warn!("[show] no s'ha pogut desar {path}: {e}");
            Err(format!("No s'ha pogut escriure {}: {}", path, e))
        }
    }
}

// Llegeix un fitxer de text (contingut JSON) des de la ruta absoluta indicada.
// Retorna error si l'extensió no és .ezyshow o .json, o si la lectura falla.
#[tauri::command]
fn read_text_file(path: String) -> Result<String, String> {
    let ext = std::path::Path::new(&path)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_lowercase())
        .unwrap_or_default();

    if !SESSION_EXTENSIONS.contains(&ext.as_str()) {
        return Err(format!(
            "Extensió «{}» no permesa: només s'accepten .ezyshow o .json.",
            ext
        ));
    }

    std::fs::read_to_string(&path)
        .map_err(|e| format!("No s'ha pogut llegir {}: {}", path, e))
}

// Calcula els pics de la forma d'ona d'un fitxer en STREAMING (symphonia), sense
// carregar tot el PCM a RAM. Retorna parells [min, max] intercalats (buckets*2
// valors, [-1, 1]): mateix format que computePeaks() al frontend. Evita l'OOM de
// descodificar cues llargs al WebView (A5).
#[tauri::command]
fn compute_peaks(path: String, buckets: u32) -> Result<Vec<f32>, String> {
    #[cfg(not(feature = "native"))]
    {
        let _ = (path, buckets);
        Err("Aquesta build no inclou el motor natiu (cal la feature `native`).".into())
    }
    #[cfg(feature = "native")]
    {
        waveform::compute_peaks(&path, buckets)
    }
}

// Llegeix la durada (segons) d'un fitxer d'àudio de les metadades del format amb
// symphonia, SENSE descodificar-lo. Fallback del frontend a <audio> si falla (B5).
#[tauri::command]
fn probe_duration(path: String) -> Result<f64, String> {
    #[cfg(not(feature = "native"))]
    {
        let _ = path;
        Err("Aquesta build no inclou el motor natiu (cal la feature `native`).".into())
    }
    #[cfg(feature = "native")]
    {
        waveform::probe_duration(&path)
    }
}

// Obre la carpeta de logs de l'app a l'explorador (Settings → General). Per a
// suport: l'operador ens pot enviar el fitxer després d'un bolo amb problemes.
#[tauri::command]
fn open_log_dir(app: tauri::AppHandle) -> Result<(), String> {
    use tauri::Manager;
    use tauri_plugin_opener::OpenerExt;
    let dir = app.path().app_log_dir().map_err(|e| e.to_string())?;
    let _ = std::fs::create_dir_all(&dir);
    app.opener()
        .open_path(dir.to_string_lossy().to_string(), None::<&str>)
        .map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
// Noms dels descodificadors VA de GStreamer (plugins `va` i `vaapi`). Rang 0 =
// GStreamer no els tria mai → descodificació per CPU. Els inexistents s'ignoren.
#[cfg(target_os = "linux")]
fn gst_va_disabled_rank() -> String {
    const VA_DECODERS: &[&str] = &[
        "vah264dec", "vah265dec", "vavp8dec", "vavp9dec", "vaav1dec", "vampeg2dec", "vajpegdec", "vavc1dec",
        "vaapih264dec", "vaapih265dec", "vaapivp8dec", "vaapivp9dec", "vaapiav1dec", "vaapimpeg2dec",
        "vaapijpegdec", "vaapivc1dec", "vaapidecodebin",
    ];
    VA_DECODERS.iter().map(|d| format!("{d}:0")).collect::<Vec<_>>().join(",")
}

// Linux: la descodificació de vídeo per MAQUINARI (VA-API) de GStreamer es MANTÉ
// per defecte (reproduir 1080p per CPU en un portàtil antic va a talls i
// l'escalfa). Amb el driver `i965` (Intel antigues) el que falla és només llegir
// fotogrames des del WebView (miniatures amb soroll): per això les miniatures a
// Linux es fan fora del WebView (video_thumbnail, per CPU). Override:
// EZYPLAYER_VIDEO_HWDEC=off → desactiva el VA a tot el WebView (vídeo per CPU).
// S'ha de fer ABANS de crear el WebView (GStreamer llegeix l'entorn en iniciar-se).
#[cfg(target_os = "linux")]
fn linux_configure_video_decoding() {
    if std::env::var_os("GST_PLUGIN_FEATURE_RANK").is_some() {
        return;
    }
    if std::env::var("EZYPLAYER_VIDEO_HWDEC").map(|v| v.eq_ignore_ascii_case("off")).unwrap_or(false) {
        std::env::set_var("GST_PLUGIN_FEATURE_RANK", gst_va_disabled_rank());
        eprintln!("[video] EZYPLAYER_VIDEO_HWDEC=off: descodificació de vídeo per CPU");
    }
}

// Miniatura d'un vídeo (JPEG, 240 px d'ample, primer fotograma) generada FORA del
// WebView amb gst-launch-1.0 i descodificació per CPU. A Linux, llegir fotogrames
// d'un <video> descodificat per VA (driver i965) dona imatges corruptes; així la
// reproducció segueix per maquinari i la miniatura surt bé. Err → el frontend cau
// al mètode del canvas.
#[tauri::command]
async fn video_thumbnail(path: String) -> Result<tauri::ipc::Response, String> {
    // Fora del fil principal: gst-launch pot trigar un parell de segons.
    tauri::async_runtime::spawn_blocking(move || video_thumbnail_blocking(path))
        .await
        .map_err(|e| e.to_string())?
}

fn video_thumbnail_blocking(path: String) -> Result<tauri::ipc::Response, String> {
    #[cfg(not(target_os = "linux"))]
    {
        let _ = path;
        Err("Només a Linux".into())
    }
    #[cfg(target_os = "linux")]
    {
        let p = std::path::Path::new(&path);
        let ext = p.extension().and_then(|e| e.to_str()).map(|e| e.to_lowercase()).unwrap_or_default();
        if !p.is_absolute() || !["mp4", "webm", "m4v", "mov"].contains(&ext.as_str()) {
            return Err("No és un vídeo".into());
        }
        let out = std::env::temp_dir().join(format!("ezyplayer-thumb-{}-{}.jpg", std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0)));
        let mut child = std::process::Command::new("gst-launch-1.0")
            .env("GST_PLUGIN_FEATURE_RANK", gst_va_disabled_rank())
            .args(["-q", "filesrc"])
            .arg(format!("location={}", path))
            .args(["!", "decodebin", "!", "videoconvert", "!", "videoscale", "!",
                   "video/x-raw,width=240,pixel-aspect-ratio=1/1", "!",
                   "jpegenc", "snapshot=true", "quality=75", "!", "filesink"])
            .arg(format!("location={}", out.display()))
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .map_err(|e| format!("gst-launch-1.0: {e}"))?;
        // Límit de temps: un fitxer estrany no pot deixar un procés penjat.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(15);
        loop {
            if let Some(st) = child.try_wait().map_err(|e| e.to_string())? {
                if !st.success() {
                    let _ = std::fs::remove_file(&out);
                    return Err("gst-launch ha fallat".into());
                }
                break;
            }
            if std::time::Instant::now() > deadline {
                let _ = child.kill();
                let _ = std::fs::remove_file(&out);
                return Err("temps esgotat generant la miniatura".into());
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        let bytes = std::fs::read(&out).map_err(|e| e.to_string())?;
        let _ = std::fs::remove_file(&out);
        if bytes.is_empty() {
            return Err("miniatura buida".into());
        }
        Ok(tauri::ipc::Response::new(bytes))
    }
}

pub fn run() {
    // Abans de res (el WebView/GStreamer llegeixen l'entorn en inicialitzar-se).
    #[cfg(target_os = "linux")]
    linux_configure_video_decoding();

    // Panic hook amb log a fitxer. Un panic en un fil de treball (decode, motor,
    // callbacks auxiliars) només sortiria per stderr, invisible en producció (l'app
    // empaquetada no té consola). Encadenem el hook per defecte (manté el
    // comportament habitual) i, a més, escrivim missatge + ubicació a un fitxer al
    // directori temporal del sistema, que és portable Win/Mac i sempre escrivible.
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        // Primer el comportament per defecte (stderr, backtrace si RUST_BACKTRACE).
        default_hook(info);
        // Després, deixa constància en disc. Cap `unwrap`: si el log falla, no
        // volem un segon panic dins el hook.
        use std::io::Write as _;
        let location = info
            .location()
            .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
            .unwrap_or_else(|| "ubicació desconeguda".to_string());
        // El payload sol ser &str o String.
        let msg = if let Some(s) = info.payload().downcast_ref::<&str>() {
            (*s).to_string()
        } else if let Some(s) = info.payload().downcast_ref::<String>() {
            s.clone()
        } else {
            "(payload de pànic no textual)".to_string()
        };
        let thread = std::thread::current();
        let thread_name = thread.name().unwrap_or("<sense nom>");
        // Al fitxer de log de l'app (si el logger ja està actiu)...
        log::error!("[PANIC] fil «{}» a {} → {}", thread_name, location, msg);
        // ...i, per si el logger no hi era, també al fitxer temporal de sempre.
        let path = std::env::temp_dir().join("ezyplayer-panic.log");
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
            let _ = writeln!(
                f,
                "[PANIC] fil «{}» a {} → {}",
                thread_name, location, msg
            );
        }
    }));

    tauri::Builder::default()
        // Instància ÚNICA: ha de ser el PRIMER plugin. Si l'usuari torna a obrir
        // ezyPlayer (doble clic, drecera...), la segona instància NO arrenca cap
        // motor (dos motors es barallarien pel driver ASIO / dispositius exclusius):
        // porta al davant la finestra principal de la que ja corre i surt.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            use tauri::Manager;
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.unminimize();
                let _ = win.show();
                let _ = win.set_focus();
            }
            log::info!("[app] segona instància bloquejada → es porta al davant la finestra");
        }))
        // Logs a FITXER rotatiu (C3): el primer plugin, perquè capturi també el que
        // passa durant el setup. L'app empaquetada no té consola; sense això, els
        // avisos del motor (dispositiu perdut, decode fallit...) es perdien.
        // Directori: Windows %LOCALAPPDATA%pp.ezyrider.ezyplayer\logs, Mac
        // ~/Library/Logs/app.ezyrider.ezyplayer, Linux ~/.local/share/app.ezyrider.ezyplayer/logs.
        .plugin(
            tauri_plugin_log::Builder::new()
                .targets([
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir {
                        file_name: Some("ezyplayer".into()),
                    }),
                ])
                .level(log::LevelFilter::Info)
                // Les biblioteques de descodificació (symphonia) emeten molts avisos
                // interns ("skipping junk", "ignoring stss atom"...) que tapen els
                // útils: d'elles només en volem els errors.
                .filter(|m| !m.target().starts_with("symphonia") || m.level() <= log::Level::Error)
                .timezone_strategy(tauri_plugin_log::TimezoneStrategy::UseLocal)
                .max_file_size(5_000_000)
                .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepSome(5))
                .build(),
        )
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            use tauri::Manager;
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.set_min_size(Some(tauri::LogicalSize::new(1000.0, 640.0)));
                // Arrenca maximitzada (ocupa tota la pantalla, sense retalls)
                let _ = win.maximize();
            }
            // Carrega i verifica la llicència guardada (OFFLINE) a l'arrencada.
            // Fixa l'estat global valid/demo que consulta la degradació demo.
            log::info!(
                "ezyPlayer {} · {} {} · motor: {}",
                app.package_info().version,
                std::env::consts::OS,
                std::env::consts::ARCH,
                if cfg!(feature = "asio") { "asio+native" } else if cfg!(feature = "native") { "native" } else { "web" }
            );
            license::load_on_startup(app.handle());
            // L'equip no s'adorm mentre l'app és oberta (la pantalla, només en LIVE/vídeo).
            power::start();
            #[cfg(target_os = "linux")]
            media_server::start(ALLOWED_EXTENSIONS);
            // Fil notificador de finals de veu ASIO → events Tauri cap a la UI.
            #[cfg(feature = "asio")]
            asio_start_notifier(app.handle().clone());
            // Fils notificador + telemetria del motor natiu cpal → events Tauri
            // (`native-voice-ended` i `native-telemetry`) cap a la UI.
            #[cfg(feature = "native")]
            native_output::start_notifier(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            read_file_bytes,
            list_audio_outputs,
            audio_platform,
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
            native_preload,
            native_stop_voice,
            native_set_gain,
            native_set_master_gain,
            native_set_buffer_size,
            native_close_unused,
            native_seek,
            native_set_paused,
            native_stop,
            compute_peaks,
            probe_duration,
            write_text_file,
            read_text_file,
            show::show_create,
            show::show_import_media,
            show::show_exists,
            set_close_guard,
            close_ack,
            app_quit,
            license::license_status,
            license::license_info,
            license::activate_license,
            license::deactivate_license,
            power::set_keep_display_awake,
            open_log_dir,
            media_server::media_base_url,
            video_thumbnail
        ])
        // Tancament fiable: en tancar la finestra PRINCIPAL, aturem el motor natiu
        // net (drop dels streams cpal al seu fil → WASAPI/CoreAudio no penja) i
        // sortim de TOTA l'app. Sense això, si quedava oberta la finestra de sortida
        // de vídeo o algun stream actiu, el procés no acabava de tancar-se.
        //
        // Si el show té canvis sense desar (la UI activa CLOSE_GUARD), no es tanca:
        // s'avisa la UI (`app-close-requested`), que pregunta i després crida
        // `app_quit`. Si la UI no respon (no fa `close_ack`), una segona X tanca igual.
        .on_window_event(|window, event| {
            use tauri::{Emitter, Manager};
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    let guard = CLOSE_GUARD.load(Ordering::SeqCst);
                    let unanswered = CLOSE_PENDING.swap(true, Ordering::SeqCst);
                    if guard && !unanswered {
                        api.prevent_close();
                        let _ = window.emit("app-close-requested", ());
                        return;
                    }
                    quit_app(window.app_handle());
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
