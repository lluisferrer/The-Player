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

// Escriu un sinus al buffer d'un canal ASIO, convertint al tipus de mostra natiu
// (només tipus LSB, que a x86 són little-endian natiu). `base` és la fase inicial.
#[cfg(feature = "asio")]
unsafe fn asio_write_sine(
    ptr: *mut std::ffi::c_void,
    n: usize,
    dt: &asio_sys::AsioSampleType,
    base: f32,
    step: f32,
    amp: f32,
) {
    use asio_sys::AsioSampleType as T;
    match dt {
        T::ASIOSTInt32LSB => {
            let s = std::slice::from_raw_parts_mut(ptr as *mut i32, n);
            for (i, v) in s.iter_mut().enumerate() {
                *v = ((base + step * i as f32).sin() * amp * 2_147_483_647.0) as i32;
            }
        }
        T::ASIOSTInt16LSB => {
            let s = std::slice::from_raw_parts_mut(ptr as *mut i16, n);
            for (i, v) in s.iter_mut().enumerate() {
                *v = ((base + step * i as f32).sin() * amp * 32_767.0) as i16;
            }
        }
        T::ASIOSTFloat32LSB => {
            let s = std::slice::from_raw_parts_mut(ptr as *mut f32, n);
            for (i, v) in s.iter_mut().enumerate() {
                *v = (base + step * i as f32).sin() * amp;
            }
        }
        T::ASIOSTInt24LSB => {
            let b = std::slice::from_raw_parts_mut(ptr as *mut u8, n * 3);
            for i in 0..n {
                let v = ((base + step * i as f32).sin() * amp * 8_388_607.0) as i32;
                b[i * 3] = (v & 0xff) as u8;
                b[i * 3 + 1] = ((v >> 8) & 0xff) as u8;
                b[i * 3 + 2] = ((v >> 16) & 0xff) as u8;
            }
        }
        _ => {}
    }
}

