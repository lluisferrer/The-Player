// Canonicalització del payload de llicència (bytes que es signen i es verifiquen).
//
// Fitxer AUTOCONTINGUT (només depèn de serde_json): el compila l'app (mòdul
// `license_canon`) i també l'eina d'autor tools/ezykeygen, que l'inclou amb
// #[path]. Així el generador de claus NO forma part del crate de l'app i el
// bundler de Tauri no el pot empaquetar mai als instal·ladors.

use serde_json::Value;

// ── Canonicalització determinista ────────────────────────────────────────────
// Reconstrueix el JSON amb les claus ORDENADES alfabèticament a tots els nivells.
// Fer-ho explícitament (no confiar en el BTreeMap per defecte de serde_json) ens
// blinda contra la unificació de features de Cargo: si un altre crate activés
// `serde_json/preserve_order`, els objectes preservarien l'ordre d'inserció i la
// signatura deixaria de coincidir. El generador (tools/ezykeygen) inclou aquest
// MATEIX fitxer (#[path]) → bytes idèntics als dos costats.
pub fn canonicalize(v: &Value) -> Value {
    match v {
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            let mut out = serde_json::Map::new();
            for k in keys {
                out.insert(k.clone(), canonicalize(&map[k]));
            }
            Value::Object(out)
        }
        Value::Array(a) => Value::Array(a.iter().map(canonicalize).collect()),
        other => other.clone(),
    }
}

// Bytes canònics d'un payload, els que es signen i es verifiquen.
pub fn canonical_payload_bytes(payload: &Value) -> Vec<u8> {
    serde_json::to_vec(&canonicalize(payload)).unwrap_or_default()
}
