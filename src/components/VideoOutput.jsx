import { useEffect, useRef, useState } from 'react';
import { convertFileSrc } from '@tauri-apps/api/core';
import { listen, emit } from '@tauri-apps/api/event';
import { ColorBars, TestCard } from './VideoTestPatterns';
import './VideoOutput.css';

// Llegeix el patró de blackout inicial del localStorage (compartit amb la
// finestra principal, mateix origen). 'black' | 'bars' | 'testcard'.
function readIdlePattern() {
  try {
    const g = JSON.parse(localStorage.getItem('the-player-globals')) || {};
    return ['black', 'bars', 'testcard'].includes(g.videoIdlePattern) ? g.videoIdlePattern : 'black';
  } catch { return 'black'; }
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
    startPoint: 0, stopPoint: 0, volume: 0.8, fadeIn: 0, fadeOut: 0, deviceId: 'default', loop: false,
  });
  const rafRef = useRef(null);             // id del requestAnimationFrame del fade de volum
  const fadingOut = useRef(false);         // ja s'ha llançat el fade out d'aquest segment?
  const stopTimerRef = useRef(null);       // timer del negre diferit després d'un stop amb fade
  const [src, setSrc] = useState(null);    // URL convertida del fitxer (o null = blackout)
  const [opacity, setOpacity] = useState(1); // opacitat del <video> (fades visuals cap a negre)
  const [fadeDur, setFadeDur] = useState(0); // durada (s) de la transició d'opacitat actual
  const [idlePattern, setIdlePattern] = useState(readIdlePattern); // patró de blackout

  // Cancel·la el rAF de fade de volum i el timer de negre diferit pendents
  const cancelFade = () => {
    if (rafRef.current != null) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
    if (stopTimerRef.current != null) { clearTimeout(stopTimerRef.current); stopTimerRef.current = null; }
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
      setFadeDur(0);   // restauració instantània (sense transició)
      setOpacity(1);   // restaura per al pròxim cue
      setSrc(null);
    };

    // Stop amb fade out: si hi ha vídeo i una durada, rampa volum→0 i opacitat→0
    // i passa a negre en acabar. Sense vídeo o sense durada, negre immediat.
    const fadeStop = (e) => {
      const dur = (e && e.payload && e.payload.fadeOut) || 0;
      const v = videoRef.current;
      if (!v || !(dur > 0)) { black(); return; }
      cancelFade();
      fadingOut.current = true;
      const from = (v.volume != null) ? v.volume : (playInfo.current.volume || 0.8);
      rampVolume(from, 0, dur);
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
        };
        // Opacitat inicial (instantània): si hi ha fade in, comença negre; si no, visible
        setFadeDur(0);
        setOpacity(fadeIn > 0 ? 0 : 1);
        setSrc(convertFileSrc(p.filePath));
      }));
      unlisteners.push(await listen('video-stop', fadeStop));
      unlisteners.push(await listen('video-black', black));
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
      // Canvi del patró de blackout en calent (des de Settings → Vídeo)
      unlisteners.push(await listen('video-idle-pattern', (e) => {
        const p = e.payload && e.payload.pattern;
        if (['black', 'bars', 'testcard'].includes(p)) setIdlePattern(p);
      }));
    })();

    return () => {
      cancelFade();
      unlisteners.forEach((u) => { try { u(); } catch { /* res */ } });
    };
  }, []);

  // En carregar el vídeo nou: aplica sortida (setSinkId), salta al punt d'inici,
  // arrenca i fa el fade in (volum + opacitat).
  const handleLoaded = async () => {
    const v = videoRef.current;
    if (!v) return;
    const { startPoint, volume, fadeIn, deviceId } = playInfo.current;

    // Routing de sortida: setSinkId si el navegador ho suporta i no és 'default'
    if (typeof v.setSinkId === 'function' && deviceId && deviceId !== 'default') {
      try { await v.setSinkId(deviceId); } catch { /* el WebView pot no suportar-ho */ }
    }

    if (startPoint > 0 && isFinite(startPoint)) {
      try { v.currentTime = startPoint; } catch { /* res */ }
    }

    if (fadeIn > 0) {
      try { v.volume = 0; } catch { /* res */ }
      setFadeDur(fadeIn);
      setOpacity(1); // dispara la transició CSS d'opacitat 0→1 (durada = fadeIn)
      rampVolume(0, volume, fadeIn);
    } else {
      try { v.volume = volume; } catch { /* res */ }
      setFadeDur(0);
      setOpacity(1);
    }

    v.play().catch(() => { /* l'autoplay pot fallar fins a la interacció */ });
  };

  // Vigila el segment: gestiona loop i fade out abans del punt de stop
  const handleTimeUpdate = () => {
    const v = videoRef.current;
    if (!v) return;
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
      ) : (
        // Blackout: negre total (sense text), barres de color o carta d'ajust
        idlePattern === 'bars' ? <ColorBars />
          : idlePattern === 'testcard' ? <TestCard />
          : null
      )}
    </div>
  );
}
