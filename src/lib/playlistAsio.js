// Motor NATIU de la Playlist per a sortida ASIO (Fase 2 del motor natiu).
//
// Quan el dispositiu de la playlist (`playlistDeviceId`) és un target ASIO,
// les pistes es reprodueixen pel motor de veus natiu (`asio_play_voice`) cap als
// canals del driver, en comptes d'elements <audio> + setSinkId (que només surten
// per WASAPI). Replica la mateixa API que `playlistEngine.js` (pla*), perquè el
// store pugui enrutar segons el dispositiu sense canviar la resta.
//
// Crossfade: s'aconsegueix encavalcant DUES veus natives — la nova entra amb
// fade-in i l'actual surt amb un release (asio_stop_voice amb fade). L'auto-avanç
// es planifica per temporitzador (com el motor <audio>), amb la durada llegida
// de les metadades del fitxer; l'event `asio-voice-ended` fa de xarxa de
// seguretat per al final natural.
//
// Limitacions Fase 2 (pendents): ducking del bus de playlist sobre les veus
// natives; canvi de dispositiu en calent (ara atura). El model d'1 sol driver
// ASIO carregat alhora implica que cues i playlist han de compartir driver.

import { invoke } from '@tauri-apps/api/core';
import { convertFileSrc } from '@tauri-apps/api/core';
import { parseTarget } from './outputTarget';
import { asioPosition } from './asioTelemetry';
import { nextIndex, prevIndex } from './playlistSeq';
import { currentDuckGain, setAsioDuckListener } from './playlistEngine';

// Ids de veu reservats per a la playlist (no col·lideixen amb els cues 1..128 ni
// amb el to de prova u64::MAX). Comptador creixent: cada pista nova en pren un de
// nou, així el crossfade pot tenir-ne dues de vives alhora amb ids diferents.
const PL_VOICE_BASE = 2_000_000;
let plVoiceSeq = 0;
function nextVoiceId() { return PL_VOICE_BASE + (plVoiceSeq++); }

let curA = null;     // { voiceId, index, startedAt, duration }
let pausedA = null;  // { index, pos }
let cfTimerA = null; // temporitzador que vigila el punt de crossfade
let tokenA = 0;      // invalida transicions obsoletes
let orphanA = null;  // voiceId d'una pista «via morta»: sona fins al final
let gRef = null;     // referències a get()/set() del store (per a l'event de fi)
let sRef = null;

function stash(get, set) { gRef = get; if (set) sRef = set; }
function clearCfA() { if (cfTimerA) { clearTimeout(cfTimerA); cfTimerA = null; } }

// Atura la veu «via morta» (si n'hi ha). Es crida en aturar o en sonar-ne una de
// nova: no pot quedar sonant alhora que una pista de la nova llista.
function killOrphanA() {
  if (orphanA != null) {
    invoke('asio_stop_voice', { voiceId: orphanA, fadeOut: 0 }).catch(() => {});
    orphanA = null;
  }
}

// Target ASIO efectiu de la playlist (driver + canals), o null si no és ASIO.
function target(get) {
  const t = parseTarget(get().playlistDeviceId);
  return t.kind === 'asio' ? t : null;
}

// Temps transcorregut segons el rellotge (per planificar; robust i monòton).
function schedElapsed() {
  if (!curA) return 0;
  return Math.max(0, performance.now() / 1000 - curA.startedAt);
}

// ── Durada de pista (per crossfade i display) ───────────────────────────────
// Es llegeix de les metadades amb un <audio> efímer (sense reproduir-lo) i es
// cau per fitxer. No surt cap so d'aquí: només serveix per saber la llargada.
const durCache = new Map();
function resolveDuration(filePath) {
  if (durCache.has(filePath)) return Promise.resolve(durCache.get(filePath));
  return new Promise((resolve) => {
    try {
      const a = new Audio(convertFileSrc(filePath));
      a.preload = 'metadata';
      const done = (d) => {
        try { a.removeAttribute('src'); a.load(); } catch { /* res */ }
        durCache.set(filePath, d);
        resolve(d);
      };
      a.addEventListener('loadedmetadata', () => done(isFinite(a.duration) ? a.duration : 0), { once: true });
      a.addEventListener('error', () => done(0), { once: true });
    } catch { durCache.set(filePath, 0); resolve(0); }
  });
}

