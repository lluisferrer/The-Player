import { useEffect, useRef, useState } from 'react';
import { mediaSrc } from '../lib/mediaSrc';
import { open } from '@tauri-apps/plugin-dialog';
import { useSoundStore } from '../store/useSoundStore';
import { useAudioEngine } from '../hooks/useAudioEngine';
import { usePlaybackTime, fmtTime } from '../hooks/usePlaybackTime';
import { keyForSlot } from '../lib/keyMap';
import { hasClip, slotDuration } from '../lib/slotAudio';
import { isHardwareEngineTarget } from '../lib/outputTarget';
import { getVideoThumb } from '../lib/videoThumb';
import { mirrorTime } from '../lib/videoMirror';
import { renderPdfPageToCanvas } from '../lib/pdfRender';
import { VuMeter } from './VuMeter';
import { Waveform } from './Waveform';

export function SoundButton({ slotId }) {
  const slot           = useSoundStore((s) => s.slots.find((sl) => sl.id === slotId));
  const playSlot       = useSoundStore((s) => s.playSlot);
  const setVolume      = useSoundStore((s) => s.setVolume);
  const seekSlot       = useSoundStore((s) => s.seekSlot);
  const clearSlot      = useSoundStore((s) => s.clearSlot);
  const setLoop        = useSoundStore((s) => s.setLoop);
  const setEditingSlot = useSoundStore((s) => s.setEditingSlot);
  const setSelectedSlot = useSoundStore((s) => s.setSelectedSlot);
  const applySlotConfig = useSoundStore((s) => s.applySlotConfig);
  const setSlotMissing  = useSoundStore((s) => s.setSlotMissing);
  const previewSlot    = useSoundStore((s) => s.previewSlot);
  const stopPreview    = useSoundStore((s) => s.stopPreview);
  const previewDeviceId = useSoundStore((s) => s.previewDeviceId);
  const isDragOver     = useSoundStore((s) => s.dragOverSlot === slotId);
  const isSelected     = useSoundStore((s) => s.selectedSlot === slotId);
  const previewArmed   = useSoundStore((s) => s.previewArmed);
  const isPreviewing   = useSoundStore((s) => s.previewingSlot === slotId);
  // Reorganització de tiles (pointer drag intern): outline blanc a l'origen i al destí.
  const isTileDragging = useSoundStore((s) => s.draggingSlot === slotId);
  const isTileDropTarget = useSoundStore((s) => s.draggingSlot != null && s.draggingSlot !== slotId && s.dropTargetSlot === slotId);
  const dropEdge       = useSoundStore((s) => (s.dropTargetSlot === slotId ? s.dropEdge : null));
  const beginTileDrag  = useSoundStore((s) => s.beginTileDrag);
  const setTileDropTarget = useSoundStore((s) => s.setTileDropTarget);
  const endTileDrag    = useSoundStore((s) => s.endTileDrag);
  const reorderSlots   = useSoundStore((s) => s.reorderSlots);
  const insertSlotContent = useSoundStore((s) => s.insertSlotContent);
  const setSlidePages  = useSoundStore((s) => s.setSlidePages);
  const isLive         = useSoundStore((s) => s.appMode === 'live'); // LIVE: edició bloquejada
  const { loadFromPath } = useAudioEngine();
  const pdfCanvasRef   = useRef(null);   // canvas del mirall/preview de slides al tile

  const [showHover, setShowHover]   = useState(false);
  const [showArming, setShowArming] = useState(false); // P4-lite: mostra "armant" només si persisteix
  const [scrub, setScrub]   = useState(null);  // posició (ratio dins segment) mentre s'arrossega el playhead
  const [seeking, setSeeking] = useState(false);
  const [previewProg, setPreviewProg] = useState(0); // progrés del preview (0..1)
  const [thumb, setThumb] = useState(null); // miniatura del cue de vídeo (dataURL)
  const [vidElapsed, setVidElapsed] = useState(0); // temps de reproducció estimat del vídeo (s)
  const [vidSeeking, setVidSeeking] = useState(false); // arrossegant el playhead del vídeo
  const [previewVidPct, setPreviewVidPct] = useState(0); // playhead del preview de vídeo (0..100, dins el segment)
  const [browsePage, setBrowsePage] = useState(1); // pàgina de FULLEIG local del PDF (Ctrl+clic), sense projectar
  const previewVidRef = useRef(null);  // <video> del preview in-tile
  const playVidRef = useRef(null);     // <video> mirall de la reproducció (monitor al tile)
  const vidBodyRef = useRef(null);
  const scrubRef = useRef(null);
  const suppressClickRef = useRef(false); // evita que el click post-drag faci play/stop
  const waveRef = useRef(null);
  const rootRef = useRef(null);       // arrel del tile (per a la captura de pointer)
  const tileDragRef = useRef(null);   // estat del drag de reorganització en curs

  const hasAudio  = hasClip(slot);
  const isVideoCue = slot.mediaType === 'video';
  const isImageCue = slot.mediaType === 'image';
  const isPdfCue = slot.mediaType === 'pdf';
  const isVisualCue = isVideoCue || isImageCue || isPdfCue;
  const isStreaming = slot.isStreaming;
  const isPlaying = slot.isPlaying;

  const { elapsed, duration, progress } = usePlaybackTime(slot);

  // Tram retallat i durada del segment
  const total      = hasAudio ? slotDuration(slot) : 0;
  const startSec   = hasAudio ? Math.max(0, slot.startPoint || 0) : 0;
  const stopSec    = hasAudio ? (slot.stopPoint ?? total) : 0;
  const segDur     = Math.max(0, stopSec - startSec);
  const startRatio = total ? startSec / total : 0;
  const stopRatio  = total ? stopSec / total : 1;

  // Posició del playhead (fracció del buffer sencer)
  const headRatio  = scrub != null ? scrub : progress;
  const playheadPct = total ? ((startSec + headRatio * segDur) / total) * 100 : 0;

  // Drag del playhead (salt en deixar anar)
  useEffect(() => {
    if (!seeking) return;
    const onMove = (e) => {
      const wrap = waveRef.current;
      if (!wrap) return;
      const rect = wrap.getBoundingClientRect();
      const bufRatio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
      const segRatio = segDur > 0
        ? Math.min(1, Math.max(0, (bufRatio * total - startSec) / segDur))
        : 0;
      scrubRef.current = segRatio;
      setScrub(segRatio);
    };
    const onUp = (e) => {
      // Només fa el salt si es deixa anar dins del rectangle de l'ona;
      // si es deixa anar fora del cue, cancel·la (no salta ni atura)
      const wrap = waveRef.current;
      let inside = false;
      if (wrap) {
        const r = wrap.getBoundingClientRect();
        inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
      }
      const v = scrubRef.current;
      setSeeking(false);
      setScrub(null);
      scrubRef.current = null;
      if (inside && v != null) seekSlot(slotId, v);
      // Neteja el flag després que s'hagi disparat (i ignorat) el click del botó
      setTimeout(() => { suppressClickRef.current = false; }, 0);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [seeking, segDur, total, startSec, slotId, seekSlot]);

  // Progrés del preview (per al playhead vermell), llegint el context de preview
  useEffect(() => {
    if (!isPreviewing) { setPreviewProg(0); return; }
    let raf;
    const tick = () => {
      const st = useSoundStore.getState();
      // Playhead del preview per RELLOTGE JS (ancorat a previewStartedAt en
      // performance.now), igual per a ASIO, WASAPI buffer i streaming. Reseteja
      // net a cada cue, sense dependre de telemetria ni del rellotge del context.
      if (segDur > 0 && st.previewStartedAt > 0) {
        let pos = performance.now() / 1000 - st.previewStartedAt;
        if (slot.loop) pos = ((pos % segDur) + segDur) % segDur;
        pos = Math.max(0, Math.min(pos, segDur));
        setPreviewProg(pos / segDur);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [isPreviewing, segDur, slot.loop]);

  const previewPlayheadPct = total ? ((startSec + previewProg * segDur) / total) * 100 : 0;

  // Miniatura del cue de vídeo (async, en segon pla; de cau si ja existeix).
  // No bloqueja la UI ni peta si el fitxer no existeix (retorna null).
  useEffect(() => {
    if (!slot.filePath) { setThumb(null); return; }
    // Imatge fixa: la miniatura és la pròpia imatge (sense generar fotograma)
    if (isImageCue) { setThumb(mediaSrc(slot.filePath)); return; }
    if (!isVideoCue) { setThumb(null); return; }
    let cancel = false;
    const seekAt = Math.max(0.1, slot.startPoint || 0);
    getVideoThumb(slot.filePath, seekAt).then((url) => {
      if (!cancel && url) setThumb(url);
    });
    return () => { cancel = true; };
  }, [isVideoCue, isImageCue, slot.filePath, slot.startPoint]);

  // En entrar al mode FULLEIG (Ctrl+clic sobre un PDF), arrenca el browse a la pàgina
  // que ja es veu: la projectada si sona, si no la portada (1). No es reinicia a cada
  // canvi de currentPage per no interrompre el fulleig (només en entrar-hi).
  useEffect(() => {
    if (isPdfCue && isPreviewing) setBrowsePage(slot.currentPage || 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPdfCue, isPreviewing]);

  // Si el PDF es projecta (GO o clic normal) mentre el fullejàvem, surt del fulleig:
  // la projecció mana i el tile passa a emmirallar la pàgina projectada.
  useEffect(() => {
    if (isPdfCue && isPlaying && isPreviewing) stopPreview();
  }, [isPdfCue, isPlaying, isPreviewing, stopPreview]);

  // Slides (PDF): mirall de la pàgina al tile. En mode FULLEIG (Ctrl+clic) mostra la
  // pàgina que s'està browsejant (browsePage) SENSE projectar-la; si no, mentre sona
  // mostra la pàgina projectada (slot.currentPage) i, aturat, la 1 com a portada.
  // Reaprofita la cau de documents (passar de pàgina no rellegeix el PDF). De passada
  // informa el recompte de pàgines perquè "x / N" surti també abans de GO.
  useEffect(() => {
    if (!isPdfCue || !slot.filePath) { return; }
    const canvas = pdfCanvasRef.current;
    if (!canvas) return;
    let cancel = false;
    const page = isPlaying ? (slot.currentPage || 1) : (isPreviewing ? browsePage : 1);
    renderPdfPageToCanvas(slot.filePath, page, canvas)
      .then((n) => {
        if (cancel) return;
        if (n && n !== slot.pageCount) setSlidePages(slotId, n); // idempotent
      })
      .catch(() => { /* fitxer no trobat o render cancel·lat: sense mirall */ });
    return () => { cancel = true; };
    // slot.pageCount s'omet expressament: només l'escrivim (evita re-render en bucle)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPdfCue, slot.filePath, isPlaying, slot.currentPage, isPreviewing, browsePage, slotId]);

  // P4-lite: estat "armant" (veu de maquinari disparada, telemetria encara no
  // arribada). Només el mostrem si PERSISTEIX >300 ms: els cues sans confirmen en
  // ~100 ms i van directes a blau (cap flaix ambre); si l'ambre apareix, és que la
  // veu no ha arrencat de debò. El reconciliador el reseteja als 2 s.
  useEffect(() => {
    const arming = isPlaying && slot.arming && (slot.asioActive || slot.nativeActive);
    if (!arming) { setShowArming(false); return; }
    const t = setTimeout(() => setShowArming(true), 300);
    return () => clearTimeout(t);
  }, [isPlaying, slot.arming, slot.asioActive, slot.nativeActive]);

  // Temps/playhead estimat del cue de vídeo (es reprodueix a la sortida, així que
  // l'estimem localment des de l'instant de dispar; el vídeo no es pausa).
  useEffect(() => {
    // Pausat: playhead congelat a la posició de pausa (no reiniciar a 0).
    if (isVideoCue && slot.pausedAt != null) { setVidElapsed(Math.max(0, slot.pausedAt)); return; }
    if (!(isVideoCue && isPlaying)) { setVidElapsed(0); return; }
    let raf;
    const tick = () => {
      let e = performance.now() / 1000 - (slot.startedAt || 0);
      if (segDur > 0) e = slot.loop ? (e % segDur) : Math.min(e, segDur);
      setVidElapsed(Math.max(0, e));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [isVideoCue, isPlaying, slot.pausedAt, segDur, slot.startedAt, slot.loop]);

  // Arrossegar el playhead del tile de vídeo: seek en directe (sense aturar)
  const handleVideoPlayheadDown = (e) => {
    e.stopPropagation();
    e.preventDefault();
    if (isLive) return; // LIVE: seek bloquejat
    suppressClickRef.current = true; // evita que el click post-drag aturi el cue
    setVidSeeking(true);
  };
  useEffect(() => {
    if (!vidSeeking) return;
    const seekFromX = (clientX) => {
      const el = vidBodyRef.current;
      if (!el || segDur <= 0) return;
      const r = el.getBoundingClientRect();
      if (r.width <= 0) return;
      const ratio = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
      useSoundStore.getState().seekVideo(slotId, ratio * segDur);
    };
    const onMove = (ev) => seekFromX(ev.clientX);
    const onUp = () => {
      setVidSeeking(false);
      // Neteja el flag després que s'hagi disparat (i ignorat) el click del botó
      setTimeout(() => { suppressClickRef.current = false; }, 0);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [vidSeeking, segDur, slotId]);

  // ── Preview in-tile del cue de vídeo (PFL) ──
  // El so del preview de vídeo:
  //   - ASIO/natiu: el WebView no hi pot enrutar el <video> → l'àudio surt pel MOTOR
  //     cap al bus de preview (vegeu preview.js) i aquí el <video> va MUT (només imatge).
  //   - WASAPI concret: enruta el so del <video> a aquell dispositiu amb setSinkId.
  //   - default: so pel dispositiu per defecte del WebView.
  // Després posa el volum del cue, salta al punt d'inici i arrenca. El <video> viu
  // només es munta mentre isPreviewing (un alhora).
  const handlePreviewLoaded = async () => {
    const v = previewVidRef.current;
    if (!v) return;
    const dev = previewDeviceId;
    if (isHardwareEngineTarget(dev)) {
      v.muted = true; // l'àudio el treu el motor (ASIO/natiu); el <video> només imatge
    } else if (typeof v.setSinkId === 'function' && dev && dev !== 'default') {
      try { await v.setSinkId(dev); v.muted = false; } catch { v.muted = false; }
    } else {
      v.muted = false; // default: so pel dispositiu per defecte del WebView
    }
    try { v.volume = slot.volume ?? 0.8; } catch { /* res */ }
    if (startSec > 0) { try { v.currentTime = startSec; } catch { /* res */ } }
    v.play().catch(() => { /* l'autoplay pot fallar fins a interacció */ });
  };

  // Vigila el segment del preview: playhead + loop/stop al punt d'out
  const handlePreviewTime = () => {
    const v = previewVidRef.current;
    if (!v) return;
    if (segDur > 0) setPreviewVidPct(Math.min(100, Math.max(0, ((v.currentTime - startSec) / segDur) * 100)));
    if (slot.stopPoint != null && v.currentTime >= stopSec) {
      if (slot.loop) { try { v.currentTime = startSec; } catch { /* res */ } }
      else stopPreview();
    }
  };

  // Final natural del fitxer: rebobina si hi ha loop, si no atura el preview
  const handlePreviewEnded = () => {
    if (slot.loop) {
      const v = previewVidRef.current;
      if (v) { try { v.currentTime = startSec; v.play().catch(() => {}); } catch { /* res */ } }
      return;
    }
    stopPreview();
  };

  // ── Mirall de reproducció al tile (monitor) ──
  // Un <video> MUT que reflecteix la reproducció del cue de vídeo (l'àudio ja surt
  // per la finestra de sortida o pel motor). En muntar-se, se situa a la posició
  // actual (startSec + temps ja transcorregut) per no reiniciar si el tile apareix
  // amb el cue ja sonant (p. ex. en canviar de pàgina). Loop/stop al punt d'out.
  // Posició objectiu del mirall: la REAL de la sortida (videoMirror) si n'hi ha; si
  // no (encara no ha arribat cap difusió), el rellotge de paret com a fallback.
  const mirrorTarget = () => {
    const out = mirrorTime(slotId);
    return out != null ? out : startSec + Math.max(0, vidElapsed || 0);
  };
  const handlePlayVidLoaded = () => {
    const v = playVidRef.current;
    if (!v) return;
    v.muted = true;
    try { v.currentTime = mirrorTarget(); } catch { /* res */ }
    v.play().catch(() => { /* autoplay pot fallar fins a interacció */ });
  };
  const handlePlayVidTime = () => {
    const v = playVidRef.current;
    if (!v || slot.pausedAt != null) return; // pausat: no re-alineïs (frame congelat)
    // Segueix la posició REAL de la sortida: el <video> mut del tile no està
    // rate-locked i, sol, derivaria volta rere volta del loop. Corregim si la
    // deriva passa el llindar (inclou la volta del loop, quan la sortida ja ha
    // saltat a startPoint i el target baixa de cop).
    const target = mirrorTarget();
    if (Math.abs(v.currentTime - target) > 0.2) {
      try { v.currentTime = target; } catch { /* res */ } }
  };
  const handlePlayVidEnded = () => {
    if (!slot.loop) return;
    const v = playVidRef.current;
    // Final natural (loop del fitxer sencer): reprèn seguint la sortida.
    if (v) { try { v.currentTime = mirrorTarget(); v.play().catch(() => {}); } catch { /* res */ } }
  };

  // Sincronitza pausa/represa del mirall amb l'estat del cue.
  useEffect(() => {
    const v = playVidRef.current;
    if (!v) return;
    if (slot.pausedAt != null) { try { v.pause(); } catch { /* res */ } }
    else { v.play().catch(() => {}); }
  }, [slot.pausedAt]);

  const handleClick = async (e) => {
    // Ignora el click immediatament posterior a arrossegar el playhead
    if (suppressClickRef.current) return;
    // Ctrl+clic → preview (in-tile per a vídeo; bus de preview per a àudio)
    if (e.ctrlKey && hasAudio) { previewSlot(slotId); return; }
    setSelectedSlot(slotId);

    // C2: slot marcat com a "missing" → reintenta carregar el fitxer des del disc.
    // L'usuari haurà de tornar a clicar un cop el fitxer s'hagi carregat.
    if (slot.missing && slot.filePath) {
      const cfg = { ...slot };
      try {
        await loadFromPath(slotId, slot.filePath);
        applySlotConfig(slotId, cfg);
        // Si la recàrrega va bé, loadAudio ja posa missing:false internament,
        // però ho fem explícit per seguretat
        setSlotMissing(slotId, false);
      } catch {
        // Continua missing; l'usuari haurà de tornar a intentar-ho
      }
      return; // no reproduïm fins que el fitxer estigui carregat
    }

    if (hasAudio) playSlot(slotId);
  };

  // Fulleig del PDF al tile (±1), acotat a [1, pageCount] quan es coneix. Només mou
  // la pàgina LOCAL de preview (browsePage): no toca la projecció ni l'estat del cue.
  const browsePdf = (delta, e) => {
    e.stopPropagation();
    const pc = slot.pageCount || 0;
    setBrowsePage((p) => Math.max(1, pc ? Math.min(p + delta, pc) : p + delta));
  };

  // Clic dret: obre el selector natiu de fitxers (retorna la ruta)
  const handleContextMenu = async (e) => {
    e.preventDefault();
    if (isLive) return; // LIVE: carregar fitxers és una mutació
    try {
      const path = await open({
        multiple: false,
        filters: [{ name: 'Media', extensions: ['mp3', 'mpeg', 'mpg', 'm4a', 'aac', 'wav', 'ogg', 'flac', 'mp4', 'webm', 'm4v', 'mov', 'jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'pdf'] }],
      });
      if (path) await loadFromPath(slotId, path);
    } catch (err) {
      console.warn('No s\'ha pogut obrir el fitxer:', err);
    }
  };

  const handleVolumeChange = (e) => {
    e.stopPropagation();
    setVolume(slotId, parseFloat(e.target.value));
  };

  // En deixar anar el slider, treu-li el focus perquè les tecles de transport
  // (espai/enter/fletxes) tornin a actuar sobre el slot i no sobre el range.
  const handleVolumeRelease = (e) => {
    e.stopPropagation();
    e.currentTarget.blur();
  };

  const handleEdit = (e) => {
    e.stopPropagation();
    if (isLive) return;
    setEditingSlot(slotId);
  };

  const handleDelete = (e) => {
    e.stopPropagation();
    if (isLive) return;
    clearSlot(slotId);
  };

  const handleLoopToggle = (e) => {
    e.stopPropagation();
    setLoop(slotId, !slot.loop);
  };

  const handlePlayheadDown = (e) => {
    e.stopPropagation();
    e.preventDefault();
    if (isLive) return; // LIVE: no es reposiciona la reproducció (seek bloquejat)
    suppressClickRef.current = true;
    scrubRef.current = progress;
    setScrub(progress);
    setSeeking(true);
  };

  // ── Reorganització del tile per arrossegament (pointer) ──
  // Comença NOMÉS des del cos del tile (no des de slider, botons ni el playhead) i
  // només si té contingut. El drag s'activa en superar un llindar de moviment; així
  // un clic net segueix disparant el cue. L'outline blanc (origen/destí) el pinta el
  // CSS via les classes tile-dragging / tile-drop-target.
  const handleTilePointerDown = (e) => {
    if (isLive) return; // LIVE: no es reorganitzen tiles
    if (e.button !== 0 || !(hasAudio || slot.label)) return;
    if (e.target.closest('input, button, .slot-playhead')) return;
    tileDragRef.current = { x: e.clientX, y: e.clientY, pid: e.pointerId, active: false };
  };
  const handleTilePointerMove = (e) => {
    const d = tileDragRef.current;
    if (!d) return;
    if (!d.active) {
      if (Math.hypot(e.clientX - d.x, e.clientY - d.y) < 6) return; // llindar anti-clic
      d.active = true;
      suppressClickRef.current = true; // en soltar, no disparar el cue
      beginTileDrag(slotId);
      try { rootRef.current?.setPointerCapture(d.pid); } catch { /* res */ }
    }
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const tile = el && el.closest('[data-slot-id]');
    if (!tile) { setTileDropTarget(null, null); return; }
    const tid = Number(tile.getAttribute('data-slot-id'));
    // Vora d'inserció: sobre un tile PLE, el 30% esquerre = insert abans, el 30%
    // dret = insert després, el centre = swap. Sobre un buit, sempre "a sobre" (move).
    let edge = null;
    if (tid !== slotId) {
      const ts = useSoundStore.getState().slots.find((s) => s.id === tid);
      if (ts && (ts.filePath || ts.label)) {
        const r = tile.getBoundingClientRect();
        const fx = (e.clientX - r.left) / r.width;
        if (fx < 0.30) edge = 'before';
        else if (fx > 0.70) edge = 'after';
      }
    }
    setTileDropTarget(tid, edge);
  };
  const handleTilePointerUp = () => {
    const d = tileDragRef.current;
    tileDragRef.current = null;
    if (!d) return;
    try { rootRef.current?.releasePointerCapture(d.pid); } catch { /* res */ }
    if (!d.active) return;
    const { dropTargetSlot: target, dropEdge: edge } = useSoundStore.getState();
    endTileDrag();
    if (target != null && target !== slotId) {
      if (edge === 'before' || edge === 'after') insertSlotContent(slotId, target, edge === 'before');
      else reorderSlots(slotId, target);
    }
    // Empassa el click sintètic posterior i reactiva després
    setTimeout(() => { suppressClickRef.current = false; }, 0);
  };
  const handleTilePointerCancel = () => {
    if (tileDragRef.current?.active) endTileDrag();
    tileDragRef.current = null;
    suppressClickRef.current = false;
  };

  const paused = hasAudio && slot.pausedAt != null;
  // Reproduint o pausat: temps transcorregut; aturat: durada total
  const timeLabel = hasAudio ? fmtTime((isPlaying || paused) ? elapsed : duration) : '';

  // Tile de vídeo: temps i playhead estimats sobre el segment (in→out)
  const vidPlayheadPct = segDur > 0 ? Math.min(100, (vidElapsed / segDur) * 100) : 0;
  const vidTimeLabel = fmtTime((isPlaying || slot.pausedAt != null) ? vidElapsed : segDur);

  const occupied = hasAudio || Boolean(slot.label);

  let stateClass = 'slot-empty';
  if (hasAudio) stateClass = 'slot-loaded';
  if (paused) stateClass = 'slot-paused';
  if (isPlaying) stateClass = 'slot-playing';
  if (showArming) stateClass = 'slot-arming'; // P4-lite: armant persistent (>300ms)
  // C2: el fitxer tenia ruta però no s'ha pogut localitzar en arrencar
  const isMissing = slot.missing && slot.filePath;

  // Nom mostrat: nom custom si n'hi ha, si no el nom del fitxer (sense extensió)
  const fileName = slot.filePath ? slot.filePath.split(/[\\/]/).pop() : '';
  const truncatedLabel = (slot.label || fileName).replace(/\.[^/.]+$/, '');
  const keyLabel = keyForSlot(((slotId - 1) % 32) + 1).toUpperCase();

  return (
    <div
      ref={rootRef}
      className={`sound-button ${stateClass} ${isMissing ? 'slot-missing' : ''} ${slot.error ? 'slot-error' : ''} ${isDragOver ? 'drag-over' : ''} ${isSelected ? 'selected' : ''} ${(isSelected && hasAudio) ? 'slot-standby' : ''} ${(previewArmed && hasAudio) ? 'preview-armed' : ''} ${isPreviewing ? 'previewing' : ''} ${isTileDragging ? 'tile-dragging' : ''} ${isTileDropTarget && !dropEdge ? 'tile-drop-target' : ''}`}
      data-slot-id={slotId}
      onClick={handleClick}
      onContextMenu={handleContextMenu}
      onMouseEnter={() => setShowHover(true)}
      onMouseLeave={() => setShowHover(false)}
      onPointerDown={handleTilePointerDown}
      onPointerMove={handleTilePointerMove}
      onPointerUp={handleTilePointerUp}
      onPointerCancel={handleTilePointerCancel}
      title={hasAudio ? slot.label : 'Drag an audio file or right-click to open'}
    >
      {/* Barra d'inserció (reorg): marca on caurà el contingut si es deixa anar */}
      {isTileDropTarget && dropEdge === 'before' && <div className="tile-insert-bar before" />}
      {isTileDropTarget && dropEdge === 'after' && <div className="tile-insert-bar after" />}

      {slot.color && <div className="slot-color-bar" style={{ background: slot.color }} />}

      {/* Indicador de standby: cue que es dispararà amb el proper GO */}
      {isSelected && hasAudio && <span className="slot-standby-badge">NEXT</span>}

      {/* Error de reproducció persistent (voice-failed): badge vermell; el missatge
          complet al title (hover). Es neteja en tornar a disparar amb èxit o recarregar. */}
      {slot.error && <span className="slot-error-badge" title={slot.error}>ERROR</span>}

      {/* Badges d'opcions (cantonada inferior esquerra):
          SO = stop others · AC = auto-continue · D = ducking · S = stop playlist */}
      {hasAudio && (slot.stopOthers || slot.continueMode === 'auto' || slot.duck || slot.stopPlaylist) && (
        <div className="slot-badges">
          {slot.stopOthers && <span className="slot-badge so" title="Stop others">SO</span>}
          {slot.continueMode === 'auto' && <span className="slot-badge ac" title="Auto-continue">AC</span>}
          {slot.duck && <span className="slot-badge duck" title="Duck playlist">D</span>}
          {slot.stopPlaylist && <span className="slot-badge stop" title="Stop playlist">S</span>}
        </div>
      )}

      {slot.loading && (
        <div className="slot-loading"><span className="slot-spinner" /></div>
      )}

      {/* Capçalera: nom (esq) + loop + eliminar + tecla (dre) */}
      <div className="slot-header">
        <span className="slot-name">{truncatedLabel}</span>
        {hasAudio && !isLive && (
          <button
            className={`slot-loop-btn ${slot.loop ? 'active' : ''}`}
            onClick={handleLoopToggle}
            title="Loop (repeat this cue)"
          >
            ⟳
          </button>
        )}
        {occupied && !isLive && (
          <button
            className={`slot-del-btn ${showHover ? 'visible' : ''}`}
            onClick={handleDelete}
            title="Remove clip"
          >
            ✕
          </button>
        )}
        {keyLabel && <span className="slot-key" title={`Key: ${keyLabel}`}>{keyLabel}</span>}
      </div>

      {hasAudio && isVisualCue ? (
        /* Cue visual (vídeo o imatge): miniatura de fons + badge. Es reprodueix
           a la finestra de sortida, no per Web Audio. Les imatges no tenen
           timeline, playhead, preview viu ni so. */
        <>
          <div className={`slot-body slot-video ${thumb || isPdfCue ? 'has-thumb' : ''}`} ref={vidBodyRef}>
            {thumb && (
              <div className="slot-video-thumb" style={{ backgroundImage: `url(${thumb})` }} />
            )}
            {/* Slides: mirall de la pàgina projectada (monitor al tile) */}
            {isPdfCue && <canvas ref={pdfCanvasRef} className="slot-pdf-canvas" />}
            {/* Fulleig (Ctrl+clic): fletxes semitransparents per passar de pàgina AL
                TILE, sense projectar a la sortida. Es surt amb un altre Ctrl+clic. */}
            {isPdfCue && isPreviewing && !isPlaying && (
              <>
                <button
                  className="slot-pdf-nav prev"
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={(e) => browsePdf(-1, e)}
                  title="Previous page"
                >‹</button>
                <button
                  className="slot-pdf-nav next"
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={(e) => browsePdf(1, e)}
                  title="Next page"
                >›</button>
              </>
            )}
            {/* Preview in-tile (PFL): vídeo viu sobre la miniatura, un sol alhora */}
            {isVideoCue && isPreviewing && (
              <video
                ref={previewVidRef}
                className="slot-video-preview"
                src={mediaSrc(slot.filePath)}
                onLoadedMetadata={handlePreviewLoaded}
                onTimeUpdate={handlePreviewTime}
                onEnded={handlePreviewEnded}
                autoPlay
              />
            )}
            {/* Mirall de reproducció: vídeo MUT que reflecteix el que sona a la
                sortida (l'àudio ja surt per la finestra/motor). Es manté en pausa
                (frame congelat). El preview té prioritat. */}
            {isVideoCue && (isPlaying || slot.pausedAt != null) && !isPreviewing && (
              <video
                ref={playVidRef}
                className="slot-video-preview"
                src={mediaSrc(slot.filePath)}
                muted
                onLoadedMetadata={handlePlayVidLoaded}
                onTimeUpdate={handlePlayVidTime}
                onEnded={handlePlayVidEnded}
                autoPlay
              />
            )}
            {/* Temps (només vídeo; imatges i slides no tenen durada) */}
            {isVideoCue && <span className="slot-time">{vidTimeLabel}</span>}
            {/* Slides: indicador de pàgina/total mentre es projecta o es fulleja */}
            {isPdfCue && (isPlaying || isPreviewing) && (
              <span className="slot-time">{(isPlaying ? (slot.currentPage || 1) : browsePage)}{slot.pageCount ? ` / ${slot.pageCount}` : ''}</span>
            )}
            {/* Badge del cue visual (mateix estil que STREAM dels àudios llargs) */}
            <span className="slot-stream-badge">{isPdfCue ? ((isPreviewing && !isPlaying) ? 'PREVIEW' : 'SLIDES') : isImageCue ? 'IMAGE' : (isPreviewing ? 'PREVIEW' : 'VIDEO')}</span>
            {/* Playhead del preview (vermell) mentre es previsualitza al tile (vídeo) */}
            {isVideoCue && isPreviewing && (
              <div className="slot-playhead preview" style={{ left: `${previewVidPct}%` }} />
            )}
            {/* Playhead arrossegable mentre es reprodueix o està pausat a la sortida */}
            {isVideoCue && (isPlaying || slot.pausedAt != null) && (
              <div
                className="slot-playhead"
                style={{ left: `${vidPlayheadPct}%` }}
                onPointerDown={handleVideoPlayheadDown}
                title="Drag to move position"
              />
            )}
            {!isLive && (
              <button
                className={`slot-edit-btn ${showHover ? 'visible' : ''}`}
                onClick={handleEdit}
                title="Edit cue (in/out, fades)"
              >
                ✎
              </button>
            )}
          </div>
          {/* Slider de volum: només vídeo (les imatges no tenen so) */}
          {isVideoCue && (
            <div className="slot-volume" onClick={(e) => e.stopPropagation()}>
              <input
                type="range" min="0" max="1" step="0.01"
                value={slot.volume}
                onChange={handleVolumeChange}
                onMouseUp={handleVolumeRelease}
                onTouchEnd={handleVolumeRelease}
                title={`Volume: ${Math.round(slot.volume * 100)}%`}
                style={{ background: `linear-gradient(to right, var(--accent) ${slot.volume * 100}%, var(--border) ${slot.volume * 100}%)` }}
              />
              <span className={`volume-value ${showHover ? 'visible' : ''}`}>
                {Math.round(slot.volume * 100)}%
              </span>
            </div>
          )}
        </>
      ) : hasAudio ? (
        <>
          {/* Cos: forma d'ona (amb playhead) al centre + picòmetre a la dreta */}
          <div className="slot-body">
            <div className="slot-waveform" ref={waveRef}>
              <Waveform
                audioBuffer={slot.audioBuffer}
                peaks={slot.peaks}
                active={isPlaying}
                startRatio={startRatio}
                stopRatio={stopRatio}
              />
              {/* Visualitzador de temps (dalt-dreta) */}
              <span className="slot-time">{timeLabel}</span>
              {/* Cue llarg en streaming: badge + indicador mentre es genera la forma d'ona.
                  No es mostra si el tile encara té l'spinner de càrrega (slot.loading),
                  per no duplicar la rodoneta: en deixem només una per tile. */}
              {isStreaming && <span className="slot-stream-badge">STREAM</span>}
              {isStreaming && !slot.peaks && !slot.peaksDone && !slot.loading && (
                <span className="slot-wave-loading"><span className="slot-spinner small" /></span>
              )}
              {/* Playhead interactiu (mentre sona o en pausa) */}
              {(isPlaying || paused) && (
                <div
                  className="slot-playhead"
                  style={{ left: `${playheadPct}%` }}
                  onPointerDown={handlePlayheadDown}
                  title="Drag to move position"
                />
              )}
              {/* Playhead vermell del preview */}
              {isPreviewing && (
                <div className="slot-playhead preview" style={{ left: `${previewPlayheadPct}%` }} />
              )}
              {/* Botó d'edició (hover) */}
              <button
                className={`slot-edit-btn ${showHover ? 'visible' : ''}`}
                onClick={handleEdit}
                title="Edit cue (in/out, fades)"
              >
                ✎
              </button>
            </div>
            <div className="slot-vu">
              <VuMeter analyserNode={slot.analyserNode} isPlaying={isPlaying} asioId={(slot.asioActive || slot.nativeActive) ? slotId : null} />
            </div>
          </div>

          {/* Slider de volum */}
          <div className="slot-volume" onClick={(e) => e.stopPropagation()}>
            <input
              type="range"
              min="0"
              max="1"
              step="0.01"
              value={slot.volume}
              onChange={handleVolumeChange}
              onMouseUp={handleVolumeRelease}
              onTouchEnd={handleVolumeRelease}
              title={`Volume: ${Math.round(slot.volume * 100)}%`}
              style={{
                background: `linear-gradient(to right, var(--accent) ${slot.volume * 100}%, var(--border) ${slot.volume * 100}%)`,
              }}
            />
            <span className={`volume-value ${showHover ? 'visible' : ''}`}>
              {Math.round(slot.volume * 100)}%
            </span>
          </div>
        </>
      ) : (
        <div className={`slot-empty-hint${isMissing ? ' slot-missing-hint' : ''}`}>
          {isMissing
            ? 'FILE MISSING · click to reload'
            : isDragOver ? 'Drop here' : (slot.label ? 'reassign' : '')}
        </div>
      )}
    </div>
  );
}
