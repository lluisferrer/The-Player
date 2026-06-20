// Telemetria del motor ASIO natiu (Fase C, pas 2).
//
// El backend emet l'event `asio-telemetry` a ~30 Hz amb un array d'ítems
// { id, pos, level } per a cada veu activa:
//   - id:    id del slot (= voiceId)
//   - pos:   posició de reproducció dins el segment, en segons (plega en loop)
//   - level: pic d'amplitud lineal (0..1) de l'últim buffer, per al picòmetre
//
// Guardem l'últim estat per id en un Map a nivell de mòdul (fora de React, com
// fa `cueStreamEngine.csPosition`), perquè el playhead i el VU el consultin cada
// frame amb RAF sense provocar re-renders del store a 30 Hz.
//
// Caducitat: si no arriba telemetria d'un id durant més de STALE_MS, els getters
// el consideren inactiu (posició 0, nivell 0). Així el VU/playhead cau sol quan
// la veu s'atura, encara que el backend deixi d'emetre.

const STALE_MS = 200;

// id -> { pos, level, at }  (at = timestamp performance.now() de l'última dada)
const state = new Map();

// Aplica un lot de telemetria rebut del backend.
export function applyAsioTelemetry(items) {
  if (!Array.isArray(items)) return;
  const now = performance.now();
  for (const it of items) {
    if (it == null || it.id == null) continue;
    state.set(it.id, { pos: it.pos || 0, level: it.level || 0, at: now });
  }
}

// Entrada vigent (no caducada) per a un id, o null.
function fresh(id) {
  const e = state.get(id);
  if (!e) return null;
  if (performance.now() - e.at > STALE_MS) return null;
  return e;
}

// Posició de reproducció (segons) d'un cue ASIO actiu, o null si no n'hi ha.
export function asioPosition(id) {
  const e = fresh(id);
  return e ? e.pos : null;
}

// Nivell (pic lineal 0..1) d'un cue ASIO actiu; 0 si no n'hi ha de vigent.
export function asioLevel(id) {
  const e = fresh(id);
  return e ? e.level : 0;
}

// Neteja l'estat d'un id (p. ex. en aturar el cue manualment).
export function clearAsioTelemetry(id) {
  state.delete(id);
}
