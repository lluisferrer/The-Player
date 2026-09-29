// Slice del SHOW com a document: quin show hi ha obert, si té canvis sense desar,
// els shows recents i la còpia de fitxers a la carpeta Media/ del show.
//
// Model: l'estat de l'app (cues, playlist, globals) segueix vivint a localStorage
// com fins ara (recuperació si l'app es tanca malament); el show obert és un
// fitxer .ezyshow dins la seva carpeta, que només s'escriu amb Save. "Canvis sense
// desar" = la serialització actual del show no coincideix amb la de l'últim desat
// (snapshot), així no cal marcar a mà cada acció que modifica el show.
//
// Les operacions que carreguen fitxers (New/Open/Save As) viuen al hook
// useShowFile, perquè necessiten loadFromPath de useAudioEngine.

import { invoke } from '@tauri-apps/api/core';
import { serializeShow, SHOW_DEFAULTS, PLAYLIST_DEFAULTS } from '../../lib/showFile';

const SHOW_KEY = 'the-player-show';           // { path, snapshot } del show obert
const RECENTS_KEY = 'the-player-recent-shows'; // [{ path, name, openedAt }]
const MAX_RECENTS = 10;

const readJson = (key, fallback) => {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
};
const savedShow = readJson(SHOW_KEY, {});

// Còpies a Media/ en sèrie (una darrere l'altra: diverses còpies grans alhora
// només farien anar més lent el disc). copyChain és la cua; jobSeq numera les
// còpies per al progrés.
let copyChain = Promise.resolve();
let jobSeq = 0;

const baseName = (p) => (p || '').split(/[\\/]/).pop();
const snapshotOf = (state, path) => JSON.stringify(serializeShow(state, path));

