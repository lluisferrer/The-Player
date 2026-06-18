// Utilitats per tractar slots tant si tenen AudioBuffer (cues curts, ≤60s) com
// si són en STREAMING (cues llargs, >60s, reproduïts amb un element <audio>).

// Un slot té clip carregat si té buffer descodificat o és en streaming
export function hasClip(slot) {
  return !!(slot && (slot.audioBuffer || slot.isStreaming));
}

// Durada total del fitxer (segons), vingui del buffer o de les metadades
export function slotDuration(slot) {
  if (!slot) return 0;
  if (slot.audioBuffer) return slot.audioBuffer.duration;
  return slot.streamDuration || 0;
}

// Fades efectius: si el cue té un fade propi (>0) s'usa aquest; si és 0,
// s'usa el fade global. No hi ha cap interruptor d'override.
export function effFadeIn(slot, globalIn) {
  return (slot && slot.fadeIn > 0) ? slot.fadeIn : (globalIn || 0);
}
export function effFadeOut(slot, globalOut) {
  return (slot && slot.fadeOut > 0) ? slot.fadeOut : (globalOut || 0);
}
