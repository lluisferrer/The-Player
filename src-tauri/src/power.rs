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
            for on in rx {
                if on && display.is_none() {
                    display = guard(true);
                } else if !on {
                    // Ordre LIFO: el guard de pantalla restaura l'estat del de sistema.
                    release(display.take());
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
