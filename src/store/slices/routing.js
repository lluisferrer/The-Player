// Slice de ROUTING — dispositius, busos i contextos d'àudio (P5 — divisió del store en slices).
//
// Concentra totes les accions que gestionen:
//   - El context d'àudio principal i els busos de color dels cues.
//   - La detecció i selecció de dispositius de sortida.
//   - El routing de la Playlist, el Preview i els cues al bus ASIO o WASAPI.
//   - El gain mestre i la informació de drivers ASIO.
//   - El pre-decode (preload) ASIO i del motor natiu cpal.
//
// S'incorpora al store amb `...createRoutingSlice(set, get)`.
//
// Variable de mòdul (aquí perquè NOMÉS la fan servir ctxForDevice i setAudioDevices):
// el registre de contextos per als busos de color dels cues.

import { AudioCtx } from '../audioCtx';
import { invoke } from '@tauri-apps/api/core';
import { isAsioTarget, isNativeTarget, isHardwareEngineTarget, parseTarget, resolveCueTargetStr, platformTarget, IS_LINUX } from '../../lib/outputTarget';
import { dispatchCue } from '../../lib/cueDispatch';
import { isVisual, hasClip } from '../../lib/slotAudio';
import {
  plSetDevice, plPosition, plStartAt,
} from '../../lib/playlistEngine';
import {
  plaPosition, plaStartAt,
} from '../../lib/playlistAsio';
import {
  plnPosition, plnStartAt,
} from '../../lib/playlistNative';

// Registre de contextos Web Audio per als busos de color dels cues:
// deviceId → AudioContext. Només el fan servir ctxForDevice i setAudioDevices.
const cueCtxRegistry = new Map();
// Context offline de descodificació (només Linux; vegeu decodeContext).
let decodeCtx = null;

