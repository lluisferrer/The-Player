// Motor de la Playlist (VLC) en STREAMING: usa elements <audio> que llegeixen
// el fitxer del disc via el protocol asset de Tauri (convertFileSrc). Càrrega
// quasi instantània i RAM mínima, llargada il·limitada.
//
// El routing al dispositiu de la playlist es fa amb audio.setSinkId, i el
// crossfade ramping audio.volume (no passem per Web Audio → sense problemes
// de CORS amb el protocol asset).
import { convertFileSrc } from '@tauri-apps/api/core';
import { nextIndex, prevIndex } from './playlistSeq';

let cur = null;        // { audio, index }
let paused = null;     // { index, pos }
let cfTimer = null;    // timeout que vigila el punt de crossfade
let token = 0;         // invalida transicions obsoletes
let fadeOutAudio = null; // pista que s'està esvaint en aturar la playlist
let orphan = null;     // pista «via morta»: sona fins al final en carregar una nova playlist

function clearCf() { if (cfTimer) { clearTimeout(cfTimer); cfTimer = null; } }

// Talla la pista «via morta» (si n'hi ha). Es crida en aturar o en sonar-ne una
// de nova: no pot quedar sonant alhora que una pista de la nova llista.
function killOrphan() {
  if (orphan) { destroy(orphan); orphan = null; }
}

// Talla immediatament una cua de fade-out pendent (p. ex. si es torna a sonar)
function killFadeOut() {
  if (fadeOutAudio) { destroy(fadeOutAudio); fadeOutAudio = null; }
}

// ── Ducking de la playlist ─────────────────────────────────────────────────
// Factor global del bus (1.0 = sense duck; duckAmount = duckejat al màxim).
// És un factor GLOBAL (no per-<audio>): l'apliquem a la pista actual i el
// mantenim en recrear pistes (crossfade, next/prev…). Multiplica el volum a
// applyVol, així conviu amb el ramping de crossfade i el master sense trepitjar-se.
let duckGain = 1;          // valor actual del factor de ducking
let duckRaf = null;        // requestAnimationFrame del ramp del duck
let duckGetRef = null;     // referència a get() per reaplicar el volum durant el ramp
const duckSet = new Set(); // ids de cues de ducking actius (evita doble compte)

// Listener opcional perquè el motor ASIO reapliqui el duck a la seva veu (el
// registra playlistAsio amb setAsioDuckListener). Evitem un import circular:
// playlistEngine NO importa playlistAsio; aquest s'hi registra en una direcció.
let asioDuckApply = null;
export function setAsioDuckListener(fn) { asioDuckApply = fn; }

// Listener equivalent per al motor cpal natiu (el registra playlistNative). Només
// un dels dos motors (ASIO o cpal) està actiu alhora segons el routing.
let nativeDuckApply = null;
export function setNativeDuckListener(fn) { nativeDuckApply = fn; }

// Reaplica el volum a la pista actual amb el duckGain vigent. Toca la pista
// WASAPI (<audio>) i les veus natives (ASIO o cpal) si la playlist hi va.
function duckReapply() {
  if (cur && duckGetRef) applyVol(duckGetRef, cur.audio, cur.audio._gain ?? 1);
  if (asioDuckApply) asioDuckApply(duckGain);
  if (nativeDuckApply) nativeDuckApply(duckGain);
}

// Factor de ducking vigent (1 = sense duck), perquè el motor ASIO el pugui
// incorporar al gain en crear/actualitzar veus.
export function currentDuckGain() {
  return duckGain;
}

// Ramp del duckGain de l'actual cap a "to" durant "dur" segons (lineal)
function rampDuck(get, to, dur) {
  duckGetRef = get;
  if (duckRaf) { cancelAnimationFrame(duckRaf); duckRaf = null; }
  const from = duckGain;
  if (dur <= 0 || from === to) { duckGain = to; duckReapply(); return; }
  const start = performance.now();
  const step = () => {
    const t = Math.min(1, (performance.now() - start) / (dur * 1000));
    duckGain = from + (to - from) * t;
    duckReapply();
    if (t < 1) duckRaf = requestAnimationFrame(step);
    else { duckRaf = null; }
  };
  step();
}

// Recalcula l'estat de ducking segons el comptador i els paràmetres globals.
// 0 cues → recupera (ramp a 1 amb release, després d'un hold opcional);
// ≥1 cue → abaixa (ramp a duckAmount amb attack).
let duckHoldTimer = null;
function applyDuckState(get) {
  if (duckHoldTimer) { clearTimeout(duckHoldTimer); duckHoldTimer = null; }
  const st = get();
  if (!st.duckEnabled) { rampDuck(get, 1, st.duckRelease ?? 0); return; }
  if (duckSet.size > 0) {
    rampDuck(get, Math.max(0, Math.min(1, st.duckAmount ?? 0.3)), st.duckAttack ?? 0.2);
  } else {
    const hold = Math.max(0, st.duckHold ?? 0);
    const release = st.duckRelease ?? 0.8;
    if (hold > 0) duckHoldTimer = setTimeout(() => { duckHoldTimer = null; rampDuck(get, 1, release); }, hold * 1000);
    else rampDuck(get, 1, release);
  }
}

