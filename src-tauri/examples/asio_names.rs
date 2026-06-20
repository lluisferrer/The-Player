// Prova aïllada del backend d'àudio, sense GUI.
// Executa:  cargo run --example asio_names --features asio
use cpal::traits::{DeviceTrait, HostTrait};

fn main() {
    // --- WASAPI (el que fa list_audio_outputs) ---
    println!("=== WASAPI (host per defecte) ===");
    let host = cpal::default_host();
    match host.output_devices() {
        Ok(devs) => {
            let mut n = 0;
            for d in devs {
                n += 1;
                let name = d.name().unwrap_or_else(|_| "?".into());
                let ch = d
                    .default_output_config()
                    .map(|c| c.channels())
                    .unwrap_or(0);
                println!("  - {} ({} canals)", name, ch);
            }
            println!("Total WASAPI: {}", n);
        }
        Err(e) => println!("ERROR output_devices(): {}", e),
    }

    // --- ASIO (el que fa detect_asio) ---
    #[cfg(feature = "asio")]
    {
        println!("=== ASIO (driver_names) ===");
        let asio = asio_sys::Asio::new();
        let names = asio.driver_names();
        println!("Total ASIO: {}", names.len());
        for (i, n) in names.iter().enumerate() {
            println!("  [{}] {}", i, n);
        }
    }
}
