// Motor de la Playlist (tipus VLC): reproducció seqüencial amb auto-avanç i
// crossfade entre pistes. Funciona sobre el mateix AudioContext que els cues,
// amb el seu propi node master (volum de la playlist) → destination.
//
// Manté estat imperatiu (nodes, timers) a nivell de mòdul per no provocar
// re-renders; l'estat "de dades" (llista, índex, flags) viu al store.
import { invoke } from '@tauri-apps/api/core';

let master = null;          // GainNode master de la playlist
let current = null;         // { source, gain, startedAt, duration, index }
let timer = null;           // timeout per a la transició/fi
let paused = null;          // { index, pos } quan està en pausa
let token = 0;              // invalida càrregues asíncrones obsoletes
const bufferCache = new Map(); // filePath -> AudioBuffer

function ensureMaster(ctx, volume) {
  if (!master || master.context !== ctx) {
    master = ctx.createGain();
    master.connect(ctx.destination);
  }
  master.gain.value = volume;
  return master;
}

async function getBuffer(ctx, filePath) {
  if (bufferCache.has(filePath)) return bufferCache.get(filePath);
  const bytes = await invoke('read_file_bytes', { path: filePath });
  const buf = await ctx.decodeAudioData(bytes);
  bufferCache.set(filePath, buf);
  return buf;
}

function clearTimer() { if (timer) { clearTimeout(timer); timer = null; } }