// Un cue de ducking ha començat a sonar
export function duckAdd(get, slotId) {
  if (duckSet.has(slotId)) return;
  duckSet.add(slotId);
  applyDuckState(get);
}

// Un cue de ducking s'ha aturat / ha acabat
export function duckRemove(get, slotId) {
  if (!duckSet.has(slotId)) return;
  duckSet.delete(slotId);
  applyDuckState(get);
}

// Reinici total del comptador (Stop All): recupera la playlist
export function duckReset(get) {
  if (duckSet.size === 0) return;
  duckSet.clear();
  applyDuckState(get);
}

// Reaplica el factor de ducking quan canvien els paràmetres globals
// (p. ex. duckAmount mentre està duckejat, o desactivar el ducking).
export function duckRefresh(get) { applyDuckState(get); }

// Volum efectiu = guany de pista (0..1) × volum master × factor de ducking
function applyVol(get, audio, gain) {
  audio._gain = gain;
  const master = get().playlistVolume ?? 1;
  audio.volume = Math.max(0, Math.min(1, gain * master * duckGain));
}

function rampVol(get, audio, from, to, dur, onDone) {
  if (audio._raf) cancelAnimationFrame(audio._raf);
  if (dur <= 0) { applyVol(get, audio, to); if (onDone) onDone(); return; }
  const start = performance.now();
  const step = () => {
    const t = Math.min(1, (performance.now() - start) / (dur * 1000));
    applyVol(get, audio, from + (to - from) * t);
    if (t < 1) audio._raf = requestAnimationFrame(step);
    else if (onDone) onDone();
  };
  step();
}

function destroy(audio) {
  if (!audio) return;
  if (audio._raf) cancelAnimationFrame(audio._raf);
  try { audio.pause(); audio.removeAttribute('src'); audio.load(); } catch { /* res */ }
}

function makeAudio(get, filePath) {
  const audio = new Audio(convertFileSrc(filePath));
  audio.preload = 'auto';
  const dev = get().playlistDeviceId;
  if (audio.setSinkId && dev && dev !== 'default') audio.setSinkId(dev).catch(() => {});
  return audio;
}

function startTrack(get, set, index, { fadeIn = 0, offset = 0 } = {}) {
  killFadeOut();   // si hi havia una cua esvaint-se d'un stop anterior, talla-la
  killOrphan();    // sonar una pista nova talla la «via morta» d'una llista anterior
  const myToken = ++token;
  const st = get();
  const track = st.playlist[index];
  if (!track || !track.filePath) return;

  const audio = makeAudio(get, track.filePath);
  if (offset > 0) {
    audio.addEventListener('loadedmetadata', () => { try { audio.currentTime = offset; } catch { /* res */ } }, { once: true });
  }
  applyVol(get, audio, fadeIn > 0 ? 0 : 1);
  audio.addEventListener('ended', () => onEnded(get, set, myToken), { once: true });
  audio.play().catch(() => {});

  cur = { audio, index };
  set({ playlistIndex: index, playlistPlaying: true, playlistPaused: false });
  if (fadeIn > 0) rampVol(get, audio, 0, 1, fadeIn);

  scheduleTransition(get, set, myToken);
}

function scheduleTransition(get, set, myToken) {
  clearCf();
  if (!cur || myToken !== token) return;
  const audio = cur.audio;
  const arm = () => {
    if (!cur || cur.audio !== audio) return;
    const cf = Math.max(0, get().crossfade || 0);
    const dur = audio.duration;
    if (!isFinite(dur) || dur <= 0) return;
    const remaining = dur - audio.currentTime;
    if (remaining <= cf + 0.08) {
      doTransition(get, set);
    } else {
      cfTimer = setTimeout(arm, Math.max(60, (remaining - cf) * 1000));
    }
  };
  if (isFinite(audio.duration) && audio.duration > 0) arm();
  else audio.addEventListener('loadedmetadata', arm, { once: true });
}

function doTransition(get, set) {
  if (!cur) return;
  const ni = nextIndex(get, cur.index, true);
  if (ni == null) return; // deixa acabar; onEnded pararà
  const cf = Math.max(0, get().crossfade || 0);
  const old = cur.audio;
  rampVol(get, old, old._gain, 0, cf, () => destroy(old));
  startTrack(get, set, ni, { fadeIn: cf });
}

function onEnded(get, set, myToken) {
  if (myToken !== token || !cur) return;
  const ni = nextIndex(get, cur.index, true);
  if (ni != null) {
    destroy(cur.audio);
    startTrack(get, set, ni, { fadeIn: 0 });
  } else {
    destroy(cur.audio); cur = null; clearCf();
    set({ playlistPlaying: false, playlistPaused: false });
  }
}

