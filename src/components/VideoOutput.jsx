import { useEffect, useRef, useState } from 'react';
import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import { listen, emit } from '@tauri-apps/api/event';
import { pdfjsLib } from '../lib/pdfjs';
import { ColorBars, TestCard } from './VideoTestPatterns';
import './VideoOutput.css';

// Llegeix la config de blackout inicial del localStorage (compartit amb la
// finestra principal, mateix origen): patró ('black' | 'bars' | 'testcard' |
// 'custom'), ruta de la imatge de fons i encaix ('cover' | 'contain').
function readIdleConfig() {
  try {
    const g = JSON.parse(localStorage.getItem('the-player-globals')) || {};
    const pattern = ['black', 'bars', 'testcard', 'custom'].includes(g.videoIdlePattern) ? g.videoIdlePattern : 'black';
    return {
      pattern,
      image: g.videoIdleImage || null,
      fit: g.videoIdleImageFit === 'contain' ? 'contain' : 'cover',
    };
  } catch { return { pattern: 'black', image: null, fit: 'cover' }; }
}

// Vista de la finestra de sortida (label "output"). Ocupa tota la finestra
// amb fons negre i mostra un <video> a pantalla completa quan rep events de
// Tauri. Imatge i so van junts a la sortida (model decidit a la Fase 4c).
//
// 4c afegeix, sobre l'in/out ja honorat:
//   - Volum base (slot.volume) i routing de sortida (setSinkId per deviceId)
//   - Fade in: volum 0→volume i opacitat 0→1 durant fadeIn segons
//   - Fade out: volum→0 i opacitat→0 durant fadeOut abans de stopPoint
//   - Loop: en arribar a stopPoint, torna a startPoint (sense re-fade, ignora fade out)
//
// Events escoltats:
//   video-play  { filePath, startPoint, stopPoint, volume, fadeIn, fadeOut, deviceId, loop, slotId }
//   video-stop                            → atura i amaga el vídeo (negre)
//   video-black                           → igual que stop (go to black)
export function VideoOutput() {
  const videoRef = useRef(null);
  const currentSlot = useRef(null);        // slotId del vídeo en curs (per informar del final)
  // Paràmetres del cue actual (en segons / 0..1). En una ref perquè estiguin
  // disponibles als handlers del <video> encara que es munti després.
  const playInfo = useRef({
    startPoint: 0, stopPoint: 0, volume: 0.8, fadeIn: 0, fadeOut: 0, deviceId: 'default', loop: false, muted: false,
  });
  const rafRef = useRef(null);             // id del requestAnimationFrame del fade de volum
  const fadingOut = useRef(false);         // ja s'ha llançat el fade out d'aquest segment?
  const stopTimerRef = useRef(null);       // timer del negre diferit després d'un stop amb fade
  const kindRef = useRef(null);            // tipus de mèdia mostrat ara: 'video' | 'image' | null (negre)
  const [src, setSrc] = useState(null);    // URL convertida del fitxer (o null = blackout)
  const [mediaKind, setMediaKind] = useState('video'); // 'video' | 'image' | 'pdf' (què renderitzem)
  // ── Slides (PDF) ──
  const canvasRef = useRef(null);          // canvas VISIBLE on es fa el swap de la pàgina
  const pdfDocRef = useRef(null);          // PDFDocumentProxy carregat (o null)
  const pdfTasksRef = useRef(new Set());   // tasques de render en vol (per cancel·lar-les en netejar)
  const pdfCacheRef = useRef(new Map());   // cau pàgina→canvas ja renderitzat (evita el blanc en passar pàgina)
  const pdfPrefetchRef = useRef(new Set());// pàgines amb prefetch en vol (per no duplicar feina)
  const pdfSlotRef = useRef(null);         // slotId del PDF (per informar slide-pages)
  const pdfFadeInPending = useRef(false);  // revelar (fade/tall) quan la 1a pàgina del cue nou ja s'ha pintat
  const [pdfPath, setPdfPath] = useState(null); // ruta del PDF projectat (o null)
  const [pdfPage, setPdfPage] = useState(1);    // pàgina actual (1-based)
  const [pdfReady, setPdfReady] = useState(false); // document carregat i llest per renderitzar
  const [opacity, setOpacity] = useState(1); // opacitat del mèdia (fades visuals cap a negre)
  const [fadeDur, setFadeDur] = useState(0); // durada (s) de la transició d'opacitat actual
  const [idleConfig, setIdleConfig] = useState(readIdleConfig); // patró + imatge + encaix de blackout
  const { pattern: idlePattern, image: idleImage, fit: idleFit } = idleConfig;

  // Cancel·la el rAF de fade de volum i el timer de negre diferit pendents
  const cancelFade = () => {
    if (rafRef.current != null) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
    if (stopTimerRef.current != null) { clearTimeout(stopTimerRef.current); stopTimerRef.current = null; }
  };

  // Allibera el document PDF, les tasques de render en vol i la cau de pàgines (slides)
  const clearPdf = () => {
    pdfTasksRef.current.forEach((t) => { try { t.cancel(); } catch { /* res */ } });
    pdfTasksRef.current.clear();
    pdfPrefetchRef.current.clear();
    pdfCacheRef.current.clear();
    pdfFadeInPending.current = false;
    if (pdfDocRef.current) { try { pdfDocRef.current.destroy(); } catch { /* res */ } pdfDocRef.current = null; }
    pdfSlotRef.current = null;
    setPdfReady(false);
    setPdfPath(null);
  };

  // Rampa lineal del volum del <video> de from→to en dur segons, via rAF.
  // L'opacitat es controla amb una transició CSS (vegeu el render).
  const rampVolume = (from, to, dur) => {
    cancelFade();
    const v = videoRef.current;
    if (!v) return;
    if (!(dur > 0)) { try { v.volume = to; } catch { /* res */ } return; }
    const t0 = performance.now();
    const step = (now) => {
      const vid = videoRef.current;
      if (!vid) { rafRef.current = null; return; }
      const k = Math.min(1, (now - t0) / (dur * 1000));
      try { vid.volume = from + (to - from) * k; } catch { /* res */ }
      if (k < 1) { rafRef.current = requestAnimationFrame(step); }
      else { rafRef.current = null; }
    };
    rafRef.current = requestAnimationFrame(step);
  };

  useEffect(() => {
    const unlisteners = [];

    const black = () => {
      cancelFade();
      fadingOut.current = false;
      const v = videoRef.current;
      if (v) { try { v.pause(); } catch { /* res */ } }
      currentSlot.current = null;
      kindRef.current = null;
      clearPdf();       // allibera el PDF si n'hi havia
      setFadeDur(0);   // restauració instantània (sense transició)
      setOpacity(1);   // restaura per al pròxim cue
      setSrc(null);
    };

    // Stop amb fade out: si hi ha mèdia i una durada, fa fade (volum si és vídeo,
    // i opacitat sempre) i passa a negre en acabar. Sense mèdia o sense durada,
    // negre immediat.
    const fadeStop = (e) => {
      const dur = (e && e.payload && e.payload.fadeOut) || 0;
      if (!kindRef.current || !(dur > 0)) { black(); return; }
      cancelFade();
      fadingOut.current = true;
      const v = videoRef.current;   // null si és imatge → només fade d'opacitat
      if (v) {
        const from = (v.volume != null) ? v.volume : (playInfo.current.volume || 0.8);
        rampVolume(from, 0, dur);
      }
      setFadeDur(dur);
      setOpacity(0);
      stopTimerRef.current = setTimeout(() => { stopTimerRef.current = null; black(); }, dur * 1000);
    };

    (async () => {
      unlisteners.push(await listen('video-play', (e) => {
        const p = e.payload || {};
        if (!p.filePath) return;
        cancelFade();
        fadingOut.current = false;

        // Slides (PDF): no fem servir <video>/<img> ni convertFileSrc; el document
        // es carrega des dels bytes (efecte de sota) i es pinta a un <canvas>. El
        // fade és només d'opacitat (sense àudio), com la imatge.
        if (p.mediaType === 'pdf') {
          const v = videoRef.current;
          if (v) { try { v.pause(); } catch { /* res */ } }
          clearPdf();
          currentSlot.current = p.slotId ?? null;
          pdfSlotRef.current = p.slotId ?? null;
          const fadeIn = Math.max(0, p.fadeIn || 0);
          playInfo.current = { ...playInfo.current, fadeIn, fadeOut: Math.max(0, p.fadeOut || 0) };
          kindRef.current = 'pdf';
          setMediaKind('pdf');
          // Neteja el canvas visible: així NO es veu la pàgina del PDF ANTERIOR mentre
          // es carrega/renderitza el nou. Comença invisible i la revelació (fade in o
          // tall) es dispara quan la 1a pàgina nova ja s'ha pintat (pdfFadeInPending,
          // a l'efecte de render), no ara que el canvas encara és el vell.
          const c = canvasRef.current;
          if (c) { try { c.getContext('2d').clearRect(0, 0, c.width, c.height); } catch { /* res */ } }
          pdfFadeInPending.current = true;
          setFadeDur(0);
          setOpacity(0);
          setPdfPage(Math.max(1, p.page | 0) || 1);
          setPdfPath(p.filePath);
          setSrc(p.filePath); // truthy: activa el branc de render (el canvas ignora el valor)
          return;
        }

        // Camí vídeo/imatge: si veníem d'un PDF (sense stop pel mig), allibera'l.
        if (kindRef.current === 'pdf' || pdfDocRef.current) clearPdf();

        currentSlot.current = p.slotId ?? null;
        const startPoint = p.startPoint || 0;
        const stopPoint = p.stopPoint || 0;
        const segment = stopPoint > startPoint ? (stopPoint - startPoint) : Infinity;
        let fadeIn = Math.max(0, p.fadeIn || 0);
        let fadeOut = Math.max(0, p.fadeOut || 0);
        // Clips curts: si fadeIn+fadeOut > segment, escala'ls perquè no se solapin
        if (isFinite(segment) && fadeIn + fadeOut > segment && (fadeIn + fadeOut) > 0) {
          const k = segment / (fadeIn + fadeOut);
          fadeIn *= k; fadeOut *= k;
        }
        playInfo.current = {
          startPoint,
          stopPoint,
          volume: p.volume != null ? p.volume : 0.8,
          fadeIn,
          fadeOut,
          deviceId: p.deviceId || 'default',
          loop: !!p.loop,
          // 4c separat: l'àudio surt pel motor → silenciem el <video> i la imatge
          // segueix l'àudio (events video-resync). Sense àudio propi ni setSinkId.
          muted: !!p.muted,
          paused: false, // un cue nou sempre arrenca reproduint
        };
        const kind = p.mediaType === 'image' ? 'image' : 'video';
        kindRef.current = kind;
        setMediaKind(kind);
        // Opacitat inicial (instantània): si hi ha fade in, comença negre; si no, visible
        setFadeDur(0);
        setOpacity(fadeIn > 0 ? 0 : 1);
        setSrc(convertFileSrc(p.filePath));
      }));
      unlisteners.push(await listen('video-stop', fadeStop));
      unlisteners.push(await listen('video-black', black));
      // Slides: salta a una pàgina del PDF projectat (l'efecte de render reacciona)
      unlisteners.push(await listen('slide-goto', (e) => {
        const page = e.payload && e.payload.page;
        if (page != null) setPdfPage(Math.max(1, page | 0) || 1);
      }));
      // Canvi de volum en directe (slider del tile). Actualitza la base i, si no
      // s'està fent un fade ara mateix, aplica-ho immediatament.
      unlisteners.push(await listen('video-volume', (e) => {
        const vol = e.payload && e.payload.volume;
        if (vol == null) return;
        playInfo.current.volume = vol;
        if (rafRef.current == null && !fadingOut.current) {
          const v = videoRef.current;
          if (v) { try { v.volume = vol; } catch { /* res */ } }
        }
      }));
      // Seek en directe (arrossegar el playhead del tile)
      unlisteners.push(await listen('video-seek', (e) => {
        const t = e.payload && e.payload.time;
        const v = videoRef.current;
        if (v && t != null) { try { v.currentTime = t; } catch { /* res */ } }
      }));
      // Pausa / resume del vídeo (congela sense amagar; NO passa a negre). El flag
      // `paused` a playInfo bloqueja els handlers de loop (handleTimeUpdate/handleEnded)
      // perquè no facin play() i des-pausin en una cursa amb la volta del loop.
      unlisteners.push(await listen('video-pause', () => {
        playInfo.current.paused = true;
        const v = videoRef.current;
        if (v) { try { v.pause(); } catch { /* res */ } }
      }));
      unlisteners.push(await listen('video-resume', () => {
        playInfo.current.paused = false;
        const v = videoRef.current;
        if (v) { v.play().catch(() => {}); }
      }));
      // Resync (4c separat): l'àudio del motor és el rellotge mestre. Corregim el
      // currentTime del vídeo NOMÉS si la deriva supera un llindar, per no fer
      // seeks constants (que es veurien com a tremolor). Llindar ~150 ms.
      unlisteners.push(await listen('video-resync', (e) => {
        const t = e.payload && e.payload.time;
        const v = videoRef.current;
        if (!v || t == null || !playInfo.current.muted) return;
        if (Math.abs(v.currentTime - t) > 0.15) {
          try { v.currentTime = t; } catch { /* res */ }
        }
      }));
      // Canvi del patró de blackout en calent (des de Settings → Vídeo o del menú
      // contextual del botó Black). Porta també imatge i encaix per al mode 'custom'.
      unlisteners.push(await listen('video-idle-pattern', (e) => {
        const pl = e.payload || {};
        if (!['black', 'bars', 'testcard', 'custom'].includes(pl.pattern)) return;
        setIdleConfig({
          pattern: pl.pattern,
          image: pl.image || null,
          fit: pl.fit === 'contain' ? 'contain' : 'cover',
        });
      }));
    })();

    return () => {
      cancelFade();
      unlisteners.forEach((u) => { try { u(); } catch { /* res */ } });
    };
  }, []);

  // Slides: carrega el document PDF des dels bytes del disc (via Tauri, no per
  // URL: la CSP del WebView bloqueja fetch d'asset://). En tenir-lo, informa el
  // nombre de pàgines a la finestra principal i marca'l llest per renderitzar.
  useEffect(() => {
    if (mediaKind !== 'pdf' || !pdfPath) return;
    let cancelled = false;
    setPdfReady(false);
    (async () => {
      try {
        const bytes = await invoke('read_file_bytes', { path: pdfPath });
        const data = new Uint8Array(bytes); // Response (ArrayBuffer) → bytes per pdf.js
        const doc = await pdfjsLib.getDocument({ data }).promise;
        if (cancelled) { try { doc.destroy(); } catch { /* res */ } return; }
        pdfDocRef.current = doc;
        emit('slide-pages', { slotId: pdfSlotRef.current, pages: doc.numPages }).catch(() => {});
        setPdfReady(true);
        // La revelació (fade in o tall) NO es dispara aquí: es fa quan la 1a pàgina ja
        // està pintada al canvas visible (efecte de render, via pdfFadeInPending), per
        // no revelar un canvas encara buit o amb la pàgina del PDF anterior.
      } catch (e) {
        console.warn('[output] error carregant PDF', e);
      }
    })();
    return () => { cancelled = true; };
  }, [pdfPath, mediaKind]);

  // Slides: pinta la pàgina actual al canvas VISIBLE, evitant el blanc en passar
  // pàgina. Estratègia: renderitzem cada pàgina a un canvas FORA de pantalla (cau)
  // i, quan està llest, el "bolquem" al canvas visible d'un sol cop (síncron) → mai
  // es veu el canvas buit mentre pdf.js renderitza. A més, prefetch de les pàgines
  // veïnes perquè el pas endavant/endarrere sigui instantani, i podem de la cau a
  // una finestra de ±2 pàgines (nitidesa sense malgastar RAM).
  useEffect(() => {
    if (!pdfReady || mediaKind !== 'pdf') return;
    const doc = pdfDocRef.current;
    const canvas = canvasRef.current;
    if (!doc || !canvas) return;
    let cancelled = false;

    // Renderitza una pàgina a un canvas nou fora de pantalla i el retorna (o null).
    const renderPageOffscreen = async (num) => {
      const page = await doc.getPage(num);
      // Escala perquè la pàgina càpiga en ~2560×1440 (nitidesa sense malgastar RAM);
      // el CSS l'ajusta després a la finestra mantenint la proporció.
      const vp1 = page.getViewport({ scale: 1 });
      const scale = Math.min(2560 / vp1.width, 1440 / vp1.height);
      const vp = page.getViewport({ scale: scale > 0 ? scale : 1 });
      const off = document.createElement('canvas');
      off.width = Math.floor(vp.width);
      off.height = Math.floor(vp.height);
      const task = page.render({ canvasContext: off.getContext('2d'), viewport: vp });
      pdfTasksRef.current.add(task);
      try { await task.promise; }
      finally { pdfTasksRef.current.delete(task); }
      return off;
    };

    // Obté el canvas d'una pàgina de la cau o el renderitza i el desa (una sola
    // feina per pàgina alhora, compartida entre visible i prefetch).
    const getPageCanvas = async (num) => {
      const cache = pdfCacheRef.current;
      if (cache.has(num)) return cache.get(num);
      const off = await renderPageOffscreen(num);
      cache.set(num, off);
      return off;
    };

    // Prefetch en segon pla (no bloqueja; ignora errors i cancel·lacions).
    const prefetch = (num) => {
      if (num < 1 || num > doc.numPages) return;
      const cache = pdfCacheRef.current;
      const inflight = pdfPrefetchRef.current;
      if (cache.has(num) || inflight.has(num)) return;
      inflight.add(num);
      getPageCanvas(num).catch(() => {}).finally(() => inflight.delete(num));
    };

    // Descarta de la cau les pàgines fora de la finestra ±2 al voltant de l'actual.
    const prune = (center) => {
      const cache = pdfCacheRef.current;
      for (const key of cache.keys()) {
        if (Math.abs(key - center) > 2) cache.delete(key);
      }
    };

    (async () => {
      const pageNum = Math.max(1, Math.min(pdfPage, doc.numPages));
      let off;
      try { off = await getPageCanvas(pageNum); }
      catch (e) {
        if (e && e.name === 'RenderingCancelledException') return;
        console.warn('[output] error renderitzant pàgina PDF', e);
        return;
      }
      if (cancelled || !off) return;
      // Swap síncron: redimensiona i pinta d'un sol cop (sense frame en blanc).
      canvas.width = off.width;
      canvas.height = off.height;
      canvas.getContext('2d').drawImage(off, 0, 0);
      // 1a pàgina d'un cue nou ja pintada: revela-la (fade in si n'hi ha, o tall). Els
      // canvis de pàgina (slide-goto) NO toquen l'opacitat: ja és visible i no volem
      // re-fade a cada pas de pàgina.
      if (pdfFadeInPending.current) {
        pdfFadeInPending.current = false;
        const fadeIn = Math.max(0, playInfo.current.fadeIn || 0);
        setFadeDur(fadeIn > 0 ? fadeIn : 0);
        setOpacity(1);
      }
      // Anticipa la següent i l'anterior; poda la resta.
      prefetch(pageNum + 1);
      prefetch(pageNum - 1);
      prune(pageNum);
    })();

    return () => { cancelled = true; };
  }, [pdfReady, pdfPage, mediaKind]);

  // En carregar el vídeo nou: aplica sortida (setSinkId), salta al punt d'inici,
  // arrenca i fa el fade in (volum + opacitat).
  const handleLoaded = async () => {
    const v = videoRef.current;
    if (!v) return;
    const { startPoint, volume, fadeIn, deviceId, muted } = playInfo.current;

    // 4c separat: àudio pel motor → vídeo MUT, sense routing propi (l'àudio del
    // motor ja s'enruta). Només l'opacitat fa el fade visual; el volum no s'usa.
    if (muted) {
      try { v.muted = true; v.volume = 0; } catch { /* res */ }
    } else if (typeof v.setSinkId === 'function' && deviceId && deviceId !== 'default') {
      // Routing de sortida: setSinkId si el navegador ho suporta i no és 'default'
      try { await v.setSinkId(deviceId); } catch { /* el WebView pot no suportar-ho */ }
    }

    if (startPoint > 0 && isFinite(startPoint)) {
      try { v.currentTime = startPoint; } catch { /* res */ }
    }

    if (fadeIn > 0) {
      if (!muted) { try { v.volume = 0; } catch { /* res */ } }
      setFadeDur(fadeIn);
      setOpacity(1); // dispara la transició CSS d'opacitat 0→1 (durada = fadeIn)
      if (!muted) rampVolume(0, volume, fadeIn);
    } else {
      if (!muted) { try { v.volume = volume; } catch { /* res */ } }
      setFadeDur(0);
      setOpacity(1);
    }

    v.play().catch(() => { /* l'autoplay pot fallar fins a la interacció */ });
  };

  // Imatge fixa carregada: només fade in d'opacitat (sense àudio ni timeline).
  // Es manté en pantalla fins que arribi un stop/black.
  const handleImgLoaded = () => {
    const { fadeIn } = playInfo.current;
    setFadeDur(fadeIn > 0 ? fadeIn : 0);
    setOpacity(1); // dispara la transició CSS d'opacitat (durada = fadeIn, o instantani)
  };

  // Vigila el segment: gestiona loop i fade out abans del punt de stop
  const handleTimeUpdate = () => {
    const v = videoRef.current;
    if (!v) return;
    // Difon la posició real cap a la finestra principal perquè el mirall del tile
    // la segueixi (el <video> mut del tile no està rate-locked i derivaria).
    if (currentSlot.current != null) {
      emit('video-mirror', { slotId: currentSlot.current, time: v.currentTime }).catch(() => {});
    }
    if (playInfo.current.paused) return; // pausat: no gestionis loop/fade
    const { startPoint, stopPoint, fadeOut, volume, loop } = playInfo.current;
    if (!(stopPoint > 0)) return; // sense punt de stop: deixem que acabi sol (onEnded)

    // Loop: en arribar a stopPoint torna a startPoint (sense re-fade, ignora fade out)
    if (loop) {
      if (v.currentTime >= stopPoint) {
        try { v.currentTime = startPoint > 0 ? startPoint : 0; } catch { /* res */ }
      }
      return;
    }

    // Final del segment
    if (v.currentTime >= stopPoint) { handleEnded(); return; }

    // Fade out: en entrar a la finestra final, ramp volum→0 i opacitat→0
    if (fadeOut > 0 && !fadingOut.current && v.currentTime >= stopPoint - fadeOut) {
      fadingOut.current = true;
      const remaining = Math.max(0, stopPoint - v.currentTime);
      rampVolume(v.volume != null ? v.volume : volume, 0, remaining);
      setFadeDur(fadeOut);
      setOpacity(0); // transició CSS d'opacitat (durada = fadeOut)
    }
  };

  // Final (natural o per punt de stop): torna a negre i informa la finestra
  // principal perquè reseteji l'estat del cue (isPlaying/activeSlot)
  const handleEnded = () => {
    if (playInfo.current.paused) return; // pausat: no rebobinis ni informis el final
    // Loop sense stopPoint (loop del fitxer sencer): rebobina al punt d'inici
    // i continua, sense informar el final ni resetejar el cue.
    if (playInfo.current.loop) {
      const v = videoRef.current;
      if (v) {
        try { v.currentTime = playInfo.current.startPoint || 0; v.play().catch(() => {}); } catch { /* res */ }
      }
      return;
    }
    cancelFade();
    fadingOut.current = false;
    const id = currentSlot.current;
    currentSlot.current = null;
    setFadeDur(0);
    setOpacity(1);
    setSrc(null);
    emit('video-ended', { slotId: id }).catch(() => { /* res */ });
  };

  return (
    <div className="video-output">
      {src ? (
        mediaKind === 'pdf' ? (
          <canvas
            ref={canvasRef}
            className="video-output-el"
            style={{ opacity, transition: `opacity ${fadeDur > 0 ? fadeDur : 0}s linear` }}
          />
        ) : mediaKind === 'image' ? (
          <img
            className="video-output-el"
            src={src}
            alt=""
            style={{ opacity, transition: `opacity ${fadeDur > 0 ? fadeDur : 0}s linear` }}
            onLoad={handleImgLoaded}
            onError={(e) => console.warn('[output] error d\'imatge', e?.currentTarget?.src)}
          />
        ) : (
          <video
            ref={videoRef}
            className="video-output-el"
            src={src}
            style={{ opacity, transition: `opacity ${fadeDur > 0 ? fadeDur : 0}s linear` }}
            onLoadedMetadata={handleLoaded}
            onTimeUpdate={handleTimeUpdate}
            onEnded={handleEnded}
            onError={(e) => console.warn('[output] error de vídeo', e?.currentTarget?.error)}
            autoPlay
          />
        )
      ) : (
        // Blackout: negre total (sense text), barres de color, carta d'ajust o
        // imatge de fons personalitzada (patró 'custom').
        idlePattern === 'bars' ? <ColorBars />
          : idlePattern === 'testcard' ? <TestCard />
          : idlePattern === 'custom' && idleImage ? (
            <img
              className="video-output-pattern"
              src={convertFileSrc(idleImage)}
              alt=""
              style={{ objectFit: idleFit }}
              onError={(e) => console.warn('[output] error de fons personalitzat', e?.currentTarget?.src)}
            />
          )
          : null
      )}
    </div>
  );
}
