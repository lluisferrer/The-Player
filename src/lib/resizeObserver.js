// ResizeObserver amb fallback per a WebKit antic: el WKWebView de macOS Mojave
// (Safari 12) NO té ResizeObserver (va arribar a Safari 13.1). Sense això, els
// canvas que l'usen (waveform, editor) petaven en muntar-se.
//
// `observeResize(el, cb)` crida `cb` un cop ara i cada cop que `el` canvia de mida;
// retorna una funció de neteja. Si no hi ha ResizeObserver, cau a escoltar el
// resize de la finestra (prou per a canvas d'amplada relativa).
export function observeResize(el, cb) {
  cb();
  if (typeof ResizeObserver !== 'undefined') {
    const ro = new ResizeObserver(cb);
    ro.observe(el);
    return () => ro.disconnect();
  }
  window.addEventListener('resize', cb);
  return () => window.removeEventListener('resize', cb);
}
