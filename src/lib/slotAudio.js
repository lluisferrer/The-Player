// Utilitats per tractar slots tant si tenen AudioBuffer (cues curts, ≤60s) com
// si són en STREAMING (cues llargs, >60s, reproduïts amb un element <audio>).

// Un slot té clip carregat si té buffer descodificat, és en streaming, o és un
// cue visual (vídeo o imatge: es reprodueix a la finestra de sortida, sense
// buffer d'àudio).
export function hasClip(slot) {
  // Un cue "missing" (fitxer persistit però no localitzat en arrencar) NO té clip
  // utilitzable, encara que la persistència hagi restaurat isStreaming/mediaType: no
  // s'ha de poder disparar ni pintar com a carregat (mostraria l'spinner de forma
  // d'ona etern). Es tracta com a buit fins que es recarrega des del disc.
  if (!slot || slot.missing) return false;
  return !!(slot.audioBuffer || slot.isStreaming || slot.mediaType === 'video' || slot.mediaType === 'image' || slot.mediaType === 'pdf');
}

// Un slot és un cue de vídeo (es dispara a la finestra de sortida)
export function isVideo(slot) {
  return !!(slot && slot.mediaType === 'video');
}

// Un slot és un cue d'imatge fixa (es projecta a la sortida i s'hi manté)
export function isImage(slot) {
  return !!(slot && slot.mediaType === 'image');
}

// Un slot és un cue de slides (PDF): es projecta a la sortida i s'hi manté,
// però amb estat de pàgina actual (navegable amb les tecles de pàgina). Com la
// imatge: sense àudio ni timeline.
export function isPdf(slot) {
  return !!(slot && slot.mediaType === 'pdf');
}

// Cue visual: vídeo, imatge o slides (PDF). Tots van a la finestra de sortida
// (no pel motor d'àudio) i comparteixen el camí de play/stop/fade cap a
// <VideoOutput/>. PDF i imatge no tenen àudio ni timeline.
export function isVisual(slot) {
  return isVideo(slot) || isImage(slot) || isPdf(slot);
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
