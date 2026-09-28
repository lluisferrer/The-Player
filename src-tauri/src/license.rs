// ─────────────────────────────────────────────────────────────────────────────
// Sistema de llicències — capa L1 (offline, xarxa de seguretat sense Railway).
//
// Principi de duresa: la decisió binària VÀLID/DEMO la dona SEMPRE aquest mòdul
// Rust, mai un `if` al React. La clau pública va incrustada al binari; la privada
// no surt mai del control de l'autor. Model de venda: perpètua + updates anuals
// (el camp `covers` del payload diu quina versió cobreix la clau).
//
// Format de clau (text base64 → JSON envelope):
//   { "payload": { name, email, tier, issued, covers, machine_id?, token_expires? },
//     "sig": "<base64 Ed25519 sobre els bytes CANÒNICS del payload>" }
//
// `machine_id` i `token_expires` són camps RESERVATS per a L2/L3 (activació online,
// token refrescable, vinculació a màquina). A L1 es porten al format però NO es
// validen: una clau és vàlida a qualsevol màquina.
// ─────────────────────────────────────────────────────────────────────────────

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use ed25519_dalek::{Signature, VerifyingKey};
use serde::Serialize;
use serde_json::Value;
use std::sync::atomic::{AtomicBool, Ordering};

// Clau pública Ed25519 (32 bytes) incrustada al binari. Generada amb
// `cargo run --manifest-path ../tools/ezykeygen/Cargo.toml -- genkeys`. La privada
// (private.key) MAI entra al repo ni al binari.
pub const PUBLIC_KEY: [u8; 32] = [
    233, 134, 50, 44, 79, 90, 71, 242, 181, 231, 223, 7,
    184, 225, 47, 139, 229, 143, 104, 153, 132, 211, 13, 246,
    26, 206, 182, 209, 203, 44, 172, 104,
];

// Font de veritat en runtime: true = llicència vàlida carregada. La llegeix la
// degradació demo al callback d'àudio (via `demo_master_multiplier`).
static LICENSED: AtomicBool = AtomicBool::new(false);

// Nom del fitxer de llicència dins app_config_dir.
const LICENSE_FILE: &str = "license.key";

// ── Estat exposat a la UI ────────────────────────────────────────────────────
#[derive(Serialize, Clone, Default)]
pub struct LicenseStatus {
    // "valid" o "demo". Mai el React decideix això; sempre ve d'aquí.
    pub state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tier: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub covers: Option<String>,
    // Motiu quan una activació falla (clau mal formada, signatura invàlida…).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

impl LicenseStatus {
    fn demo() -> Self {
        LicenseStatus { state: "demo".into(), ..Default::default() }
    }
    fn demo_msg(msg: impl Into<String>) -> Self {
        LicenseStatus { state: "demo".into(), message: Some(msg.into()), ..Default::default() }
    }
}

// ── Canonicalització determinista ────────────────────────────────────────────
// Viu a license_canon.rs (JSON pur, sense Tauri) perquè l'eina d'autor
// tools/ezykeygen la inclogui per ruta i signi EXACTAMENT els mateixos bytes.
pub use crate::license_canon::canonical_payload_bytes;

// ── Verificació ──────────────────────────────────────────────────────────────
// Descodifica i verifica una clau. Retorna Valid amb les dades del payload o Demo
// (amb missatge) si qualsevol pas falla. NO té efectes secundaris (no toca fitxers
// ni l'estat global); això ho fan `apply_status` / `activate`.
pub fn verify_key_str(key: &str) -> LicenseStatus {
    let key = key.trim();
    if key.is_empty() {
        return LicenseStatus::demo();
    }
    // base64 → JSON envelope
    let json_bytes = match B64.decode(key.as_bytes()) {
        Ok(b) => b,
        Err(_) => return LicenseStatus::demo_msg("Invalid key format (base64)."),
    };
    let envelope: Value = match serde_json::from_slice(&json_bytes) {
        Ok(v) => v,
        Err(_) => return LicenseStatus::demo_msg("Invalid key format (JSON)."),
    };
    let payload = match envelope.get("payload") {
        Some(p) => p,
        None => return LicenseStatus::demo_msg("Key missing payload."),
    };
    let sig_b64 = match envelope.get("sig").and_then(|s| s.as_str()) {
        Some(s) => s,
        None => return LicenseStatus::demo_msg("Key missing signature."),
    };
    let sig_bytes = match B64.decode(sig_b64.as_bytes()) {
        Ok(b) => b,
        Err(_) => return LicenseStatus::demo_msg("Invalid signature encoding."),
    };
    let sig_arr: [u8; 64] = match sig_bytes.as_slice().try_into() {
        Ok(a) => a,
        Err(_) => return LicenseStatus::demo_msg("Invalid signature length."),
    };
    let signature = Signature::from_bytes(&sig_arr);

    let verifying_key = match VerifyingKey::from_bytes(&PUBLIC_KEY) {
        Ok(k) => k,
        Err(_) => return LicenseStatus::demo_msg("Product misconfigured (public key)."),
    };

    let msg = canonical_payload_bytes(payload);
    if verifying_key.verify_strict(&msg, &signature).is_err() {
        return LicenseStatus::demo_msg("Signature does not match.");
    }

    // Signatura vàlida → extreu les dades per mostrar.
    let get = |k: &str| payload.get(k).and_then(|v| v.as_str()).map(|s| s.to_string());
    LicenseStatus {
        state: "valid".into(),
        name: get("name"),
        email: get("email"),
        tier: get("tier"),
        covers: get("covers"),
        message: None,
    }
}

// Fixa l'estat global a partir d'un LicenseStatus verificat.
fn apply_status(status: &LicenseStatus) {
    LICENSED.store(status.state == "valid", Ordering::Relaxed);
}

// ── Persistència ─────────────────────────────────────────────────────────────
fn license_path<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Result<std::path::PathBuf, String> {
    use tauri::Manager;
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("No config dir: {e}"))?;
    Ok(dir.join(LICENSE_FILE))
}

