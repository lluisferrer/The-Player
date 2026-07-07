import { invoke, convertFileSrc } from '@tauri-apps/api/core';
import { useSoundStore } from '../store/useSoundStore';
import { computePeaks } from '../lib/waveformPeaks';
import { getCachedPeaks, putCachedPeaks } from '../lib/peakCache';

// Llindar (s) per decidir el mode de càrrega:
//   ≤ 60s → descodifica a AudioBuffer (precís: VU, forma d'ona, fades de mostra)
//   > 60s → STREAMING amb <audio> (càrrega quasi instantània, RAM mínima)
const STREAM_THRESHOLD = 60;

// Extensions de vídeo: aquests cues no es descodifiquen a AudioBuffer; es
// reprodueixen a la finestra de sortida (vegeu videoOutput.js i la Fase 4a).
const VIDEO_EXT = /\.(mp4|webm|m4v|mov)$/i;

// Extensions d'imatge fixa: cue visual que es projecta a la sortida i s'hi manté
// fins que s'atura. Sense àudio ni timeline (durada 0).
const IMAGE_EXT = /\.(jpg|jpeg|png|webp|gif|bmp)$/i;

// Extensions de slides: PDF (cue visual amb pàgina navegable). Es projecta a la
// sortida i s'hi manté; sense àudio ni timeline.
const PDF_EXT = /\.pdf$/i;

// Presentacions: es converteixen a PDF amb LibreOffice (comanda Rust soffice_to_pdf)
// i després es tracten com un cue de slides normal. Cal una ruta de disc (la
// conversió la fa soffice sobre el fitxer), així que només via loadFromPath.
const PPT_EXT = /\.pptx?$/i;

// Nom de fitxer a partir d'una ruta (Windows o Unix)
function basename(path) {
  return path.split(/[\\/]/).pop() || path;
}

// Envolta una promesa amb un temps màxim: si no es resol en `ms`, rebutja. Evita
// que una crida penjada (p. ex. un decode/probe patològic) bloquegi un flux per sempre.
function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`timeout ${ms}ms`)), ms)),
  ]);
}

// Llegeix només les metadades per saber la durada, sense descodificar res.
// Si es coneix la ruta de disc (`path`), prova primer symphonia a Rust
// (probe_duration), que no depèn que el WebView suporti el còdec (B5). Si falla
// o retorna 0, cau al mètode <audio>. Només àudio: el vídeo usa probeVideoDuration.
async function probeDuration(src, path) {
  if (path) {
    try {
      const d = await invoke('probe_duration', { path });
      if (isFinite(d) && d > 0) return d;
    } catch { /* cau al mètode <audio> */ }
  }
  return new Promise((resolve) => {
    const a = new Audio();
    a.preload = 'metadata';
    let settled = false;
    const done = (d) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      a.removeAttribute('src');
      resolve(d);
    };
    // Marge de seguretat: si el fitxer no existeix o l'asset retorna una resposta
    // que no dispara ni `loadedmetadata` ni `error`, sense això el <audio> es penjaria
    // per sempre → el cue quedaria carregant (spinner encallat). Amb el timeout, es
    // resol 0 i el flux continua fins a la fallada real (read_file_bytes) → missing.
    const timer = setTimeout(() => done(0), 8000);
    a.addEventListener('loadedmetadata', () => done(a.duration), { once: true });
    a.addEventListener('error', () => done(0), { once: true });
    a.src = src;
  });
}

// Llegeix la durada d'un vídeo amb un <video> temporal (només metadades).
// Cal perquè slotDuration() retorni durada i l'editor tingui timeline.
function probeVideoDuration(src) {
  return new Promise((resolve) => {
    const v = document.createElement('video');
    v.preload = 'metadata';
    v.muted = true;
    let settled = false;
    const done = (d) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      v.removeAttribute('src'); v.load();
      resolve(Number.isFinite(d) ? d : 0);
    };
    // Marge de seguretat: si no arriben metadades (còdec no suportat, fitxer
    // corrupte), no deixis el slot penjat carregant per sempre.
    const timer = setTimeout(() => done(0), 8000);
    v.addEventListener('loadedmetadata', () => done(v.duration), { once: true });
    v.addEventListener('error', () => done(0), { once: true });
    v.src = src;
  });
}

