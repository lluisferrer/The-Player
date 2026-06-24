// Motor NATIU de la Playlist per al backend cpal multiplataforma (WASAPI a
// Windows, CoreAudio a Mac).
//
// Quan el motor natiu cpal està actiu (`useNativeCueEngine`) i el dispositiu de
// la playlist NO és un target ASIO, les pistes es reprodueixen pel motor de veus
// natiu (`native_play_cue` → camí streaming) cap als canals del dispositiu cpal
// triat (`nativePlaylistDeviceName`/`nativePlaylistChannels`), en comptes
// d'elements <audio> + setSinkId. Això dona routing multicanal real també a Mac,
// on el WebView no té `setSinkId`.
//
// És un calc de `playlistAsio.js` canviant les comandes `asio_*` per `native_*`
// i el target (driver+canals ASIO) per (deviceName+canals cpal). Replica la
// mateixa API (pln*) perquè el store pugui enrutar segons el dispositiu.
//
// Crossfade: igual que ASIO, encavalcant DUES veus natives (la nova amb fade-in,
// l'actual amb release). Auto-avanç per temporitzador amb la durada del fitxer;
// l'event `native-voice-ended` fa de xarxa de seguretat per al final natural.
//
// Telemetria: el backend natiu emet `native-telemetry` cap al MATEIX Map que
// l'ASIO (App.jsx ho redirigeix a applyAsioTelemetry), així que `asioPosition`
// retorna també la posició de les veus natives.

import { invoke } from '@tauri-apps/api/core';
import { convertFileSrc } from '@tauri-apps/api/core';
import { asioPosition } from './asioTelemetry';
import { nextIndex, prevIndex } from './playlistSeq';
import { currentDuckGain, setNativeDuckListener } from './playlistEngine';

// Ids de veu reservats per a la playlist (no col·lideixen amb els cues 1..128 ni
// amb el to de prova). Comptador creixent: cada pista nova en pren un de nou,
// així el crossfade pot tenir-ne dues de vives alhora amb ids diferents.
const PL_VOICE_BASE = 3_000_000;
let plVoiceSeq = 0;
function nextVoiceId() { return PL_VOICE_BASE + (plVoiceSeq++); }

let curN = null;     // { voiceId, index, startedAt, duration }
let pausedN = null;  // { index, pos, duration }
let cfTimerN = null; // temporitzador que vigila el punt de crossfade
let tokenN = 0;      // invalida transicions obsoletes
let orphanN = null;  // voiceId d'una pista «via morta»: sona fins al final
let gRef = null;     // referències a get()/set() del store (per a l'event de fi)
let sRef = null;

function stash(get, set) { gRef = get; if (set) sRef = set; }
function clearCfN() { if (cfTimerN) { clearTimeout(cfTimerN); cfTimerN = null; } }

// Indica si un voiceId pertany a la playlist nativa (per filtrar l'event de fi).
export function plnOwnsVoice(voiceId) {
  return typeof voiceId === 'number' && voiceId >= PL_VOICE_BASE && voiceId < PL_VOICE_BASE + 1_000_000;
}

// Atura la veu «via morta» (si n'hi ha). Es crida en aturar o en sonar-ne una de
// nova: no pot quedar sonant alhora que una pista de la nova llista.
function killOrphanN() {
  if (orphanN != null) {
    invoke('native_stop_voice', { voiceId: orphanN, fadeOut: 0 }).catch(() => {});
    orphanN = null;
  }
}

// Dispositiu cpal efectiu de la playlist (nom + canals destí).
function target(get) {
  const st = get();
  return { deviceName: st.nativePlaylistDeviceName || '', channels: st.nativePlaylistChannels || [] };
}

