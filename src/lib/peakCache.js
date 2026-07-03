// Memòria cau de pics de forma d'ona per fitxer (com els fitxers d'overview
// dels DAWs: Reaper .reapeaks, Pro Tools .pkf…). Evita re-descodificar un cue
// llarg cada cop que es carrega: si el fitxer no ha canviat (mateixa durada),
// es reutilitzen els pics desats.
//
// Es desa a localStorage com un mapa: filePath → { d: durada, b: base64, t: timestamp }.
// Els pics es quantitzen a 8 bits (−1..1 → −127..127): ~8 KB per cue.
// El camp `t` (timestamp d'últim ús) permet desallotjar les entrades menys
// usades recentment (LRU) quan la quota de localStorage s'omple.
const KEY = 'the-player-peaks';

function readCache() {
  try { return JSON.parse(localStorage.getItem(KEY)) || {}; }
  catch { return {}; }
}

// Escriu la cau. Si localStorage llança per quota plena, elimina entrades LRU
// una a una (les menys usades recentment, per camp `t`) i reintenta, fins que
// l'entrada càpiga o s'hagin esgotat totes les entrades anteriors.
// Les entrades sense camp `t` (format antic) es tracten com a les més antigues (t=0).
function writeCache(obj) {
  try {
    localStorage.setItem(KEY, JSON.stringify(obj));
  } catch {
    // Quota plena: desallotgem LRU en lloc de purgar tot
    // Ordenem les claus de menys a més recentment usades
    const keys = Object.keys(obj).sort((a, b) => {
      const ta = obj[a].t || 0;
      const tb = obj[b].t || 0;
      return ta - tb; // ascendent: primer el més antic
    });

    // Eliminem entrades d'una en una fins que càpiga o no en quedi cap
    for (const k of keys) {
      delete obj[k];
      try {
        localStorage.setItem(KEY, JSON.stringify(obj));
        return; // ha caigut, sortim
      } catch {
        // Encara no cap, continuem eliminant
      }
    }
    // Si no ha cabut res, abandonem silenciosament (prescindim de la cau)
  }
}

// Float32Array (parells min/max, −1..1) → base64 de bytes amb signe
function encodePeaks(peaks) {
  const n = peaks.length;
  const bytes = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const v = Math.max(-1, Math.min(1, peaks[i]));
    bytes[i] = Math.round(v * 127) & 0xff; // signe → byte sense signe
  }
  let s = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < n; i += CHUNK) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(s);
}

function decodePeaks(b64) {
  const s = atob(b64);
  const n = s.length;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let b = s.charCodeAt(i);
    if (b > 127) b -= 256; // byte sense signe → signe
    out[i] = b / 127;
  }
  return out;
}

// Durada arrodonida (clau de validació: si canvia, els pics ja no valen)
function durKey(duration) {
  return Math.round((duration || 0) * 10) / 10;
}

// Recupera els pics d'un fitxer si la durada coincideix, o null.
// NO reescrivim la cau en un HIT: fer-ho re-serialitzaria TOTES les entrades
// (cada una ~8 KB) de forma síncrona a cada lectura, i a l'arrencada això és jank
// (molts cues carreguen alhora). El desallotjament LRU s'ordena per `t` d'ESCRIPTURA
// (posat a putCachedPeaks), que per a una cau de formes d'ona és prou bo.
export function getCachedPeaks(filePath, duration) {
  if (!filePath) return null;
  const entry = readCache()[filePath];
  if (!entry || entry.d !== durKey(duration)) return null;
  try { return decodePeaks(entry.b); }
  catch { return null; }
}

// Desa els pics d'un fitxer. Inclou el timestamp d'última escriptura per LRU.
export function putCachedPeaks(filePath, duration, peaks) {
  if (!filePath || !peaks) return;
  const all = readCache();
  all[filePath] = { d: durKey(duration), b: encodePeaks(peaks), t: Date.now() };
  writeCache(all);
}
