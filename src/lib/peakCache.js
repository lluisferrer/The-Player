// Memòria cau de pics de forma d'ona per fitxer (com els fitxers d'overview
// dels DAWs: Reaper .reapeaks, Pro Tools .pkf…). Evita re-descodificar un cue
// llarg cada cop que es carrega: si el fitxer no ha canviat (mateixa durada),
// es reutilitzen els pics desats.
//
// Es desa a localStorage com un mapa: filePath → { d: durada, b: base64 }.
// Els pics es quantitzen a 8 bits (−1..1 → −127..127): ~8 KB per cue.
const KEY = 'the-player-peaks';

function readCache() {
  try { return JSON.parse(localStorage.getItem(KEY)) || {}; }
  catch { return {}; }
}
function writeCache(obj) {
  try {
    localStorage.setItem(KEY, JSON.stringify(obj));
  } catch {
    // Quota plena: buida la cau i torna a provar un sol cop
    try { localStorage.removeItem(KEY); localStorage.setItem(KEY, JSON.stringify(obj)); }
    catch { /* prescindim de la cau */ }
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

// Recupera els pics d'un fitxer si la durada coincideix, o null
export function getCachedPeaks(filePath, duration) {
  if (!filePath) return null;
  const entry = readCache()[filePath];
  if (!entry || entry.d !== durKey(duration)) return null;
  try { return decodePeaks(entry.b); }
  catch { return null; }
}

// Desa els pics d'un fitxer
export function putCachedPeaks(filePath, duration, peaks) {
  if (!filePath || !peaks) return;
  const all = readCache();
  all[filePath] = { d: durKey(duration), b: encodePeaks(peaks) };
  writeCache(all);
}
