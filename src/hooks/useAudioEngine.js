import { invoke } from '@tauri-apps/api/core';
import { useSoundStore } from '../store/useSoundStore';

// Nom de fitxer a partir d'una ruta (Windows o Unix)
function basename(path) {
  return path.split(/[\\/]/).pop() || path;
}

export function useAudioEngine() {
  const initAudioContext = useSoundStore((s) => s.initAudioContext);
  const loadAudio = useSoundStore((s) => s.loadAudio);

  // Càrrega des d'un objecte File (drag&drop web / input).
  // No cal reprendre el context per descodificar; el resume es fa al Play.
  const decodeAndLoad = async (slotId, file) => {
    const ctx = initAudioContext();
    const arrayBuffer = await file.arrayBuffer();
    const audioBuffer = await ctx.decodeAudioData(arrayBuffer);
    const audioUrl = URL.createObjectURL(file);
    loadAudio(slotId, file, audioBuffer, audioUrl, null);
  };

  // Càrrega des d'una ruta de fitxer (Tauri): llegeix els bytes al backend,
  // decodifica i desa la ruta perquè es pugui recarregar des de la Library.
  const loadFromPath = async (slotId, path) => {
    const ctx = initAudioContext();
    const buffer = await invoke('read_file_bytes', { path }); // ArrayBuffer
    const audioBuffer = await ctx.decodeAudioData(buffer);
    loadAudio(slotId, { name: basename(path) }, audioBuffer, null, path);
  };

  return { decodeAndLoad, loadFromPath };
}
