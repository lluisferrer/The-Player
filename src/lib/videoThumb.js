// Memòria cau de miniatures de cues de vídeo per fitxer (com els overviews de
// pics d'àudio a peakCache.js). Genera un fotograma representatiu del vídeo i
// el desa com a JPEG en dataURL a localStorage, indexat per filePath. Evita
// regenerar la miniatura cada cop que es carrega la sessió.
//
// Les miniatures JPEG poden ser grans, així que es limita la quantitat
// d'entrades (FIFO) i, davant de quota plena, es buida la cau i es reintenta.
import { convertFileSrc } from '@tauri-apps/api/core';

const KEY = 'the-player-thumbs';
const MAX_ENTRIES = 32;   // sostre d'entrades a la cau (evita inflar localStorage)
const THUMB_WIDTH = 240;  // amplada de la miniatura (mantenint aspecte)

function readCache() {
  try { return JSON.parse(localStorage.getItem(KEY)) || {}; }
  catch { return {}; }
}
function writeCache(obj) {
  try {
    localStorage.setItem(KEY, JSON.stringify(obj));
  } catch {
    // Quota plena: buida la cau i torna a provar un sol cop amb només l'entrada nova
    try { localStorage.removeItem(KEY); localStorage.setItem(KEY, JSON.stringify(obj)); }
    catch { /* prescindim de la cau */ }
  }
}

// Recupera la miniatura desada d'un fitxer (dataURL) o null
export function getCachedThumb(filePath) {
  if (!filePath) return null;
  const entry = readCache()[filePath];
  return (entry && entry.t) || null;
}

// Desa la miniatura d'un fitxer, mantenint la cau sota MAX_ENTRIES (FIFO)
function putCachedThumb(filePath, dataUrl) {
  if (!filePath || !dataUrl) return;
  const all = readCache();
  all[filePath] = { t: dataUrl, at: Date.now() };
  // Si superem el sostre, elimina les entrades més antigues
  const keys = Object.keys(all);
  if (keys.length > MAX_ENTRIES) {
    keys.sort((a, b) => (all[a].at || 0) - (all[b].at || 0));
    for (let i = 0; i < keys.length - MAX_ENTRIES; i++) delete all[keys[i]];
  }
  writeCache(all);
}

// Genera (o recupera de la cau) la miniatura d'un cue de vídeo.
//   filePath  — ruta del fitxer (clau de cau i font via convertFileSrc)
//   seekTime  — segon a capturar (per defecte un punt inicial representatiu)
// Retorna una promesa amb el dataURL JPEG, o null si no es pot generar.
// No bloqueja la UI: es crida en segon pla des del component.
export async function getVideoThumb(filePath, seekTime = 0.1) {
  if (!filePath) return null;
  const cached = getCachedThumb(filePath);
  if (cached) return cached;

  return new Promise((resolve) => {
    const v = document.createElement('video');
    v.muted = true;
    v.preload = 'auto';
    v.crossOrigin = 'anonymous';
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      try { v.removeAttribute('src'); v.load(); } catch { /* res */ }
      resolve(result);
    };

    // Quan les metadades estan a punt, salta a un temps representatiu (clampat)
    v.addEventListener('loadedmetadata', () => {
      const dur = isFinite(v.duration) ? v.duration : 0;
      const t = Math.min(Math.max(0.1, seekTime), dur > 0 ? Math.max(0.1, dur - 0.1) : 0.1);
      try { v.currentTime = t; } catch { finish(null); }
    }, { once: true });

    // Un cop posicionat al fotograma, dibuixa'l en un canvas i exporta JPEG
    v.addEventListener('seeked', () => {
      try {
        const vw = v.videoWidth || THUMB_WIDTH;
        const vh = v.videoHeight || Math.round(THUMB_WIDTH * 9 / 16);
        const w = THUMB_WIDTH;
        const h = Math.max(1, Math.round((vh / vw) * w));
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(v, 0, 0, w, h);
        const dataUrl = canvas.toDataURL('image/jpeg', 0.7);
        putCachedThumb(filePath, dataUrl);
        finish(dataUrl);
      } catch {
        finish(null); // p. ex. canvas "tainted" o fitxer inaccessible
      }
    }, { once: true });

    v.addEventListener('error', () => finish(null), { once: true });
    // Marge de seguretat: si el vídeo no respon, no deixis la promesa penjada
    setTimeout(() => finish(null), 8000);

    v.src = convertFileSrc(filePath);
  });
}
