// Configuració central de pdf.js (slides PDF). Es carrega un sol cop: fixa el
// worker (empaquetat per Vite via ?url) perquè la descodificació del PDF no
// bloquegi el fil principal de la finestra de sortida.
//
// El document es carrega SEMPRE des dels bytes en memòria (invoke read_file_bytes),
// no per URL: dins el WebView de Tauri el `connect-src` de la CSP no inclou el
// protocol asset:, així que un fetch d'asset:// quedaria bloquejat.
import * as pdfjsLib from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

export { pdfjsLib };
