// Slice de CUES — motor de reproducció de la botonera (P5 — divisió del store en slices).
//
// Concentra totes les accions que gestionen els slots/cues de la graella:
// carrega d'àudio, play/stop/pause/resume, transport GO, seek, volum, color,
// loop, preload predictiu del standby i neteig de slots.
//
// S'incorpora al store amb `...createCuesSlice(set, get)`.
//
// Variables de mòdul (aquí perquè NOMÉS les usen accions d'aquest slice):
//   - goTimers / goChain / clearGoTimers: temporitzadors de la seqüència GO.
//   - preloadStandbyTimer / scheduleStandbyPreload: debounce del preload predictiu.
//
// Símbols compartits (exportats perquè useSoundStore.js en necessita a l'estat inicial):
//   - SLOTS_PER_PAGE / NUM_PAGES / NUM_SLOTS: dimensions de la graella.
//   - createEmptySlot: plantilla d'un slot buit (usada a clearSlot i a initialSlots).

import { invoke } from '@tauri-apps/api/core';
import { hasClip, isVideo, isImage, isPdf, isVisual, effFadeIn, effFadeOut, slotDuration } from '../../lib/slotAudio';
import { dispatchCue } from '../../lib/cueDispatch';
import { isAsioTarget, resolveCueTargetStr, parseTarget, isHardwareEngineTarget } from '../../lib/outputTarget';
import { clearAsioTelemetry, asioPosition } from '../../lib/asioTelemetry';
import {
  emitVideoPlay, emitVideoStop, emitVideoBlack, emitVideoVolume,
  emitSlideGoto, startVideoResync, stopVideoResync,
  emitVideoPause, emitVideoResume,
} from '../../lib/videoOutput';
import {
  csPlay, csStop, csPause, csResume, csSeek, csSetVolume,
} from '../../lib/cueStreamEngine';
import {
  duckAdd, duckRemove, duckReset, duckRefresh,
} from '../../lib/playlistEngine';

// ── Constants de la graella (exportades perquè useSoundStore.js les usa a l'estat inicial) ──

export const SLOTS_PER_PAGE = 32;   // 8 columnes × 4 files
export const NUM_PAGES = 4;         // pàgines de cues (4 × 32 = 128 cues)
export const NUM_SLOTS = SLOTS_PER_PAGE * NUM_PAGES;

// ── Plantilla d'un slot buit (exportada perquè useSoundStore.js la usa a initialSlots) ──

export const createEmptySlot = (id) => ({
  id,
  label: '',
  filePath: null,      // ruta absoluta del fitxer (per recarregar des de la Library)
  mediaType: 'audio',  // 'audio' | 'video' | 'image' | 'pdf' (els visuals van a la finestra de sortida)
  currentPage: 1,      // (només PDF) pàgina projectada ara mateix
  pageCount: 0,        // (només PDF) nombre total de pàgines (l'informa la sortida en carregar)
  loading: false,      // s'està llegint/descodificant
  audioUrl: null,
  audioBuffer: null,
  isStreaming: false,  // cue llarg (>60s): es reprodueix amb <audio> en streaming
  streamDuration: 0,   // durada (s) del fitxer en streaming (des de les metadades)
  peaks: null,         // pics min/max de la forma d'ona (streaming; generats en segon pla)
  peaksDone: false,    // la generació de la forma d'ona ha acabat (èxit o fracàs) → atura l'spinner
  gainNode: null,
  fadeGainNode: null,  // node de guany dedicat als fades (independent del volum)
  analyserNode: null,
  sourceNode: null,
  isPlaying: false,
  asioActive: false,   // sona pel motor ASIO natiu (playhead/VU venen per telemetria)
  nativeActive: false, // sona pel motor natiu cpal (WASAPI/CoreAudio; playhead/VU per telemetria nativa)
  arming: false,       // P4-lite: veu de maquinari (asio/natiu) disparada però encara no confirmada per telemetria

  volume: 0.8,
  startedAt: 0,        // instant (audioContext.currentTime) en què va començar a sonar
  pausedAt: null,      // posició (s dins el segment) on s'ha pausat (null = no pausat)
  loop: false,         // opció de reproducció: repeteix el mateix slot
  color: null,         // color del cue (organització + futur routing per grup)
  stopOthers: false,   // en disparar, atura la resta de cues (QLab)
  duck: false,         // en sonar, abaixa el volum de la Playlist (ducking)
  stopPlaylist: false, // en disparar, atura del tot la Playlist (alternatiu al duck)
  // Edició del slot (segons l'editor) — tot en segons
  startPoint: 0,       // punt d'inici dins el buffer
  stopPoint: null,     // punt de stop (null = final del buffer)
  fadeIn: null,        // fade in propi (null = usa el global; 0 = tall sec explícit)
  fadeOut: null,       // fade out propi (null = usa el global; 0 = tall sec explícit)
  // Seqüència estil QLab (mode GO)
  preWait: 0,          // retard (s) entre prémer GO i que el cue soni
  continueMode: 'none',// 'none' | 'auto' (auto-continue: dispara el següent tot seguit)
  // Estat de sessió: fitxer persistit però no localitzat en arrencar.
  // NO es desa a localStorage (es recalcula a cada boot).
  missing: false,
  // Estat de sessió: la reproducció ha fallat en disparar-se (voice-failed). Missatge
  // d'error o null. Persistent al tile fins a un nou dispar amb èxit o recàrrega.
  error: null,
});

// Camps de CONTINGUT d'un slot (els que es mouen en reorganitzar tiles). Tota la
// resta —id, nodes Web Audio, flags de reproducció— és estat viu i es reinicia a
// partir d'un createEmptySlot(id). L'usen reorderSlots i insertSlotContent.
const slotContent = (s) => ({
  label: s.label, filePath: s.filePath, mediaType: s.mediaType, audioUrl: s.audioUrl,
  audioBuffer: s.audioBuffer, isStreaming: s.isStreaming, streamDuration: s.streamDuration,
  peaks: s.peaks, volume: s.volume, loop: s.loop, color: s.color,
  stopOthers: s.stopOthers, duck: s.duck, stopPlaylist: s.stopPlaylist,
  startPoint: s.startPoint, stopPoint: s.stopPoint, fadeIn: s.fadeIn, fadeOut: s.fadeOut,
  preWait: s.preWait, continueMode: s.continueMode, missing: s.missing,
});

// ── Variables de mòdul (temporitzadors de la seqüència GO i del preload predictiu) ──

// P7: debounce del preload predictiu del standby (evita disparar decodes en cada
// pas de fletxa quan es navega ràpid pel grid). Programa una escalfada del standby
// ~250 ms després de l'últim moviment de selecció.
let preloadStandbyTimer = null;
const scheduleStandbyPreload = (get) => {
  if (preloadStandbyTimer) clearTimeout(preloadStandbyTimer);
  preloadStandbyTimer = setTimeout(() => { preloadStandbyTimer = null; get().preloadStandby(); }, 250);
};

// Timers pendents de la seqüència GO (pre-wait i encadenament auto-continue).
// A nivell de mòdul perquè els puguem cancel·lar des de stopAll o d'un GO nou.
const goTimers = new Set();

// Cues que formen part de la cadena auto-continue en curs: dins una cadena no
// es tallen entre ells (Stop Others només actua sobre cues de FORA la cadena).
// Només l'usa el camí de GO; els disparos manuals (teclat/clic) no el passen.
const goChain = new Set();

const clearGoTimers = () => {
  for (const t of goTimers) clearTimeout(t);
  goTimers.clear();
  goChain.clear();
};

// ── Factory del slice ─────────────────────────────────────────────────────────