function stopCurrent() {
  if (current && current.source) {
    try { current.source.onended = null; current.source.stop(); } catch { /* ja aturat */ }
  }
  current = null;
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

async function startTrack(get, set, index, { fadeIn = 0, offset = 0 } = {}) {
  const myToken = ++token;
  const st = get();
  const ctx = st.audioContext || st.initAudioContext();
  if (ctx.state === 'suspended') ctx.resume();
  const track = st.playlist[index];
  if (!track || !track.filePath) return;
  const m = ensureMaster(ctx, st.playlistVolume);

  let buf;
  try {
    buf = await getBuffer(ctx, track.filePath);
  } catch (e) {
    console.warn('Playlist: no es pot carregar', track.filePath, e);
    if (myToken !== token) return;
    const ni = nextIndex(get, index);
    if (ni != null) startTrack(get, set, ni, { fadeIn });
    else { plStop(get, set); }
    return;
  }
  if (myToken !== token) return; // s'ha interromput durant la descàrrega

  const gain = ctx.createGain();
  gain.connect(m);
  const now = ctx.currentTime;
  if (fadeIn > 0) {
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(1, now + fadeIn);
  } else {
    gain.gain.setValueAtTime(1, now);
  }
  const source = ctx.createBufferSource();
  source.buffer = buf;
  source.connect(gain);
  source.start(now, offset);
  current = { source, gain, startedAt: now - offset, duration: buf.duration, index };
  set({ playlistIndex: index, playlistPlaying: true, playlistPaused: false });

  // Pre-descodifica la següent per a un crossfade sense buits
  const ni = nextIndex(get, index);
  if (ni != null) {
    const t = get().playlist[ni];
    if (t && t.filePath) getBuffer(ctx, t.filePath).catch(() => {});
  }

  scheduleTransition(get, set);
}

function scheduleTransition(get, set) {
  clearTimer();
  const st = get();
  const ctx = st.audioContext;
  if (!current || !ctx) return;
  const cf = Math.max(0, st.crossfade || 0);
  const remaining = current.duration - (ctx.currentTime - current.startedAt);
  const ni = nextIndex(get, current.index);
  if (ni == null) {
    // Sense següent: para en acabar
    timer = setTimeout(() => {
      stopCurrent(); clearTimer();
      set({ playlistPlaying: false, playlistPaused: false });
    }, Math.max(0, remaining * 1000) + 50);
    return;
  }
  const lead = Math.max(0, remaining - cf);
  timer = setTimeout(() => doTransition(get, set), lead * 1000);
}

function doTransition(get, set) {
  const st = get();
  const ctx = st.audioContext;
  if (!current || !ctx) return;
  const cf = Math.max(0, st.crossfade || 0);
  const ni = nextIndex(get, current.index);
  if (ni == null) return;
  if (cf > 0 && current.gain) {
    const now = ctx.currentTime;
    current.gain.gain.cancelScheduledValues(now);
    current.gain.gain.setValueAtTime(current.gain.gain.value, now);
    current.gain.gain.linearRampToValueAtTime(0, now + cf);
    try { current.source.onended = null; current.source.stop(now + cf + 0.05); } catch { /* res */ }
  } else {
    stopCurrent();
  }
  startTrack(get, set, ni, { fadeIn: cf });
}

export function plPlayPause(get, set) {
  const st = get();
  if (st.playlistPlaying) {
    const ctx = st.audioContext;
    if (current && ctx) {
      const pos = Math.max(0, Math.min(ctx.currentTime - current.startedAt, current.duration - 0.01));
      paused = { index: current.index, pos };
      token++; clearTimer(); stopCurrent();
      set({ playlistPlaying: false, playlistPaused: true });
    }
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
  token++; clearTimer(); stopCurrent(); paused = null;
  set({ playlistPlaying: false, playlistPaused: false });
}

export function plNext(get, set) {
  const st = get();
  const base = current ? current.index : (st.playlistIndex >= 0 ? st.playlistIndex : 0);
  const ni = nextIndex(get, base);
  if (ni == null) { plStop(get, set); return; }
  const cf = Math.max(0, st.crossfade || 0);
  const hadCurrent = !!current;
  if (current && cf > 0 && current.gain && st.audioContext) {
    const now = st.audioContext.currentTime;
    current.gain.gain.cancelScheduledValues(now);
    current.gain.gain.setValueAtTime(current.gain.gain.value, now);
    current.gain.gain.linearRampToValueAtTime(0, now + cf);
    try { current.source.onended = null; current.source.stop(now + cf + 0.05); } catch { /* res */ }
    current = null;
  } else {
    stopCurrent();
  }
  paused = null;
  startTrack(get, set, ni, { fadeIn: hadCurrent ? cf : 0 });
}

export function plPrev(get, set) {
  const st = get();
  const base = current ? current.index : (st.playlistIndex >= 0 ? st.playlistIndex : 0);
  const pi = prevIndex(get, base);
  if (pi == null) return;
  const cf = Math.max(0, st.crossfade || 0);
  const hadCurrent = !!current;
  if (current && cf > 0 && current.gain && st.audioContext) {
    const now = st.audioContext.currentTime;
    current.gain.gain.cancelScheduledValues(now);
    current.gain.gain.setValueAtTime(current.gain.gain.value, now);
    current.gain.gain.linearRampToValueAtTime(0, now + cf);
    try { current.source.onended = null; current.source.stop(now + cf + 0.05); } catch { /* res */ }
    current = null;
  } else {
    stopCurrent();
  }
  paused = null;
  startTrack(get, set, pi, { fadeIn: hadCurrent ? cf : 0 });
}

export function plPlayIndex(get, set, index) {
  stopCurrent(); paused = null;
  startTrack(get, set, index, { fadeIn: 0 });
}

export function plSetVolume(get, v) {
  if (master) master.gain.value = v;
}

// Posició actual per a la UI (sense passar pel store, llegit cada frame)
export function plPosition(get) {
  const st = get();
  const ctx = st.audioContext;
  if (current && ctx) {
    const e = Math.max(0, ctx.currentTime - current.startedAt);
    return { elapsed: Math.min(e, current.duration), duration: current.duration, index: current.index };
  }
  if (paused) return { elapsed: paused.pos, duration: 0, index: paused.index };
  return { elapsed: 0, duration: 0, index: st.playlistIndex };
}
