// Motor de la Playlist (VLC) en STREAMING: usa elements <audio> que llegeixen
// el fitxer del disc via el protocol asset de Tauri (convertFileSrc). Càrrega
// quasi instantània i RAM mínima, llargada il·limitada.
//
// El routing al dispositiu de la playlist es fa amb audio.setSinkId, i el
// crossfade ramping audio.volume (no passem per Web Audio → sense problemes
// de CORS amb el protocol asset).
import { convertFileSrc } from '@tauri-apps/api/core';

let cur = null;      // { audio, index }
let paused = null;   // { index, pos }
let cfTimer = null;  // timeout que vigila el punt de crossfade
let token = 0;       // invalida transicions obsoletes

function clearCf() { if (cfTimer) { clearTimeout(cfTimer); cfTimer = null; } }

// Volum efectiu = guany de pista (0..1) × volum master de la playlist
function applyVol(get, audio, gain) {
  audio._gain = gain;
  const master = get().playlistVolume ?? 1;
  audio.volume = Math.max(0, Math.min(1, gain * master));
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

function nextIndex(get, idx) {
  const st = get();
  const n = st.playlist.length;
  if (n === 0) return null;
  if (st.playlistShuffle) {
    if (n === 1) return st.playlistRepeat ? 0 : null;
    let r = idx;
    while (r === idx) r = Math.floor(Math.random() * n);
    return r;
  }
  const next = idx + 1;
  if (next >= n) return st.playlistRepeat ? 0 : null;
  return next;
}

function prevIndex(get, idx) {
  const st = get();
  const n = st.playlist.length;
  if (n === 0) return null;
  const p = idx - 1;
  if (p < 0) return st.playlistRepeat ? n - 1 : 0;
  return p;
}

function startTrack(get, set, index, { fadeIn = 0, offset = 0 } = {}) {
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
  const ni = nextIndex(get, cur.index);
  if (ni == null) return; // deixa acabar; onEnded pararà
  const cf = Math.max(0, get().crossfade || 0);
  const old = cur.audio;
  rampVol(get, old, old._gain, 0, cf, () => destroy(old));
  startTrack(get, set, ni, { fadeIn: cf });
}

function onEnded(get, set, myToken) {
  if (myToken !== token || !cur) return;
  const ni = nextIndex(get, cur.index);
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
    paused = { index: cur.index, pos: cur.audio.currentTime };
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

export function plStop(get, set) {
  token++; clearCf();
  if (cur) destroy(cur.audio);
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
  if (cur) destroy(cur.audio);
  cur = null; paused = null; clearCf();
  startTrack(get, set, index, { fadeIn: 0 });
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
  if (paused) return { elapsed: paused.pos, duration: 0, index: paused.index };
  return { elapsed: 0, duration: 0, index: -1 };
}
