// Motor de reproducció en STREAMING per a cues llargs (>60s). El fitxer es
// carrega com a Blob (mateix origen) i es reprodueix amb un element <audio>
// connectat a Web Audio via MediaElementSource. Així evitem descodificar tot
// el fitxer a un AudioBuffer (lent i car en RAM) però mantenim:
//   - picòmetre (AnalyserNode), com els cues curts
//   - fades amb GainNode (precisos)
//   - routing per color amb ctx.setSinkId (a través de ctxForDevice)
// L'element <audio> descodifica sota demanda mentre reprodueix.

import { effFadeIn, effFadeOut } from './slotAudio';
import { duckRemove } from './playlistEngine';

const active = new Map(); // slotId → { audio, g, startPoint, stopPoint, segDur }
let previewEl = null;     // { audio, srcNode, gain }

// ── Helpers ──
function segmentOf(get, slot) {
  const total = slot.streamDuration || 0;
  const startPoint = Math.max(0, Math.min(slot.startPoint || 0, total));
  const stopPoint = Math.min(slot.stopPoint ?? total, total);
  const segDur = Math.max(0.05, stopPoint - startPoint);
  const fadeIn = Math.max(0, Math.min(effFadeIn(slot, get().globalFadeIn), segDur));
  const fadeOut = Math.max(0, Math.min(effFadeOut(slot, get().globalFadeOut), segDur));
  return { total, startPoint, stopPoint, segDur, fadeIn, fadeOut };
}

// Construeix el graf Web Audio per a un element <audio>, al context del
// dispositiu segons el color del cue (routing per grup).
function buildGraph(get, slot, audio) {
  const outDev = (slot.color && get().colorOutputs[slot.color]) || get().selectedDeviceId;
  const ctx = get().ctxForDevice(outDev);
  if (ctx.state === 'suspended') ctx.resume();
  const srcNode = ctx.createMediaElementSource(audio);
  const fadeGain = ctx.createGain();
  const volGain = ctx.createGain();
  volGain.gain.value = slot.volume ?? 0.8;
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  srcNode.connect(fadeGain);
  fadeGain.connect(volGain);
  volGain.connect(analyser);
  analyser.connect(ctx.destination);
  return { ctx, srcNode, fadeGain, volGain, analyser };
}

function destroyEntry(entry) {
  if (!entry) return;
  const { audio, g } = entry;
  if (audio._watch) cancelAnimationFrame(audio._watch);
  try { audio.pause(); } catch { /* res */ }
  try { g.srcNode.disconnect(); g.fadeGain.disconnect(); g.volGain.disconnect(); g.analyser.disconnect(); } catch { /* res */ }
  try { audio.removeAttribute('src'); audio.load(); } catch { /* res */ }
}

function killSlot(slotId) {
  const e = active.get(slotId);
  if (e) { destroyEntry(e); active.delete(slotId); }
}

function setStopped(set, slotId) {
  set((state) => ({
    slots: state.slots.map((s) =>
      s.id === slotId
        ? { ...s, isPlaying: false, pausedAt: null, sourceNode: null, analyserNode: null }
        : s),
    activeSlot: state.activeSlot === slotId ? null : state.activeSlot,
  }));
}

function onEnded(get, set, slotId) {
  killSlot(slotId);
  // Final natural d'un cue en streaming: si duckejava, deixa de comptar.
  // (El Set del motor de ducking evita doble compte si ja s'havia tret.)
  const slot = get().slots.find((s) => s.id === slotId);
  if (slot && slot.duck) duckRemove(get, slotId);
  set((state) => ({
    slots: state.slots.map((s) =>
      s.id === slotId
        ? { ...s, isPlaying: false, sourceNode: null, analyserNode: null }
        : s),
    activeSlot: state.activeSlot === slotId ? null : state.activeSlot,
  }));
}

// ── API ──

