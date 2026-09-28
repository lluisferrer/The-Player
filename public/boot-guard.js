// Xarxa de seguretat de diagnòstic D'ARRENCADA: si el bundle peta en carregar o
// muntar (p. ex. sintaxi o API no suportada per un WebKit antic), en comptes d'una
// pantalla negra muda mostra l'error a pantalla. També avisa si passats uns
// segons el #root segueix buit (res no s'ha muntat).
//
// NOMÉS durant l'arrencada: quan l'app ja s'ha muntat (main.jsx posa
// window.__ezyBooted = true), els errors ja NO tapen la UI — a mitja funció un
// error puntual (una promesa rebutjada) no pot deixar l'operador sense botonera.
// Aquests errors van al fitxer de log (src/lib/logBridge.js).
//
// Fitxer extern (servit des de /public, mateix origen) perquè la CSP no hagi de
// permetre scripts inline ('unsafe-inline').
(function () {
  function booted() { return window.__ezyBooted === true; }
  function show(title, detail) {
    if (booted()) return;
    var el = document.getElementById('boot-error');
    if (!el) {
      el = document.createElement('div');
      el.id = 'boot-error';
      el.style.cssText = 'position:fixed;top:0;right:0;bottom:0;left:0;z-index:99999;background:#0f0f0f;color:#f4f4f5;font:13px/1.5 monospace;padding:24px;overflow:auto;white-space:pre-wrap;';
      (document.body || document.documentElement).appendChild(el);
    }
    el.textContent = 'ezyPlayer — error d\'arrencada\n\n' + title + '\n\n' + (detail || '');
  }
  window.addEventListener('error', function (e) {
    show(e.message || 'Error', (e.filename || '') + ':' + (e.lineno || '') + '\n' + ((e.error && e.error.stack) || ''));
  });
  window.addEventListener('unhandledrejection', function (e) {
    var r = e.reason;
    show('Promesa rebutjada: ' + ((r && r.message) || r), (r && r.stack) || '');
  });
  // Si passats 5 s el #root segueix buit, l'app no s'ha muntat (sense excepció
  // capturada): probable WebKit massa antic o assets no carregats.
  setTimeout(function () {
    var root = document.getElementById('root');
    if (root && root.childElementCount === 0 && !document.getElementById('boot-error')) {
      show('El frontend no s\'ha muntat (#root buit, sense errors capturats).',
           'Pista: WebKit del sistema massa antic per al bundle, o els assets no s\'han carregat.\nUserAgent:\n' + navigator.userAgent);
    }
  }, 5000);
})();
