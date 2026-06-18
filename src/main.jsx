import React from "react";
import ReactDOM from "react-dom/client";
import { getCurrentWindow } from "@tauri-apps/api/window";
import App from "./App";
import { VideoOutput } from "./components/VideoOutput";
import { OUTPUT_LABEL } from "./lib/videoOutput";

// Segons el label de la finestra actual decidim quina vista renderitzem:
// la finestra "output" mostra la sortida de vídeo; la resta, l'app normal.
let isOutput = false;
try { isOutput = getCurrentWindow().label === OUTPUT_LABEL; }
catch { /* fora de Tauri (p. ex. build/preview): app normal */ }

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    {isOutput ? <VideoOutput /> : <App />}
  </React.StrictMode>,
);
