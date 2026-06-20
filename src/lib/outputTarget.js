// Abstracció de "sortida" (output target) per al routing de cues i busos.
//
// Fase B, pas 1 (routing + plumbing, SENSE render ASIO real encara). Un target
// pot ser de dos tipus:
//   - WASAPI: el so surt per Web Audio + AudioContext.setSinkId(deviceId), tal
//     com fins ara. És el camí per defecte i el ÚNIC que treu so de debò avui.
//   - ASIO:   un parell/conjunt de canals d'un driver ASIO natiu (p. ex. la
//     MixPre, canals 1-2 o 3-4). El render natiu encara NO existeix (és el pas
//     següent: motor de veus al fil `asio-engine`). De moment és un STUB.
//
// ── Serialització retrocompatible ──────────────────────────────────────────
// El routing es desa com a STRING (a colorOutputs[color] i als *DeviceId dels
// busos). Per no trencar cap sessió ni cap codi existent:
//   - WASAPI → el deviceId pla de sempre ('default', 'cues', o un id WASAPI).
//   - ASIO   → un string amb prefix: "asio:<driver>|<ch0>,<ch1>,..."
//             p. ex. "asio:MixPre|0,1" = MixPre, canals 1-2 (0-indexats).
// Qualsevol string SENSE el prefix "asio:" és, per definició, un target WASAPI.
// Així, tot el routing desat fins ara (deviceIds plans) es continua interpretant
// EXACTAMENT igual.

export const ASIO_PREFIX = 'asio:';

// Construeix l'string serialitzat d'un target ASIO a partir de driver + canals.
// channels: array d'índexs de canal 0-indexats (p. ex. [0,1] = canals 1-2).
export function makeAsioTargetStr(driver, channels) {
  const chs = (channels || []).filter((c) => Number.isInteger(c) && c >= 0);
  return `${ASIO_PREFIX}${driver}|${chs.join(',')}`;
}

// Normalitza un valor de routing (string desat) a un objecte target ric.
// Tot valor que no comenci per "asio:" es tracta com a WASAPI (retrocompatible).
// Retorna:
//   { kind: 'wasapi', deviceId }                      o
//   { kind: 'asio', driver, channels: number[] }
export function parseTarget(value) {
  if (typeof value === 'string' && value.startsWith(ASIO_PREFIX)) {
    const rest = value.slice(ASIO_PREFIX.length);
    const sep = rest.indexOf('|');
    const driver = sep >= 0 ? rest.slice(0, sep) : rest;
    const chPart = sep >= 0 ? rest.slice(sep + 1) : '';
    const channels = chPart
      .split(',')
      .map((s) => parseInt(s, 10))
      .filter((n) => Number.isInteger(n) && n >= 0);
    return { kind: 'asio', driver, channels };
  }
  // Qualsevol altra cosa (inclòs null/undefined) → WASAPI amb aquest deviceId.
  return { kind: 'wasapi', deviceId: value || 'default' };
}

// És aquest valor de routing un target ASIO?
export function isAsioTarget(value) {
  return typeof value === 'string' && value.startsWith(ASIO_PREFIX);
}

// Etiqueta curta i llegible d'un target (per a la UI / depuració).
export function targetLabel(value) {
  const t = parseTarget(value);
  if (t.kind === 'asio') {
    const chs = t.channels.map((c) => c + 1).join('-'); // 1-indexat per a humans
    return `ASIO · ${t.driver} · ch ${chs || '?'}`;
  }
  return t.deviceId === 'default' ? 'Per defecte' : t.deviceId;
}

// Resol el target de SORTIDA efectiu d'un cue (slot), aplicant el routing per
// COLOR per damunt del bus de Cues per defecte. Centralitza la regla que avui
// està repetida (playSlot buffer/vídeo, cueStreamEngine.buildGraph):
//   target = colorOutputs[color]  (si el cue té color i està assignat)
//          | bus de Cues (selectedDeviceId)
// Rep l'snapshot d'estat (resultat de get()) per no acoblar-se al store.
// Retorna l'string serialitzat (NO l'objecte), perquè el cridador decideixi.
export function resolveCueTargetStr(state, slot) {
  const byColor = slot && slot.color ? state.colorOutputs[slot.color] : null;
  return byColor || state.selectedDeviceId;
}