// Llegeix i aplica la llicència guardada a l'arrencada. Funciona OFFLINE: només
// llegeix el fitxer local i en verifica la signatura amb la clau pública del
// binari. Si no hi ha fitxer o no verifica → queda en demo (per defecte).
pub fn load_on_startup<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    let path = match license_path(app) {
        Ok(p) => p,
        Err(_) => return,
    };
    if let Ok(contents) = std::fs::read_to_string(&path) {
        let status = verify_key_str(&contents);
        apply_status(&status);
    }
}

// ── Degradació demo ──────────────────────────────────────────────────────────
// La criden els callbacks d'àudio (natiu i ASIO) com a MULTIPLICADOR addicional
// del màster. Amb llicència vàlida sempre retorna 1.0 (transparent). En demo,
// aplica un "silenci intermitent": una rampa suau (cosinus elevat) a 0 durant els
// últims DEMO_DIP_SECS de cada cicle DEMO_PERIOD_SECS. Es computa al vol des d'un
// rellotge monotònic → sense estat compartit fràgil ni fils extra.
//
// NOTA de prova: per validar el dip sense esperar 15 min, baixar temporalment
// DEMO_PERIOD_SECS a ~30.0 i recompilar.
const DEMO_PERIOD_SECS: f32 = 900.0; // 15 min entre dips
const DEMO_DIP_SECS: f32 = 2.5; // durada del fade-a-0-i-torna

pub fn demo_master_multiplier() -> f32 {
    if LICENSED.load(Ordering::Relaxed) {
        return 1.0;
    }
    use std::sync::OnceLock;
    use std::time::Instant;
    static START: OnceLock<Instant> = OnceLock::new();
    let start = START.get_or_init(Instant::now);
    let elapsed = start.elapsed().as_secs_f32();
    let t = elapsed % DEMO_PERIOD_SECS;
    // El dip cau als últims DEMO_DIP_SECS del cicle → el primer tram sempre és net
    // (una prova ràpida no s'interromp de seguida).
    let dip_start = DEMO_PERIOD_SECS - DEMO_DIP_SECS;
    if t < dip_start {
        return 1.0;
    }
    let phase = (t - dip_start) / DEMO_DIP_SECS; // 0..1
    // Cosinus elevat: 0 als extrems, 1 al centre → guany 1 → 0 → 1, sense clics.
    let d = 0.5 * (1.0 - (2.0 * std::f32::consts::PI * phase).cos());
    1.0 - d
}

