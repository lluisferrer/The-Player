// Pont de logs del frontend cap al fitxer de log de l'app (tauri-plugin-log).
//
// L'app empaquetada no té consola: sense això, els console.warn/error del
// WebView (errors del motor, dispositius, càrregues) es perdien i no hi havia
// manera de saber què havia passat en un bolo. Ara van també al fitxer rotatiu
// del directori de logs, juntament amb els logs del Rust.
//
// Es manté el comportament original de la consola (devtools en dev).

import { warn as logWarn, error as logError } from '@tauri-apps/plugin-log';

// Converteix els arguments de console.* a una sola línia de text.
function fmt(args) {
  return args
    .map((a) => {
      if (a instanceof Error) return `${a.name}: ${a.message}`;
      if (typeof a === 'string') return a;
      try { return JSON.stringify(a); } catch { return String(a); }
    })
    .join(' ')
    .slice(0, 2000); // talla missatges gegants (p. ex. objectes grossos)
}

let installed = false;

export function installLogBridge(windowLabel = 'main') {
  if (installed) return;
  installed = true;
  const prefix = `[ui:${windowLabel}]`;

  // Cap error del pont no pot fer soroll ni recursivitat: .catch(() => {}).
  const origWarn = console.warn.bind(console);
  const origError = console.error.bind(console);
  console.warn = (...args) => {
    origWarn(...args);
    logWarn(`${prefix} ${fmt(args)}`).catch(() => {});
  };
  console.error = (...args) => {
    origError(...args);
    logError(`${prefix} ${fmt(args)}`).catch(() => {});
  };

  // Errors no capturats (el que abans només veia l'overlay de diagnòstic).
  window.addEventListener('error', (e) => {
    logError(`${prefix} uncaught: ${e.message} @ ${e.filename}:${e.lineno}`).catch(() => {});
  });
  window.addEventListener('unhandledrejection', (e) => {
    logError(`${prefix} unhandled rejection: ${fmt([e.reason])}`).catch(() => {});
  });
}