// Omple de silenci (zeros) el buffer d'un canal ASIO.
#[cfg(feature = "asio")]
unsafe fn asio_silence(ptr: *mut std::ffi::c_void, n: usize, dt: &asio_sys::AsioSampleType) {
    use asio_sys::AsioSampleType as T;
    let bytes = match dt {
        T::ASIOSTInt16LSB => n * 2,
        T::ASIOSTInt24LSB => n * 3,
        _ => n * 4,
    };
    std::slice::from_raw_parts_mut(ptr as *mut u8, bytes).fill(0);
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

// Ordres que el fil ASIO dedicat sap atendre. Cada una porta un canal de
// resposta perquè la comanda Tauri pugui esperar el resultat amb timeout.
#[cfg(feature = "asio")]
enum AsioCmd {
    // Treu un to de 440 Hz pel canal indicat durant `seconds`. Carrega el
    // driver si cal (o en canvia), però el manté carregat en acabar.
    Tone {
        driver_name: String,
        channel: u16,
        seconds: f32,
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

// Estat propietari del fil ASIO: el driver carregat (si n'hi ha), amb el seu
// `Asio` i el nom. Mantenir `Asio` viu evita que el seu `Weak<DriverInner>`
// es perdi; mantenir el `Driver` original (sense clonar-lo) garanteix que
// `destroy()` pugui consumir l'únic `Arc` i cridar ASIOExit de debò.
#[cfg(feature = "asio")]
struct AsioLoaded {
    asio: asio_sys::Asio,
    driver: asio_sys::Driver,
    name: String,
}

// Allibera el driver carregat (si n'hi ha) des del fil ASIO. Torna el resultat
// del destroy per informar-ne. És idempotent: si no hi ha res, no fa res.
#[cfg(feature = "asio")]
fn asio_release_loaded(loaded: &mut Option<AsioLoaded>) -> Result<(), String> {
    if let Some(l) = loaded.take() {
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

// Carrega el driver demanat (si encara no ho està) i en treu un to pel canal
// indicat durant `seconds`. Manté el driver carregat en acabar. Tota la feina
// ASIO passa al fil dedicat (és qui crida aquesta funció).
#[cfg(feature = "asio")]
fn asio_do_tone(
    loaded: &mut Option<AsioLoaded>,
    driver_name: &str,
    channel: u16,
    seconds: f32,
) -> Result<(), String> {
    use asio_sys::AsioSampleType as T;
    use std::sync::{Arc, Mutex};

    asio_ensure_loaded(loaded, driver_name)?;
    let driver = &loaded.as_ref().unwrap().driver;

    let outs = driver.channels().map_err(|e| format!("channels(): {:?}", e))?.outs as usize;
    let target = channel as usize;
    if target >= outs {
        return Err(format!("El canal {} no existeix (el driver té {} sortides)", channel + 1, outs));
    }
    let sample_rate = driver.sample_rate().map_err(|e| format!("sample_rate(): {:?}", e))? as f32;
    let data_type = driver.output_data_type().map_err(|e| format!("output_data_type(): {:?}", e))?;
    match data_type {
        T::ASIOSTInt32LSB | T::ASIOSTInt16LSB | T::ASIOSTFloat32LSB | T::ASIOSTInt24LSB => {}
        other => return Err(format!("Tipus de mostra ASIO no suportat (de moment): {:?}", other)),
    }

    // Preparem els canals 0..=target (només els que calen).
    let num = target + 1;
    let streams = driver
        .prepare_output_stream(None, num, None)
        .map_err(|e| format!("prepare_output_stream(): {:?}", e))?;
    let buffer_size = match streams.output.as_ref() {
        Some(o) => o.buffer_size as usize,
        None => return Err("El driver no ha donat stream de sortida.".into()),
    };
    let streams = Arc::new(Mutex::new(streams));

    let step = 2.0 * std::f32::consts::PI * 440.0 / sample_rate;
    let mut phase = 0.0f32;
    let cb_streams = streams.clone();
    let cb_dt = data_type;
    let callback_id = driver.add_callback(move |info: &asio_sys::CallbackInfo| {
        let bi = info.buffer_index as usize;
        let mut lock = match cb_streams.lock() {
            Ok(l) => l,
            Err(_) => return,
        };
        let stream = match lock.output {
            Some(ref mut s) => s,
            None => return,
        };
        let base = phase;
        unsafe {
            for ch in 0..num {
                let ptr = stream.buffer_infos[ch].buffers[bi];
                if ch == target {
                    asio_write_sine(ptr, buffer_size, &cb_dt, base, step, 0.2);
                } else {
                    asio_silence(ptr, buffer_size, &cb_dt);
                }
            }
        }
        phase = (base + step * buffer_size as f32) % std::f32::consts::TAU;
    });

    if let Err(e) = driver.start() {
        driver.remove_callback(callback_id);
        let _ = driver.dispose_buffers();
        // No destruïm el driver: el deixem carregat per al pròxim to.
        return Err(format!("start(): {:?}", e));
    }

    // Reproduïm el to bloquejant aquest fil. Com que el fil ASIO és serial,
    // cap altra ordre no s'atendrà fins que aquest to acabi (comportament
    // volgut: no se solapen tons sobre el mateix driver).
    std::thread::sleep(std::time::Duration::from_secs_f32(seconds.max(0.1)));

    let _ = driver.stop();
    driver.remove_callback(callback_id);
    // dispose_buffers allibera els buffers PERÒ manté el driver inicialitzat
    // (estat Initialized), llest per a un altre prepare/start sense re-load.
    let _ = driver.dispose_buffers();
    Ok(())
}

// Bucle del fil ASIO dedicat: rep ordres pel canal i les atén una a una,
// mantenint el driver carregat entre tons. En sortir el bucle (canal tancat),
// allibera el driver. Aïllem cada ordre amb `catch_unwind` perquè un driver
// dolent no mati el fil i deixi el dispositiu segrestat.
#[cfg(feature = "asio")]
fn asio_thread_main(rx: std::sync::mpsc::Receiver<AsioCmd>) {
    let mut loaded: Option<AsioLoaded> = None;
    while let Ok(cmd) = rx.recv() {
        match cmd {
            AsioCmd::Tone { driver_name, channel, seconds, reply } => {
                let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    asio_do_tone(&mut loaded, &driver_name, channel, seconds)
                }))
                .unwrap_or_else(|_| Err("Pànic processant el to ASIO.".into()));
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
        // Esperem que el to acabi (el fil bloqueja durant `seconds`). Marge ampli.
        match reply_rx.recv_timeout(std::time::Duration::from_secs(10)) {
            Ok(res) => res,
            Err(_) => Err("Temps esgotat o error processant el to ASIO.".into()),
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
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            read_file_bytes,
            list_audio_outputs,
            detect_asio,
            play_test_tone,
            asio_test_tone,
            asio_load,
            asio_release
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
