// Punt de DISPATCH del routing de cues (Fase B, pas 1).
//
// Aquí es decideix, segons el TARGET de sortida d'un cue, per quin camí surt:
//   - WASAPI → camí Web Audio de sempre (playSlot / cueStreamEngine). Treu so.
//   - ASIO   → camí natiu (motor de veus al fil `asio-engine`). ENCARA NO existeix
//     el render: és el pas SEGÜENT. De moment és un STUB.
//
// ── Regla anti-duplicació (CRÍTICA) ─────────────────────────────────────────
// Fet observat amb la MixPre: NO agafa el WDM en exclusiva. Si un mateix cue
// sonés alhora per Web Audio (WASAPI) i per ASIO cap al mateix dispositiu físic,
// es DUPLICARIA el so (dos camins independents al mateix hardware).
// Per evitar-ho, el dispatch garanteix que cada cue surt per UN SOL camí:
//   · target WASAPI → Web Audio, i prou.
//   · target ASIO   → camí ASIO, i prou. El camí Web Audio NO s'activa.
// Com que el render ASIO encara no existeix, un cue amb target ASIO de moment
// NO treu so per ENLLOC — però TAMPOC el treu per WASAPI. Així evitem la
// duplicació des d'avui: quan s'enendolli el render natiu (pas següent), el so
// apareixerà només per ASIO, sense haver de tocar la regla.

import { parseTarget, resolveCueTargetStr } from './outputTarget';

// Decideix el camí d'un cue i, si cal, executa l'stub ASIO. Retorna:
//   { route: 'wasapi' }  → el cridador segueix amb el camí Web Audio habitual.
//   { route: 'asio', target } → el cridador NO ha de tocar Web Audio (stub fet).
//
// Paràmetres:
//   state: snapshot de l'estat (get()).
//   slot:  el cue a disparar.
//   ctx:   { kind: 'play' | 'preview' | 'video', ... } per a traces/futur.
export function dispatchCue(state, slot, ctx = {}) {
  const targetStr = resolveCueTargetStr(state, slot);
  const target = parseTarget(targetStr);

  if (target.kind !== 'asio') {
    // Camí normal: Web Audio / WASAPI. (Inclou el bus de Cues per defecte i
    // qualsevol routing per color cap a un deviceId WASAPI.)
    return { route: 'wasapi', target };
  }

  // ── Camí ASIO ─────────────────────────────────────────────────────────────
  // El render natiu JA existeix: el cridador (playSlot/cueStreamEngine) fa
  // invoke('asio_play_voice', …) cap al fil `asio-engine`, que registra una VEU
  // (en memòria o streaming) i la mescla al callback. Aquí només decidim el camí
  // i garantim que el cue NO surt també per WASAPI (regla anti-duplicació).
  return { route: 'asio', target };
}
