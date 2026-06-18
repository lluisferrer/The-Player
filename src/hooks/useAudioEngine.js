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

// Nom de fitxer a partir d'una ruta (Windows o Unix)
function basename(path) {
  return path.split(/[\\/]/).pop() || path;
}

// Llegeix només les metadades per saber la durada, sense descodificar res
function probeDuration(src) {
  return new Promise((resolve) => {
    const a = new Audio();
    a.preload = 'metadata';
    const done = (d) => { a.removeAttribute('src'); resolve(d); };
    a.addEventListener('loadedmetadata', () => done(a.duration), { once: true });
    a.addEventListener('error', () => done(0), { once: true });
    a.src = src;
  });
}

export function useAudioEngine() {
  const initAudioContext = useSoundStore((s) => s.initAudioContext);
  const loadAudio = useSoundStore((s) => s.loadAudio);
  const setSlotLoading = useSoundStore((s) => s.setSlotLoading);
  const setSlotPeaks = useSoundStore((s) => s.setSlotPeaks);

  // Genera (o recupera de la cau) els pics de la forma d'ona d'un cue en
  // streaming. Si hi ha pics desats per aquest fitxer i durada, s'estalvia la
  // descodificació sencera; si no, descodifica un sol cop en segon pla, en desa
  // la versió reduïda a la cau i descarta el buffer (RAM mínima). No bloqueja:
  // el cue ja és reproduïble abans que la forma d'ona aparegui.
  const stillStreaming = (slotId) => {
    const slot = useSoundStore.getState().slots.find((s) => s.id === slotId);
    return slot && slot.isStreaming;
  };

  const buildPeaksBackground = async (slotId, { path, url, duration, bytes }) => {
    // Cau per fitxer (com els overviews dels DAWs)
    if (path) {
      const cached = getCachedPeaks(path, duration);
      if (cached) { if (stillStreaming(slotId)) setSlotPeaks(slotId, cached); return; }
    }
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
    } catch { /* sense forma d'ona */ }
  };

  // Càrrega des d'un objecte File (drag&drop web / input).
  const decodeAndLoad = async (slotId, file) => {
    setSlotLoading(slotId, true);
    try {
      // Cue de vídeo (per nom de fitxer): no es descodifica àudio
      if (VIDEO_EXT.test(file.name || '')) {
        const url = URL.createObjectURL(file);
        loadAudio(slotId, file, null, url, null, { mediaType: 'video' });
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
      // sortida. Es desa la ruta i es marca mediaType 'video'.
      if (VIDEO_EXT.test(path)) {
        loadAudio(slotId, { name: basename(path) }, null, null, path, { mediaType: 'video' });
        return;
      }
      const src = convertFileSrc(path);
      const dur = await probeDuration(src);
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
