// Format del fitxer de show (.ezyshow) — funcions PURES (sense store ni Tauri).
//
// Un show és una carpeta autocontinguda:
//   <Nom>/<Nom>.ezyshow  +  <Nom>/Media/…
// El fitxer desa les rutes de mèdia RELATIVES a la carpeta ("Media/intro.wav",
// sempre amb "/"), de manera que la carpeta es pot moure a un altre disc, USB o
// sistema operatiu. A l'estat de l'app les rutes són sempre ABSOLUTES (és el que
// fan servir els motors d'àudio i el vídeo): la conversió es fa només en desar i
// en obrir.
//
// El show porta el CONTINGUT (cues, playlist, fades, ducking, blackout). La
// configuració de la MÀQUINA (dispositius, routing, ASIO, monitor…) no hi va: si
// s'obre el show en un altre ordinador, conserva la seva.

export const SHOW_VERSION = 2;

// Camps de cada cue que formen part del show.
const SLOT_KEYS = [
  'id', 'filePath', 'label', 'mediaType', 'volume', 'startPoint', 'stopPoint',
  'fadeIn', 'fadeOut', 'loop', 'color', 'stopOthers', 'duck', 'stopPlaylist',
  'preWait', 'continueMode',
];

// Ajustos globals que són del SHOW (la resta de globals són de la màquina), amb
// els valors d'un show nou.
export const SHOW_DEFAULTS = {
  globalFadeIn: 0,
  globalFadeOut: 0,
  cuesStopOthers: false,
  cuesCrossfade: 0,
  cuesDuck: false,
  cuesStopPlaylist: false,
  duckEnabled: false,
  duckAmount: 0.3,
  duckAttack: 0.2,
  duckRelease: 0.8,
  duckHold: 0,
  videoIdlePattern: 'black',
  videoIdleImage: null,
  videoIdleImageFit: 'cover',
};

export const PLAYLIST_DEFAULTS = {
  tracks: [],
  crossfade: 3,
  repeatMode: 'off',
  shuffle: false,
  volume: 0.8,
};

// ── Rutes ────────────────────────────────────────────────────────────────────

export const isAbsolutePath = (p) => /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith('/') || p.startsWith('\\\\');

// Carpeta que conté un fitxer (accepta "\" i "/").
export const dirOf = (file) => {
  const i = Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\'));
  return i > 0 ? file.slice(0, i) : file;
};

// Nom del show a partir del fitxer: "…/Gala/Gala.ezyshow" → "Gala".
export const showNameOf = (file) =>
  file.slice(Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\')) + 1).replace(/\.ezyshow$/i, '');

// A Windows les rutes no distingeixen majúscules.
const isWinPath = (p) => /^[a-zA-Z]:/.test(p) || p.startsWith('\\\\');
const norm = (p) => p.replace(/\\/g, '/').replace(/\/+$/, '');

// Absoluta → relativa a la carpeta del show si hi és a dins; si no, igual.
export function toShowRelative(absPath, showDir) {
  if (!absPath) return absPath;
  const a = norm(absPath);
  const d = norm(showDir) + '/';
  const inside = isWinPath(showDir)
    ? a.toLowerCase().startsWith(d.toLowerCase())
    : a.startsWith(d);
  return inside ? a.slice(d.length) : absPath;
}

// Relativa (com es desa al fitxer) → absoluta, amb el separador de la carpeta.
export function fromShowRelative(path, showDir) {
  if (!path || isAbsolutePath(path)) return path;
  const sep = showDir.includes('\\') ? '\\' : '/';
  return norm(showDir).replace(/\//g, sep) + sep + path.split('/').join(sep);
}

// ── Serialització ────────────────────────────────────────────────────────────

// Contingut del show a partir de l'estat de l'app. Sense data: així dues
// serialitzacions del mateix estat són idèntiques (serveix per saber si hi ha
// canvis sense desar).
export function serializeShow(state, showFile) {
  const dir = showFile ? dirOf(showFile) : null;
  const rel = (p) => (dir ? toShowRelative(p, dir) : p);

  const slots = state.slots
    .filter((s) => s.filePath || s.label)
    .map((s) => {
      const out = {};
      for (const k of SLOT_KEYS) out[k] = s[k] ?? null;
      out.filePath = rel(s.filePath);
      return out;
    });

  const show = {};
  for (const k of Object.keys(SHOW_DEFAULTS)) show[k] = state[k] ?? SHOW_DEFAULTS[k];
  show.videoIdleImage = rel(show.videoIdleImage);

  return {
    app: 'ezyPlayer',
    kind: 'show',
    version: SHOW_VERSION,
    slots,
    show,
    playlist: {
      tracks: state.playlist.map((t) => ({ filePath: rel(t.filePath), label: t.label ?? '' })),
      crossfade: state.crossfade,
      repeatMode: state.playlistRepeatMode,
      shuffle: state.playlistShuffle,
      volume: state.playlistVolume,
    },
  };
}

// Llegeix un fitxer de show (v1 o v2) i el retorna normalitzat, amb rutes
// absolutes. Llança un Error si no és un show d'ezyPlayer.
//   · v1 (exportació antiga): rutes absolutes i globals barrejats amb els de la
//     màquina; només se n'agafen els del show. `legacy: true` perquè la UI
//     proposi desar-lo com a carpeta.
export function parseShow(raw, showFile) {
  let data;
  try { data = JSON.parse(raw); } catch { throw new Error('The file is not a valid show file.'); }
  if (!data || data.app !== 'ezyPlayer') throw new Error('Invalid file: not an ezyPlayer show file.');
  if ((data.version ?? 1) > SHOW_VERSION) {
    throw new Error('This show was saved by a newer version of ezyPlayer. Update ezyPlayer to open it.');
  }
  const legacy = (data.version ?? 1) < 2;
  const dir = dirOf(showFile);
  const abs = (p) => (legacy ? p : fromShowRelative(p, dir));

  const src = (legacy ? data.globals : data.show) || {};
  const show = {};
  for (const k of Object.keys(SHOW_DEFAULTS)) show[k] = src[k] ?? SHOW_DEFAULTS[k];
  show.videoIdleImage = abs(show.videoIdleImage) || null;

  const slots = (Array.isArray(data.slots) ? data.slots : [])
    .filter((s) => s && Number.isInteger(s.id))
    .map((s) => ({ ...s, filePath: s.filePath ? abs(s.filePath) : null }));

  const pl = data.playlist || {};
  const playlist = {
    tracks: (Array.isArray(pl.tracks) ? pl.tracks : [])
      .filter((t) => t && t.filePath)
      .map((t) => ({ filePath: abs(t.filePath), label: t.label ?? '' })),
    crossfade: pl.crossfade ?? PLAYLIST_DEFAULTS.crossfade,
    repeatMode: pl.repeatMode ?? PLAYLIST_DEFAULTS.repeatMode,
    shuffle: pl.shuffle ?? PLAYLIST_DEFAULTS.shuffle,
    volume: pl.volume ?? PLAYLIST_DEFAULTS.volume,
  };

  return { legacy, slots, show, playlist };
}

// Totes les rutes de mèdia que fa servir l'estat (per recollir-les en un Save As).
export function mediaPathsOf(state) {
  const set = new Set();
  for (const s of state.slots) if (s.filePath) set.add(s.filePath);
  for (const t of state.playlist) if (t.filePath) set.add(t.filePath);
  if (state.videoIdleImage) set.add(state.videoIdleImage);
  return [...set];
}
