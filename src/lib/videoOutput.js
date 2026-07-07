// Gestió de la finestra de sortida de vídeo (2n monitor) i dels events que
// la controlen. Tot via l'API JS de Tauri v2 (sense codi Rust).
//
// La finestra té el label "output" i carrega la mateixa URL que la principal
// (index.html); a main.jsx es detecta el label i es renderitza <VideoOutput/>.
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { availableMonitors, primaryMonitor } from '@tauri-apps/api/window';
import { emit } from '@tauri-apps/api/event';
import { asioPosition } from './asioTelemetry';

export const OUTPUT_LABEL = 'output';

// Retorna la finestra de sortida si ja existeix (o null). Asíncron: a l'API
// de Tauri v2 getByLabel retorna una Promise.
export async function getOutputWindow() {
  try { return await WebviewWindow.getByLabel(OUTPUT_LABEL); }
  catch { return null; }
}

// Indica si la finestra de sortida està oberta ara mateix
export async function isOutputOpen() {
  const w = await getOutputWindow();
  if (!w) return false;
  try { return await w.isVisible(); }
  catch { return false; }
}

// Resol quin monitor és el destí de la sortida: el de nom indicat, si no el
// primer que no sigui el principal (mode auto). Retorna l'objecte monitor o
// null (un sol monitor / sense API → la sortida s'obre com a finestra normal,
// sense monitor de destí). Compartit per openOutputWindow i pel watchdog de
// resiliència (per saber quin monitor cal vigilar).
export async function resolveTargetMonitor(monitorName = null) {
  let monitors = [];
  let primary = null;
  try {
    monitors = await availableMonitors();
    primary = await primaryMonitor();
  } catch { return null; } // sense API de monitors

  let target = null;
  if (monitorName) {
    target = monitors.find((m) => m.name === monitorName) || null;
  }
  if (!target) {
    if (primary) {
      target = monitors.find((m) => m.name !== primary.name) || null;
    } else if (monitors.length > 1) {
      target = monitors[1];
    }
  }
  return target;
}

// Nom del monitor de destí de la sortida (o null si no n'hi ha cap: un sol
// monitor / dev). El watchdog el captura en obrir i vigila que segueixi present.
export async function resolveTargetMonitorName(monitorName = null) {
  const t = await resolveTargetMonitor(monitorName);
  return t ? t.name : null;
}

// Comprova si un monitor (per nom) segueix connectat ara mateix. Sense nom (no
// hi ha monitor de destí) o sense API → true (no vigilem res).
export async function monitorIsPresent(name) {
  if (!name) return true;
  try {
    const monitors = await availableMonitors();
    return monitors.some((m) => m.name === name);
  } catch { return true; }
}

// Re-assegura que la finestra de sortida segueix a pantalla completa (mateix
// monitor). Un canvi de resolució o de topologia de pantalles pot treure-la de
// fullscreen; això ho restaura sense moure-la de monitor. No fa res si ja hi és.
export async function reassertOutputFullscreen() {
  const w = await getOutputWindow();
  if (!w) return;
  try { if (!(await w.isFullscreen())) await w.setFullscreen(true); }
  catch { /* res */ }
}

// Obre la finestra de sortida. Si hi ha un 2n monitor (o se n'indica un per
// nom), la posiciona allà a pantalla completa; si no, l'obre com a finestra
// normal (útil en dev amb un sol monitor). No duplica: si ja existeix, la
// mostra i l'enfoca.
//
// monitorName: nom del monitor de destí (m.name d'availableMonitors). Si és
// null o no es troba (p. ex. pantalla desconnectada), cau al mode auto: el
// primer monitor que no sigui el principal.
export async function openOutputWindow(monitorName = null) {
  const existing = await getOutputWindow();
  if (existing) {
    try { await existing.show(); await existing.setFocus(); } catch { /* res */ }
    return existing;
  }

  // Tria el monitor de destí: el de nom indicat, si no el primer que no sigui el principal
  const target = await resolveTargetMonitor(monitorName);

  const opts = {
    url: 'index.html',
    title: 'ezyPlayer — Output',
    decorations: false,
    backgroundColor: '#000000',
    focus: true,
  };
  // Si tenim monitor de destí, hi col·loquem la finestra (després farem
  // fullscreen perquè ocupi exactament aquell monitor)
  if (target) {
    opts.x = target.position.x;
    opts.y = target.position.y;
    opts.width = Math.round(target.size.width / target.scaleFactor);
    opts.height = Math.round(target.size.height / target.scaleFactor);
  } else {
    opts.width = 960;
    opts.height = 540;
    opts.center = true;
  }

  const win = new WebviewWindow(OUTPUT_LABEL, opts);

  // Quan la webview estigui creada, si hi ha monitor de destí, fullscreen.
  win.once('tauri://created', async () => {
    if (target) {
      try {
        await win.setPosition({ type: 'Physical', x: target.position.x, y: target.position.y });
        await win.setFullscreen(true);
      } catch { /* res */ }
    }
  });
  win.once('tauri://error', (e) => {
    console.warn('No s\'ha pogut crear la finestra de sortida:', e);
  });

  return win;
}

