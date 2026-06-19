// Gestió de la finestra de sortida de vídeo (2n monitor) i dels events que
// la controlen. Tot via l'API JS de Tauri v2 (sense codi Rust).
//
// La finestra té el label "output" i carrega la mateixa URL que la principal
// (index.html); a main.jsx es detecta el label i es renderitza <VideoOutput/>.
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { availableMonitors, primaryMonitor } from '@tauri-apps/api/window';
import { emit } from '@tauri-apps/api/event';

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

// Obre la finestra de sortida. Si hi ha un 2n monitor (o se n'indica un per
// índex), la posiciona allà a pantalla completa; si no, l'obre com a finestra
// normal (útil en dev amb un sol monitor). No duplica: si ja existeix, la
// mostra i l'enfoca.
export async function openOutputWindow(monitorIndex = null) {
  const existing = await getOutputWindow();
  if (existing) {
    try { await existing.show(); await existing.setFocus(); } catch { /* res */ }
    return existing;
  }

  // Tria el monitor de destí: l'indicat, si no el primer que no sigui el principal
  let monitors = [];
  let primary = null;
  try {
    monitors = await availableMonitors();
    primary = await primaryMonitor();
  } catch { /* sense API de monitors: obrirà finestra normal */ }

  let target = null;
  if (monitorIndex != null && monitors[monitorIndex]) {
    target = monitors[monitorIndex];
  } else if (primary) {
    target = monitors.find((m) => m.name !== primary.name) || null;
  } else if (monitors.length > 1) {
    target = monitors[1];
  }

  const opts = {
    url: 'index.html',
    title: 'The Player — Sortida',
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
export async function toggleOutputWindow(monitorIndex = null) {
  if (await isOutputOpen()) { await closeOutputWindow(); return false; }
  await openOutputWindow(monitorIndex);
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
    });
  } catch (e) { console.warn('video-play:', e); }
}

// Atura el vídeo (manté la finestra negra)
export async function emitVideoStop() {
  try { await emit('video-stop'); }
  catch (e) { console.warn('video-stop:', e); }
}

// Posa la sortida en negre (go to black)
export async function emitVideoBlack() {
  try { await emit('video-black'); }
  catch (e) { console.warn('video-black:', e); }
}
