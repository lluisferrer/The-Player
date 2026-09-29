import { useCallback } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { invoke } from '@tauri-apps/api/core';
import { documentDir, join } from '@tauri-apps/api/path';
import { useSoundStore } from '../store/useSoundStore';
import { useAudioEngine } from './useAudioEngine';
import { serializeShow, parseShow, showNameOf, dirOf, toShowRelative, isAbsolutePath } from '../lib/showFile';

// Carpeta on es proposa crear els shows nous: Documents/ezyPlayer Shows.
export async function defaultShowsDir() {
  try { return await join(await documentDir(), 'ezyPlayer Shows'); } catch { return ''; }
}

// Fitxers que fa servir l'estat i que encara són FORA de la carpeta del show
// (còpies que havien fallat, o un show antic). Els que falten no es poden copiar.
function externalMediaOf(state, showFile) {
  const dir = dirOf(showFile);
  const out = new Set();
  const add = (p) => { if (p && isAbsolutePath(toShowRelative(p, dir))) out.add(p); };
  for (const s of state.slots) if (!s.missing) add(s.filePath);
  for (const t of state.playlist) add(t.filePath);
  add(state.videoIdleImage);
  return [...out];
}

// Escriu l'estat actual al fitxer del show (rutes relatives a la seva carpeta).
async function writeShow(showFile) {
  const data = {
    ...serializeShow(useSoundStore.getState(), showFile),
    name: showNameOf(showFile),
    savedAt: new Date().toISOString(),
  };
  await invoke('write_text_file', { path: showFile, contents: JSON.stringify(data, null, 2) });
}

const errText = (e) => (e && e.message) || String(e);

// Operacions de document del show: New / Open / Save / Save As. Totes informen
// l'usuari amb notificacions i retornen true si han acabat bé. La confirmació de
// "canvis sense desar" la fa la UI abans de cridar-les.
export function useShowFile() {
  const { loadFromPath } = useAudioEngine();

  // Show nou i buit a <parent>/<name>/. Conserva la configuració de la màquina.
  const newShow = useCallback(async ({ parent, name }) => {
    const st = useSoundStore.getState();
    try {
      const showFile = await invoke('show_create', { parent, name });
      st.setShowBusy('opening');
      st.clearShowContent();
      st.setPage(0);
      st.setSelectedSlot(1);
      st.setShowBusy(null);
      await writeShow(showFile);
      st.markShowSaved(showFile);
      return true;
    } catch (e) {
      st.setShowBusy(null);
      st.pushNotification({ type: 'error', message: `Cannot create the show: ${errText(e)}` });
      return false;
    }
  }, []);

  // Obre un show. Sense ruta, demana el fitxer. Retorna 'ok', 'legacy' (show
  // antic carregat sense carpeta: la UI ha de proposar desar-lo com a show) o false.
  const openShow = useCallback(async (path) => {
    const st = useSoundStore.getState();
    let showFile = path;
    if (!showFile) {
      try {
        showFile = await open({
          multiple: false,
          filters: [{ name: 'ezyPlayer show', extensions: ['ezyshow', 'json'] }],
        });
      } catch { return false; }
      if (!showFile) return false;
    }

    let parsed;
    try {
      parsed = parseShow(await invoke('read_text_file', { path: showFile }), showFile);
    } catch (e) {
      if (path) st.removeRecentShow(path);
      st.pushNotification({ type: 'error', message: `Cannot open the show: ${errText(e)}` });
      return false;
    }

    st.setShowBusy('opening');
    try {
      st.clearShowContent();
      let missing = 0;
      for (const cfg of parsed.slots) {
        if (cfg.filePath) {
          try {
            await loadFromPath(cfg.id, cfg.filePath);
            st.applySlotConfig(cfg.id, cfg);
          } catch {
            // Fitxer no trobat: es conserva la configuració i la ruta, marcat
            // FILE MISSING (clicant el cue es torna a provar).
            st.applySlotConfig(cfg.id, cfg);
            st.setSlotMissing(cfg.id, true);
            missing++;
          }
        } else if (cfg.label) {
          st.applySlotConfig(cfg.id, cfg);
        }
      }
      st.applyShowSettings(parsed.show);
      st.applyShowPlaylist(parsed.playlist);
      st.setPage(0);
      st.setSelectedSlot(1);
      st.setShowBusy(null);

      if (parsed.legacy) {
        st.detachShow();
        return 'legacy';
      }
      st.markShowSaved(showFile);
      st.pushNotification({
        type: missing ? 'warning' : 'info',
        message: missing
          ? `Show opened: ${missing} file${missing > 1 ? 's' : ''} not found (FILE MISSING).`
          : `Show opened: ${showNameOf(showFile)}`,
      });
      return 'ok';
    } catch (e) {
      st.setShowBusy(null);
      st.pushNotification({ type: 'error', message: `Error opening the show: ${errText(e)}` });
      return false;
    }
  }, [loadFromPath]);

  // Desa el show obert. Espera abans que acabin les còpies a Media/ pendents.
  const saveShow = useCallback(async () => {
    const st = useSoundStore.getState();
    const showFile = st.currentShowPath;
    if (!showFile) return false;
    try {
      st.setShowBusy('saving');
      await st.waitForMedia();
      // Un show desat ha de ser complet: recull el que encara sigui a fora.
      for (const p of externalMediaOf(useSoundStore.getState(), showFile)) await st.adoptMedia(p, showFile);
      await writeShow(showFile);
      st.markShowSaved(showFile);
      st.pushNotification({ type: 'info', message: `Saved: ${showNameOf(showFile)}` });
      return true;
    } catch (e) {
      st.pushNotification({ type: 'error', message: `Save failed: ${errText(e)}` });
      return false;
    } finally {
      st.setShowBusy(null);
    }
  }, []);

  // Desa l'estat actual com a show NOU a <parent>/<name>/, copiant-hi tots els
  // fitxers que fa servir (també serveix per convertir una sessió o un show antic).
  const saveShowAs = useCallback(async ({ parent, name }) => {
    const st = useSoundStore.getState();
    let showFile;
    try {
      showFile = await invoke('show_create', { parent, name });
    } catch (e) {
      st.pushNotification({ type: 'error', message: `Cannot create the show: ${errText(e)}` });
      return false;
    }
    try {
      st.setShowBusy('saving');
      await st.waitForMedia();
      // El .ezyshow ha d'existir abans de copiar-hi res (la còpia a Media/ valida
      // que el destí és un show real). Es torna a escriure al final amb les rutes noves.
      await writeShow(showFile);
      for (const p of externalMediaOf(useSoundStore.getState(), showFile)) await st.adoptMedia(p, showFile);
      await writeShow(showFile);
      st.markShowSaved(showFile);
      st.pushNotification({ type: 'info', message: `Saved: ${showNameOf(showFile)}` });
      return true;
    } catch (e) {
      st.pushNotification({ type: 'error', message: `Save failed: ${errText(e)}` });
      return false;
    } finally {
      st.setShowBusy(null);
    }
  }, []);

  return { newShow, openShow, saveShow, saveShowAs };
}