// Tanca la finestra de sortida (si existeix). Abans, posa-la en negre.
export async function closeOutputWindow() {
  const w = await getOutputWindow();
  if (!w) return;
  try { await emit('video-black'); } catch { /* res */ }
  try { await w.close(); } catch { /* res */ }
}

// Obre/tanca segons l'estat actual
export async function toggleOutputWindow(monitorName = null) {
  if (await isOutputOpen()) { await closeOutputWindow(); return false; }
  await openOutputWindow(monitorName);
  return true;
}

// ── Events cap a la finestra de sortida ──
// Tots protegits: si la finestra no està oberta, el disparo no peta (l'event
// simplement no té cap oient).

// Reprodueix un fitxer de vídeo entre startPoint i stopPoint (slotId per
// identificar el cue quan la sortida informi que ha acabat o ha arribat al stop).
// Payload ric (4c): volum base, fades efectius (in/out), dispositiu de sortida
// (routing per color) i loop. Es passen com a objecte opts per compatibilitat.
export async function emitVideoPlay(filePath, startPoint = 0, stopPoint = null, slotId = null, opts = {}) {
  try {
    await emit('video-play', {
      filePath,
      startPoint: startPoint || 0,
      stopPoint: stopPoint || 0,
      slotId,
      volume: opts.volume != null ? opts.volume : 0.8,
      fadeIn: opts.fadeIn || 0,
      fadeOut: opts.fadeOut || 0,
      deviceId: opts.deviceId || 'default',
      loop: !!opts.loop,
      mediaType: opts.mediaType || 'video',
      // 4c separat: la sortida silencia el <video> (l'àudio surt pel motor) i la
      // imatge segueix l'àudio via els events de resync.
      muted: !!opts.muted,
      // Slides (PDF): pàgina inicial a projectar (1 per defecte).
      page: opts.page || 1,
    });
  } catch (e) { console.warn('video-play:', e); }
}

// Salta a una pàgina concreta del PDF projectat ara mateix a la sortida (slides).
export async function emitSlideGoto(page) {
  try { await emit('slide-goto', { page: Math.max(1, page | 0) }); }
  catch (e) { console.warn('slide-goto:', e); }
}

// ── Resync imatge→àudio (Fase 4c, separació d'àudio) ──
// Quan l'àudio d'un cue de vídeo surt pel motor (no pel <video>), la imatge de la
// sortida es manté sincronitzada amb l'àudio: cada ~400 ms enviem el temps absolut
// d'àudio (startPoint + posició dins el segment, de la telemetria nativa) i la
// finestra de sortida nomès corregeix el currentTime del vídeo si la deriva és
// gran. MAI toquem l'àudio (que és el rellotge mestre), així no hi ha glitches.
let resyncTimer = null;
export function startVideoResync(slotId, startPoint = 0) {
  stopVideoResync();
  resyncTimer = setInterval(() => {
    const pos = asioPosition(slotId);            // null si encara no arriba telemetria
    if (pos == null) return;
    emit('video-resync', { time: (startPoint || 0) + pos }).catch(() => {});
  }, 400);
}
export function stopVideoResync() {
  if (resyncTimer != null) { clearInterval(resyncTimer); resyncTimer = null; }
}

// Atura el vídeo (manté la finestra negra). Amb fadeOut>0, la sortida fa un
// fade (volum + opacitat) abans de passar a negre; 0 = tall sec.
export async function emitVideoStop(fadeOut = 0) {
  try { await emit('video-stop', { fadeOut: fadeOut || 0 }); }
  catch (e) { console.warn('video-stop:', e); }
}

// Posa la sortida en negre (go to black)
export async function emitVideoBlack() {
  try { await emit('video-black'); }
  catch (e) { console.warn('video-black:', e); }
}

// Congela el vídeo de la sortida (pausa) sense amagar-lo ni passar a negre.
export async function emitVideoPause() {
  try { await emit('video-pause'); }
  catch (e) { console.warn('video-pause:', e); }
}

// Reprèn el vídeo de la sortida des d'on estava congelat.
export async function emitVideoResume() {
  try { await emit('video-resume'); }
  catch (e) { console.warn('video-resume:', e); }
}

// Canvia el volum del vídeo en reproducció a la sortida
export async function emitVideoVolume(volume) {
  try { await emit('video-volume', { volume }); }
  catch (e) { console.warn('video-volume:', e); }
}

// Salta a un temps (segons, absolut dins el fitxer) del vídeo a la sortida
export async function emitVideoSeek(time) {
  try { await emit('video-seek', { time }); }
  catch (e) { console.warn('video-seek:', e); }
}

// Canvia el patró de la pantalla de blackout a la sortida en calent
// ('black' | 'bars' | 'testcard'). La finestra de sortida llegeix el valor
// inicial del localStorage compartit; aquest event és per al canvi en viu.
export async function emitVideoIdlePattern(pattern) {
  try { await emit('video-idle-pattern', { pattern }); }
  catch (e) { console.warn('video-idle-pattern:', e); }
}
