import { useEffect, useRef, useState } from 'react';
import { convertFileSrc } from '@tauri-apps/api/core';
import { listen, emit } from '@tauri-apps/api/event';
import './VideoOutput.css';

// Vista de la finestra de sortida (label "output"). Ocupa tota la finestra
// amb fons negre i mostra un <video> a pantalla completa quan rep events de
// Tauri. Per la Fase 4a el vídeo es reprodueix amb el seu propi so.
//
// Events escoltats:
//   video-play  { filePath, startPoint } → mostra i reprodueix el vídeo
//   video-stop                            → atura i amaga el vídeo (negre)
//   video-black                           → igual que stop (go to black)
export function VideoOutput() {
  const videoRef = useRef(null);
  const currentSlot = useRef(null);        // slotId del vídeo en curs (per informar del final)
  const [src, setSrc] = useState(null);   // URL convertida del fitxer (o null = negre)

  useEffect(() => {
    const unlisteners = [];

    const black = () => {
      const v = videoRef.current;
      if (v) { try { v.pause(); } catch { /* res */ } }
      currentSlot.current = null;
      setSrc(null);
    };

    (async () => {
      unlisteners.push(await listen('video-play', (e) => {
        const { filePath, startPoint, slotId } = e.payload || {};
        if (!filePath) return;
        currentSlot.current = slotId ?? null;
        setSrc(convertFileSrc(filePath));
        // El seek a startPoint es fa quan el vídeo té metadades (onLoadedMetadata)
        const v = videoRef.current;
        if (v) v.dataset.startPoint = String(startPoint || 0);
      }));
      unlisteners.push(await listen('video-stop', black));
      unlisteners.push(await listen('video-black', black));
    })();

    return () => { unlisteners.forEach((u) => { try { u(); } catch { /* res */ } }); };
  }, []);

  // En carregar el vídeo nou: salta al punt d'inici i reprodueix
  const handleLoaded = () => {
    const v = videoRef.current;
    if (!v) return;
    const sp = parseFloat(v.dataset.startPoint || '0');
    if (sp > 0 && isFinite(sp)) { try { v.currentTime = sp; } catch { /* res */ } }
    v.play().catch(() => { /* l'autoplay pot fallar fins a la interacció */ });
  };

  // Final natural del vídeo: torna a negre i informa la finestra principal
  // perquè reseteji l'estat del cue (isPlaying/activeSlot)
  const handleEnded = () => {
    const id = currentSlot.current;
    currentSlot.current = null;
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
          onLoadedMetadata={handleLoaded}
          onEnded={handleEnded}
          onError={(e) => console.warn('[output] error de vídeo', e?.currentTarget?.error)}
          autoPlay
        />
      ) : (
        <div className="video-output-idle">SORTIDA DE VÍDEO — en espera</div>
      )}
    </div>
  );
}
