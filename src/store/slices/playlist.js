// Slice de PLAYLIST — reproducció de llista (estil VLC) (P5 — divisió del store en slices).
//
// Concentra totes les accions que gestionen la playlist: afegir/eliminar/moure
// pistes, controls de transport (play/pause/stop/next/prev/seek), volum, crossfade,
// mode de repetició i shuffle.
//
// S'incorpora al store amb `...createPlaylistSlice(set, get)`.
//
// Variables de mòdul (aquí perquè NOMÉS les usen les accions d'aquest slice i la
// inicialització de l'estat del store):
//   - loadPlaylist / savedPlaylist: carrega la sessió persistent de localStorage.
//   - plNextId: comptador d'IDs únics per a les pistes de la playlist.
//   - consumePlNextId: funció exportada per a useSoundStore.js (importSessionPlaylist
//     es queda al store i necessita generar IDs nous).

import { isAsioTarget, isNativeTarget } from '../../lib/outputTarget';
import {
  plPlayPause, plStop, plNext, plPrev, plPlayIndex, plSetVolume, plSeek,
  plDetach,
} from '../../lib/playlistEngine';
import {
  plaPlayPause, plaStop, plaNext, plaPrev, plaPlayIndex, plaSetVolume, plaSeek,
  plaDetach,
} from '../../lib/playlistAsio';
import {
  plnPlayPause, plnStop, plnNext, plnPrev, plnPlayIndex, plnSetVolume, plnSeek,
  plnDetach,
} from '../../lib/playlistNative';

// ── Persistència inicial de la playlist ──────────────────────────────────────
// Càrrega des de localStorage en arrencar. S'avalua a nivell de mòdul (una sola
// vegada), abans de crear el store, perquè l'estat inicial en pugui llegir els valors.

const loadPlaylist = () => {
  try { return JSON.parse(localStorage.getItem('the-player-playlist')) || {}; }
  catch { return {}; }
};

// Exportat perquè useSoundStore.js l'usi a l'estat inicial dels camps de playlist
// (playlist, crossfade, playlistRepeatMode, playlistShuffle, playlistVolume).
export const savedPlaylist = loadPlaylist();

// Comptador d'IDs únics per a les pistes. S'inicialitza al valor màxim dels IDs
// ja existents (per no reutilitzar-ne cap després de recarregar).
let plNextId = 1;
if (Array.isArray(savedPlaylist.tracks)) {
  for (const t of savedPlaylist.tracks) if (t.id >= plNextId) plNextId = t.id + 1;
}

// Consumeix i retorna el proper ID de pista (post-increment). Exportat perquè
// importSessionPlaylist (a useSoundStore.js) l'usi per generar IDs nous.
export const consumePlNextId = () => plNextId++;

// ── Factory del slice ─────────────────────────────────────────────────────────

