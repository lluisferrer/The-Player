// URL per carregar un fitxer de mèdia (vídeo / imatge) en un <video> o <img>.
//
// A Windows/Mac: el protocol asset de Tauri (convertFileSrc), com sempre.
// A Linux: el servidor de mèdia local (src-tauri/src/media_server.rs). El <video>
// de WebKitGTK el reprodueix GStreamer, que no es porta bé amb asset:// (els
// vídeos quedaven en negre); per HTTP a 127.0.0.1 (amb Range) funciona.
//
// `initMediaSrc()` s'ha de cridar (i esperar) abans del primer render: main.jsx.
import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import { IS_LINUX } from './outputTarget';

let base = null;

export async function initMediaSrc() {
  if (!IS_LINUX) return;
  try { base = (await invoke('media_base_url')) || null; } catch { base = null; }
}

export function mediaSrc(path) {
  if (!path) return '';
  return base ? base + encodeURIComponent(path) : convertFileSrc(path);
}
