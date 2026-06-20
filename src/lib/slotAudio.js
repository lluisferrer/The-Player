// Utilitats per tractar slots tant si tenen AudioBuffer (cues curts, ≤60s) com
// si són en STREAMING (cues llargs, >60s, reproduïts amb un element <audio>).

// Un slot té clip carregat si té buffer descodificat, és en streaming, o és un
// cue de vídeo (es reprodueix a la finestra de sortida, sense buffer d'àudio).
export function hasClip(slot) {
  return !!(slot && (slot.audioBuffer || slot.isStreaming || slot.mediaType === 'video'));
}

// Un slot és un cue de vídeo (es disparta a la finestra de sortida)
export function isVideo(slot) {
  return !!(slot && slot.mediaType === 'video');
}

// Durada total del fitxer (segons), vingui del buffer o de les metadades
export function slotDuration(slot) {
  if (!slot) return 0;
  if (slot.audioBuffer) return slot.audioBuffer.duration;
  return slot.streamDuration || 0;
}

// Fades efectius: si el cue té un fade propi (override no-null) s'usa aquest,
// fins i tot si és 0 (tall sec explícit); si és null, s'usa el fade global.
export function effFadeIn(slot, globalIn) {
  return (slot && slot.fadeIn != null) ? slot.fadeIn : (globalIn || 0);
}
export function effFadeOut(slot, globalOut) {
  return (slot && slot.fadeOut != null) ? slot.fadeOut : (globalOut || 0);
}