// Temps transcorregut segons el rellotge (per planificar; robust i monòton).
function schedElapsed() {
  if (!curN) return 0;
  return Math.max(0, performance.now() / 1000 - curN.startedAt);
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

function startTrackN(get, set, index, { fadeIn = 0, offset = 0 } = {}) {
  stash(get, set);
  killOrphanN();   // sonar una pista nova talla la «via morta» d'una llista anterior
  const myToken = ++tokenN;
  const st = get();
  const track = st.playlist[index];
  if (!track || !track.filePath) return;
  const tgt = target(get);

  const voiceId = nextVoiceId();
  // El gain inclou el factor de ducking vigent (música de fons sota els cues).
  const gain = (st.playlistVolume ?? 1) * currentDuckGain();
  invoke('native_play_cue', {
    voiceId,
    deviceName: tgt.deviceName,
    filePath: track.filePath,
    channels: tgt.channels,
    gain,
    fadeIn,
    fadeOut: 0,
    loopOn: false,
    startPoint: offset,
    stopPoint: 0,
    streaming: true,
  }).catch((e) => console.warn('[plNative] play:', e));

  curN = { voiceId, index, startedAt: performance.now() / 1000 - offset, duration: 0 };
  set({ playlistIndex: index, playlistPlaying: true, playlistPaused: false });

  // Durada (asíncrona): quan arribi, el crossfade ja la podrà fer servir.
  resolveDuration(track.filePath).then((d) => {
    if (curN && curN.voiceId === voiceId && d > 0) curN.duration = d;
  });

  // Pre-descodifica la pista següent per encadenar fluid. (El camí streaming no
  // passa per la cau, però native_preload és un no-op innocu per a pistes llargues.)
  const ni = nextIndex(get, index, true);
  if (ni != null && ni !== index) {
    const nt = st.playlist[ni];
    if (nt && nt.filePath) invoke('native_preload', { deviceName: tgt.deviceName, filePath: nt.filePath }).catch(() => {});
  }

  scheduleTransitionN(myToken);
}

function scheduleTransitionN(myToken) {
  clearCfN();
  if (!curN || myToken !== tokenN || !gRef) return;
  const voiceId = curN.voiceId;
  const arm = () => {
    if (!curN || curN.voiceId !== voiceId || myToken !== tokenN) return;
    const dur = curN.duration;
    if (!dur || dur <= 0) { cfTimerN = setTimeout(arm, 120); return; } // espera la durada
    const cf = Math.max(0, gRef().crossfade || 0);
    const remaining = dur - schedElapsed();
    if (remaining <= cf + 0.08) {
      doTransitionN();
    } else {
      cfTimerN = setTimeout(arm, Math.max(60, (remaining - cf) * 1000));
    }
  };
  arm();
}

function doTransitionN() {
  if (!curN || !gRef || !sRef) return;
  const get = gRef, set = sRef;
  const ni = nextIndex(get, curN.index, true);
  if (ni == null) return; // sense següent: deixa acabar; plnOnVoiceEnded pararà
  const cf = Math.max(0, get().crossfade || 0);
  // Esvaeix l'actual (release natiu) i arrenca la nova amb fade-in.
  invoke('native_stop_voice', { voiceId: curN.voiceId, fadeOut: cf }).catch(() => {});
  startTrackN(get, set, ni, { fadeIn: cf });
}

// L'event `native-voice-ended` (App.jsx) ens avisa del final natural d'una veu.
// Només actuem si és la pista ACTUAL (no una que s'esvaeix per crossfade).
export function plnOnVoiceEnded(voiceId) {
  if (voiceId === orphanN) { orphanN = null; return; } // la «via morta» ha acabat sola
  if (!curN || curN.voiceId !== voiceId || !gRef || !sRef) return;
  const get = gRef, set = sRef;
  const ni = nextIndex(get, curN.index, true);
  if (ni != null) {
    startTrackN(get, set, ni, { fadeIn: 0 });
  } else {
    curN = null; pausedN = null; clearCfN();
    set({ playlistPlaying: false, playlistPaused: false });
  }
}

export function plnPlayPause(get, set) {
  stash(get, set);
  const st = get();
  if (st.playlistPlaying && curN) {
    // Pausa: recorda índex+posició i atura la veu (el resume la recrea amb offset)
    pausedN = { index: curN.index, pos: schedElapsed(), duration: curN.duration || 0 };
    tokenN++; clearCfN();
    invoke('native_stop_voice', { voiceId: curN.voiceId, fadeOut: 0 }).catch(() => {});
    curN = null;
    set({ playlistPlaying: false, playlistPaused: true });
  } else if (st.playlistPaused && pausedN) {
    const p = pausedN; pausedN = null;
    startTrackN(get, set, p.index, { fadeIn: 0, offset: p.pos });
  } else {
    if (st.playlist.length === 0) return;
    const idx = st.playlistIndex >= 0 ? st.playlistIndex : 0;
    startTrackN(get, set, idx, { fadeIn: 0 });
  }
}

// Despenja la pista actual (via morta): la veu nativa segueix sonant fins al
// final; la nova llista es carrega neta. La crida el store en carregar-ne una nova.
export function plnDetach(get, set) {
  stash(get, set);
  clearCfN(); killOrphanN();
  tokenN++;
  if (curN) { orphanN = curN.voiceId; curN = null; } // no l'aturem: que acabi sola
  pausedN = null;
  set({ playlistPlaying: false, playlistPaused: false });
}

export function plnStop(get, set) {
  stash(get, set);
  tokenN++; clearCfN(); killOrphanN();
  if (curN) {
    const cf = Math.max(0, get().crossfade || 0);
    invoke('native_stop_voice', { voiceId: curN.voiceId, fadeOut: cf }).catch(() => {});
    curN = null;
  }
  pausedN = null;
  set({ playlistPlaying: false, playlistPaused: false });
}

export function plnNext(get, set) {
  stash(get, set);
  const st = get();
  const base = curN ? curN.index : (st.playlistIndex >= 0 ? st.playlistIndex : 0);
  const ni = nextIndex(get, base); // manual (auto=false)
  if (ni == null) { plnStop(get, set); return; }
  const cf = Math.max(0, st.crossfade || 0);
  const had = !!curN;
  if (curN) invoke('native_stop_voice', { voiceId: curN.voiceId, fadeOut: cf }).catch(() => {});
  pausedN = null;
  startTrackN(get, set, ni, { fadeIn: had ? cf : 0 });
}

export function plnPrev(get, set) {
  stash(get, set);
  const st = get();
  const base = curN ? curN.index : (st.playlistIndex >= 0 ? st.playlistIndex : 0);
  const pi = prevIndex(get, base);
  if (pi == null) return;
  const cf = Math.max(0, st.crossfade || 0);
  const had = !!curN;
  if (curN) invoke('native_stop_voice', { voiceId: curN.voiceId, fadeOut: cf }).catch(() => {});
  pausedN = null;
  startTrackN(get, set, pi, { fadeIn: had ? cf : 0 });
}

export function plnPlayIndex(get, set, index) {
  stash(get, set);
  const cf = Math.max(0, get().crossfade || 0);
  const had = !!curN;
  if (curN) invoke('native_stop_voice', { voiceId: curN.voiceId, fadeOut: cf }).catch(() => {});
  pausedN = null; clearCfN();
  startTrackN(get, set, index, { fadeIn: had ? cf : 0 });
}

export function plnSeek(get, fraction) {
  stash(get);
  if (!curN) return;
  const dur = curN.duration;
  if (!dur || dur <= 0) return;
  const f = Math.max(0, Math.min(1, fraction));
  const pos = f * dur;
  invoke('native_seek', { voiceId: curN.voiceId, position: pos }).catch(() => {});
  curN.startedAt = performance.now() / 1000 - pos;
  scheduleTransitionN(tokenN);
}

export function plnSetVolume(get) {
  stash(get);
  if (curN) invoke('native_set_gain', { voiceId: curN.voiceId, gain: (get().playlistVolume ?? 1) * currentDuckGain() }).catch(() => {});
}

// Reaplica el factor de ducking a la veu nativa actual (cridat per playlistEngine
// durant el ramp del duck). No fa res si la playlist no va per cpal o està en pausa.
export function plnApplyDuck(duckGain) {
  if (curN && gRef) {
    const vol = (gRef().playlistVolume ?? 1) * duckGain;
    invoke('native_set_gain', { voiceId: curN.voiceId, gain: vol }).catch(() => {});
  }
}

// Registra plnApplyDuck al motor de ducking (playlistEngine) en carregar el mòdul.
setNativeDuckListener(plnApplyDuck);

// Canvi de dispositiu en calent: el gestiona el store. Aquí només atura per si de cas.
export function plnSetDevice(get) {
  if ((curN || pausedN) && sRef) plnStop(get, sRef);
}

// Arrenca una pista a un offset concret (per canvi de dispositiu en calent).
export function plnStartAt(get, set, index, offset, fadeIn = 0) {
  startTrackN(get, set, index, { fadeIn, offset });
}

export function plnPosition() {
  if (curN) {
    const pos = asioPosition(curN.voiceId);
    const elapsed = pos != null ? pos : schedElapsed();
    return { elapsed, duration: curN.duration || 0, index: curN.index };
  }
  if (pausedN) return { elapsed: pausedN.pos, duration: pausedN.duration || 0, index: pausedN.index };
  return { elapsed: 0, duration: 0, index: -1 };
}

// Hi ha reproducció (o pausa) gestionada pel motor natiu ara mateix?
export function plnActive() { return !!(curN || pausedN); }
