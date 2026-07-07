import { create } from 'zustand';
// P5: la persistència a localStorage viu en un slice a part (primer pas de la
// divisió del store). El loader inicial es queda aquí sota (s'executa abans de
// crear el store).
import { createPersistenceSlice } from './slices/persistence';
import { createVideoSlice } from './slices/video';
import { createPreviewSlice } from './slices/preview';
import { createRoutingSlice } from './slices/routing';
import { createPlaylistSlice, savedPlaylist, consumePlNextId } from './slices/playlist';
import { createCuesSlice, createEmptySlot, NUM_PAGES, NUM_SLOTS } from './slices/cues';
// AudioCtx → mogut al slice de routing (P5); ja no cal aquí
// duckAdd/duckRemove/duckReset/duckRefresh → moguts al slice de cues (P5)
// csPlay/csStop/csPause/csResume/csSeek/csSetVolume → moguts al slice de cues (P5)
// invoke / hasClip / isVideo / isImage / isVisual / effFadeIn / effFadeOut / slotDuration → moguts al slice de cues (P5)
// dispatchCue / isAsioTarget / resolveCueTargetStr / parseTarget → moguts al slice de cues (P5)
// clearAsioTelemetry / asioPosition → moguts al slice de cues (P5)
// emitVideoPlay / emitVideoStop / emitVideoBlack / emitVideoVolume / startVideoResync / stopVideoResync → moguts al slice de cues (P5)
import { PREVIEW_VOICE_ID } from '../lib/asioIds';
import { makeNativeTargetStr, isAsioTarget, isNativeTarget } from '../lib/outputTarget';
// emitVideoSeek / emitVideoIdlePattern → moguts al slice de vídeo (P5); emitVideoBlack/emitVideoPlay/etc. → slice de cues (P5)

// SLOTS_PER_PAGE / NUM_PAGES / NUM_SLOTS / createEmptySlot → moguts al slice de cues (P5)

// Esquema v2 dels slots persistits: el fade és un override nullable (null =
// segueix el global; 0 = tall sec explícit). Abans, 0 volia dir "segueix el
// global", per això migrem els 0 antics a null. (El número de versió que s'escriu
// viu ara al slice de persistència, SLOTS_SCHEMA.)
const loadPersistedSlots = () => {
  try {
    const saved = localStorage.getItem('the-player-slots');
    if (!saved) return null;
    const parsed = JSON.parse(saved);
    // Format antic (array directe, sense versió): migra fadeIn/fadeOut 0 → null
    if (Array.isArray(parsed)) {
      return parsed.map((s) => (s ? {
        ...s,
        fadeIn: s.fadeIn ? s.fadeIn : null,
        fadeOut: s.fadeOut ? s.fadeOut : null,
      } : s));
    }
    return Array.isArray(parsed.slots) ? parsed.slots : null;
  } catch {
    return null;
  }
};

const savedSlots = loadPersistedSlots();

const loadGlobals = () => {
  try { return JSON.parse(localStorage.getItem('the-player-globals')) || {}; }
  catch { return {}; }
};

// Migració P3 (unificació del routing): fins ara el motor natiu era un flag GLOBAL
// (useNativeCueEngine) amb dispositiu/canals en camps a part (nativeCue*, native
// Playlist*, nativePreview*). Ara el motor de cada bus es codifica al seu propi
// target ("native:<dev>|<canals>"). Si una sessió antiga tenia el motor natiu
// ACTIU, convertim els busos no-ASIO al target natiu equivalent perquè segueixin
// sonant pel motor natiu. Si estava apagat (cas per defecte), no toquem res.
const migrateGlobals = (g) => {
  if (!g || !g.useNativeCueEngine) return g;
  const toNative = (devId, name, channels) =>
    (isAsioTarget(devId) || isNativeTarget(devId)) ? devId
      : makeNativeTargetStr(name || '', Array.isArray(channels) ? channels : []);
  return {
    ...g,
    cuesDeviceId: toNative(g.cuesDeviceId, g.nativeCueDeviceName, g.nativeCueChannels),
    playlistDeviceId: toNative(g.playlistDeviceId, g.nativePlaylistDeviceName, g.nativePlaylistChannels),
    previewDeviceId: toNative(g.previewDeviceId, g.nativePreviewDeviceName, g.nativePreviewChannels),
  };
};
const savedGlobals = migrateGlobals(loadGlobals());