// ── Comandes Tauri ───────────────────────────────────────────────────────────
#[tauri::command]
pub fn license_status() -> LicenseStatus {
    if LICENSED.load(Ordering::Relaxed) {
        // Rellegeix el fitxer per retornar les dades (name/tier/covers) a la UI.
        // La font de veritat de valid/demo segueix sent l'atòmic; això només
        // rehidrata els camps informatius.
        LicenseStatus { state: "valid".into(), ..Default::default() }
    } else {
        LicenseStatus::demo()
    }
}

// Variant que sí que porta les dades: la UI la crida al boot. Necessita AppHandle
// per rellegir el fitxer i mostrar name/email/tier/covers.
#[tauri::command]
pub fn license_info<R: tauri::Runtime>(app: tauri::AppHandle<R>) -> LicenseStatus {
    let path = match license_path(&app) {
        Ok(p) => p,
        Err(_) => return LicenseStatus::demo(),
    };
    match std::fs::read_to_string(&path) {
        Ok(contents) => {
            let status = verify_key_str(&contents);
            apply_status(&status); // manté l'atòmic coherent amb el fitxer
            status
        }
        Err(_) => LicenseStatus::demo(),
    }
}

// Verifica una clau enganxada per l'usuari; si és vàlida la desa a app_config_dir
// i actualitza l'estat global. Si no, NO escriu res i retorna el motiu.
#[tauri::command]
pub fn activate_license<R: tauri::Runtime>(app: tauri::AppHandle<R>, key: String) -> LicenseStatus {
    let status = verify_key_str(&key);
    if status.state == "valid" {
        if let Ok(path) = license_path(&app) {
            if let Some(parent) = path.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            // Desem la clau tal qual l'ha enganxat l'usuari (ja verificada).
            let _ = std::fs::write(&path, key.trim().as_bytes());
        }
    }
    apply_status(&status);
    status
}

// Esborra la llicència guardada i torna a demo (proves / traspàs de màquina).
#[tauri::command]
pub fn deactivate_license<R: tauri::Runtime>(app: tauri::AppHandle<R>) -> LicenseStatus {
    if let Ok(path) = license_path(&app) {
        let _ = std::fs::remove_file(&path);
    }
    LICENSED.store(false, Ordering::Relaxed);
    LicenseStatus::demo()
}

#[cfg(test)]
mod tests {
    use super::*;

    // Clau REAL signada per la private.key que casa amb PUBLIC_KEY (generada amb
    // ezykeygen). Verifica el round-trip complet: base64 → envelope → canonical →
    // verify_strict amb la clau pública incrustada. Si es regenera la parella, cal
    // regenerar aquesta clau.
    const VALID_KEY: &str = "eyJwYXlsb2FkIjp7ImNvdmVycyI6IjEueCIsImVtYWlsIjoicHJvdmFAZXp5cGxheWVyLmNhdCIsImlzc3VlZCI6IjE3ODM1MjM3MTMiLCJuYW1lIjoiQ2xpZW50IFByb3ZhIiwidGllciI6InBybyJ9LCJzaWciOiI5VTQyR3QwL0swWkIyMXkvWG9DazhnNDZBTy91ZFIzdnVCQlRZSGNFM3BBaG1xTjhwZHk5bGdIS2JvNU9lVjV5bVpLUVIzR0IvS3RYb1dJYklITjVDZz09In0=";

    #[test]
    fn valid_key_verifies() {
        let s = verify_key_str(VALID_KEY);
        assert_eq!(s.state, "valid", "msg: {:?}", s.message);
        assert_eq!(s.name.as_deref(), Some("Client Prova"));
        assert_eq!(s.tier.as_deref(), Some("pro"));
        assert_eq!(s.covers.as_deref(), Some("1.x"));
    }

    #[test]
    fn tampered_key_is_demo() {
        // Canvia un caràcter enmig del base64 → signatura no casa → demo.
        let mut bytes = VALID_KEY.as_bytes().to_vec();
        let i = bytes.len() / 2;
        bytes[i] = if bytes[i] == b'A' { b'B' } else { b'A' };
        let tampered = String::from_utf8(bytes).unwrap();
        assert_eq!(verify_key_str(&tampered).state, "demo");
    }

    #[test]
    fn empty_key_is_demo() {
        assert_eq!(verify_key_str("").state, "demo");
        assert_eq!(verify_key_str("   ").state, "demo");
    }
}
