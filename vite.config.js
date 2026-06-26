import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react()],

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // Compila amb sintaxi compatible amb el WebKit del SISTEMA a macOS Mojave
  // (10.14 = WebKit ~Safari 12; el WKWebView que usa Tauri és el del sistema, no
  // l'app Safari actualitzada). Ha de coincidir amb `minimumSystemVersion: 10.14`
  // de tauri.conf.json. No afecta WebView2 a Windows (és un superconjunt). Només
  // transforma sintaxi, no afegeix polyfills d'APIs runtime.
  build: {
    target: ["safari12", "chrome105"],
  },
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