// loadPlaylist / savedPlaylist / plNextId → moguts al slice de playlist (P5)
// preloadStandbyTimer / scheduleStandbyPreload / goTimers / goChain / clearGoTimers → moguts al slice de cues (P5)
// cueCtxRegistry → mogut a src/store/slices/routing.js (P5)
// Bucle d'init de plNextId → mogut al slice de playlist (P5)

const initialSlots = Array.from({ length: NUM_SLOTS }, (_, i) => {
  const base = createEmptySlot(i + 1);
  if (savedSlots && savedSlots[i]) {
    return {
      ...base,
      label: savedSlots[i].label || '',
      filePath: savedSlots[i].filePath ?? null,
      mediaType: savedSlots[i].mediaType ?? 'audio',
      isStreaming: savedSlots[i].isStreaming ?? false,
      streamDuration: savedSlots[i].streamDuration ?? 0,
      volume: savedSlots[i].volume ?? 0.8,
      loop: savedSlots[i].loop ?? false,
      color: savedSlots[i].color ?? null,
      stopOthers: savedSlots[i].stopOthers ?? false,
      duck: savedSlots[i].duck ?? false,
      stopPlaylist: savedSlots[i].stopPlaylist ?? false,
      startPoint: savedSlots[i].startPoint ?? 0,
      stopPoint: savedSlots[i].stopPoint ?? null,
      fadeIn: savedSlots[i].fadeIn ?? null,
      fadeOut: savedSlots[i].fadeOut ?? null,
      preWait: savedSlots[i].preWait ?? 0,
      continueMode: savedSlots[i].continueMode ?? 'none',
    };
  }
  return base;
});

// Comptador de mòdul per a IDs únics de notificació (evita col·lisions de Date.now)
let _notifSeq = 0;

// Màxim de notificacions simultànies al tauler (les més antigues es descarten)
const MAX_NOTIFICATIONS = 5;