export function createRoutingSlice(set, get) {
  return {
    // Crea (o reutilitza) l'AudioContext principal del bus de Cues.
    initAudioContext: () => {
      const existing = get().audioContext;
      if (existing && existing.state !== 'closed') return existing;
      const ctx = new AudioCtx();
      set({ audioContext: ctx });
      return ctx;
    },

    // Context NOMÉS per descodificar (decodeAudioData). A Linux és un
    // OfflineAudioContext: no obre cap stream de PulseAudio (el so hi surt sempre
    // pel motor natiu). A la resta, el context principal de sempre.
    decodeContext: () => {
      if (IS_LINUX) {
        const Offline = window.OfflineAudioContext || window.webkitOfflineAudioContext;
        if (Offline) {
          if (!decodeCtx) decodeCtx = new Offline(2, 1, 48000);
          return decodeCtx;
        }
      }
      return get().audioContext || get().initAudioContext();
    },

    // Retorna (o crea) el context d'un dispositiu de sortida per als cues.
    // El bus de Cues reutilitza l'audioContext principal.
    ctxForDevice: (deviceId) => {
      const st = get();
      if (!deviceId || deviceId === st.selectedDeviceId) {
        return st.audioContext || get().initAudioContext();
      }
      let ctx = cueCtxRegistry.get(deviceId);
      if (!ctx || ctx.state === 'closed') {
        ctx = new AudioCtx();
        // setSinkId retorna una Promise; cal capturar el rebuig asíncron amb .catch,
        // no amb try/catch síncron (que no captura errors de Promise).
        if (ctx.setSinkId && !isHardwareEngineTarget(deviceId)) {
          ctx.setSinkId(deviceId).catch((e) =>
            console.warn('[setSinkId] ctxForDevice: dispositiu no disponible:', deviceId, e)
          );
        }
        cueCtxRegistry.set(deviceId, ctx);
      }
      if (ctx.state === 'suspended') ctx.resume();
      return ctx;
    },

    // Crea/reutilitza el context d'un bus i li aplica el dispositiu de sortida
    ensurePlaylistCtx: () => {
      let ctx = get().playlistCtx;
      if (!ctx || ctx.state === 'closed') {
        ctx = new AudioCtx();
        set({ playlistCtx: ctx });
        const dev = get().playlistDeviceId;
        // setSinkId és asíncron; el rebuig (dispositiu absent) es captura amb .catch.
        if (ctx.setSinkId && dev && !isHardwareEngineTarget(dev)) {
          ctx.setSinkId(dev).catch((e) =>
            console.warn('[setSinkId] ensurePlaylistCtx: dispositiu no disponible:', dev, e)
          );
        }
      }
      if (ctx.state === 'suspended') ctx.resume();
      return ctx;
    },

    // Detecta quants canals de sortida exposa el dispositiu seleccionat.
    // maxChannelCount > 2 vol dir que podem fer routing multicanal / cue
    // via Web Audio (ChannelMergerNode). Si és 2, només estèreo.
    detectOutputChannels: async () => {
      const ctx = get().audioContext || get().initAudioContext();
      const dev = get().selectedDeviceId;
      // Si el bus de Cues apunta a un motor de maquinari (ASIO o natiu), no és un
      // sinkId WASAPI: no el toquem.
      if (ctx.setSinkId && dev && dev !== 'default' && !isHardwareEngineTarget(dev)) {
        try { await ctx.setSinkId(dev); } catch { /* res */ }
      }
      const max = ctx.destination.maxChannelCount;
      set({ outputChannels: max });
      return max;
    },

    // Actualitza la llista de dispositius i tanca els contextos de color obsolets.
    setAudioDevices: (devices) => {
      set({ audioDevices: devices });
      // Tanca i elimina del registre els contextos de busos de color (cueCtxRegistry)
      // els dispositius dels quals ja no existeixen a la nova llista. Els busos secundaris
      // de cues no poden enviar so a un dispositiu desendollat; tancar-los és segur.
      // No toquem el selectedDeviceId principal (té el seu propi context a audioContext).
      const currentSelected = get().selectedDeviceId;
      const availableIds = new Set(devices.map((d) => d.deviceId));
      for (const [id, ctx] of cueCtxRegistry) {
        if (!availableIds.has(id) && id !== currentSelected) {
          ctx.close().catch(() => { /* ja tancat o sense permís */ });
          cueCtxRegistry.delete(id);
        }
      }
    },

    // Canvia el dispositiu de sortida del bus de Cues (WASAPI o ASIO).
    setSelectedDevice: async (deviceId) => {
      deviceId = platformTarget(deviceId);
      const { audioContext } = get();
      set({ selectedDeviceId: deviceId });
      // Si el bus de Cues s'assigna a un target ASIO (string "asio:…"), NO és un
      // sinkId WASAPI vàlid: no toquem el setSinkId del context Web Audio (el
      // render ASIO és el pas següent). Guardem el valor igualment (routing).
      if (!isHardwareEngineTarget(deviceId) && audioContext && audioContext.setSinkId) {
        try {
          await audioContext.setSinkId(deviceId);
        } catch (e) {
          console.warn('setSinkId no suportat:', e);
        }
      }
      if (!isHardwareEngineTarget(deviceId)) get().detectOutputChannels();
      get().persistGlobals();
      // El bus de Cues ha canviat: pre-descodifica els cues que ara routegen a ASIO.
      get().preloadAllAsioCues();
      // ...i els que ara routegen a WASAPI pel motor natiu (si està actiu).
      get().preloadAllNativeCues();
    },

    // Canvia el dispositiu de la Playlist (WASAPI o ASIO). Si sona, migra en calent.
    setPlaylistDevice: (deviceId) => {
      deviceId = platformTarget(deviceId);
      const oldDev = get().playlistDeviceId;
      if (oldDev === deviceId) return;
      const oldHw = isHardwareEngineTarget(oldDev);   // ASIO o natiu cpal
      const newHw = isHardwareEngineTarget(deviceId);

      // WASAPI → WASAPI (cap dels dos és motor de maquinari): canvi de sink en calent.
      if (!oldHw && !newHw) {
        set({ playlistDeviceId: deviceId });
        plSetDevice(get);
        get().persistGlobals();
        return;
      }

      // Canvi que implica ASIO o natiu (o de tipus): captura la posició actual, atura
      // el motor antic i reprèn a la nova sortida des de la mateixa posició. Si estava
      // en pausa, simplement atura (no es reprèn).
      const wasPlaying = get().playlistPlaying;
      let resumeIndex = -1, resumePos = 0;
      if (wasPlaying) {
        // Motor antic segons el target ANTIC (encara vigent): ASIO / natiu / Web Audio.
        const p = get().plIsAsio() ? plaPosition() : get().plIsNative() ? plnPosition() : plPosition();
        if (p && p.index >= 0) { resumeIndex = p.index; resumePos = Math.max(0, p.elapsed); }
      }
      get().playlistStop(); // atura el motor antic (routeja amb el deviceId encara antic)
      set({ playlistDeviceId: deviceId });
      if (wasPlaying && resumeIndex >= 0) {
        const cf = Math.max(0, get().crossfade || 0);
        // Motor nou segons el target DESTÍ.
        if (isAsioTarget(deviceId)) plaStartAt(get, set, resumeIndex, resumePos, cf);
        else if (isNativeTarget(deviceId)) plnStartAt(get, set, resumeIndex, resumePos, cf);
        else plStartAt(get, set, resumeIndex, resumePos, cf);
      }
      get().persistGlobals();
      get().closeUnusedNativeDevices(); // allibera dispositius natius que ja no s'usin
    },

    // Canvia el dispositiu del bus de Preview. Atura qualsevol preview en curs.
    setPreviewDevice: async (deviceId) => {
      deviceId = platformTarget(deviceId);
      // En canviar de dispositiu, atura qualsevol preview en curs (no es pot
      // migrar en calent entre WASAPI i ASIO).
      if (get().previewingSlot != null) get().stopPreview();
      set({ previewDeviceId: deviceId });
      // ASIO/natiu no són sinkIds WASAPI vàlids: no toquem el setSinkId del context.
      if (!isHardwareEngineTarget(deviceId)) {
        const ctx = get().previewCtx;
        if (ctx && ctx.setSinkId) { try { await ctx.setSinkId(deviceId); } catch (e) { console.warn(e); } }
      }
      get().persistGlobals();
      get().closeUnusedNativeDevices(); // allibera dispositius natius que ja no s'usin
    },

    // Assigna un color a un dispositiu de sortida (routing per grup)
    setColorOutput: (color, deviceId) => {
      set((state) => {
        const colorOutputs = { ...state.colorOutputs };
        if (!deviceId || deviceId === 'cues') delete colorOutputs[color];
        else colorOutputs[color] = platformTarget(deviceId);
        return { colorOutputs };
      });
      get().persistGlobals();
      // El routing per color ha canviat: pre-descodifica els cues que ara són ASIO.
      get().preloadAllAsioCues();
      // ...i els que ara routegen a WASAPI pel motor natiu (si està actiu).
      get().preloadAllNativeCues();
    },

    // Allibera els dispositius cpal oberts que ja no usa cap rol (cues/playlist/
    // preview) i que no sonin, perquè en canviar de sortida el vell quedi lliure.
    closeUnusedNativeDevices: () => {
      const st = get();
      // Manté oberts els dispositius cpal que algun bus (Cues, color, Playlist,
      // Preview) fa servir de debò via un target "native:…". La resta es tanquen.
      const keep = [];
      const addNative = (v) => { const t = parseTarget(v); if (t.kind === 'native') keep.push(t.device || ''); };
      addNative(st.selectedDeviceId);
      addNative(st.playlistDeviceId);
      addNative(st.previewDeviceId);
      Object.values(st.colorOutputs || {}).forEach(addNative);
      invoke('native_close_unused', { keep }).catch(() => { /* sense motor natiu */ });
    },

    // Gain mestre del bus ASIO (0..1). S'aplica al motor natiu (abans del soft clip)
    // i es desa. També es reaplica en arrencar (initAsioMaster).
    setAsioMasterGain: (v) => {
      const gain = Math.max(0, Math.min(1.5, v));
      set({ asioMasterGain: gain });
      // Un sol guany mestre per als dos motors natius (ASIO i cpal).
      invoke('asio_set_master_gain', { gain }).catch(() => { /* sense ASIO */ });
      invoke('native_set_master_gain', { gain }).catch(() => { /* sense motor natiu */ });
      get().persistGlobals();
    },
    // Aplica el gain mestre desat als motors en arrencar.
    initAsioMaster: () => {
      const gain = get().asioMasterGain ?? 1;
      invoke('asio_set_master_gain', { gain }).catch(() => { /* res */ });
      invoke('native_set_master_gain', { gain }).catch(() => { /* res */ });
      // Reaplica també la mida de buffer desada del motor natiu (frames per callback).
      invoke('native_set_buffer_size', { frames: get().nativeBufferSize ?? 0 }).catch(() => { /* sense motor natiu */ });
    },

    // Mida de buffer del motor natiu cpal (frames per callback; 0 = Auto). Un buffer
    // més gran dona marge davant pics de CPU i sol eliminar els clics/microtalls per
    // underrun, a canvi d'una mica més de latència. El motor reobre els dispositius
    // ociosos amb la mida nova; els que sonen l'agafen quan les seves veus acaben.
    setNativeBufferSize: (frames) => {
      const n = Number.isFinite(frames) ? Math.max(0, Math.floor(frames)) : 0;
      set({ nativeBufferSize: n });
      invoke('native_set_buffer_size', { frames: n }).catch(() => { /* sense motor natiu */ });
      get().persistGlobals();
    },

    // Info dels drivers ASIO carregats ara (per a les opcions de routing). Es manté
    // a la sessió perquè no es perdi en reobrir Settings.
    setAsioInfo: (info) => set({ asioInfo: info || {} }),
    // Pregunta al motor quin driver hi ha carregat ara (pel botó «Carregar» o per la
    // reproducció) i actualitza asioInfo. Cobreix el cas de reobrir el modal.
    refreshAsioLoaded: async () => {
      try {
        const li = await invoke('asio_loaded_info');
        if (li && li.name) set({ asioInfo: { [li.name]: { outs: li.outs, sample_rate: li.sample_rate } } });
        else set({ asioInfo: {} });
      } catch { /* sense ASIO */ }
    },

    // Marca/desmarca un dispositiu WASAPI com a "Usar" (curació del pool de Routing).
    // Llista buida = tots actius; en desmarcar el primer, materialitza la llista
    // completa menys aquell (així el comportament per defecte no canvia).
    toggleEnabledOutput: (deviceId) => {
      set((s) => {
        let cur = s.enabledOutputs || [];
        if (cur.length === 0) cur = (s.audioDevices || []).map((d) => d.deviceId);
        const enabledOutputs = cur.includes(deviceId)
          ? cur.filter((d) => d !== deviceId)
          : [...cur, deviceId];
        return { enabledOutputs };
      });
      get().persistGlobals();
    },

    // ── Pre-decode ASIO (dispar instantani) ───────────────────────────────────
    // Demana a Rust que descodifiqui i deixi a la cau el PCM d'un cue que routeja
    // a ASIO, perquè el seu GO no carregui la latència de descodificació (~2 s).
    // No fa res per a cues WASAPI, sense fitxer o en streaming a un altre camí.
    preloadAsioSlot: (slotId) => {
      const slot = get().slots.find((s) => s.id === slotId);
      if (!slot || !slot.filePath) return;
      // Els cues visuals (vídeo/imatge) no van pel motor d'àudio ASIO (el seu so,
      // si en tenen, és a la finestra de sortida); no els pre-descodifiquis.
      if (isVisual(slot)) return;
      // Cue llarg (streaming): NO té sentit fer-ne full-decode a la cau; el dispar ja
      // va per decode-ahead (asio_play_voice amb streaming=true). Sense aquest guard,
      // pre-descodificar un fitxer de dues hores intenta assignar GB de PCM f32 (un
      // estèreo de ~105 min ≈ 2,4 GB) i pot fer OOM a l'arrencada. Simètric a
      // preloadNativeSlot, que ja el salta.
      if (slot.isStreaming) return;
      const target = parseTarget(resolveCueTargetStr(get(), slot));
      if (target.kind !== 'asio') return;
      invoke('asio_preload', { driver: target.driver, filePath: slot.filePath })
        .catch((e) => console.warn('[asio] preload:', e));
    },

    // Pre-descodifica tots els cues carregats que routegen a ASIO. S'hi crida en
    // canviar el routing (bus de Cues o routing per color) a un driver ASIO.
    preloadAllAsioCues: () => {
      for (const s of get().slots) {
        if (s.filePath) get().preloadAsioSlot(s.id);
      }
      // P7: toca el standby l'ÚLTIM perquè quedi el més recent a la cau LRU (si el
      // pressupost s'ha superat amb tants cues, el que dispararà el proper GO no
      // ha de ser el primer a desallotjar-se).
      get().preloadStandby();
    },

    // ── Pre-decode motor NATIU cpal (dispar instantani) ───────────────────────
    // Equivalent natiu de `preloadAsioSlot`: demana a Rust que descodifiqui i deixi
    // a la cau del motor natiu el PCM d'un cue que hi routejarà, perquè el seu GO no
    // carregui la latència de descodificació (~4 s). Només actua si el motor natiu
    // està actiu i el cue surt per WASAPI (la mateixa condició que a `playSlot`).
    preloadNativeSlot: (slotId) => {
      const slot = get().slots.find((s) => s.id === slotId);
      if (!slot || !slot.filePath || isVisual(slot)) return;
      // Cue llarg (streaming): NO té sentit fer-ne full-decode a la cau; el dispar
      // ja va per decode-ahead. Saltem la precàrrega nativa.
      if (slot.isStreaming) return;
      // Mateixa decisió de routing que al dispar: només precarreguem els que routegen
      // al motor NATIU (els ASIO els cobreix preloadAsioSlot; els WASAPI, Web Audio).
      const decision = dispatchCue(get(), slot, { kind: 'preload' });
      if (decision.route !== 'native') return;
      invoke('native_preload', {
        deviceName: decision.target.device || '',
        filePath: slot.filePath,
      }).catch((e) => console.warn('[native] preload:', e));
    },

    // Pre-descodifica al motor natiu tots els cues carregats que hi routejaran.
    // S'hi crida en activar el motor natiu o en canviar-ne el dispositiu/canals.
    preloadAllNativeCues: () => {
      for (const s of get().slots) {
        if (s.filePath) get().preloadNativeSlot(s.id);
      }
      // P7: toca el standby l'últim (protecció LRU; vegeu preloadAllAsioCues).
      get().preloadStandby();
    },
  };
}
