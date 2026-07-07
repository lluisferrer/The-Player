// Posició real del vídeo de la finestra de SORTIDA, difosa cap a la finestra
// principal perquè el "mirall" del tile (un <video> MUT) la segueixi.
//
// Per què cal: un <video> silenciat no està lligat a cap rellotge d'àudio, així
// que el navegador el deixa avançar a un ritme lleugerament diferent i, volta
// rere volta d'un loop, deriva respecte de la sortida (que sí que va a 1x). En
// lloc d'ancorar el mirall al rellotge de paret (que no casa amb l'overshoot del
// loop de la sortida), el fem esclau de la posició REAL de la sortida.
//
// La sortida emet `video-mirror` { slotId, time } a cada timeupdate (~4/s); un
// únic listener (a App) crida setMirrorTime. El mirall llegeix mirrorTime(slotId)
// i corregeix el seu currentTime si la deriva passa un llindar. Map fora de React
// (com asioTelemetry) per no provocar re-renders.

const positions = new Map(); // slotId → { time, at } (temps absolut del fitxer, ms)

export function setMirrorTime(slotId, time) {
  if (slotId == null || typeof time !== 'number') return;
  positions.set(slotId, { time, at: performance.now() });
}

// Posició estimada ara: l'última rebuda + el temps transcorregut des d'aleshores
// (extrapolació a 1x perquè el target sigui continu entre missatges). null si no
// n'hi ha cap de recent (>1 s: la sortida deu haver parat).
export function mirrorTime(slotId) {
  const e = positions.get(slotId);
  if (!e) return null;
  const dt = (performance.now() - e.at) / 1000;
  if (dt > 1) return null;
  return e.time + dt;
}

export function clearMirrorTime(slotId) { positions.delete(slotId); }