export const useSoundStore = create((set, get) => ({
  // P5: slice de persistència (persistGlobals/persistSlots/persistPlaylist).
  ...createPersistenceSlice(get),
  // P5: slice de vídeo (setVideoOutputOpen/setVideoMonitorName/setVideoIdlePattern/setSeparateVideoAudio/seekVideo/handleVideoEnded/clearVideoCues).
  ...createVideoSlice(set, get),
  // P5: slice de preview — bus PFL (setPreviewArmed/previewSlot/stopPreview/previewEnded/ensurePreviewCtx).
  ...createPreviewSlice(set, get),
  // P5: slice de routing — dispositius/busos/contextos/preload (initAudioContext/ctxForDevice/
  // ensurePlaylistCtx/detectOutputChannels/setAudioDevices/setSelectedDevice/setPlaylistDevice/
  // setPreviewDevice/setColorOutput/closeUnusedNativeDevices/
  // setAsioMasterGain/initAsioMaster/setAsioInfo/refreshAsioLoaded/toggleEnabledOutput/preload*).
  ...createRoutingSlice(set, get),
  // P5: slice de playlist — addPlaylistTracks/removePlaylistTrack/movePlaylistTrack/clearPlaylist/
  // loadPlaylistKeepPlaying/plIsAsio/plIsNative/setCrossfade/cyclePlaylistRepeat/togglePlaylistShuffle/
  // setPlaylistVolume/playlistPlayPause/playlistStop/playlistNext/playlistPrev/playlistPlayIndex/
  // setPlaylistSelected/movePlaylistSelection/playlistPlaySelected/playlistSeek.
  ...createPlaylistSlice(set, get),
  // P5: slice de cues — motor de reproducció de la botonera (setCuesStopOthers/setCuesCrossfade/
  // setCuesPlaylistAction/setDuckSettings/setPlaylistAction/setGlobalFades/setEditingSlot/
  // setDragOverSlot/applySlotConfig/preloadStandby/updateSlotEdit/loadAudio/playSlot/triggerSlot/
  // pauseSlot/resumeSlot/setSelectedSlot/setPage/moveSelection/selectStep/togglePlayPause/
  // stopAll/handleEnded/advanceStandby/go/_goStep/seekSlot/clearSlot/setSlotLoading/
  // setSlotMissing/setSlotPeaks/setColor/setLoop/stopSlot/setVolume).
  ...createCuesSlice(set, get),
  slots: initialSlots,

  // ── Notificacions efímeres (P1: contracte d'errors motor→UI) ──
  // Estat de sessió: NO es persisteix a localStorage.
  // Cada entrada: { id: number, type: 'error'|'warning'|'info', message: string, at: number }
  notifications: [],

  // Afegeix una notificació nova. Descarta les més antigues si la llista supera MAX_NOTIFICATIONS.
  pushNotification: ({ type = 'error', message }) => {
    const id = ++_notifSeq;
    set((state) => {
      const next = [...state.notifications, { id, type, message, at: Date.now() }];
      // Descarta les entrades més antigues (primeres) si superem el límit
      return { notifications: next.length > MAX_NOTIFICATIONS ? next.slice(next.length - MAX_NOTIFICATIONS) : next };
    });
  },

  // Treu una notificació pel seu id (cridat pel botó de tancar o per l'auto-descart)
  dismissNotification: (id) => {
    set((state) => ({ notifications: state.notifications.filter((n) => n.id !== id) }));
  },
  globalFadeIn: savedGlobals.globalFadeIn ?? 0,   // fades per defecte de tots els cues
  globalFadeOut: savedGlobals.globalFadeOut ?? 0,
  cuesStopOthers: savedGlobals.cuesStopOthers ?? false, // Stop Others global per a tots els cues
  cuesCrossfade: savedGlobals.cuesCrossfade ?? 0,       // crossfade (s) entre cues quan un en para d'altres (0 = tall sec)
  cuesDuck: savedGlobals.cuesDuck ?? false,             // Ducking per defecte dels cues nous
  cuesStopPlaylist: savedGlobals.cuesStopPlaylist ?? false, // Stop Playlist per defecte dels cues nous
  // ── Ducking de la Playlist (híbrid: paràmetres globals + activador per cue) ──
  duckEnabled: savedGlobals.duckEnabled ?? false,  // activa el ducking globalment
  duckAmount: savedGlobals.duckAmount ?? 0.3,       // volum al qual baixa la playlist (factor lineal 0..1; 0.3 = 30%)
  duckAttack: savedGlobals.duckAttack ?? 0.2,       // temps (s) de baixada en començar un cue de duck
  duckRelease: savedGlobals.duckRelease ?? 0.8,     // temps (s) de recuperació quan no queda cap cue de duck
  duckHold: savedGlobals.duckHold ?? 0,             // espera (s) abans de recuperar (0 = immediat)
  viewMode: 'grid',        // 'grid' (botonera 8×4) | 'list' (llista de files)
  // Mode global EDIT/LIVE (com el Show Mode de QLab). En LIVE es bloqueja tota
  // mutació d'estructura/config (editar/moure/esborrar tiles, carregar fitxers,
  // editar la playlist, seek, canvis a Settings) i es mantenen les accions de
  // control (disparar, Stop/panic, pausa, volum, preview). NO es persisteix:
  // l'app arrenca SEMPRE en 'edit' (primer muntes, després passes a Live).
  appMode: 'edit',         // 'edit' | 'live'
  editingSlot: null,       // id del slot obert a l'editor (o null)
  dragOverSlot: null,      // id del slot sota un drag&drop natiu de FITXERS (o null)
  draggingSlot: null,      // id del tile que s'està reorganitzant (pointer drag intern)
  dropTargetSlot: null,    // id del tile sota el cursor durant la reorganització
  dropEdge: null,          // null = a sobre (move/swap) | 'before' | 'after' (insert)
  selectedSlot: 1,         // slot seleccionat (cursor de teclat per al transport)
  currentPage: 0,          // pàgina de cues visible (0..NUM_PAGES-1)
  numPages: NUM_PAGES,
  activeSlot: null,
  audioDevices: [],
  // Tres busos de sortida (cada un a un dispositiu estèreo)
  selectedDeviceId: savedGlobals.cuesDeviceId ?? 'default',  // sortida dels CUES
  playlistDeviceId: savedGlobals.playlistDeviceId ?? 'default',
  previewDeviceId: savedGlobals.previewDeviceId ?? 'default',
  asioMasterGain: savedGlobals.asioMasterGain ?? 1,  // gain mestre del bus ASIO (0..1)
  // Dispositius WASAPI marcats com a "Usar" (curats a Dispositius). El Routing
  // només n'ofereix aquests; llista BUIDA = mostra'ls tots (compatibilitat).
  enabledOutputs: Array.isArray(savedGlobals.enabledOutputs) ? savedGlobals.enabledOutputs : [],
  asioInfo: {},            // driver ASIO carregat ara: { [name]: {outs, sample_rate} } (sessió)
  audioContext: null,      // context dels cues
  playlistCtx: null,       // context de la playlist
  previewCtx: null,        // context del preview
  outputChannels: 2,       // canals màxims de sortida del dispositiu de cues
  previewArmed: false,     // Ctrl premut: mode preview
  previewingSlot: null,    // slot que sona ara pel bus de preview
  previewVoiceId: PREVIEW_VOICE_ID, // id de la veu ASIO del preview actual (rotatiu)
  previewStartedAt: 0,     // instant (previewCtx) en què va començar el preview
  colorOutputs: savedGlobals.colorOutputs || {}, // { color: deviceId } routing per grup
  // P3: el motor de cada bus (WASAPI/ASIO/natiu) es codifica al seu propi target
  // (selectedDeviceId/playlistDeviceId/previewDeviceId/colorOutputs). Ja no hi ha un
  // flag global useNativeCueEngine ni camps nativeCue*/nativePlaylist*/nativePreview*
  // separats; migrateGlobals converteix les sessions antigues (vegeu a dalt).
  // Monitor predeterminat de la finestra de sortida de vídeo, identificat per NOM
  // (m.name d'availableMonitors). null = auto (primer monitor no principal).
  videoMonitorName: savedGlobals.videoMonitorName ?? null,
  // Patró de la pantalla de sortida quan no hi ha vídeo (blackout): 'black'
  // (negre total, sense text), 'bars' (barres de color) o 'testcard' (carta d'ajust).
  videoIdlePattern: savedGlobals.videoIdlePattern ?? 'black',
  // Si la finestra de sortida de vídeo estava oberta en tancar l'app: es torna a
  // obrir automàticament a la pròxima arrencada (persistència de sessió).
  videoOutputOpen: savedGlobals.videoOutputOpen ?? false,
  // 4c (opt-in): separa l'àudio del vídeo. Si el bus del cue routeja a un motor de
  // maquinari (ASIO a Windows, natiu cpal a Mac), el vídeo sona pel motor
  // (routing/fades/ducking/multicanal) i la imatge va muda a la sortida, sincronitzada
  // per resync. Default APAGAT.
  separateVideoAudio: savedGlobals.separateVideoAudio ?? false,

  // ── Playlist (VLC) ──
  playlist: Array.isArray(savedPlaylist.tracks) ? savedPlaylist.tracks : [],
  playlistIndex: -1,
  playlistSelected: 0,     // cursor de selecció a la llista (fletxes / clic)
  playlistPlaying: false,
  playlistPaused: false,
  crossfade: savedPlaylist.crossfade ?? 3,
  // Mode de repetició: 'off' | 'song' (repeteix la pista) | 'list' (repeteix la llista)
  // Retrocompatibilitat amb sessions antigues que guardaven repeat com a booleà.
  playlistRepeatMode: savedPlaylist.repeatMode ?? (savedPlaylist.repeat ? 'list' : 'off'),
  playlistShuffle: savedPlaylist.shuffle ?? false,
  playlistVolume: savedPlaylist.volume ?? 0.8,

  // initAudioContext / ctxForDevice / ensurePlaylistCtx / detectOutputChannels /
  // setAudioDevices / setSelectedDevice / setPlaylistDevice / setPreviewDevice /
  // setColorOutput / closeUnusedNativeDevices / setAsioMasterGain / initAsioMaster /
  // setAsioInfo / refreshAsioLoaded / toggleEnabledOutput / preloadAsioSlot /
  // preloadAllAsioCues / preloadNativeSlot / preloadAllNativeCues → slice de routing (P5).

  // persistGlobals / persistSlots / persistPlaylist → slice de persistència (P5).

  // setVideoOutputOpen / setVideoMonitorName / setVideoIdlePattern / setSeparateVideoAudio
  // seekVideo / handleVideoEnded / clearVideoCues → slice de vídeo (P5).

  // setCuesStopOthers / setCuesCrossfade / setCuesPlaylistAction / setDuckSettings /
  // setPlaylistAction / setGlobalFades / setEditingSlot / setDragOverSlot /
  // applySlotConfig / preloadStandby / updateSlotEdit / loadAudio / playSlot /
  // triggerSlot / pauseSlot / resumeSlot / setSelectedSlot / setPage / moveSelection /
  // selectStep / togglePlayPause / stopAll / handleEnded / advanceStandby / go /
  // _goStep / seekSlot / clearSlot / setSlotLoading / setSlotMissing / setSlotPeaks /
  // setColor / setLoop / stopSlot / setVolume → slice de cues (P5).

  // setPreviewArmed / previewSlot / stopPreview / previewEnded / ensurePreviewCtx → slice de preview (P5).

  setViewMode: (viewMode) => set({ viewMode }),
  setAppMode: (appMode) => set({ appMode: appMode === 'live' ? 'live' : 'edit' }),

  // addPlaylistTracks / removePlaylistTrack / movePlaylistTrack / clearPlaylist /
  // loadPlaylistKeepPlaying / plIsAsio / plIsNative / setCrossfade / cyclePlaylistRepeat /
  // togglePlaylistShuffle / setPlaylistVolume / playlistPlayPause / playlistStop /
  // playlistNext / playlistPrev / playlistPlayIndex / setPlaylistSelected /
  // movePlaylistSelection / playlistPlaySelected / playlistSeek → slice de playlist (P5).

  // ── Exportació / importació de sessió completa (P2 — Show file) ─────────────

  // Retorna un objecte JS serialitzable amb tota la sessió (cues + globals + playlist).
  // Utilitza els mateixos camps que persistGlobals, persistPlaylist i saveSet per no divergir.
  exportSessionData: () => {
    const state = get();

    // Camps de cada slot (mirall exacte de saveSet de useLibrary)
    const slots = state.slots
      .map((s) => ({
        id: s.id,
        filePath: s.filePath,
        label: s.label,
        mediaType: s.mediaType,
        volume: s.volume,
        startPoint: s.startPoint,
        stopPoint: s.stopPoint,
        fadeIn: s.fadeIn,
        fadeOut: s.fadeOut,
        loop: s.loop,
        color: s.color,
        stopOthers: s.stopOthers,
        duck: s.duck,
        stopPlaylist: s.stopPlaylist,
        preWait: s.preWait,
        continueMode: s.continueMode,
      }))
      .filter((s) => s.filePath || s.label); // només slots ocupats

    // Globals (mirall exacte de persistGlobals)
    const globals = {
      globalFadeIn: state.globalFadeIn,
      globalFadeOut: state.globalFadeOut,
      cuesStopOthers: state.cuesStopOthers,
      cuesCrossfade: state.cuesCrossfade,
      cuesDuck: state.cuesDuck,
      cuesStopPlaylist: state.cuesStopPlaylist,
      cuesDeviceId: state.selectedDeviceId,
      playlistDeviceId: state.playlistDeviceId,
      previewDeviceId: state.previewDeviceId,
      colorOutputs: state.colorOutputs,
      duckEnabled: state.duckEnabled,
      duckAmount: state.duckAmount,
      duckAttack: state.duckAttack,
      duckRelease: state.duckRelease,
      duckHold: state.duckHold,
      asioMasterGain: state.asioMasterGain,
      enabledOutputs: state.enabledOutputs,
      videoMonitorName: state.videoMonitorName,
      videoIdlePattern: state.videoIdlePattern,
      videoOutputOpen: state.videoOutputOpen,
      separateVideoAudio: state.separateVideoAudio,
    };

    // Playlist (mirall exacte de persistPlaylist)
    const playlist = {
      tracks: state.playlist,
      crossfade: state.crossfade,
      repeatMode: state.playlistRepeatMode,
      shuffle: state.playlistShuffle,
      volume: state.playlistVolume,
    };

    return {
      app: 'ezyPlayer',
      kind: 'show',
      version: 1,
      savedAt: Date.now(),
      slots,
      globals,
      playlist,
    };
  },

  // Aplica els camps de globals rebuts (importació). Usa defaults segurs per als
  // camps que no existeixin al fitxer (compatibilitat amb versions anteriors).
  importSessionGlobals: (globals) => {
    if (!globals || typeof globals !== 'object') return;
    // Migra el routing d'un motor natiu global (format antic) a targets "native:…"
    // per bus, igual que a l'arrencada (vegeu migrateGlobals).
    const g = migrateGlobals(globals);
    // Apliquem només els camps coneguts; cap camp desconegut no entra a l'estat
    set({
      globalFadeIn: g.globalFadeIn ?? 0,
      globalFadeOut: g.globalFadeOut ?? 0,
      cuesStopOthers: g.cuesStopOthers ?? false,
      cuesCrossfade: g.cuesCrossfade ?? 0,
      cuesDuck: g.cuesDuck ?? false,
      cuesStopPlaylist: g.cuesStopPlaylist ?? false,
      selectedDeviceId: g.cuesDeviceId ?? '',
      playlistDeviceId: g.playlistDeviceId ?? '',
      previewDeviceId: g.previewDeviceId ?? '',
      colorOutputs: globals.colorOutputs ?? {},
      duckEnabled: globals.duckEnabled ?? false,
      duckAmount: globals.duckAmount ?? 0.3,
      duckAttack: globals.duckAttack ?? 0.3,
      duckRelease: globals.duckRelease ?? 1.0,
      duckHold: globals.duckHold ?? 0.5,
      asioMasterGain: globals.asioMasterGain ?? 1.0,
      enabledOutputs: Array.isArray(globals.enabledOutputs) ? globals.enabledOutputs : [],
      videoMonitorName: globals.videoMonitorName ?? null,
      videoIdlePattern: globals.videoIdlePattern ?? 'black',
      // videoOutputOpen s'ignora deliberadament: no volem obrir la sortida de vídeo
      // automàticament en importar (pot sorprendre a l'operador en ple show).
      separateVideoAudio: globals.separateVideoAudio ?? false,
    });
    get().persistGlobals();
  },

  // Substitueix la playlist completa amb les pistes del fitxer importat.
  // Atura l'engine de playlist primer (evita sons orfes). Cada pista nova
  // rep un id fresc (igual que addPlaylistTracks).
  importSessionPlaylist: (playlist) => {
    if (!playlist || typeof playlist !== 'object') return;
    // Atura qualsevol reproducció de playlist en curs
    get().playlistStop();
    const tracks = Array.isArray(playlist.tracks) ? playlist.tracks : [];
    // Mapa a { id: nou, filePath, label } com fa addPlaylistTracks
    const mapped = tracks.map((t) => ({
      id: consumePlNextId(),
      filePath: t.filePath ?? null,
      label: t.label ?? '',
    }));
    set({
      playlist: mapped,
      playlistIndex: -1,
      playlistSelected: 0,
      crossfade: playlist.crossfade ?? 3,
      playlistRepeatMode: playlist.repeatMode ?? 'off',
      playlistShuffle: playlist.shuffle ?? false,
      playlistVolume: playlist.volume ?? 0.8,
    });
    get().persistPlaylist();
  },
}));