export function createShowSlice(set, get) {
  return {
    currentShowPath: savedShow.path || null,
    showSnapshot: savedShow.snapshot || null,
    showDirty: false,
    // 'opening' mentre es carrega un show (no es calculen canvis a mig carregar).
    showBusy: null,
    mediaJobs: {},               // { [job]: { name, copied, total } }
    recentShows: readJson(RECENTS_KEY, []),

    // Recalcula si hi ha canvis sense desar. Es crida en cada persist* (és a dir,
    // cada cop que canvia alguna cosa que es desa).
    refreshShowDirty: () => {
      const st = get();
      if (st.showBusy === 'opening' || !st.currentShowPath) return;
      const dirty = snapshotOf(st, st.currentShowPath) !== st.showSnapshot;
      if (dirty !== st.showDirty) set({ showDirty: dirty });
    },

    setShowBusy: (showBusy) => set({ showBusy }),

    // El show `path` acaba de ser desat o obert: l'estat actual és el de referència.
    markShowSaved: (path) => {
      const snapshot = snapshotOf(get(), path);
      set({ currentShowPath: path, showSnapshot: snapshot, showDirty: false });
      localStorage.setItem(SHOW_KEY, JSON.stringify({ path, snapshot }));
      get().addRecentShow(path);
    },

    // Cap show obert (p. ex. s'ha importat un show antic que encara no té carpeta,
    // o el show desat ja no existeix). La UI mostra la pantalla d'inici.
    detachShow: () => {
      set({ currentShowPath: null, showSnapshot: null, showDirty: false });
      localStorage.removeItem(SHOW_KEY);
    },

    addRecentShow: (path) => {
      const name = baseName(path).replace(/\.ezyshow$/i, '');
      const list = [{ path, name, openedAt: Date.now() }, ...get().recentShows.filter((r) => r.path !== path)]
        .slice(0, MAX_RECENTS);
      set({ recentShows: list });
      localStorage.setItem(RECENTS_KEY, JSON.stringify(list));
    },

    removeRecentShow: (path) => {
      const list = get().recentShows.filter((r) => r.path !== path);
      set({ recentShows: list });
      localStorage.setItem(RECENTS_KEY, JSON.stringify(list));
    },

    // ── Contingut ────────────────────────────────────────────────────────────

    // Buida el show (cues, playlist i ajustos del show) sense tocar la màquina.
    clearShowContent: () => {
      get().stopAll();
      get().playlistStop();
      for (const s of get().slots) {
        if (s.filePath || s.label) get().clearSlot(s.id);
      }
      get().applyShowSettings(SHOW_DEFAULTS);
      get().applyShowPlaylist(PLAYLIST_DEFAULTS);
    },

    applyShowSettings: (show) => {
      const g = { ...SHOW_DEFAULTS, ...show };
      set({
        globalFadeIn: g.globalFadeIn, globalFadeOut: g.globalFadeOut,
        cuesStopOthers: g.cuesStopOthers, cuesCrossfade: g.cuesCrossfade,
        cuesDuck: g.cuesDuck, cuesStopPlaylist: g.cuesStopPlaylist,
        duckEnabled: g.duckEnabled, duckAmount: g.duckAmount, duckAttack: g.duckAttack,
        duckRelease: g.duckRelease, duckHold: g.duckHold,
        videoIdleImageFit: g.videoIdleImageFit,
      });
      // Aquests dos avisen la finestra de sortida de vídeo (i persisteixen).
      get().setVideoIdleImage(g.videoIdleImage);
      get().setVideoIdlePattern(g.videoIdlePattern);
    },

    // Substitueix la playlist (pistes amb ids nous) i els seus ajustos.
    applyShowPlaylist: (pl) => get().importSessionPlaylist({ ...PLAYLIST_DEFAULTS, ...pl }),

    // ── Còpia de mèdia a la carpeta del show ────────────────────────────────

    // Copia `src` a Media/ del show (per defecte, l'obert) i, quan acaba, fa que
    // tot el que l'usava (cues, pistes, imatge de blackout) apunti a la còpia.
    // Mentrestant l'app segueix fent servir l'original, així el cue sona de
    // seguida. Retorna la ruta final (o la original si no s'ha pogut copiar).
    adoptMedia: (src, showFile = get().currentShowPath) => {
      if (!src || !showFile) return Promise.resolve(src);
      const job = ++jobSeq;
      const name = baseName(src);
      set((st) => ({ mediaJobs: { ...st.mediaJobs, [job]: { name, copied: 0, total: 0 } } }));
      const run = async () => {
        try {
          const dest = await invoke('show_import_media', { showFile, src, job });
          if (dest !== src) get().remapMediaPath(src, dest);
          return dest;
        } catch (err) {
          get().pushNotification({
            type: 'warning',
            message: `Could not copy «${name}» into the show folder: ${err}. It is still used from its original location.`,
          });
          return src;
        } finally {
          set((st) => {
            const jobs = { ...st.mediaJobs };
            delete jobs[job];
            return { mediaJobs: jobs };
          });
        }
      };
      const p = copyChain.then(run);
      copyChain = p.catch(() => {});
      return p;
    },

    // Espera que acabin totes les còpies pendents (abans de desar).
    waitForMedia: () => copyChain,

    setMediaProgress: ({ job, copied, total }) => {
      if (!get().mediaJobs[job]) return;
      set((st) => ({ mediaJobs: { ...st.mediaJobs, [job]: { ...st.mediaJobs[job], copied, total } } }));
    },

    // Substitueix una ruta de mèdia per una altra a tot arreu on es fa servir.
    remapMediaPath: (from, to) => {
      const st = get();
      const ids = st.slots.filter((s) => s.filePath === from).map((s) => s.id);
      if (ids.length) {
        set((s) => ({ slots: s.slots.map((x) => (x.filePath === from ? { ...x, filePath: to } : x)) }));
        get().persistSlots();
        // La cau de PCM dels motors va per ruta: escalfa la còpia per al proper GO.
        for (const id of ids) { get().preloadAsioSlot(id); get().preloadNativeSlot(id); }
      }
      if (st.playlist.some((t) => t.filePath === from)) {
        set((s) => ({ playlist: s.playlist.map((t) => (t.filePath === from ? { ...t, filePath: to } : t)) }));
        get().persistPlaylist();
      }
      if (st.videoIdleImage === from) get().setVideoIdleImage(to);
    },
  };
}
