// Render de pàgines de PDF a un <canvas> per als miralls/miniatures del tile
// (slides). El document es carrega des dels bytes del disc (via Tauri, no per URL:
// la CSP del WebView bloqueja fetch d'asset://) i es CAUEN per ruta perquè passar
// de pàgina no torni a llegir ni descodificar tot el PDF.
import { pdfjsLib } from './pdfjs';
import { invoke } from '@tauri-apps/api/core';

// Cau de documents oberts: ruta → Promise<PDFDocumentProxy>. Es comparteix entre
// tots els tiles; un PDF que és a diversos slots es descodifica un sol cop.
const docCache = new Map();

export function getPdfDoc(path) {
  if (docCache.has(path)) return docCache.get(path);
  const p = (async () => {
    const bytes = await invoke('read_file_bytes', { path });
    const data = new Uint8Array(bytes);
    return pdfjsLib.getDocument({ data }).promise;
  })();
  // Si la càrrega falla, treu-la de la cau perquè un reintent torni a provar
  p.catch(() => docCache.delete(path));
  docCache.set(path, p);
  return p;
}

// Pinta la pàgina `pageNum` (1-based) del PDF `path` al canvas donat, escalada a
// `maxW` px d'ample (nitidesa raonable per a un tile). Retorna el nombre total de
// pàgines del document. Llança si es cancel·la o falla (el cridador ho gestiona).
export async function renderPdfPageToCanvas(path, pageNum, canvas, maxW = 360) {
  const doc = await getPdfDoc(path);
  const n = doc.numPages;
  const page = await doc.getPage(Math.max(1, Math.min(pageNum, n)));
  const vp1 = page.getViewport({ scale: 1 });
  const scale = maxW / vp1.width;
  const vp = page.getViewport({ scale: scale > 0 ? scale : 1 });
  canvas.width = Math.floor(vp.width);
  canvas.height = Math.floor(vp.height);
  const ctx = canvas.getContext('2d');
  await page.render({ canvasContext: ctx, viewport: vp }).promise;
  return n;
}
