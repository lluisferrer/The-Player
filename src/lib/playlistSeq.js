// Seqüenciació de la Playlist (pròxim/anterior índex) compartida pels dos
// motors: el de streaming amb <audio> (WASAPI, playlistEngine.js) i el natiu
// per ASIO (playlistAsio.js). Funcions PURES que reben get() per llegir l'estat
// (playlist, repeat mode, shuffle). Extretes aquí per evitar imports circulars.

// auto=true quan és un avanç automàtic (final de pista); auto=false en saltar
// manualment amb el botó Next. En mode 'song' només l'avanç automàtic repeteix
// la pista actual: el botó Next sempre salta de debò.
export function nextIndex(get, idx, auto = false) {
  const st = get();
  const n = st.playlist.length;
  if (n === 0) return null;
  if (auto && st.playlistRepeatMode === 'song') return idx;
  const loop = st.playlistRepeatMode === 'list';
  if (st.playlistShuffle) {
    if (n === 1) return loop ? 0 : null;
    let r = idx;
    while (r === idx) r = Math.floor(Math.random() * n);
    return r;
  }
  const next = idx + 1;
  if (next >= n) return loop ? 0 : null;
  return next;
}

export function prevIndex(get, idx) {
  const st = get();
  const n = st.playlist.length;
  if (n === 0) return null;
  const p = idx - 1;
  if (p < 0) return st.playlistRepeatMode === 'list' ? n - 1 : 0;
  return p;
}