export function createCuesSlice(set, get) {
  return {
    // Stop Others global: en disparar qualsevol cue, atura la resta
    setCuesStopOthers: (on) => { set({ cuesStopOthers: !!on }); get().persistGlobals(); },
    setCuesCrossfade: (sec) => { set({ cuesCrossfade: Math.max(0, sec) }); get().persistGlobals(); },
    // Acció per defecte dels cues nous sobre la Playlist: 'none' | 'duck' | 'stop'
    // (duck i stop són mútuament excloents)
    setCuesPlaylistAction: (action) => {
      set({ cuesDuck: action === 'duck', cuesStopPlaylist: action === 'stop' });
      get().persistGlobals();
    },

    // Paràmetres globals del ducking. Reaplica el factor de duck al motor de la
    // playlist (p. ex. canviar duckAmount mentre està duckejat, o desactivar-lo).
    setDuckSettings: (patch) => {
      set(patch);
      get().persistGlobals();
      duckRefresh(get);
    },

    // Acció d'un cue sobre la Playlist: 'none' | 'duck' | 'stop'. Duck (abaixa) i
    // stop (atura del tot) són mútuament excloents. Si el cue ja sona, ajusta el
    // comptador de ducking en calent i, si passa a 'stop', atura la playlist ara.
    setPlaylistAction: (slotId, action) => {
      const slot = get().slots.find((s) => s.id === slotId);
      const wasPlaying = slot && (slot.isPlaying || slot.pausedAt != null);
      const wasDuck = !!(slot && slot.duck);
      const duck = action === 'duck';
      const stopPlaylist = action === 'stop';
      set((state) => ({
        slots: state.slots.map((s) => (s.id === slotId ? { ...s, duck, stopPlaylist } : s)),
      }));
      if (wasPlaying) {
        if (duck && !wasDuck) duckAdd(get, slotId);
        else if (!duck && wasDuck) duckRemove(get, slotId);
        if (stopPlaylist) get().playlistStop();
      }
      get().persistSlots();
    },

    setGlobalFades: (patch) => {
      set(patch);
      get().persistGlobals();
    },

    setEditingSlot: (slotId) => set({ editingSlot: slotId }),

    setDragOverSlot: (slotId) => set({ dragOverSlot: slotId }),

    // ── Reorganització de tiles (pointer drag intern) ──────────────────────────
    // Estat de la reorg: quin tile s'arrossega i sobre quin està el cursor. El
    // pinten SoundButton (outline blanc origen/destí). Vegeu reorderSlots.
    beginTileDrag: (slotId) => set({ draggingSlot: slotId, dropTargetSlot: null, dropEdge: null }),
    setTileDropTarget: (slotId, edge = null) => set({ dropTargetSlot: slotId, dropEdge: edge }),
    endTileDrag: () => set({ draggingSlot: null, dropTargetSlot: null, dropEdge: null }),

    // Reorganitza el CONTINGUT de dos tiles (els ids són fixos, lligats al teclat):
    //   - destí BUIT  → MOVE  (el contingut passa al destí i l'origen queda buit)
    //   - destí PLE   → SWAP  (s'intercanvien els continguts)
    // Es mou només el contingut persistent + dades (buffer/peaks), NO els nodes vius
    // ni l'estat de reproducció (es reconstrueixen a partir d'un slot buit). Qualsevol
    // reproducció/preview dels slots implicats s'atura abans (la veu va lligada a l'id).
    reorderSlots: (fromId, toId) => {
      if (fromId === toId) return;
      const from0 = get().slots.find((s) => s.id === fromId);
      const to0 = get().slots.find((s) => s.id === toId);
      if (!from0 || !to0) return;

      // Atura reproducció/preview dels dos slots (evita veus orfes lligades a l'id vell)
      [fromId, toId].forEach((id) => {
        const s = get().slots.find((x) => x.id === id);
        if (s && (s.isPlaying || s.pausedAt != null || s.nativeActive || s.asioActive)) get().stopSlot(id);
        if (get().previewingSlot === id) get().stopPreview();
      });

      const from = get().slots.find((s) => s.id === fromId);
      const to = get().slots.find((s) => s.id === toId);
      const fromC = slotContent(from);
      const toOccupied = !!(to.filePath || to.label);
      const build = (id, c) => ({ ...createEmptySlot(id), ...c });

      set((state) => ({
        slots: state.slots.map((s) => {
          if (s.id === toId) return build(toId, fromC);                     // destí ← origen
          if (s.id === fromId) return build(fromId, toOccupied ? slotContent(to) : {}); // swap o buit
          return s;
        }),
        draggingSlot: null,
        dropTargetSlot: null,
        dropEdge: null,
        // Si el slot seleccionat era un dels dos, mantén la selecció sobre el destí
        selectedSlot: state.selectedSlot === fromId ? toId : state.selectedSlot,
      }));
      get().persistSlots();
      // Re-preload (ASIO/natiu) dels dos slots perquè el GO segueixi instantani
      [fromId, toId].forEach((id) => { get().preloadAsioSlot(id); get().preloadNativeSlot(id); });
    },

    // INSERT-entre-dos: mou el contingut de fromId a la posició immediatament ABANS
    // (before=true) o DESPRÉS (before=false) de toId, desplaçant en cascada la resta
    // de la MATEIXA pàgina (l'ordre és fila-major, ids fixos). Com que canvia l'id de
    // molts continguts, atura TOTES les reproduccions/preview de la pàgina abans.
    insertSlotContent: (fromId, toId, before) => {
      if (fromId === toId) return;
      const SLOTS = SLOTS_PER_PAGE;
      const base = Math.floor((fromId - 1) / SLOTS) * SLOTS; // primer id (0-based) de la pàgina
      // fromId i toId han de ser de la mateixa pàgina (tots dos visibles)
      if (Math.floor((toId - 1) / SLOTS) * SLOTS !== base) return;
      const ids = Array.from({ length: SLOTS }, (_, i) => base + i + 1);

      // Atura reproducció/preview de tota la pàgina (molts continguts canvien d'id)
      ids.forEach((id) => {
        const s = get().slots.find((x) => x.id === id);
        if (s && (s.isPlaying || s.pausedAt != null || s.nativeActive || s.asioActive)) get().stopSlot(id);
        if (get().previewingSlot === id) get().stopPreview();
      });

      // Seqüència de continguts de la pàgina, treu l'origen i insereix a la posició destí
      const conts = ids.map((id) => slotContent(get().slots.find((s) => s.id === id)));
      const fromIdx = fromId - base - 1;
      const [moved] = conts.splice(fromIdx, 1);
      let insertIdx = (toId - base - 1) + (before ? 0 : 1);
      if (fromIdx < insertIdx) insertIdx -= 1; // treure l'origen desplaça el destí a l'esquerra
      insertIdx = Math.max(0, Math.min(conts.length, insertIdx));
      conts.splice(insertIdx, 0, moved);

      const newSelId = base + insertIdx + 1; // on ha anat a parar el contingut mogut
      set((state) => ({
        slots: state.slots.map((s) => {
          const idx = s.id - base - 1;
          if (idx < 0 || idx >= SLOTS) return s; // altra pàgina: intacte
          return { ...createEmptySlot(s.id), ...conts[idx] };
        }),
        draggingSlot: null,
        dropTargetSlot: null,
        dropEdge: null,
        selectedSlot: state.selectedSlot === fromId ? newSelId : state.selectedSlot,
      }));
      get().persistSlots();
      // Re-preload de tota la pàgina (els ids del contingut han canviat)
      ids.forEach((id) => { get().preloadAsioSlot(id); get().preloadNativeSlot(id); });
    },

    // Aplica una configuració desada a un slot (després de recarregar l'àudio)
    applySlotConfig: (slotId, cfg) => {
      const slot = get().slots.find((s) => s.id === slotId);
      if (slot && slot.gainNode && cfg.volume != null) {
        slot.gainNode.gain.value = cfg.volume;
      }
      set((state) => ({
        slots: state.slots.map((s) =>
          s.id === slotId
            ? {
                ...s,
                label: cfg.label != null ? cfg.label : s.label,
                filePath: cfg.filePath != null ? cfg.filePath : s.filePath,
                mediaType: (cfg.mediaType === 'video' || cfg.mediaType === 'image' || cfg.mediaType === 'pdf') ? cfg.mediaType : s.mediaType,
                volume: cfg.volume != null ? cfg.volume : s.volume,
                startPoint: cfg.startPoint || 0,
                stopPoint: cfg.stopPoint != null ? cfg.stopPoint : null,
                fadeIn: cfg.fadeIn ?? null,
                fadeOut: cfg.fadeOut ?? null,
                loop: !!cfg.loop,
                color: cfg.color != null ? cfg.color : null,
                stopOthers: !!cfg.stopOthers,
                duck: !!cfg.duck,
                stopPlaylist: !!cfg.stopPlaylist,
                preWait: cfg.preWait || 0,
                continueMode: cfg.continueMode === 'auto' ? 'auto' : 'none',
              }
            : s
        ),
      }));
      get().persistSlots();
      // El fitxer o el color (→ routing) poden haver canviat: re-preload si és ASIO.
      get().preloadAsioSlot(slotId);
      // I, si el motor natiu està actiu i el cue routeja a WASAPI, pre-decode natiu.
      get().preloadNativeSlot(slotId);
    },

    // P7 — Preload predictiu del standby. Manté descodificats a la cau del motor el
    // cue en standby (el que dispararà el proper GO) i els dos cues carregats
    // següents, perquè el GO no pateixi la latència de descodificar encara que un
    // show gran hagi desallotjat entrades per LRU. Idempotent i barat: si el PCM ja
    // és a la cau, el motor no torna a descodificar (només toca l'LRU). Cobreix els
    // dos motors natius (ASIO i cpal); preloadAsioSlot/preloadNativeSlot ja filtren
    // per routing, streaming i tipus de mèdia, així que és segur cridar-los tots dos.
    preloadStandby: () => {
      const { slots, selectedSlot } = get();
      const ids = [];
      for (let id = selectedSlot || 1; id <= slots.length && ids.length < 3; id++) {
        const s = slots.find((x) => x.id === id);
        if (s && hasClip(s) && s.filePath) ids.push(id);
      }
      for (const sid of ids) {
        get().preloadAsioSlot(sid);
        get().preloadNativeSlot(sid);
      }
    },

    // Actualitza els camps d'edició d'un slot (startPoint, stopPoint, fadeIn, fadeOut)
    updateSlotEdit: (slotId, patch) =>
      set((state) => ({
        slots: state.slots.map((s) =>
          s.id === slotId ? { ...s, ...patch } : s
        ),
      })),

    loadAudio: (slotId, file, audioBuffer, audioUrl, filePath = null, opts = {}) => {
      // Els nodes (gain/fade/analyser) es construeixen al Play, al context del
      // dispositiu segons el color del cue (routing per grup).
      const streaming = !!opts.streaming;
      const mediaType = (opts.mediaType === 'video' || opts.mediaType === 'image' || opts.mediaType === 'pdf') ? opts.mediaType : 'audio';
      // Allibera el blob URL anterior d'aquest slot (si n'hi havia)
      const prev = get().slots.find((s) => s.id === slotId);
      // Si el slot previ sonava (o estava pausat), atura'l abans de reescriure'l:
      // evita reproducció òrfena i que el seu id quedi penjat al comptador de duck.
      if (prev && (prev.isPlaying || prev.pausedAt != null)) get().stopSlot(slotId);
      if (prev && prev.duck) duckRemove(get, slotId);
      if (prev && prev.audioUrl && prev.audioUrl !== audioUrl) {
        try { URL.revokeObjectURL(prev.audioUrl); } catch { /* res */ }
      }
      set((state) => ({
        slots: state.slots.map((s) =>
          s.id === slotId
            ? {
                ...s,
                label: file.name,
                filePath,
                mediaType,
                loading: false,
                audioUrl,
                audioBuffer,
                isStreaming: streaming,
                // Durada de les metadades: per streaming d'àudio i també per als
                // cues de vídeo (perquè slotDuration() i l'editor tinguin timeline).
                streamDuration: (streaming || mediaType === 'video') ? (opts.duration || 0) : 0,
                peaks: null,
                peaksDone: false, // la generació de forma d'ona d'aquest fitxer encara no ha acabat
                // Slides (PDF): un fitxer nou reinicia la pàgina projectada i el
                // recompte (la sortida el reportarà en carregar el document).
                currentPage: 1,
                pageCount: 0,
                gainNode: null,
                fadeGainNode: null,
                analyserNode: null,
                sourceNode: null,
                isPlaying: false,
                // Cue nou: Stop Others i acció de Playlist prenen el valor per defecte global (Settings)
                stopOthers: get().cuesStopOthers,
                duck: get().cuesDuck,
                stopPlaylist: get().cuesStopPlaylist,
                // Un fitxer nou reinicia els punts d'edició
                startPoint: 0,
                stopPoint: null,
                fadeIn: null,
                fadeOut: null,
                // ...i les opcions de seqüència
                preWait: 0,
                continueMode: 'none',
                // Fitxer carregat correctament: ja no és "missing" ni en error
                missing: false,
                error: null,
              }
            : s
        ),
      }));

      get().persistSlots();
      // Si aquest cue routeja a ASIO, pre-descodifica'l ja per a un GO instantani.
      get().preloadAsioSlot(slotId);
      // I si el motor natiu està actiu i routeja a WASAPI, pre-decode natiu equivalent.
      get().preloadNativeSlot(slotId);
    },

    playSlot: (slotId, opts = {}) => {
      const { slots, globalFadeIn, globalFadeOut, colorOutputs } = get();
      const slot = slots.find((s) => s.id === slotId);
      if (!slot || !hasClip(slot)) return;

      // Nou dispar: neteja optimista de l'estat d'error (si torna a fallar, el
      // handler de voice-failed el tornarà a marcar).
      if (slot.error) {
        set((state) => ({ slots: state.slots.map((s) => (s.id === slotId ? { ...s, error: null } : s)) }));
      }

      // Si ja sona, el togglam (atura amb fade out)
      if (slot.isPlaying) {
        get().stopSlot(slotId, true);
        return;
      }

      // "Stop others" del cue: atura la resta de cues que sonin, excepte els que
      // formen part de la mateixa cadena auto-continue (opts.exemptIds). Amb crossfade
      // entre cues (cuesCrossfade>0), els sortints s'esvaeixen en aquest temps i el
      // nou entra amb el mateix fade-in (xfadeIn) → encavalcament suau.
      const cuesCrossfade = Math.max(0, get().cuesCrossfade || 0);
      let xfadeIn = 0;
      if (slot.stopOthers) {
        const exempt = opts.exemptIds;
        slots.forEach((s) => {
          if (s.id === slotId || (exempt && exempt.has(s.id))) return;
          if (s.isPlaying || s.pausedAt != null) {
            get().stopSlot(s.id, cuesCrossfade > 0 ? cuesCrossfade : false);
            if (cuesCrossfade > 0) xfadeIn = cuesCrossfade;
          }
        });
      }
      // Fade-in efectiu del cue entrant (el propi o el global), amb terra al crossfade.
      const xFadeIn = (slot) => Math.max(effFadeIn(slot, globalFadeIn), xfadeIn);

      // Cue visual (vídeo o imatge): es reprodueix a la finestra de sortida (no
      // per Web Audio). Emet l'event video-play amb un payload ric (volum, fades
      // efectius, routing per color, loop i mediaType); la finestra de sortida
      // aplica volum/fades/sortida sobre l'element <video> o <img>. Si la finestra
      // no està oberta, no passa res. Marquem isPlaying perquè el tile/transport
      // ho reflecteixin. Les imatges no tenen so ni timeline (es mantenen fins a stop).
      if (isVisual(slot)) {
        // Un sol cue visual alhora a la sortida: atura qualsevol altre visual que
        // s'estigui projectant (vídeo/imatge/slides). Silent = neteja el seu estat i
        // efectes (ducking, àudio separat) sense emetre negre; el video-play de sota
        // ja reemplaça la imatge, evitant el flaix.
        slots.forEach((s) => {
          if (s.id !== slotId && s.isPlaying && isVisual(s)) get().stopSlot(s.id, false, { silent: true });
        });
        // Routing per color (com el camí d'àudio); per defecte, bus de Cues.
        // Els cues de VÍDEO surten per la finestra de sortida amb <video>.setSinkId,
        // que només entén deviceIds WASAPI. Si el color apunta a un target ASIO,
        // no és servible per vídeo → caiem al bus de Cues WASAPI per defecte.
        // La imatge del vídeo surt per <video>.setSinkId, que només entén deviceIds
        // WASAPI: si el target (color o bus de Cues) és d'un motor de maquinari
        // (ASIO o natiu), no és servible per a la imatge → caiem a un WASAPI vàlid.
        const colorOut = slot.color ? colorOutputs[slot.color] : null;
        const cueTarget = parseTarget(resolveCueTargetStr(get(), slot));
        const outDev = (colorOut && !isHardwareEngineTarget(colorOut)) ? colorOut
          : (!isHardwareEngineTarget(get().selectedDeviceId) ? get().selectedDeviceId : 'default');
        // Fades efectius: el propi del cue si és >0, si no el global; el fade-in
        // respecta la terra del crossfade entre cues (igual que els camins d'àudio).
        const effIn = Math.max(0, xFadeIn(slot));
        const effOut = Math.max(0, effFadeOut(slot, globalFadeOut));
        // 4c (opt-in): separar l'àudio del vídeo. Si el bus del cue routeja a un motor
        // de MAQUINARI (ASIO a Windows, natiu cpal a Mac) i és un cue de VÍDEO (no
        // imatge), l'àudio surt pel motor (routing/fades/ducking/multicanal) i la
        // imatge va silenciada a la sortida, sincronitzada per resync.
        const sepKind = (cueTarget.kind === 'asio' || cueTarget.kind === 'native') ? cueTarget.kind : null;
        const separated = get().separateVideoAudio && !!sepKind && isVideo(slot);
        emitVideoPlay(slot.filePath, slot.startPoint || 0, slot.stopPoint || 0, slotId, {
          volume: slot.volume,
          fadeIn: effIn,
          fadeOut: effOut,
          deviceId: outDev,
          loop: !!slot.loop,
          mediaType: slot.mediaType,
          muted: separated,
          // Slides: sempre s'arrenca per la pàgina 1 (un cue és un punt fix).
          page: 1,
        });
        if (separated) {
          const total = slotDuration(slot);
          const startPoint = Math.max(0, Math.min(slot.startPoint || 0, total || Infinity));
          const stopPoint = slot.stopPoint != null ? slot.stopPoint : 0;
          const segDur = Math.max(0.02, (stopPoint > 0 ? stopPoint : total) - startPoint);
          const sepFadeIn = Math.max(0, Math.min(effIn, segDur));
          const sepFadeOut = Math.max(0, Math.min(effOut, segDur));
          if (sepKind === 'asio') {
            // Windows: l'àudio del vídeo surt pel motor ASIO (multicanal) cap als
            // canals del target; la imatge va muda a la sortida, sincronitzada per resync.
            invoke('asio_play_voice', {
              voiceId: slot.id,
              driver: cueTarget.driver,
              filePath: slot.filePath,
              gain: slot.volume ?? 0.8,
              fadeIn: sepFadeIn,
              fadeOut: sepFadeOut,
              channels: cueTarget.channels || [],
              loopOn: !!slot.loop,
              startPoint,
              stopPoint,
              streaming: !!slot.isStreaming,
            }).catch((e) => console.warn('[asio] video-audio:', e));
          } else {
            invoke('native_play_cue', {
              voiceId: slot.id,
              deviceName: cueTarget.device || '',
              filePath: slot.filePath,
              gain: slot.volume ?? 0.8,
              fadeIn: sepFadeIn,
              fadeOut: sepFadeOut,
              channels: cueTarget.channels || [],
              loopOn: !!slot.loop,
              startPoint,
              stopPoint,
              streaming: !!slot.isStreaming,
            }).catch((e) => console.warn('[native] video-audio:', e));
          }
          startVideoResync(slotId, startPoint);
        }
        // Ducking: si aquest cue de vídeo abaixa la playlist, incrementa el comptador
        if (slot.duck) duckAdd(get, slotId);
        // Stop Playlist: si aquest cue atura del tot la playlist, atura-la ara
        if (slot.stopPlaylist) get().playlistStop();
        set((state) => ({
          slots: state.slots.map((s) =>
            // startedAt en rellotge de paret (s) per estimar el playhead/temps al tile
            s.id === slotId ? { ...s, isPlaying: true, pausedAt: null, startedAt: performance.now() / 1000, videoSeparated: separated ? sepKind : false, currentPage: 1 } : s
          ),
          activeSlot: slotId,
        }));
        return;
      }

      // Ducking: si aquest cue abaixa la playlist, incrementa el comptador.
      // (Vàlid tant per a cues en buffer com en streaming; el decrement es fa a
      // stopSlot / handleEnded / final natural de l'streaming.)
      if (slot.duck) duckAdd(get, slotId);
      // Stop Playlist: si aquest cue atura del tot la playlist, atura-la ara
      if (slot.stopPlaylist) get().playlistStop();

      // ── DISPATCH de routing: WASAPI (Web Audio) · ASIO · natiu cpal ──────────
      // Segons el target del bus del cue (resolveCueTargetStr). Regla anti-duplicació:
      // ASIO i natiu tenen render propi i NO passen també per Web Audio (sonaria dos
      // cops al mateix dispositiu físic). L'ordre és: ASIO → natiu → Web Audio.
      const decision = dispatchCue(get(), slot, { kind: 'play' });
      if (decision.route === 'asio') {
        // Render natiu: descodifica i mescla el cue pel motor ASIO (fil
        // `asio-engine`), cap als canals del target. NO toca Web Audio (regla
        // anti-duplicació). Fades/volum/segment/loop efectius del store.
        const total = slotDuration(slot);
        const startPoint = Math.max(0, Math.min(slot.startPoint || 0, total || Infinity));
        const stopPoint = slot.stopPoint != null ? slot.stopPoint : 0; // 0 = fins al final
        const segDur = Math.max(0.02, (stopPoint > 0 ? stopPoint : total) - startPoint);
        const effIn = Math.max(0, Math.min(xFadeIn(slot), segDur));
        const effOut = Math.max(0, Math.min(effFadeOut(slot, globalFadeOut), segDur));
        invoke('asio_play_voice', {
          voiceId: slot.id,
          driver: decision.target.driver,
          filePath: slot.filePath,
          channels: decision.target.channels,
          gain: slot.volume ?? 0.8,
          fadeIn: effIn,
          fadeOut: effOut,
          loopOn: !!slot.loop,
          startPoint,
          stopPoint,
          // Cue llarg (>60s): render natiu en streaming (decode-ahead), no a RAM sencer
          streaming: !!slot.isStreaming,
        }).catch((e) => console.warn('[asio] play_voice:', e));
        set((state) => ({
          slots: state.slots.map((s) =>
            s.id === slotId
              ? { ...s, isPlaying: true, asioActive: true, arming: true, pausedAt: null, startedAt: performance.now() / 1000 }
              : s
          ),
          activeSlot: slotId,
        }));
        return;
      }

      // ── Motor natiu cpal (WASAPI/CoreAudio) ─────────────────────────────────
      // Si l'interruptor està actiu i el cue és WASAPI (decision.route === 'wasapi')
      // amb fitxer a disc i NO és visual, enruta'l pel motor natiu cpal en lloc de
      // Web Audio. Marca nativeActive i NO segueix el camí Web Audio (anti-duplicació).
      if (decision.route === 'native' && slot.filePath && !isVisual(slot)) {
        const total = slotDuration(slot);
        const startPoint = Math.max(0, Math.min(slot.startPoint || 0, total || Infinity));
        const stopPoint = slot.stopPoint != null ? slot.stopPoint : 0; // 0 = fins al final
        const segDur = Math.max(0.02, (stopPoint > 0 ? stopPoint : total) - startPoint);
        const effIn = Math.max(0, Math.min(xFadeIn(slot), segDur));
        const effOut = Math.max(0, Math.min(effFadeOut(slot, globalFadeOut), segDur));
        invoke('native_play_cue', {
          voiceId: slot.id,
          deviceName: decision.target.device || '',
          filePath: slot.filePath,
          gain: slot.volume ?? 0.8,
          fadeIn: effIn,
          fadeOut: effOut,
          channels: decision.target.channels || [],
          loopOn: !!slot.loop,
          startPoint,
          stopPoint,
          // Cue llarg (>60s): render natiu en streaming (decode-ahead), no a RAM sencer.
          // Així el GO sona quasi a l'instant (sense esperar el decode complet).
          streaming: !!slot.isStreaming,
        }).catch((e) => console.warn('[native] play_cue:', e));
        set((state) => ({
          slots: state.slots.map((s) =>
            s.id === slotId
              ? { ...s, isPlaying: true, nativeActive: true, arming: true, pausedAt: null, startedAt: performance.now() / 1000 }
              : s
          ),
          activeSlot: slotId,
        }));
        return;
      }

      // Cue llarg en streaming: reproducció amb element <audio>
      if (slot.isStreaming) { csPlay(get, set, slotId, { fadeInFloor: xfadeIn }); return; }

      // Atura qualsevol font residual d'aquest slot (p. ex. en ple fade out)
      if (slot.sourceNode) {
        try { slot.sourceNode.onended = null; slot.sourceNode.stop(); } catch { /* res */ }
      }

      // Context segons el color del cue (routing per grup); per defecte, bus Cues
      const outDev = (slot.color && colorOutputs[slot.color]) || get().selectedDeviceId;
      const ctx = get().ctxForDevice(outDev);
      if (ctx.state === 'suspended') ctx.resume();

      // (Re)construeix el graf si no existeix o és d'un altre context
      let { fadeGainNode, gainNode, analyserNode } = slot;
      if (!fadeGainNode || fadeGainNode.context !== ctx) {
        try { slot.fadeGainNode && slot.fadeGainNode.disconnect(); } catch { /* res */ }
        try { slot.gainNode && slot.gainNode.disconnect(); } catch { /* res */ }
        try { slot.analyserNode && slot.analyserNode.disconnect(); } catch { /* res */ }
        fadeGainNode = ctx.createGain();
        fadeGainNode.gain.value = 1;
        gainNode = ctx.createGain();
        gainNode.gain.value = slot.volume ?? 0.8;
        analyserNode = ctx.createAnalyser();
        analyserNode.fftSize = 1024;
        fadeGainNode.connect(gainNode);
        gainNode.connect(analyserNode);
        analyserNode.connect(ctx.destination);
      }

      const source = ctx.createBufferSource();
      source.buffer = slot.audioBuffer;
      source.connect(fadeGainNode);

      // Punts d'inici/stop (segment) i durada efectiva
      const total = slot.audioBuffer.duration;
      const startPoint = Math.max(0, Math.min(slot.startPoint || 0, total));
      const stopPoint  = Math.min(slot.stopPoint ?? total, total);
      const segDur     = Math.max(0.02, stopPoint - startPoint);
      // Fades efectius: el propi del cue si és >0, si no el global
      const fadeIn     = Math.max(0, Math.min(xFadeIn(slot), segDur));
      const fadeOut    = Math.max(0, Math.min(effFadeOut(slot, globalFadeOut), segDur));

      const now = ctx.currentTime;

      // Envolupant de fade sobre el node de fade (0..1), independent del volum
      const fg = fadeGainNode;
      if (fg) {
        fg.gain.cancelScheduledValues(now);
        if (fadeIn > 0) {
          fg.gain.setValueAtTime(0, now);
          fg.gain.linearRampToValueAtTime(1, now + fadeIn);
        } else {
          fg.gain.setValueAtTime(1, now);
        }
        // El fade out només té sentit si el slot no està en loop infinit
        if (!slot.loop && fadeOut > 0) {
          fg.gain.setValueAtTime(1, now + segDur - fadeOut);
          fg.gain.linearRampToValueAtTime(0, now + segDur);
        }
      }

      // En acabar de forma natural: atura i, si cal, encadena (mode continuous)
      source.onended = () => get().handleEnded(slotId);

      if (slot.loop) {
        // Loop del segment [startPoint, stopPoint]
        source.loop = true;
        source.loopStart = startPoint;
        source.loopEnd = stopPoint;
        source.start(0, startPoint);
      } else {
        source.start(0, startPoint, segDur);
      }
      const startedAt = ctx.currentTime;

      set((state) => ({
        slots: state.slots.map((s) =>
          s.id === slotId
            ? { ...s, sourceNode: source, fadeGainNode, gainNode, analyserNode, isPlaying: true, startedAt, pausedAt: null }
            : s
        ),
        activeSlot: slotId,
      }));
    },

    // Re-dispara un slot des de l'inici (per la tecla del teclat). opts es passa a
    // playSlot (p. ex. exemptIds de la cadena auto-continue del GO).
    triggerSlot: (slotId, opts = {}) => {
      const slot = get().slots.find((s) => s.id === slotId);
      if (!slot || !hasClip(slot)) return;
      if (slot.isPlaying) get().stopSlot(slotId);
      set((state) => ({
        slots: state.slots.map((s) => (s.id === slotId ? { ...s, pausedAt: null } : s)),
        selectedSlot: slotId,
      }));
      get().playSlot(slotId, opts);
    },

    // Pausa: atura recordant la posició dins el segment
    pauseSlot: (slotId) => {
      const slot = get().slots.find((s) => s.id === slotId);
      if (!slot || !slot.isPlaying) return;
      // Imatges: no tenen reproducció → pausar equival a aturar.
      if (isImage(slot)) { get().stopSlot(slotId); return; }
      // VÍDEO: pausa REAL. Congela la sortida, l'àudio separat (si n'hi ha) i el
      // playhead; el mirall del tile es congela sol (via slot.pausedAt).
      if (isVideo(slot)) {
        const segDur = Math.max(0.02, (slot.stopPoint != null ? slot.stopPoint : (slot.streamDuration || 0)) - (slot.startPoint || 0));
        const elapsed = Math.max(0, performance.now() / 1000 - (slot.startedAt || 0));
        const pos = slot.loop && segDur > 0 ? (elapsed % segDur) : Math.min(elapsed, segDur);
        emitVideoPause();
        if (slot.duck) duckRemove(get, slotId);
        if (slot.videoSeparated) {
          const cmd = slot.videoSeparated === 'asio' ? 'asio_set_paused' : 'native_set_paused';
          invoke(cmd, { voiceId: slotId, paused: true }).catch((e) => console.warn('[video pause]', e));
        }
        set((state) => ({
          slots: state.slots.map((s) => (s.id === slotId ? { ...s, isPlaying: false, pausedAt: pos } : s)),
        }));
        return;
      }
      // En pausar deixa de sonar → deixa de duckejar (es reincrementa al resume)
      if (slot.duck) duckRemove(get, slotId);
      // Cue ASIO: congela la veu nativa (no l'atura). La posició la guardem des de
      // la telemetria per mostrar-la congelada; el motor manté la pos exacta.
      if (slot.asioActive) {
        const pos = asioPosition(slotId) ?? 0;
        invoke('asio_set_paused', { voiceId: slotId, paused: true })
          .catch((e) => console.warn('[asio] pause:', e));
        set((state) => ({
          slots: state.slots.map((s) =>
            s.id === slotId ? { ...s, isPlaying: false, pausedAt: pos } : s
          ),
        }));
        return;
      }
      // Cue natiu cpal: congela la veu nativa (la posició ve de la telemetria nativa,
      // que es desa al mateix Map que la d'ASIO → asioPosition).
      if (slot.nativeActive) {
        const pos = asioPosition(slotId) ?? 0;
        invoke('native_set_paused', { voiceId: slotId, paused: true })
          .catch((e) => console.warn('[native] pause:', e));
        set((state) => ({
          slots: state.slots.map((s) =>
            s.id === slotId ? { ...s, isPlaying: false, pausedAt: pos } : s
          ),
        }));
        return;
      }
      if (slot.isStreaming) { csPause(get, set, slotId); return; }
      const ctx = slot.fadeGainNode ? slot.fadeGainNode.context : get().audioContext;
      if (!ctx) return;

      const total = slot.audioBuffer.duration;
      const startPoint = Math.max(0, Math.min(slot.startPoint || 0, total));
      const stopPoint = Math.min(slot.stopPoint ?? total, total);
      const segDur = Math.max(0.02, stopPoint - startPoint);
      let pos = ctx.currentTime - slot.startedAt;
      if (slot.loop) pos = pos % segDur;
      pos = Math.max(0, Math.min(pos, segDur));

      if (slot.sourceNode) {
        try { slot.sourceNode.onended = null; slot.sourceNode.stop(); } catch { /* ja aturat */ }
      }
      set((state) => ({
        slots: state.slots.map((s) =>
          s.id === slotId ? { ...s, sourceNode: null, isPlaying: false, pausedAt: pos } : s
        ),
      }));
    },

    // Reprèn la reproducció des de la posició pausada
    resumeSlot: (slotId) => {
      const slot = get().slots.find((s) => s.id === slotId);
      if (!slot || !hasClip(slot) || slot.pausedAt == null) return;
      if (isImage(slot)) return; // les imatges no tenen estat de pausa
      // VÍDEO: reprèn. Restaura startedAt perquè el playhead continuï des de pausedAt;
      // reprèn la sortida i l'àudio separat (si n'hi ha).
      if (isVideo(slot)) {
        emitVideoResume();
        if (slot.duck) duckAdd(get, slotId);
        if (slot.videoSeparated) {
          const cmd = slot.videoSeparated === 'asio' ? 'asio_set_paused' : 'native_set_paused';
          invoke(cmd, { voiceId: slotId, paused: false }).catch((e) => console.warn('[video resume]', e));
        }
        set((state) => ({
          slots: state.slots.map((s) => (
            s.id === slotId
              ? { ...s, isPlaying: true, pausedAt: null, startedAt: performance.now() / 1000 - (s.pausedAt || 0) }
              : s
          )),
          activeSlot: slotId,
        }));
        return;
      }
      // Torna a sonar → torna a duckejar (si és un cue de duck)
      if (slot.duck) duckAdd(get, slotId);
      // Cue ASIO: reprèn la veu nativa des de la posició congelada (el motor l'ha
      // mantingut). No cal seek: continua exactament des d'on s'havia pausat.
      if (slot.asioActive) {
        invoke('asio_set_paused', { voiceId: slotId, paused: false })
          .catch((e) => console.warn('[asio] resume:', e));
        set((state) => ({
          slots: state.slots.map((s) =>
            s.id === slotId ? { ...s, isPlaying: true, pausedAt: null } : s
          ),
          activeSlot: slotId,
        }));
        return;
      }
      // Cue natiu cpal: reprèn la veu nativa des de la posició congelada.
      if (slot.nativeActive) {
        invoke('native_set_paused', { voiceId: slotId, paused: false })
          .catch((e) => console.warn('[native] resume:', e));
        set((state) => ({
          slots: state.slots.map((s) =>
            s.id === slotId ? { ...s, isPlaying: true, pausedAt: null } : s
          ),
          activeSlot: slotId,
        }));
        return;
      }
      if (slot.isStreaming) { csResume(get, set, slotId); return; }
      const ctx = slot.fadeGainNode ? slot.fadeGainNode.context : (get().audioContext || get().initAudioContext());

      const total = slot.audioBuffer.duration;
      const startPoint = Math.max(0, Math.min(slot.startPoint || 0, total));
      const stopPoint = Math.min(slot.stopPoint ?? total, total);
      const segDur = Math.max(0.02, stopPoint - startPoint);
      const pos = Math.max(0, Math.min(slot.pausedAt, segDur));
      const offset = startPoint + pos;
      const remaining = Math.max(0.02, stopPoint - offset);

      const source = ctx.createBufferSource();
      source.buffer = slot.audioBuffer;
      source.connect(slot.fadeGainNode || slot.gainNode);

      const now = ctx.currentTime;
      const fg = slot.fadeGainNode;
      if (fg) {
        fg.gain.cancelScheduledValues(now);
        fg.gain.setValueAtTime(1, now); // sense fade in en reprendre
        const fadeOut = Math.max(0, Math.min(effFadeOut(slot, get().globalFadeOut), segDur));
        if (!slot.loop && fadeOut > 0 && remaining > fadeOut) {
          fg.gain.setValueAtTime(1, now + remaining - fadeOut);
          fg.gain.linearRampToValueAtTime(0, now + remaining);
        }
      }

      source.onended = () => get().handleEnded(slotId);
      if (slot.loop) {
        source.loop = true;
        source.loopStart = startPoint;
        source.loopEnd = stopPoint;
        source.start(0, offset);
      } else {
        source.start(0, offset, remaining);
      }
      const startedAt = now - pos;

      set((state) => ({
        slots: state.slots.map((s) =>
          s.id === slotId ? { ...s, sourceNode: source, isPlaying: true, startedAt, pausedAt: null } : s
        ),
        activeSlot: slotId,
      }));
    },

    setSelectedSlot: (slotId) => {
      set({ selectedSlot: slotId });
      scheduleStandbyPreload(get); // P7: escalfa el standby (debounce)
    },

    // Canvia de pàgina (conserva la posició del cursor dins la graella)
    setPage: (n) => {
      const page = Math.max(0, Math.min(n, NUM_PAGES - 1));
      const local = (get().selectedSlot - 1) % SLOTS_PER_PAGE;
      set({ currentPage: page, selectedSlot: page * SLOTS_PER_PAGE + local + 1 });
    },

    // Mou el cursor de selecció amb les fletxes.
    // Esquerra/dreta: seqüencial travessant files I pàgines (auto-flip de pàgina).
    // Amunt/avall: moviment vertical dins la pàgina actual (8×4).
    moveSelection: (dir) => {
      const { selectedSlot, currentPage } = get();
      if (dir === 'left' || dir === 'right') {
        let id = (selectedSlot || 1) + (dir === 'right' ? 1 : -1);
        id = Math.max(1, Math.min(NUM_SLOTS, id));
        set({ selectedSlot: id, currentPage: Math.floor((id - 1) / SLOTS_PER_PAGE) });
        scheduleStandbyPreload(get); // P7
        return;
      }
      const base = currentPage * SLOTS_PER_PAGE;
      let local = (selectedSlot - 1) % SLOTS_PER_PAGE;
      const row = Math.floor(local / 8);
      if (dir === 'up' && row > 0) local -= 8;
      if (dir === 'down' && row < 3) local += 8;
      set({ selectedSlot: base + local + 1 });
      scheduleStandbyPreload(get); // P7
    },

    // Mou la selecció al cue carregat anterior/següent, dins la pàgina activa
    selectStep: (delta) => {
      const { selectedSlot, slots, currentPage } = get();
      const base = currentPage * SLOTS_PER_PAGE;
      let id = (selectedSlot || 1) + delta;
      while (id >= base + 1 && id <= base + SLOTS_PER_PAGE) {
        const s = slots.find((x) => x.id === id);
        if (s && hasClip(s)) { set({ selectedSlot: id }); scheduleStandbyPreload(get); return; }
        id += delta;
      }
    },

    // Transport sobre un slot: play si aturat, pausa si sona, reprèn si pausat
    togglePlayPause: (slotId) => {
      const slot = get().slots.find((s) => s.id === slotId);
      if (!slot || !hasClip(slot)) return;
      if (slot.isPlaying) get().pauseSlot(slotId);
      else if (slot.pausedAt != null) get().resumeSlot(slotId);
      else get().triggerSlot(slotId);
    },

    // Parada d'emergència: atura TOTS els slots
    // Parada d'emergència de TOTS els cues, amb fade out (segons el fade-out
    // efectiu de cada cue; si és 0, tall sec).
    stopAll: () => {
      // Cancel·la qualsevol seqüència GO pendent (pre-wait en curs o cadena
      // auto-continue): si l'usuari prem Stop All mentre hi ha un disparo
      // programat, no s'ha de disparar.
      clearGoTimers();
      const { slots } = get();
      slots.forEach((s) => {
        if (s.isPlaying || s.pausedAt != null) get().stopSlot(s.id, true);
      });
      get().stopPreview();
      // NOTA: el Stop All dels cues (Esc a la vista de cues) NO atura la Playlist:
      // la música de fons no forma part del pànic dels cues. La Playlist té el seu
      // propi Stop (Esc a la vista de Playlist). [Revertit M7 a petició de l'usuari.]
      // Negre a la sortida de vídeo (pànic: assegura pantalla negra encara que
      // cap cue de vídeo constés com a actiu)
      emitVideoBlack();
      // Seguretat: buida el comptador de ducking (recupera la playlist) per si
      // hagués quedat algun id penjat
      duckReset(get);
      set({ activeSlot: null });
    },

    // Gestiona el final natural d'un clip: l'atura (l'encadenament és manual
    // amb GO, o automàtic a la Playlist; la botonera no avança sola).
    handleEnded: (slotId) => {
      const current = get().slots.find((s) => s.id === slotId);
      // R1: normalment només actuem si el cue sonava, però una FALLADA de veu nativa
      // (C1) pot arribar en una cursa abans que `isPlaying` s'hagi assentat; en aquest
      // cas els flags asioActive/nativeActive ja hi són i cal netejar igualment perquè
      // el tile no quedi blau ni el ducking penjat.
      if (!current) return;
      if (!current.isPlaying && !current.asioActive && !current.nativeActive) return;
      // El cue ha acabat de forma natural: deixa de duckejar (si tocava)
      if (current.duck) duckRemove(get, slotId);
      if (current.asioActive || current.nativeActive) clearAsioTelemetry(slotId);
      // 4c separat: si l'àudio del vídeo (motor) ha acabat, atura la imatge i el resync.
      if (current.videoSeparated) {
        emitVideoStop(0);
        stopVideoResync();
        clearAsioTelemetry(slotId);
      }
      set((state) => ({
        slots: state.slots.map((s) =>
          s.id === slotId ? { ...s, isPlaying: false, asioActive: false, nativeActive: false, arming: false, sourceNode: null, videoSeparated: false } : s
        ),
        activeSlot: state.activeSlot === slotId ? null : state.activeSlot,
      }));
    },

    // ── Slides (PDF) ───────────────────────────────────────────────────────────
    // Navega les pàgines del cue de slides ACTIU a la sortida (delta ±1). El target
    // és el PDF que ES VEU ara a la sortida, és a dir, el disparat MÉS RECENTMENT
    // (per startedAt): si es fa GO a un segon slide sense aturar el primer, tots dos
    // queden isPlaying, però a la sortida només hi ha el darrer i les tecles l'han de
    // seguir. Si no en sona cap, no fa res (les tecles de pàgina són contextuals).
    // Clampa a [1, pageCount] quan ja coneixem el recompte (l'informa la sortida).
    slidePage: (delta) => {
      const playing = get().slots.filter((s) => s.isPlaying && isPdf(s));
      if (!playing.length) return;
      const slot = playing.reduce((a, b) => ((b.startedAt || 0) > (a.startedAt || 0) ? b : a));
      const count = slot.pageCount || 0;
      let page = (slot.currentPage || 1) + delta;
      page = Math.max(1, count ? Math.min(page, count) : page);
      if (page === (slot.currentPage || 1)) return; // ja hi som (extrem)
      set((state) => ({
        slots: state.slots.map((s) => (s.id === slot.id ? { ...s, currentPage: page } : s)),
      }));
      emitSlideGoto(page);
    },

    // P4-lite — Confirma que unes veus de maquinari han arrencat de debò: en rebre
    // la primera telemetria d'un cue en estat "armant", li treu l'arming (el tile
    // passa d'"armant…" a "reproduint"). Ho crida el listener de telemetria amb els
    // ids del lot; només toca l'estat si de veritat hi ha algun arming a confirmar.
    confirmArming: (ids) => {
      const list = Array.isArray(ids) ? ids : [ids];
      if (!get().slots.some((s) => s.arming && list.includes(s.id))) return;
      set((state) => ({
        slots: state.slots.map((s) =>
          s.arming && list.includes(s.id) ? { ...s, arming: false } : s
        ),
      }));
    },

    // La finestra de sortida informa el nombre total de pàgines d'un PDF en
    // carregar-lo (per poder clampar la navegació i mostrar "3/24" al tile).
    setSlidePages: (slotId, pages) =>
      set((state) => ({
        slots: state.slots.map((s) => (s.id === slotId ? { ...s, pageCount: Math.max(0, pages | 0) } : s)),
      })),

    // Avança el standby al següent cue carregat (per id), travessant pàgines.
    // Si surt de la pàgina actual, fa auto-flip de currentPage perquè el standby
    // quedi visible. Si no hi ha cap cue carregat després, manté el standby.
    advanceStandby: (fromId) => {
      const { slots } = get();
      const next = slots.find((s) => s.id > fromId && hasClip(s));
      if (!next) return null;
      const page = Math.floor((next.id - 1) / SLOTS_PER_PAGE);
      set({ selectedSlot: next.id, currentPage: page });
      // P7: el standby ha avançat (flux de GO) → escalfa el nou standby i veïns ara
      // mateix, que és el que és MÉS probable que soni tot seguit.
      get().preloadStandby();
      return next.id;
    },

    // GO seqüencial estil QLab: dispara el standby (respectant el seu pre-wait),
    // avança el standby al següent cue carregat (travessant pàgines), i si el cue
    // disparat és auto-continue, encadena un GO sobre el nou standby.
    //
    // Cancel·lació: un GO manual nou cancel·la qualsevol seqüència pendent (pre-wait
    // o cadena) abans d'iniciar-ne una de nova — comportament més predictible que
    // ignorar-lo o encuar-lo. stopAll també la cancel·la.
    go: () => {
      clearGoTimers();
      get()._goStep();
    },

    // Un pas de la seqüència (intern). No cancel·la timers: l'usa la cadena.
    _goStep: () => {
      const { selectedSlot, slots } = get();
      const sel = selectedSlot || 1;
      const slot = slots.find((s) => s.id === sel);
      if (!slot || !hasClip(slot)) return; // cap cue carregat al standby: GO no fa res

      const continueMode = slot.continueMode;
      const preWait = Math.max(0, slot.preWait || 0);

      // Dispara el cue (immediat o després del pre-wait). Un cop disparat,
      // avança el standby i, si cal, encadena.
      const fire = () => {
        // Afegeix aquest cue a la cadena ABANS de disparar-lo, perquè el seu
        // Stop Others (si en té) no talli els cues anteriors de la mateixa cadena.
        goChain.add(sel);
        get().triggerSlot(sel, { exemptIds: goChain });
        const nextId = get().advanceStandby(sel);
        // Auto-continue: encadena sobre el nou standby. Evita bucles: només si
        // el standby ha avançat de debò (nextId != null i != sel).
        if (continueMode === 'auto' && nextId != null && nextId !== sel) {
          get()._goStep();
        }
      };

      if (preWait > 0) {
        const t = setTimeout(() => { goTimers.delete(t); fire(); }, preWait * 1000);
        goTimers.add(t);
      } else {
        fire();
      }
    },

    // Salta a una posició (ratio 0..1 dins el segment) mentre el slot sona,
    // recreant el node de reproducció amb el nou offset.
    seekSlot: (slotId, ratio) => {
      const slot = get().slots.find((s) => s.id === slotId);
      if (!slot || !hasClip(slot) || !slot.isPlaying) return;
      if (isVideo(slot)) return; // el vídeo no es busca des d'aquí (4a)
      // Cue ASIO actiu: reposiciona la veu nativa (no té graf Web Audio). El
      // playhead s'actualitzarà sol per la telemetria. Va ABANS de l'streaming
      // (un cue ASIO pot ser >60s i estar marcat isStreaming sense graf Web Audio).
      if (slot.asioActive) {
        const total = slotDuration(slot);
        const startPoint = Math.max(0, Math.min(slot.startPoint || 0, total || 0));
        const stopPoint = slot.stopPoint != null ? Math.min(slot.stopPoint, total) : total;
        const segDur = Math.max(0.02, stopPoint - startPoint);
        const r = Math.min(1, Math.max(0, ratio));
        // position ABSOLUTA dins el fitxer (inici del tram + offset dins el tram)
        invoke('asio_seek', { voiceId: slotId, position: startPoint + r * segDur })
          .catch((e) => console.warn('[asio] seek:', e));
        return;
      }
      // Cue natiu cpal: reposiciona la veu nativa (mateixa via que ASIO, sense graf
      // Web Audio). El playhead s'actualitza per la telemetria nativa.
      if (slot.nativeActive) {
        const total = slotDuration(slot);
        const startPoint = Math.max(0, Math.min(slot.startPoint || 0, total || 0));
        const stopPoint = slot.stopPoint != null ? Math.min(slot.stopPoint, total) : total;
        const segDur = Math.max(0.02, stopPoint - startPoint);
        const r = Math.min(1, Math.max(0, ratio));
        invoke('native_seek', { voiceId: slotId, position: startPoint + r * segDur })
          .catch((e) => console.warn('[native] seek:', e));
        return;
      }
      if (slot.isStreaming) { csSeek(get, set, slotId, ratio); return; }
      const ctx = slot.fadeGainNode ? slot.fadeGainNode.context : get().audioContext;
      if (!ctx) return;

      const total      = slot.audioBuffer.duration;
      const startPoint = Math.max(0, Math.min(slot.startPoint || 0, total));
      const stopPoint  = Math.min(slot.stopPoint ?? total, total);
      const segDur     = Math.max(0.02, stopPoint - startPoint);
      const r          = Math.min(1, Math.max(0, ratio));
      const offset     = startPoint + r * segDur;
      const remaining  = Math.max(0.02, stopPoint - offset);

      // Atura el node actual sense disparar l'encadenament
      if (slot.sourceNode) {
        try { slot.sourceNode.onended = null; slot.sourceNode.stop(); } catch { /* ja aturat */ }
      }

      const source = ctx.createBufferSource();
      source.buffer = slot.audioBuffer;
      source.connect(slot.fadeGainNode || slot.gainNode);

      const now = ctx.currentTime;
      const fg = slot.fadeGainNode;
      if (fg) {
        // En fer seek no apliquem fade in; mantenim el fade out cap al final
        fg.gain.cancelScheduledValues(now);
        fg.gain.setValueAtTime(1, now);
        const fadeOut = Math.max(0, Math.min(effFadeOut(slot, get().globalFadeOut), segDur));
        if (!slot.loop && fadeOut > 0 && remaining > fadeOut) {
          fg.gain.setValueAtTime(1, now + remaining - fadeOut);
          fg.gain.linearRampToValueAtTime(0, now + remaining);
        }
      }

      source.onended = () => get().handleEnded(slotId);

      if (slot.loop) {
        source.loop = true;
        source.loopStart = startPoint;
        source.loopEnd = stopPoint;
        source.start(0, offset);
      } else {
        source.start(0, offset, remaining);
      }

      // startedAt ajustat perquè el progrés reflecteixi la posició actual
      const startedAt = now - (offset - startPoint);

      set((state) => ({
        slots: state.slots.map((s) =>
          s.id === slotId ? { ...s, sourceNode: source, startedAt } : s
        ),
      }));
    },

    // Elimina el clip d'un slot: l'atura, allibera recursos i el deixa buit
    clearSlot: (slotId) => {
      const { slots } = get();
      const slot = slots.find((s) => s.id === slotId);
      if (!slot) return;

      // Si era un cue de ducking actiu, deixa de comptar
      if (slot.duck) duckRemove(get, slotId);

      // Atura la veu ASIO nativa (sonant o pausada) perquè no quedi penjada al motor
      if (slot.asioActive) {
        invoke('asio_stop_voice', { voiceId: slotId, fadeOut: 0 })
          .catch((e) => console.warn('[asio] stop_voice (clear):', e));
        clearAsioTelemetry(slotId);
      }
      // Atura la veu nativa cpal (sonant o pausada) perquè no quedi penjada al motor
      if (slot.nativeActive) {
        invoke('native_stop_voice', { voiceId: slotId, fadeOut: 0 })
          .catch((e) => console.warn('[native] stop_voice (clear):', e));
        clearAsioTelemetry(slotId);
      }
      // Atura l'streaming (l'element <audio> no és un sourceNode)
      if (slot.isStreaming) csStop(get, set, slotId);
      if (slot.sourceNode) {
        try { slot.sourceNode.onended = null; slot.sourceNode.stop(); } catch { /* ja aturat */ }
      }
      if (slot.audioUrl) {
        try { URL.revokeObjectURL(slot.audioUrl); } catch { /* res */ }
      }
      try { slot.fadeGainNode && slot.fadeGainNode.disconnect(); } catch { /* res */ }
      try { slot.gainNode && slot.gainNode.disconnect(); } catch { /* res */ }
      try { slot.analyserNode && slot.analyserNode.disconnect(); } catch { /* res */ }

      set((state) => ({
        slots: state.slots.map((s) => (s.id === slotId ? createEmptySlot(slotId) : s)),
        activeSlot: state.activeSlot === slotId ? null : state.activeSlot,
        editingSlot: state.editingSlot === slotId ? null : state.editingSlot,
      }));
      get().persistSlots();
    },

    setSlotLoading: (slotId, loading) =>
      set((state) => ({
        slots: state.slots.map((s) => (s.id === slotId ? { ...s, loading } : s)),
      })),

    // Marca un slot com a "fitxer no trobat en arrencar" sense tocar cap altre camp
    // ni persistir. És estat pur de sessió; es recalcula a cada boot.
    setSlotMissing: (slotId, missing) =>
      set((state) => ({
        slots: state.slots.map((s) => (s.id === slotId ? { ...s, missing } : s)),
      })),

    // Marca un slot amb un error de reproducció (voice-failed): el fitxer hi és però
    // el motor no ha pogut sonar-lo. Estat de sessió (no persistit); es neteja en
    // tornar a disparar amb èxit o recarregar. message=null el treu.
    setSlotError: (slotId, message) =>
      set((state) => ({
        slots: state.slots.map((s) => (s.id === slotId ? { ...s, error: message || null } : s)),
      })),

    // C2 — El motor natiu informa que un dispositiu de sortida ha desaparegut a
    // mitja funció (deviceName buit = per defecte). Fa VISIBLE la pèrdua: atura i
    // marca en error tots els cues que sonaven per aquest dispositiu (en lloc de
    // quedar-se sense so en silenci) i treu un toast. Les seves veus ja són mortes
    // al motor; només cal netejar l'estat i avisar l'operador.
    handleNativeDeviceLost: (deviceName) => {
      const dev = deviceName || '';
      const label = dev || 'default';
      const affected = get().slots.filter((s) => {
        if (!s.nativeActive) return false;
        const t = parseTarget(resolveCueTargetStr(get(), s));
        return t.kind === 'native' && (t.device || '') === dev;
      });
      affected.forEach((s) => {
        get().handleEnded(s.id); // reset del tile + duckRemove + neteja telemetria
        get().setSlotError(s.id, `Output device lost: ${label}`);
      });
      get().pushNotification({
        type: 'error',
        message: affected.length
          ? `Output device lost (${label}) — ${affected.length} cue(s) stopped`
          : `Output device lost: ${label}`,
      });
    },

    // C2 — El motor ASIO informa que el dispositiu ha desaparegut a mitja funció (el
    // callback del driver s'ha congelat; típicament la interfície USB desendollada).
    // Fa visible la pèrdua: atura i marca en error TOTS els cues que sonaven per ASIO
    // (només hi ha un driver ASIO actiu alhora) i treu un toast.
    handleAsioDeviceLost: (driver) => {
      const affected = get().slots.filter((s) => s.asioActive);
      affected.forEach((s) => {
        get().handleEnded(s.id);
        // Missatge instructiu (el driver ASIO no reviu sol; un GO el re-prepara).
        get().setSlotError(s.id, 'ASIO device lost — reconnect and press GO');
      });
      get().pushNotification({
        type: 'error',
        message: affected.length
          ? `ASIO device lost — ${affected.length} cue(s) stopped. Reconnect the device and press GO.`
          : 'ASIO device lost. Reconnect the device and press GO.',
      });
    },

    // C2 — El motor ASIO informa que el dispositiu ha TORNAT (el callback del driver
    // reprèn). Neteja l'estat d'error dels cues routejats a ASIO (perquè l'operador no
    // hagi de disparar per treure el vermell) i avisa. NO torna a sonar res sol.
    handleAsioDeviceRecovered: () => {
      const asioErr = get().slots.filter(
        (s) => s.error && parseTarget(resolveCueTargetStr(get(), s)).kind === 'asio'
      );
      if (asioErr.length) {
        const ids = new Set(asioErr.map((s) => s.id));
        set((state) => ({
          slots: state.slots.map((s) => (ids.has(s.id) ? { ...s, error: null } : s)),
        }));
      }
      get().pushNotification({ type: 'info', message: 'ASIO device reconnected' });
    },

    // Desa els pics de la forma d'ona d'un cue en streaming (generats en segon pla)
    setSlotPeaks: (slotId, peaks) =>
      set((state) => ({
        slots: state.slots.map((s) => (s.id === slotId ? { ...s, peaks, peaksDone: true } : s)),
      })),

    // Marca la generació de forma d'ona com a ACABADA (èxit o fracàs). L'usa
    // buildPeaksBackground al final perquè, si els pics no es poden generar, l'spinner
    // de la forma d'ona no giri indefinidament (mostra àrea buida en lloc de spinner).
    setSlotPeaksDone: (slotId) =>
      set((state) => ({
        slots: state.slots.map((s) => (s.id === slotId ? { ...s, peaksDone: true } : s)),
      })),

    setColor: (slotId, color) => {
      set((state) => ({
        slots: state.slots.map((s) => (s.id === slotId ? { ...s, color } : s)),
      }));
      get().persistSlots();
    },

    // Activa/desactiva el loop d'un slot (opció de reproducció persistida)
    setLoop: (slotId, loop) => {
      set((state) => ({
        slots: state.slots.map((s) =>
          s.id === slotId ? { ...s, loop } : s
        ),
      }));
      get().persistSlots();
    },

    // fade: false/undefined = tall sec · true = usa el fade-out efectiu del cue
    //       · número = fade d'aquests segons
    // opts.silent (només cues visuals): neteja l'estat i els efectes secundaris
    // (ducking, àudio separat, resync) però NO emet el negre a la sortida. L'usa el
    // relleu de visuals (un de sol alhora): el nou video-play ja reemplaça la imatge,
    // així que emetre negre pel de sortida provocaria un flaix.
    stopSlot: (slotId, fade = false, opts = {}) => {
      const { audioContext, globalFadeOut } = get();
      const slot = get().slots.find((s) => s.id === slotId);
      // Res a fer si ja està del tot aturat (sense source ni pausa)
      if (!slot || (!slot.sourceNode && slot.pausedAt == null && !slot.isPlaying)) return;
      // Cue visual (vídeo o imatge): atura la sortida i marca'l aturat (sense Web
      // Audio). Honora el fade out (com l'àudio): fade===true → fade efectiu del
      // cue; número → aquests segons; false → tall sec. La finestra de sortida fa
      // el fade visual (i de volum, si és vídeo) abans de passar a negre.
      if (isVisual(slot)) {
        // Deixa de duckejar (idempotent: el Set evita doble compte si ja no hi era)
        if (slot.duck) duckRemove(get, slotId);
        let fadeSec = 0;
        if (fade === true) {
          // Les imatges no tenen durada: no es clampa el fade. El vídeo sí (al segment).
          if (isImage(slot)) fadeSec = Math.max(0, effFadeOut(slot, globalFadeOut));
          else {
            const segDur = Math.max(0.02, (slot.stopPoint ?? (slot.streamDuration || 0)) - Math.max(0, slot.startPoint || 0));
            fadeSec = Math.max(0, Math.min(effFadeOut(slot, globalFadeOut), segDur));
          }
        } else if (typeof fade === 'number') fadeSec = Math.max(0, fade);
        // En mode silent (relleu de visuals) no emetem negre: el nou video-play ja
        // reemplaça la imatge i evitem el flaix.
        if (!opts.silent) emitVideoStop(fadeSec);
        // 4c separat: atura també l'àudio del vídeo, pel motor que el reprodueix
        // (ASIO a Windows, natiu cpal a Mac), i para el resync.
        if (slot.videoSeparated) {
          const cmd = slot.videoSeparated === 'asio' ? 'asio_stop_voice' : 'native_stop_voice';
          invoke(cmd, { voiceId: slot.id, fadeOut: fadeSec }).catch(() => {});
          stopVideoResync();
          clearAsioTelemetry(slotId);
        }
        set((state) => ({
          slots: state.slots.map((s) =>
            s.id === slotId ? { ...s, isPlaying: false, pausedAt: null, videoSeparated: false } : s
          ),
          activeSlot: state.activeSlot === slotId ? null : state.activeSlot,
        }));
        return;
      }
      // Deixa de duckejar (el Set evita doble compte si ja no hi era)
      if (slot.duck) duckRemove(get, slotId);
      // Cue routejat a ASIO: no té graf Web Audio (ni sourceNode). Atura la veu
      // nativa al fil `asio-engine` amb el fade-out efectiu i marca'l aturat.
      // IMPORTANT: aquesta comprovació va ABANS de la d'streaming — un cue ASIO
      // pot ser >60s (marcat isStreaming), però NO té graf Web Audio, així que
      // csStop no l'aturaria; ha de parar per la via nativa. (A playSlot el
      // dispatch ASIO també es resol abans de l'streaming.)
      // Cue natiu cpal: no té graf Web Audio. Atura la veu nativa amb el fade-out
      // efectiu. Va ABANS del bloc ASIO i de l'streaming (mateix motiu).
      if (slot.nativeActive) {
        let fadeSec = 0;
        if (fade === true) fadeSec = Math.max(0, effFadeOut(slot, globalFadeOut));
        else if (typeof fade === 'number') fadeSec = Math.max(0, fade);
        // Pausat: la veu no avança al motor → atura de cop (fade 0).
        if (slot.pausedAt != null) fadeSec = 0;
        invoke('native_stop_voice', { voiceId: slot.id, fadeOut: fadeSec })
          .catch((e) => console.warn('[native] stop_voice:', e));
        clearAsioTelemetry(slotId);
        set((state) => ({
          slots: state.slots.map((s) =>
            s.id === slotId ? { ...s, isPlaying: false, nativeActive: false, pausedAt: null } : s
          ),
          activeSlot: state.activeSlot === slotId ? null : state.activeSlot,
        }));
        return;
      }
      // C3: decidim per l'ESTAT de la veu (slot.asioActive), no pel routing vigent.
      // Si es canvia el bus/color d'un cue mentre sona per ASIO, el routing passa a
      // WASAPI però la veu segueix viva al motor: keying pel routing la deixaria
      // impossible d'aturar (ni Stop All). El flag reflecteix per on sona DE DEBÒ.
      // Mantenim la resolució per routing només com a fallback (slots sense flag).
      if (slot.asioActive || (isAsioTarget(resolveCueTargetStr(get(), slot)) && !slot.sourceNode)) {
        // Calcula el fade-out: true → efectiu del cue; número → aquests segons.
        let fadeSec = 0;
        if (fade === true) fadeSec = Math.max(0, effFadeOut(slot, globalFadeOut));
        else if (typeof fade === 'number') fadeSec = Math.max(0, fade);
        // Si està PAUSAT, la veu no avança al motor: un release amb fade quedaria
        // encallat. Atura-la de cop (fade 0).
        if (slot.pausedAt != null) fadeSec = 0;
        invoke('asio_stop_voice', { voiceId: slot.id, fadeOut: fadeSec })
          .catch((e) => console.warn('[asio] stop_voice:', e));
        clearAsioTelemetry(slotId);
        set((state) => ({
          slots: state.slots.map((s) =>
            s.id === slotId ? { ...s, isPlaying: false, asioActive: false, pausedAt: null } : s
          ),
          activeSlot: state.activeSlot === slotId ? null : state.activeSlot,
        }));
        return;
      }
      if (slot.isStreaming) { csStop(get, set, slotId, fade); return; }
      const ctx = slot.fadeGainNode ? slot.fadeGainNode.context : audioContext;

      // Calcula la durada del fade out
      let fadeSec = 0;
      if (fade === true) {
        const total = slot.audioBuffer ? slot.audioBuffer.duration : 0;
        const segDur = Math.max(
          0.02,
          Math.min(slot.stopPoint ?? total, total) - Math.max(0, slot.startPoint || 0)
        );
        fadeSec = Math.max(0, Math.min(effFadeOut(slot, globalFadeOut), segDur));
      } else if (typeof fade === 'number') {
        fadeSec = Math.max(0, fade);
      }

      const fading = slot.sourceNode && fadeSec > 0 && slot.fadeGainNode && ctx;
      if (fading) {
        // Fade out: rampa el node de fade a 0 i atura la font en acabar.
        // Mantenim la referència perquè playSlot la pugui aturar si es re-dispara.
        const now = ctx.currentTime;
        const fg = slot.fadeGainNode;
        try {
          fg.gain.cancelScheduledValues(now);
          fg.gain.setValueAtTime(fg.gain.value, now);
          fg.gain.linearRampToValueAtTime(0, now + fadeSec);
          slot.sourceNode.onended = null;
          slot.sourceNode.stop(now + fadeSec + 0.05);
        } catch { /* res */ }
      } else if (slot.sourceNode) {
        try { slot.sourceNode.onended = null; slot.sourceNode.stop(); } catch { /* ja aturat */ }
      }

      set((state) => ({
        slots: state.slots.map((s) =>
          s.id === slotId
            ? { ...s, sourceNode: fading ? s.sourceNode : null, isPlaying: false, pausedAt: null }
            : s
        ),
        activeSlot: state.activeSlot === slotId ? null : state.activeSlot,
      }));
    },

    setVolume: (slotId, volume) => {
      const { slots } = get();
      const slot = slots.find((s) => s.id === slotId);
      if (slot?.gainNode) {
        slot.gainNode.gain.value = volume;
      }
      // Cue ASIO actiu: aplica el volum a la veu nativa en calent (no té gainNode)
      if (slot?.asioActive) {
        invoke('asio_set_gain', { voiceId: slotId, gain: volume })
          .catch((e) => console.warn('[asio] set_gain:', e));
      }
      // Cue natiu cpal actiu: aplica el volum a la veu nativa en calent
      if (slot?.nativeActive) {
        invoke('native_set_gain', { voiceId: slotId, gain: volume })
          .catch((e) => console.warn('[native] set_gain:', e));
      }
      if (slot?.isStreaming) csSetVolume(get, slotId, volume);
      // Cue de vídeo en reproducció: aplica el volum a la finestra de sortida
      if (slot && isVideo(slot) && slot.isPlaying) emitVideoVolume(volume);
      // Vídeo amb àudio separat: el so surt pel motor (imatge muda) → el volum ha
      // d'anar al motor que el reprodueix, no al <video> (que està silenciat).
      if (slot?.videoSeparated === 'asio') invoke('asio_set_gain', { voiceId: slotId, gain: volume }).catch(() => {});
      else if (slot?.videoSeparated === 'native') invoke('native_set_gain', { voiceId: slotId, gain: volume }).catch(() => {});
      set((state) => ({
        slots: state.slots.map((s) =>
          s.id === slotId ? { ...s, volume } : s
        ),
      }));
      get().persistSlots();
    },
  };
}
