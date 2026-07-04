// Tema Dia/Nit. Es desa a localStorage i s'aplica com a `data-theme` a l'arrel del
// document; App.css hi té la paleta clara (alt contrast per a llum de sol) com a
// override de les variables de :root. Default: fosc (nit), comportament de sempre.
const KEY = 'ezyplayer-theme';

// Llegeix el tema desat (o 'dark' per defecte).
export function getInitialTheme() {
  try { return localStorage.getItem(KEY) === 'light' ? 'light' : 'dark'; }
  catch { return 'dark'; }
}

// Aplica el tema (data-theme a <html>) i el desa. Retorna el tema aplicat.
export function applyTheme(theme) {
  const t = theme === 'light' ? 'light' : 'dark';
  try { document.documentElement.dataset.theme = t; } catch { /* res */ }
  try { localStorage.setItem(KEY, t); } catch { /* res */ }
  return t;
}