function startTrackA(get, set, index, { fadeIn = 0, offset = 0 } = {}) {
  stash(get, set);
  killOrphanA();   // sonar una pista nova talla la «via morta» d'una llista anterior
  const myToken = ++tokenA;
  const st = get();
  const track = st.playlist[index];
  if (!track || !track.filePath) return;
  const tgt = target(get);
  if (!tgt) return;

  const voiceId = nextVoiceId();
  // El gain inclou el factor de ducking vigent (música de fons sota els cues).
  const gain = (st.playlistVolume ?? 1) * currentDuckGain();
  invoke('asio_play_voice', {
    voiceId,
    driver: tgt.driver,
    filePath: track.filePath,
    channels: tgt.channels,
    gain,
    fadeIn,
    fadeOut: 0,
    loopOn: false,
    streaming: true,
    startPoint: offset,
    stopPoint: 0,
  }).catch((e) => console.warn('[plAsio] play:', e));

  curA = { voiceId, index, startedAt: performance.now() / 1000 - offset, duration: 0 };
  set({ playlistIndex: index, playlistPlaying: true, playlistPaused: false });

  // Durada (asíncrona): quan arribi, el crossfade ja la podrà fer servir.
  resolveDuration(track.filePath).then((d) => {
    if (curA && curA.voiceId === voiceId && d > 0) curA.duration = d;
  });

  // Pre-descodifica la pista següent per encadenar fluid.
  const ni = nextIndex(get, index, true);
  if (ni != null && ni !== index) {
    const nt = st.playlist[ni];
    if (nt && nt.filePath) invoke('asio_preload', { driver: tgt.driver, filePath: nt.filePath }).catch(() => {});
  }

  scheduleTransitionA(myToken);
}

function scheduleTransitionA(myToken) {
  clearCfA();
  if (!curA || myToken !== tokenA || !gRef) return;
  const voiceId = curA.voiceId;
  const arm = () => {
    if (!curA || curA.voiceId !== voiceId || myToken !== tokenA) return;
    const dur = curA.duration;
    if (!dur || dur <= 0) { cfTimerA = setTimeout(arm, 120); return; } // espera la durada
    const cf = Math.max(0, gRef().crossfade || 0);
    const remaining = dur - schedElapsed();
    if (remaining <= cf + 0.08) {
      doTransitionA();
    } else {
      cfTimerA = setTimeout(arm, Math.max(60, (remaining - cf) * 1000));
    }
  };
  arm();
}

function doTransitionA() {
  if (!curA || !gRef || !sRef) return;
  const get = gRef, set = sRef;
  const ni = nextIndex(get, curA.index, true);
  if (ni == null) return; // sense següent: deixa acabar; plaOnVoiceEnded pararà
  const cf = Math.max(0, get().crossfade || 0);
  // Esvaeix l'actual (release natiu) i arrenca la nova amb fade-in.
  invoke('asio_stop_voice', { voiceId: curA.voiceId, fadeOut: cf }).catch(() => {});
  startTrackA(get, set, ni, { fadeIn: cf });
}

// L'event `asio-voice-ended` (App.jsx) ens avisa del final natural d'una veu.
// Només actuem si és la pista ACTUAL (no una que s'esvaeix per crossfade, que ja
// no és curA). Fa de xarxa de seguretat si la planificació no ha encadenat.
export function plaOnVoiceEnded(voiceId) {
  if (voiceId === orphanA) { orphanA = null; return; } // la «via morta» ha acabat sola
  if (!curA || curA.voiceId !== voiceId || !gRef || !sRef) return;
  const get = gRef, set = sRef;
  const ni = nextIndex(get, curA.index, true);
  if (ni != null) {
    startTrackA(get, set, ni, { fadeIn: 0 });
  } else {
    curA = null; pausedA = null; clearCfA();
    set({ playlistPlaying: false, playlistPaused: false });
  }
}

export function plaPlayPause(get, set) {
  stash(get, set);
  const st = get();
  if (st.playlistPlaying && curA) {
    // Pausa: recorda índex+posició i atura la veu (el resume la recrea amb offset)
    pausedA = { index: curA.index, pos: schedElapsed(), duration: curA.duration || 0 };
    tokenA++; clearCfA();
    invoke('asio_stop_voice', { voiceId: curA.voiceId, fadeOut: 0 }).catch(() => {});
    curA = null;
    set({ playlistPlaying: false, playlistPaused: true });
  } else if (st.playlistPaused && pausedA) {
    const p = pausedA; pausedA = null;
    startTrackA(get, set, p.index, { fadeIn: 0, offset: p.pos });
  } else {
    if (st.playlist.length === 0) return;
    const idx = st.playlistIndex >= 0 ? st.playlistIndex : 0;
    startTrackA(get, set, idx, { fadeIn: 0 });
  }
}

