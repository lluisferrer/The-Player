import React from "react";
import ReactDOM from "react-dom/client";
import { getCurrentWindow } from "@tauri-apps/api/window";
import App from "./App";
import { VideoOutput } from "./components/VideoOutput";
import { OUTPUT_LABEL } from "./lib/videoOutput";
import { getInitialTheme, applyTheme } from "./lib/theme";
import { installLogBridge } from "./lib/logBridge";
import { initMediaSrc } from "./lib/mediaSrc";

// Aplica el tema Dia/Nit desat ABANS del primer render (evita el flash del tema
// per defecte). La finestra de sortida de vídeo no el necessita, però és inofensiu.
applyTheme(getInitialTheme());

// Segons el label de la finestra actual decidim quina vista renderitzem:
// la finestra "output" mostra la sortida de vídeo; la resta, l'app normal.
let isOutput = false;
try { isOutput = getCurrentWindow().label === OUTPUT_LABEL; }
catch { /* fora de Tauri (p. ex. build/preview): app normal */ }

// console.warn/error i errors no capturats → també al fitxer de log de l'app.
try { installLogBridge(isOutput ? 'output' : 'main'); } catch { /* fora de Tauri */ }

// A Linux, la URL del servidor de mèdia local s'ha de saber abans de pintar cap
// <video>/<img> (vegeu lib/mediaSrc.js). A la resta és immediat.
initMediaSrc().finally(() => {
  ReactDOM.createRoot(document.getElementById("root")).render(
    <React.StrictMode>
      {isOutput ? <VideoOutput /> : <App />}
    </React.StrictMode>,
  );
});

// Quan React ja ha pintat alguna cosa a #root, el diagnòstic d'arrencada
// (public/boot-guard.js) deixa de tapar la UI amb errors; a partir d'aquí van al
// fitxer de log. Si el muntatge peta, #root queda buit i el diagnòstic segueix actiu.
(function markBooted() {
  const root = document.getElementById('root');
  if (root && root.childElementCount > 0) window.__ezyBooted = true;
  else setTimeout(markBooted, 100);
})();
