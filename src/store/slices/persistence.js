// Slice de PERSISTÈNCIA (P5 — divisió del store en slices).
//
// Concentra en un sol lloc tota l'escriptura a localStorage de la sessió, com
// demanava l'auditoria. És una FACTORY que rep get(): aquestes accions només
// LLEGEIXEN l'estat i escriuen a disc (no criden set()). S'incorpora al store amb
// `...createPersistenceSlice(get)`. La LECTURA inicial (loaders) es manté a
// useSoundStore.js perquè s'executa a l'inici del mòdul, abans de crear el store.

// Versió de l'esquema de persistència dels slots (s'escriu a cada desat). El
// loader (loadPersistedSlots, a useSoundStore) migra els formats antics; aquí
// només s'escriu el número de versió vigent.
export const SLOTS_SCHEMA = 2;

export function createPersistenceSlice(get) {
  return {
    persistGlobals: () => {
      const {
        globalFadeIn, globalFadeOut, cuesStopOthers, cuesCrossfade, cuesDuck, cuesStopPlaylist, selectedDeviceId, playlistDeviceId, previewDeviceId, colorOutputs,
        duckEnabled, duckAmount, duckAttack, duckRelease, duckHold, asioMasterGain, nativeBufferSize, enabledOutputs, videoMonitorName, videoIdlePattern, videoOutputOpen,
        separateVideoAudio,
      } = get();
      localStorage.setItem('the-player-globals', JSON.stringify({
        globalFadeIn, globalFadeOut, cuesStopOthers, cuesCrossfade, cuesDuck, cuesStopPlaylist,
        cuesDeviceId: selectedDeviceId, playlistDeviceId, previewDeviceId,
        colorOutputs,
        duckEnabled, duckAmount, duckAttack, duckRelease, duckHold, asioMasterGain, nativeBufferSize, enabledOutputs, videoMonitorName, videoIdlePattern, videoOutputOpen,
        separateVideoAudio,
      }));
    },

    persistPlaylist: () => {
      const { playlist, crossfade, playlistRepeatMode, playlistShuffle, playlistVolume } = get();
      localStorage.setItem('the-player-playlist', JSON.stringify({
        tracks: playlist, crossfade, repeatMode: playlistRepeatMode, shuffle: playlistShuffle, volume: playlistVolume,
      }));
    },

    persistSlots: () => {
      const { slots } = get();
      const data = slots.map((s) => ({
        label: s.label,
        filePath: s.filePath,
        mediaType: s.mediaType,
        isStreaming: s.isStreaming,
        streamDuration: s.streamDuration,
        volume: s.volume,
        loop: s.loop,
        color: s.color,
        stopOthers: s.stopOthers,
        duck: s.duck,
        stopPlaylist: s.stopPlaylist,
        startPoint: s.startPoint,
        stopPoint: s.stopPoint,
        fadeIn: s.fadeIn,
        fadeOut: s.fadeOut,
        preWait: s.preWait,
        continueMode: s.continueMode,
      }));
      localStorage.setItem('the-player-slots', JSON.stringify({ v: SLOTS_SCHEMA, slots: data }));
    },
  };
}