export function plPlayPause(get, set) {
  const st = get();
  if (st.playlistPlaying && cur) {
    paused = { index: cur.index, pos: cur.audio.currentTime, duration: cur.audio.duration };
    token++; clearCf();
    try { cur.audio.pause(); } catch { /* res */ }
    destroy(cur.audio); cur = null;
    set({ playlistPlaying: false, playlistPaused: true });
  } else if (st.playlistPaused && paused) {
    const p = paused; paused = null;
    startTrack(get, set, p.index, { fadeIn: 0, offset: p.pos });
  } else {
    if (st.playlist.length === 0) return;
    const idx = st.playlistIndex >= 0 ? st.playlistIndex : 0;
    startTrack(get, set, idx, { fadeIn: 0 });
  }
}

// Despenja la pista actual perquè soni fins al final (via morta) sense encadenar
// la playlist: la nova llista es carrega neta. Si està en pausa, no hi ha res
// sonant: simplement es descarta. La crida el store en carregar una playlist nova.
export function plDetach(get, set) {
  clearCf(); killFadeOut(); killOrphan();
  token++;            // invalida onEnded/transicions de la pista actual
  if (cur) {
    const a = cur.audio;
    cur = null;
    a.loop = false;
    // En acabar de forma natural, neteja la via morta (l'onEnded original ja no
    // avança perquè el token ha canviat).
    a.addEventListener('ended', () => { if (orphan === a) killOrphan(); }, { once: true });
    orphan = a;
  }
  paused = null;
  set({ playlistPlaying: false, playlistPaused: false });
}

export function plStop(get, set) {
  token++; clearCf();
  killFadeOut(); killOrphan();
  if (cur) {
    const cf = Math.max(0, get().crossfade || 0);
    const old = cur.audio;
    cur = null; paused = null;
    set({ playlistPlaying: false, playlistPaused: false });
    if (cf > 0) {
      // Fade out: esvaeix el volum durant el temps de crossfade i després destrueix
      fadeOutAudio = old;
      rampVol(get, old, old._gain ?? 1, 0, cf, () => {
        if (fadeOutAudio === old) { destroy(old); fadeOutAudio = null; }
      });
    } else {
      destroy(old);
    }
    return;
  }
  cur = null; paused = null;
  set({ playlistPlaying: false, playlistPaused: false });
}

export function plNext(get, set) {
  const st = get();
  const base = cur ? cur.index : (st.playlistIndex >= 0 ? st.playlistIndex : 0);
  const ni = nextIndex(get, base);
  if (ni == null) { plStop(get, set); return; }
  const cf = Math.max(0, st.crossfade || 0);
  if (cur) { const old = cur.audio; rampVol(get, old, old._gain, 0, cf, () => destroy(old)); }
  paused = null;
  startTrack(get, set, ni, { fadeIn: cur ? cf : 0 });
}

export function plPrev(get, set) {
  const st = get();
  const base = cur ? cur.index : (st.playlistIndex >= 0 ? st.playlistIndex : 0);
  const pi = prevIndex(get, base);
  if (pi == null) return;
  const cf = Math.max(0, st.crossfade || 0);
  if (cur) { const old = cur.audio; rampVol(get, old, old._gain, 0, cf, () => destroy(old)); }
  paused = null;
  startTrack(get, set, pi, { fadeIn: cur ? cf : 0 });
}

export function plPlayIndex(get, set, index) {
  // Crossfade amb la pista actual (si n'hi ha), com fa Next/Prev
  const cf = Math.max(0, get().crossfade || 0);
  const hadCur = !!cur;
  if (cur) { const old = cur.audio; rampVol(get, old, old._gain ?? 1, 0, cf, () => destroy(old)); }
  paused = null; clearCf();
  startTrack(get, set, index, { fadeIn: hadCur ? cf : 0 });
}

// Salta a una fracció (0..1) de la pista actual de la playlist
export function plSeek(get, fraction) {
  if (cur && isFinite(cur.audio.duration) && cur.audio.duration > 0) {
    const f = Math.max(0, Math.min(1, fraction));
    try { cur.audio.currentTime = f * cur.audio.duration; } catch { /* res */ }
  }
}

export function plSetVolume(get) {
  if (cur) applyVol(get, cur.audio, cur.audio._gain ?? 1);
}

export function plSetDevice(get) {
  const dev = get().playlistDeviceId;
  if (cur && cur.audio.setSinkId) cur.audio.setSinkId(dev).catch(() => {});
}

export function plPosition() {
  if (cur && isFinite(cur.audio.duration)) {
    return { elapsed: cur.audio.currentTime, duration: cur.audio.duration, index: cur.index };
  }
  if (paused) return { elapsed: paused.pos, duration: isFinite(paused.duration) ? paused.duration : 0, index: paused.index };
  return { elapsed: 0, duration: 0, index: -1 };
}

// Arrenca una pista a un offset concret (per canvi de dispositiu en calent).
export function plStartAt(get, set, index, offset, fadeIn = 0) {
  startTrack(get, set, index, { fadeIn, offset });
}