export function createPlaylistSlice(set, get) {
  return {
    // Afegeix pistes noves a la llista. Cada pista rep un ID únic creixent.
    addPlaylistTracks: (items) => {
      set((state) => ({
        playlist: [
          ...state.playlist,
          ...items.map((it) => ({ id: plNextId++, filePath: it.filePath, label: it.label })),
        ],
      }));
      get().persistPlaylist();
    },

    // Elimina una pista pel seu ID. Ajusta el marcador de pista sonant i el cursor
    // de selecció perquè segueixin sent coherents amb la nova llista.
    removePlaylistTrack: (id) => {
      set((state) => {
        const idx = state.playlist.findIndex((t) => t.id === id);
        const playlist = state.playlist.filter((t) => t.id !== id);
        // Marcador de pista sonant: si s'esborra una pista d'abans, decreix; si
        // s'esborra la que sona, el marcador deixa de ser vàlid a la nova llista (-1;
        // l'auto-avanç del motor el reposarà al seu índex en encadenar).
        let playlistIndex = state.playlistIndex;
        if (idx >= 0) {
          if (idx < playlistIndex) playlistIndex -= 1;
          else if (idx === playlistIndex) playlistIndex = -1;
        }
        if (playlistIndex > playlist.length - 1) playlistIndex = -1;
        // Manté el cursor de selecció coherent amb la nova llista
        let playlistSelected = state.playlistSelected;
        if (idx >= 0 && idx < playlistSelected) playlistSelected -= 1;
        playlistSelected = playlist.length === 0 ? 0 : Math.max(0, Math.min(playlistSelected, playlist.length - 1));
        return { playlist, playlistIndex, playlistSelected };
      });
      get().persistPlaylist();
    },

    // Mou una pista de la posició `from` a la posició `to`. El cursor de selecció
    // i el marcador de pista sonant segueixen el moviment de les pistes.
    movePlaylistTrack: (from, to) => {
      set((state) => {
        const playlist = [...state.playlist];
        if (from < 0 || from >= playlist.length || to < 0 || to >= playlist.length) return {};
        const [item] = playlist.splice(from, 1);
        playlist.splice(to, 0, item);
        // Tant el cursor de selecció com el marcador de pista sonant segueixen el
        // moviment de les pistes (mateixa transformació d'índexs).
        const follow = (i) => {
          if (i < 0) return i;
          if (i === from) return to;
          if (from < i && to >= i) return i - 1;
          if (from > i && to <= i) return i + 1;
          return i;
        };
        const playlistSelected = follow(state.playlistSelected);
        const playlistIndex = follow(state.playlistIndex);
        return { playlist, playlistSelected, playlistIndex };
      });
      get().persistPlaylist();
    },

    // Esborra tota la llista i atura la reproducció.
    clearPlaylist: () => {
      get().playlistStop();
      set({ playlist: [], playlistIndex: -1, playlistSelected: 0 });
      get().persistPlaylist();
    },

    // Carrega una playlist nova deixant la pista actual sonar fins al final (via
    // morta): no atura res, però la llista entra NETA (índex reiniciat). La pista
    // despenjada sona fins que acaba sola, o fins a un Stop / Play d'una altra
    // pista de la nova llista. No interfereix amb l'índex de la llista nova.
    loadPlaylistKeepPlaying: (tracks) => {
      if (get().plIsAsio()) plaDetach(get, set); else if (get().plIsNative()) plnDetach(get, set); else plDetach(get, set);
      set({
        playlist: (tracks || []).map((t) => ({ id: plNextId++, filePath: t.filePath, label: t.label })),
        playlistIndex: -1,
        playlistSelected: 0,
        playlistPlaying: false,
        playlistPaused: false,
      });
      get().persistPlaylist();
    },

    // Cert si la playlist routeja a un dispositiu ASIO (→ motor natiu de veus).
    plIsAsio: () => isAsioTarget(get().playlistDeviceId),
    // La playlist va pel motor natiu cpal quan el seu bus routeja a un target
    // "native:…" (device+canals cpal). Cobreix WASAPI a Windows i CoreAudio a Mac
    // amb routing multicanal real (que el WebView no pot fer a Mac).
    plIsNative: () => isNativeTarget(get().playlistDeviceId),

    // Assigna el temps de crossfade entre pistes (en segons; mínim 0).
    setCrossfade: (sec) => { set({ crossfade: Math.max(0, sec) }); get().persistPlaylist(); },
    // Cicla el mode de repetició: off → song → list → off
    cyclePlaylistRepeat: () => {
      const next = { off: 'song', song: 'list', list: 'off' };
      set((s) => ({ playlistRepeatMode: next[s.playlistRepeatMode] ?? 'song' }));
      get().persistPlaylist();
    },
    // Activa/desactiva el mode aleatori (shuffle).
    togglePlaylistShuffle: () => { set((s) => ({ playlistShuffle: !s.playlistShuffle })); get().persistPlaylist(); },
    // Aplica el volum de la playlist (0..1) al motor actiu.
    setPlaylistVolume: (v) => {
      set({ playlistVolume: v });
      if (get().plIsAsio()) plaSetVolume(get); else if (get().plIsNative()) plnSetVolume(get); else plSetVolume(get);
      get().persistPlaylist();
    },

    // Controls de transport: dispatxen al motor actiu (ASIO / natiu cpal / Web Audio).
    playlistPlayPause: () => (get().plIsAsio() ? plaPlayPause(get, set) : get().plIsNative() ? plnPlayPause(get, set) : plPlayPause(get, set)),
    playlistStop: () => (get().plIsAsio() ? plaStop(get, set) : get().plIsNative() ? plnStop(get, set) : plStop(get, set)),
    playlistNext: () => (get().plIsAsio() ? plaNext(get, set) : get().plIsNative() ? plnNext(get, set) : plNext(get, set)),
    playlistPrev: () => (get().plIsAsio() ? plaPrev(get, set) : get().plIsNative() ? plnPrev(get, set) : plPrev(get, set)),
    playlistPlayIndex: (i) => {
      set({ playlistSelected: i });
      if (get().plIsAsio()) plaPlayIndex(get, set, i); else if (get().plIsNative()) plnPlayIndex(get, set, i); else plPlayIndex(get, set, i);
    },

    // Selecció (cursor) de la llista: clic o fletxes
    setPlaylistSelected: (i) => {
      const n = get().playlist.length;
      if (n === 0) { set({ playlistSelected: 0 }); return; }
      set({ playlistSelected: Math.max(0, Math.min(i, n - 1)) });
    },
    // Mou el cursor de selecció amb un delta (+1/-1).
    movePlaylistSelection: (dir) => {
      const { playlist, playlistSelected } = get();
      if (playlist.length === 0) return;
      const next = Math.max(0, Math.min((playlistSelected || 0) + dir, playlist.length - 1));
      set({ playlistSelected: next });
    },
    // Dispara la pista seleccionada al cursor actual.
    playlistPlaySelected: () => {
      const { playlist, playlistSelected } = get();
      if (playlist.length === 0) return;
      const i = Math.max(0, Math.min(playlistSelected || 0, playlist.length - 1));
      if (get().plIsAsio()) plaPlayIndex(get, set, i); else if (get().plIsNative()) plnPlayIndex(get, set, i); else plPlayIndex(get, set, i);
    },
    // Salta a una fracció (0..1) de la pista que sona ara
    playlistSeek: (fraction) => (get().plIsAsio() ? plaSeek(get, fraction) : get().plIsNative() ? plnSeek(get, fraction) : plSeek(get, fraction)),
  };
}