export function useAudioEngine() {
  const initAudioContext = useSoundStore((s) => s.initAudioContext);
  const loadAudio = useSoundStore((s) => s.loadAudio);
  const setSlotLoading = useSoundStore((s) => s.setSlotLoading);
  const setSlotPeaks = useSoundStore((s) => s.setSlotPeaks);
  const setSlotPeaksDone = useSoundStore((s) => s.setSlotPeaksDone);

  // Genera (o recupera de la cau) els pics de la forma d'ona d'un cue en
  // streaming. Si hi ha pics desats per aquest fitxer i durada, s'estalvia la
  // descodificació sencera; si no, descodifica un sol cop en segon pla, en desa
  // la versió reduïda a la cau i descarta el buffer (RAM mínima). No bloqueja:
  // el cue ja és reproduïble abans que la forma d'ona aparegui.
  const stillStreaming = (slotId) => {
    const slot = useSoundStore.getState().slots.find((s) => s.id === slotId);
    return slot && slot.isStreaming;
  };

  // Nombre de columnes (buckets) de la forma d'ona: ha de coincidir amb el
  // valor per defecte de computePeaks() (parells min/max → buckets*2 valors).
  const PEAK_BUCKETS = 8000;

  const buildPeaksBackground = async (slotId, { path, url, duration, bytes }) => {
    let ok = false;
    try {
      // Cau per fitxer (com els overviews dels DAWs)
      if (path) {
        const cached = getCachedPeaks(path, duration);
        if (cached) { if (stillStreaming(slotId)) setSlotPeaks(slotId, cached); ok = true; return; }
      }
      // Camí preferent per a cues amb ruta de disc: càlcul de pics a Rust
      // (symphonia, STREAMING). Evita descodificar GB de PCM al WebView (A5).
      // Retorna parells [min, max] intercalats, [-1, 1]: mateix format que
      // computePeaks(). Un Vec<f32> arriba com a array JS → Float32Array.
      // Amb timeout: si compute_peaks es pengés per a un fitxer patològic, no volem
      // que l'spinner de la forma d'ona giri per sempre; caiem al fallback / al finally.
      if (path) {
        try {
          const arr = await withTimeout(invoke('compute_peaks', { path, buckets: PEAK_BUCKETS }), 30000);
          if (arr && arr.length) {
            const peaks = new Float32Array(arr);
            putCachedPeaks(path, duration, peaks);
            if (stillStreaming(slotId)) setSlotPeaks(slotId, peaks);
            ok = true;
            return;
          }
        } catch (e) { console.warn('[peaks] compute_peaks slot', slotId, '-', String(e)); }
      }
      // Fallback JS (decodeAudioData): drag&drop web sense ruta, o si la comanda
      // Rust falla. Descodifica tot el buffer → només apte per fitxers no gegants.
      try {
        const ctx = initAudioContext();
        let arrayBuffer = bytes;
        if (!arrayBuffer) {
          if (path) arrayBuffer = await invoke('read_file_bytes', { path });
          else if (url) arrayBuffer = await (await fetch(url)).arrayBuffer();
          else return;
        }
        const audioBuffer = await ctx.decodeAudioData(arrayBuffer);
        const peaks = computePeaks(audioBuffer);
        if (path) putCachedPeaks(path, duration, peaks);
        if (stillStreaming(slotId)) setSlotPeaks(slotId, peaks);
        ok = true;
      } catch (e) { console.warn('[peaks] fallback JS slot', slotId, '-', String(e)); }
    } finally {
      // Passi el que passi, marca la generació com a acabada perquè l'spinner de la
      // forma d'ona s'aturi (si no hi ha pics, es mostra àrea buida, no spinner etern).
      if (!ok && stillStreaming(slotId)) console.warn('[peaks] slot', slotId, 'sense forma d\'ona (spinner aturat)');
      setSlotPeaksDone(slotId);
    }
  };

  // Càrrega des d'un objecte File (drag&drop web / input).
  const decodeAndLoad = async (slotId, file) => {
    setSlotLoading(slotId, true);
    try {
      // Cue de vídeo (per nom de fitxer): no es descodifica àudio. Es llegeix
      // la durada amb un <video> temporal perquè l'editor tingui timeline.
      if (VIDEO_EXT.test(file.name || '')) {
        const url = URL.createObjectURL(file);
        const vdur = await probeVideoDuration(url);
        loadAudio(slotId, file, null, url, null, {
          mediaType: 'video',
          duration: isFinite(vdur) ? vdur : 0,
        });
        return;
      }
      // Cue d'imatge fixa: ni àudio ni durada. Es projecta a la sortida.
      if (IMAGE_EXT.test(file.name || '')) {
        const url = URL.createObjectURL(file);
        loadAudio(slotId, file, null, url, null, { mediaType: 'image', duration: 0 });
        return;
      }
      // Cue de slides (PDF): sense àudio ni durada. La sortida el renderitza per
      // pàgines amb pdf.js llegint els bytes del disc, per la qual cosa NOMÉS és
      // servible amb ruta de disc (drag&drop natiu / selector); un File web sense
      // ruta quedaria sense projectar (la finestra de sortida no veu els blob URL).
      if (PDF_EXT.test(file.name || '')) {
        loadAudio(slotId, file, null, null, null, { mediaType: 'pdf', duration: 0 });
        return;
      }
      const url = URL.createObjectURL(file);
      const dur = await probeDuration(url);
      if (isFinite(dur) && dur > STREAM_THRESHOLD) {
        // Streaming: l'object URL serveix com a font de l'element <audio>
        loadAudio(slotId, file, null, url, null, { streaming: true, duration: dur });
        buildPeaksBackground(slotId, { url, duration: dur }); // forma d'ona en segon pla
        return;
      }
      const ctx = initAudioContext();
      const arrayBuffer = await file.arrayBuffer();
      const audioBuffer = await ctx.decodeAudioData(arrayBuffer);
      loadAudio(slotId, file, audioBuffer, url, null);
    } catch (e) {
      setSlotLoading(slotId, false);
      throw e;
    }
  };

  // Càrrega des d'una ruta de fitxer (Tauri): decideix entre descodificar o
  // streaming segons la durada, llegida abans de res via metadades.
  const loadFromPath = async (slotId, path) => {
    setSlotLoading(slotId, true);
    try {
      // Cue de vídeo: no es descodifica àudio; el reproduirà la finestra de
      // sortida. Es desa la ruta, es marca mediaType 'video' i es llegeix la
      // durada amb un <video> temporal (perquè l'editor tingui timeline).
      if (VIDEO_EXT.test(path)) {
        const vsrc = convertFileSrc(path);
        const vdur = await probeVideoDuration(vsrc);
        loadAudio(slotId, { name: basename(path) }, null, null, path, {
          mediaType: 'video',
          duration: isFinite(vdur) ? vdur : 0,
        });
        return;
      }
      // Cue d'imatge fixa: es desa la ruta, mediaType 'image', sense durada.
      if (IMAGE_EXT.test(path)) {
        loadAudio(slotId, { name: basename(path) }, null, null, path, { mediaType: 'image', duration: 0 });
        return;
      }
      // Cue de slides (PDF): es desa la ruta, mediaType 'pdf', sense durada. La
      // finestra de sortida el renderitza per pàgines (pdf.js) llegint els bytes.
      if (PDF_EXT.test(path)) {
        loadAudio(slotId, { name: basename(path) }, null, null, path, { mediaType: 'pdf', duration: 0 });
        return;
      }
      // Presentació (PPT/PPTX): converteix a PDF amb LibreOffice i carrega el PDF
      // resultant com un cue de slides. El label es manté amb el nom de la
      // presentació original. Si no hi ha LibreOffice, avisa i deixa el slot buit.
      if (PPT_EXT.test(path)) {
        try {
          const pdfPath = await invoke('soffice_to_pdf', { path });
          loadAudio(slotId, { name: basename(path) }, null, null, pdfPath, { mediaType: 'pdf', duration: 0 });
        } catch (e) {
          setSlotLoading(slotId, false);
          const msg = String(e || '');
          useSoundStore.getState().pushNotification({
            type: 'error',
            message: msg.includes('LIBREOFFICE_NOT_FOUND')
              ? 'Per obrir presentacions (.ppt/.pptx) cal LibreOffice instal·lat. Instal·la\'l o exporta la presentació a PDF.'
              : `No s'ha pogut convertir la presentació a PDF: ${msg}`,
          });
        }
        return;
      }
      const src = convertFileSrc(path);
      const dur = await probeDuration(src, path);
      if (isFinite(dur) && dur > STREAM_THRESHOLD) {
        // Streaming: llegeix els bytes (ràpid) i en fa un Blob de mateix origen
        // perquè Web Audio el pugui analitzar (picòmetre). NO es descodifica.
        // El Blob rep una còpia independent perquè la descodificació dels pics
        // (decodeAudioData allibera el buffer) no interfereixi amb la font.
        const bytes = await invoke('read_file_bytes', { path });
        const blobUrl = URL.createObjectURL(new Blob([bytes.slice(0)]));
        loadAudio(slotId, { name: basename(path) }, null, blobUrl, path, { streaming: true, duration: dur });
        buildPeaksBackground(slotId, { path, duration: dur, bytes }); // forma d'ona en segon pla
        return;
      }
      // Cue curt: descodifica a AudioBuffer (precís)
      const ctx = initAudioContext();
      const buffer = await invoke('read_file_bytes', { path }); // ArrayBuffer
      const audioBuffer = await ctx.decodeAudioData(buffer);
      loadAudio(slotId, { name: basename(path) }, audioBuffer, null, path);
    } catch (e) {
      setSlotLoading(slotId, false);
      throw e;
    }
  };

  return { decodeAndLoad, loadFromPath };
}