// Despenja la pista actual (via morta): la veu nativa segueix sonant fins al
// final; la nova llista es carrega neta. La crida el store en carregar-ne una nova.
export function plaDetach(get, set) {
  stash(get, set);
  clearCfA(); killOrphanA();
  tokenA++;
  if (curA) { orphanA = curA.voiceId; curA = null; } // no l'aturem: que acabi sola
  pausedA = null;
  set({ playlistPlaying: false, playlistPaused: false });
}

export function plaStop(get, set) {
  stash(get, set);
  tokenA++; clearCfA(); killOrphanA();
  if (curA) {
    const cf = Math.max(0, get().crossfade || 0);
    invoke('asio_stop_voice', { voiceId: curA.voiceId, fadeOut: cf }).catch(() => {});
    curA = null;
  }
  pausedA = null;
  set({ playlistPlaying: false, playlistPaused: false });
}

export function plaNext(get, set) {
  stash(get, set);
  const st = get();
  const base = curA ? curA.index : (st.playlistIndex >= 0 ? st.playlistIndex : 0);
  const ni = nextIndex(get, base); // manual (auto=false)
  if (ni == null) { plaStop(get, set); return; }
  const cf = Math.max(0, st.crossfade || 0);
  const had = !!curA;
  if (curA) invoke('asio_stop_voice', { voiceId: curA.voiceId, fadeOut: cf }).catch(() => {});
  pausedA = null;
  startTrackA(get, set, ni, { fadeIn: had ? cf : 0 });
}

export function plaPrev(get, set) {
  stash(get, set);
  const st = get();
  const base = curA ? curA.index : (st.playlistIndex >= 0 ? st.playlistIndex : 0);
  const pi = prevIndex(get, base);
  if (pi == null) return;
  const cf = Math.max(0, st.crossfade || 0);
  const had = !!curA;
  if (curA) invoke('asio_stop_voice', { voiceId: curA.voiceId, fadeOut: cf }).catch(() => {});
  pausedA = null;
  startTrackA(get, set, pi, { fadeIn: had ? cf : 0 });
}

export function plaPlayIndex(get, set, index) {
  stash(get, set);
  const cf = Math.max(0, get().crossfade || 0);
  const had = !!curA;
  if (curA) invoke('asio_stop_voice', { voiceId: curA.voiceId, fadeOut: cf }).catch(() => {});
  pausedA = null; clearCfA();
  startTrackA(get, set, index, { fadeIn: had ? cf : 0 });
}

export function plaSeek(get, fraction) {
  stash(get);
  if (!curA) return;
  const dur = curA.duration;
  if (!dur || dur <= 0) return;
  const f = Math.max(0, Math.min(1, fraction));
  const pos = f * dur;
  invoke('asio_seek', { voiceId: curA.voiceId, position: pos }).catch(() => {});
  curA.startedAt = performance.now() / 1000 - pos;
  scheduleTransitionA(tokenA);
}

export function plaSetVolume(get) {
  stash(get);
  if (curA) invoke('asio_set_gain', { voiceId: curA.voiceId, gain: (get().playlistVolume ?? 1) * currentDuckGain() }).catch(() => {});
}

// Reaplica el factor de ducking a la veu ASIO actual (cridat per playlistEngine
// durant el ramp del duck). No fa res si la playlist no va per ASIO o està en pausa.
export function plaApplyDuck(duckGain) {
  if (curA && !curA.paused && gRef) {
    const vol = (gRef().playlistVolume ?? 1) * duckGain;
    invoke('asio_set_gain', { voiceId: curA.voiceId, gain: vol }).catch(() => {});
  }
}

// Registra plaApplyDuck al motor de ducking (playlistEngine) en carregar el
// mòdul, en UNA sola direcció (sense import circular).
setAsioDuckListener(plaApplyDuck);

// Canvi de dispositiu en calent: el gestiona el store (capturant la posició i
// reprenent a la nova sortida). Aquí només atura per si de cas.
export function plaSetDevice(get) {
  if ((curA || pausedA) && sRef) plaStop(get, sRef);
}

// Arrenca una pista a un offset concret (per canvi de dispositiu en calent).
export function plaStartAt(get, set, index, offset, fadeIn = 0) {
  startTrackA(get, set, index, { fadeIn, offset });
}

export function plaPosition() {
  if (curA) {
    const pos = asioPosition(curA.voiceId);
    const elapsed = pos != null ? pos : schedElapsed();
    return { elapsed, duration: curA.duration || 0, index: curA.index };
  }
  if (pausedA) return { elapsed: pausedA.pos, duration: pausedA.duration || 0, index: pausedA.index };
  return { elapsed: 0, duration: 0, index: -1 };
}

// Hi ha reproducció (o pausa) gestionada pel motor natiu ara mateix?
export function plaActive() { return !!(curA || pausedA); }