// offset != null → reprèn des d'aquesta posició dins el segment (sense fade in)
export function csPlay(get, set, slotId, { offset = null } = {}) {
  const slot = get().slots.find((s) => s.id === slotId);
  if (!slot || !slot.isStreaming) return;
  const src = slot.audioUrl;
  if (!src) return;

  killSlot(slotId);

  const { startPoint, stopPoint, segDur, fadeIn, fadeOut } = segmentOf(get, slot);
  const resuming = offset != null;
  const begin = resuming ? startPoint + Math.max(0, Math.min(offset, segDur)) : startPoint;

  const audio = new Audio();
  audio.preload = 'auto';
  audio.crossOrigin = 'anonymous';
  audio.src = src;
  const g = buildGraph(get, slot, audio);

  // Fade in quan l'àudio comença realment a sonar (precisió)
  g.fadeGain.gain.setValueAtTime((fadeIn > 0 && !resuming) ? 0 : 1, g.ctx.currentTime);
  audio.addEventListener('playing', () => {
    if (active.get(slotId)?.audio !== audio) return;
    if (fadeIn > 0 && !resuming) {
      const t = g.ctx.currentTime;
      g.fadeGain.gain.cancelScheduledValues(t);
      g.fadeGain.gain.setValueAtTime(0, t);
      g.fadeGain.gain.linearRampToValueAtTime(1, t + fadeIn);
    }
  }, { once: true });

  const seekStart = () => { try { audio.currentTime = begin; } catch { /* res */ } };
  if (audio.readyState >= 1) seekStart();
  else audio.addEventListener('loadedmetadata', seekStart, { once: true });
  audio.play().catch(() => {});

  // Vigila el punt de stop, el loop i el fade out final
  let fadedOut = false;
  const watch = () => {
    const cur = active.get(slotId);
    if (!cur || cur.audio !== audio) return;
    const ct = audio.currentTime;
    if (!slot.loop && fadeOut > 0 && !fadedOut && ct >= stopPoint - fadeOut) {
      fadedOut = true;
      const t = g.ctx.currentTime;
      g.fadeGain.gain.cancelScheduledValues(t);
      g.fadeGain.gain.setValueAtTime(g.fadeGain.gain.value, t);
      g.fadeGain.gain.linearRampToValueAtTime(0, t + Math.max(0.02, stopPoint - ct));
    }
    if (ct >= stopPoint - 0.02) {
      if (slot.loop) {
        try { audio.currentTime = startPoint; } catch { /* res */ }
        fadedOut = false;
        const t = g.ctx.currentTime;
        g.fadeGain.gain.cancelScheduledValues(t);
        g.fadeGain.gain.setValueAtTime(1, t);
      } else {
        onEnded(get, set, slotId);
        return;
      }
    }
    audio._watch = requestAnimationFrame(watch);
  };
  audio.addEventListener('ended', () => { if (!slot.loop) onEnded(get, set, slotId); }, { once: true });
  audio._watch = requestAnimationFrame(watch);

  active.set(slotId, { audio, g, startPoint, stopPoint, segDur });
  set((state) => ({
    slots: state.slots.map((s) =>
      s.id === slotId
        ? { ...s, isPlaying: true, pausedAt: null, sourceNode: null, analyserNode: g.analyser, fadeGainNode: g.fadeGain, gainNode: g.volGain }
        : s),
    activeSlot: slotId,
  }));
}

// fade: false = tall sec · true = fade out efectiu del cue · número = segons
export function csStop(get, set, slotId, fade = false) {
  const entry = active.get(slotId);
  if (!entry) { setStopped(set, slotId); return; }
  const slot = get().slots.find((s) => s.id === slotId);

  let fadeSec = 0;
  if (fade === true && slot) fadeSec = segmentOf(get, slot).fadeOut;
  else if (typeof fade === 'number') fadeSec = Math.max(0, fade);

  if (entry.audio._watch) cancelAnimationFrame(entry.audio._watch);
  setStopped(set, slotId);

  if (fadeSec > 0) {
    const g = entry.g;
    try {
      const t = g.ctx.currentTime;
      g.fadeGain.gain.cancelScheduledValues(t);
      g.fadeGain.gain.setValueAtTime(g.fadeGain.gain.value, t);
      g.fadeGain.gain.linearRampToValueAtTime(0, t + fadeSec);
    } catch { /* res */ }
    setTimeout(() => {
      if (active.get(slotId)?.audio === entry.audio) active.delete(slotId);
      destroyEntry(entry);
    }, fadeSec * 1000 + 80);
  } else {
    active.delete(slotId);
    destroyEntry(entry);
  }
}

