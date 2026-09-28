// ─────────────────────────────────────────────────────────────────────────────
// Evitar el repòs durant un show (crate `keepawake`: Windows
// SetThreadExecutionState, macOS IOPMAssertion, Linux inhibit per D-Bus).
//
// Dos nivells:
//   · SISTEMA (idle): sempre actiu mentre l'app és oberta → l'equip no s'adorm
//     a mig assaig/bolo encara que ningú toqui el ratolí.
//   · PANTALLA (display): només quan la UI ho demana (mode LIVE o finestra de
//     sortida de vídeo oberta) → ni salvapantalles ni pantalla apagada.
//
// A Windows l'estat d'execució és PER FIL: si el crees en un fil del pool de
// Tauri, es perd quan aquell fil canvia de feina. Per això un fil dedicat és
// l'únic propietari dels guards i rep ordres per canal. Tot envoltat amb
// catch_unwind: el Drop de Linux fa unwrap i un error de D-Bus no pot tombar res.
// ─────────────────────────────────────────────────────────────────────────────

use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Mutex, OnceLock};

static POWER_TX: OnceLock<Mutex<Sender<bool>>> = OnceLock::new();

fn guard(display: bool) -> Option<keepawake::KeepAwake> {
    let res = catch_unwind(AssertUnwindSafe(|| {
        keepawake::Builder::default()
            .display(display)
            .idle(true)
            .reason(if display { "ezyPlayer show en curs" } else { "ezyPlayer obert" })
            .app_name("ezyPlayer")
            .app_reverse_domain("app.ezyrider.ezyplayer")
            .create()
    }));
    match res {
        Ok(Ok(g)) => Some(g),
        Ok(Err(e)) => {
            log::warn!("[power] no s'ha pogut inhibir el repòs (display={display}): {e}");
            None
        }
        Err(_) => {
            log::warn!("[power] pànic creant l'inhibició (display={display})");
            None
        }
    }
}

fn release(g: Option<keepawake::KeepAwake>) {
    if let Some(g) = g {
        let _ = catch_unwind(AssertUnwindSafe(move || drop(g)));
    }
}

/// Pla B de PANTALLA a Linux/X11: si l'escriptori no ofereix el servei D-Bus
/// org.freedesktop.ScreenSaver (p. ex. XFCE sense xfce4-screensaver), reiniciem
/// el comptador d'inactivitat de X cada 30 s amb `xset s reset` (el mateix que
/// fan mpv/VLC amb XResetScreenSaver): ni salvapantalles ni DPMS s'activen.
/// Retorna la bandera que l'atura. A Wayland `xset` no fa res (sense efecte).
#[cfg(target_os = "linux")]
fn linux_x11_heartbeat() -> Option<std::sync::Arc<std::sync::atomic::AtomicBool>> {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    if std::env::var_os("DISPLAY").is_none() {
        return None;
    }
    let stop = Arc::new(AtomicBool::new(false));
    let flag = stop.clone();
    let spawned = std::thread::Builder::new()
        .name("power-x11-heartbeat".into())
        .spawn(move || {
            while !flag.load(Ordering::Relaxed) {
                let _ = std::process::Command::new("xset").args(["s", "reset"]).status();
                // Dorm 30 s en trossos d'1 s perquè l'aturada sigui ràpida.
                for _ in 0..30 {
                    if flag.load(Ordering::Relaxed) {
                        return;
                    }
                    std::thread::sleep(std::time::Duration::from_secs(1));
                }
            }
        });
    match spawned {
        Ok(_) => {
            log::info!("[power] pantalla: pla B X11 (xset s reset cada 30 s)");
            Some(stop)
        }
        Err(_) => None,
    }
}

/// Arrenca el fil propietari de les inhibicions i activa la de SISTEMA.
pub fn start() {
    let (tx, rx) = channel::<bool>();
    if POWER_TX.set(Mutex::new(tx)).is_err() {
        return; // ja arrencat
    }
    let _ = std::thread::Builder::new()
        .name("power-keepawake".into())
        .spawn(move || {
            // Guard de sistema: viu tota la vida del fil (= de l'app).
            let _system = guard(false);
            let mut display: Option<keepawake::KeepAwake> = None;
            // Estat demanat per la UI (independent de si el guard ha reeixit), perquè
            // un guard que falla no es reintenti (ni torni a avisar) a cada missatge.
            let mut display_on = false;
            #[cfg(target_os = "linux")]
            let mut x11_stop: Option<std::sync::Arc<std::sync::atomic::AtomicBool>> = None;
            for on in rx {
                if on == display_on {
                    continue;
                }
                display_on = on;
                if on {
                    display = guard(true);
                    #[cfg(target_os = "linux")]
                    if display.is_none() {
                        x11_stop = linux_x11_heartbeat();
                    }
                } else {
                    // Ordre LIFO: el guard de pantalla restaura l'estat del de sistema.
                    release(display.take());
                    #[cfg(target_os = "linux")]
                    if let Some(stop) = x11_stop.take() {
                        stop.store(true, std::sync::atomic::Ordering::Relaxed);
                    }
                }
            }
            release(display.take());
        });
}

/// La UI demana mantenir la PANTALLA encesa (LIVE o sortida de vídeo oberta).
#[tauri::command]
pub fn set_keep_display_awake(on: bool) {
    if let Some(tx) = POWER_TX.get() {
        if let Ok(tx) = tx.lock() {
            let _ = tx.send(on);
        }
    }
}
