// ─────────────────────────────────────────────────────────────────────────────
// ezykeygen — generador de claus de llicència offline d'ezyPlayer (eina d'autor).
//
// Comparteix la canonicalització amb l'app (`tauri_app_lib::license`) → els bytes
// signats són EXACTAMENT els que el verificador reconstrueix. Compila SENSE l'SDK
// d'ASIO; executa'l així:
//
//   Generar la parella (un sol cop):
//     cargo run --no-default-features --bin ezykeygen -- genkeys
//       → escriu ./private.key (SECRET, gitignored) i imprimeix la clau PÚBLICA
//         llesta per enganxar a `PUBLIC_KEY` de src/license.rs.
//
//   Emetre una clau per a un client:
//     cargo run --no-default-features --bin ezykeygen -- sign \
//       --name "Nom Client" --email client@correu.cat --tier pro --covers 1.x
//       → imprimeix la clau base64 que l'usuari enganxa a Settings → License.
//
// La privada MAI entra al repo ni al binari de l'app.
// ─────────────────────────────────────────────────────────────────────────────

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use ed25519_dalek::{Signer, SigningKey};
use serde_json::json;
use std::collections::HashMap;

const PRIVATE_FILE: &str = "private.key";

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(|s| s.as_str()) {
        Some("genkeys") => genkeys(),
        Some("sign") => sign(&args[1..]),
        _ => {
            eprintln!("Ús:");
            eprintln!("  ezykeygen genkeys");
            eprintln!("  ezykeygen sign --name <n> --email <e> --tier <t> --covers <c> \\");
            eprintln!("                 [--issued <iso>] [--machine-id <id>]");
            std::process::exit(2);
        }
    }
}

fn genkeys() {
    use rand_core::OsRng;
    let signing_key = SigningKey::generate(&mut OsRng);
    let secret: [u8; 32] = signing_key.to_bytes();
    let public: [u8; 32] = signing_key.verifying_key().to_bytes();

    if std::path::Path::new(PRIVATE_FILE).exists() {
        eprintln!("⚠  {PRIVATE_FILE} ja existeix — no el sobreescric. Esborra'l a mà si vols regenerar.");
        std::process::exit(1);
    }
    std::fs::write(PRIVATE_FILE, B64.encode(secret).as_bytes())
        .expect("no s'ha pogut escriure private.key");

    println!("Parella generada. private.key escrit (NO el pugis al repo).\n");
    println!("Enganxa aquesta clau pública a src/license.rs (PUBLIC_KEY):\n");
    print!("pub const PUBLIC_KEY: [u8; 32] = [");
    for (i, b) in public.iter().enumerate() {
        if i % 12 == 0 {
            print!("\n    ");
        }
        print!("{b}, ");
    }
    println!("\n];");
}

fn sign(args: &[String]) {
    let opts = parse_opts(args);
    let require = |k: &str| -> String {
        opts.get(k).cloned().unwrap_or_else(|| {
            eprintln!("Falta --{k}");
            std::process::exit(2);
        })
    };

    // Carrega la clau privada
    let secret_b64 = std::fs::read_to_string(PRIVATE_FILE)
        .unwrap_or_else(|_| {
            eprintln!("No trobo {PRIVATE_FILE}. Executa primer `ezykeygen genkeys`.");
            std::process::exit(1);
        });
    let secret_bytes = B64
        .decode(secret_b64.trim().as_bytes())
        .expect("private.key corrupte (base64)");
    let secret_arr: [u8; 32] = secret_bytes.as_slice().try_into().expect("private.key mida incorrecta");
    let signing_key = SigningKey::from_bytes(&secret_arr);

    // issued per defecte = timestamp unix (l'autor pot passar --issued per una data ISO)
    let issued = opts.get("issued").cloned().unwrap_or_else(|| {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs().to_string())
            .unwrap_or_default()
    });

    // Construeix el payload. Camps reservats L3 (machine_id) només si es passen.
    let mut payload = json!({
        "name": require("name"),
        "email": require("email"),
        "tier": require("tier"),
        "covers": require("covers"),
        "issued": issued,
    });
    if let Some(mid) = opts.get("machine-id") {
        payload["machine_id"] = json!(mid);
    }

    // Signa els bytes CANÒNICS (mateixa funció que el verificador).
    let msg = tauri_app_lib::license::canonical_payload_bytes(&payload);
    let signature = signing_key.sign(&msg);

    let envelope = json!({
        "payload": payload,
        "sig": B64.encode(signature.to_bytes()),
    });
    let key = B64.encode(serde_json::to_vec(&envelope).unwrap());
    println!("{key}");
}

// Parseig mínim de --clau valor (sense dependre de clap).
fn parse_opts(args: &[String]) -> HashMap<String, String> {
    let mut map = HashMap::new();
    let mut i = 0;
    while i < args.len() {
        if let Some(key) = args[i].strip_prefix("--") {
            if let Some(val) = args.get(i + 1) {
                map.insert(key.to_string(), val.clone());
                i += 2;
                continue;
            }
        }
        i += 1;
    }
    map
}
