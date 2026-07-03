// Constructor d'AudioContext amb fallback amb prefix: el WKWebView de macOS Mojave
// (Safari 12) NOMÉS exposa webkitAudioContext; el nom sense prefix no va arribar
// fins a Safari 14.1. Sense això, `new AudioCtx()` peta amb "Can't find
// variable: AudioContext" i el frontend no arrenca al Mac.
//
// P5: extret a un mòdul compartit perquè els slices que creen contextos (cues,
// playlist, preview, routing) l'importin sense dependre de useSoundStore.js
// (evita dependències circulars entre els slices i el store).
export const AudioCtx = (typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext)) || null;