export function csPause(get, set, slotId) {
  const entry = active.get(slotId);
  if (!entry) return;
  const pos = Math.max(0, entry.audio.currentTime - entry.startPoint);
  destroyEntry(entry);
  active.delete(slotId);
  set((state) => ({
    slots: state.slots.map((s) =>
      s.id === slotId
        ? { ...s, isPlaying: false, pausedAt: pos, analyserNode: null }
        : s),
  }));
}

export function csResume(get, set, slotId) {
  const slot = get().slots.find((s) => s.id === slotId);
  if (!slot || slot.pausedAt == null) return;
  csPlay(get, set, slotId, { offset: slot.pausedAt });
}

export function csSeek(get, set, slotId, ratio) {
  const slot = get().slots.find((s) => s.id === slotId);
  if (!slot) return;
  const { startPoint, segDur } = segmentOf(get, slot);
  const r = Math.min(1, Math.max(0, ratio));
  const entry = active.get(slotId);
  if (entry) {
    try { entry.audio.currentTime = startPoint + r * segDur; } catch { /* res */ }
  } else if (slot.pausedAt != null) {
    set((state) => ({
      slots: state.slots.map((s) => (s.id === slotId ? { ...s, pausedAt: r * segDur } : s)),
    }));
  }
}

export function csSetVolume(get, slotId, volume) {
  const entry = active.get(slotId);
  if (entry) { try { entry.g.volGain.gain.value = volume; } catch { /* res */ } }
}

// Posició dins el segment (s) si el slot sona en streaming, o null
export function csPosition(slotId) {
  const entry = active.get(slotId);
  if (entry) return Math.max(0, entry.audio.currentTime - entry.startPoint);
  return null;
}

export function csIsActive(slotId) {
  return active.has(slotId);
}

// ── Preview (bus PFL) ──
export function csPreviewStart(get, set, slotId) {
  csPreviewStop();
  const slot = get().slots.find((s) => s.id === slotId);
  if (!slot || !slot.isStreaming) return false;
  const src = slot.audioUrl;
  if (!src) return false;

  const ctx = get().ensurePreviewCtx();
  const audio = new Audio();
  audio.preload = 'auto';
  audio.crossOrigin = 'anonymous';
  audio.src = src;
  const srcNode = ctx.createMediaElementSource(audio);
  const gain = ctx.createGain();
  gain.gain.value = slot.volume ?? 0.8;
  srcNode.connect(gain);
  gain.connect(ctx.destination);

  const { startPoint, stopPoint } = segmentOf(get, slot);
  const seekStart = () => { try { audio.currentTime = startPoint; } catch { /* res */ } };
  if (audio.readyState >= 1) seekStart();
  else audio.addEventListener('loadedmetadata', seekStart, { once: true });
  audio.play().catch(() => {});

  const watch = () => {
    if (!previewEl || previewEl.audio !== audio) return;
    if (audio.currentTime >= stopPoint - 0.02) {
      if (slot.loop) { try { audio.currentTime = startPoint; } catch { /* res */ } }
      else { csPreviewStop(); set({ previewingSlot: null }); return; }
    }
    audio._watch = requestAnimationFrame(watch);
  };
  audio._watch = requestAnimationFrame(watch);
  previewEl = { audio, srcNode, gain };
  return true;
}

export function csPreviewStop() {
  if (!previewEl) return;
  const { audio, srcNode, gain } = previewEl;
  if (audio._watch) cancelAnimationFrame(audio._watch);
  try { audio.pause(); } catch { /* res */ }
  try { srcNode.disconnect(); gain.disconnect(); } catch { /* res */ }
  try { audio.removeAttribute('src'); audio.load(); } catch { /* res */ }
  previewEl = null;
}
