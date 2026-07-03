import { useCallback } from 'react';
import { save, open, ask } from '@tauri-apps/plugin-dialog';
import { invoke } from '@tauri-apps/api/core';
import { useSoundStore } from '../store/useSoundStore';
import { useAudioEngine } from './useAudioEngine';

// Hook d'orquestració per exportar/importar la sessió sencera a un fitxer .ezyshow.
// Segueix el patró de useLibrary: exportació i importació com a accions async
// que coordinen el diàleg natiu, les comandes Rust i el store Zustand.
export function useShowFile() {
  const { loadFromPath } = useAudioEngine();

  // Exporta la sessió sencera a un fitxer .ezyshow triat per l'usuari.
  const exportShow = useCallback(async () => {
    const { exportSessionData, pushNotification } = useSoundStore.getState();

    // Diàleg natiu de desar amb filtre .ezyshow
    let filePath;
    try {
      filePath = await save({
        filters: [{ name: 'ezyPlayer show', extensions: ['ezyshow'] }],
        defaultPath: 'show.ezyshow',
      });
    } catch (err) {
      // L'usuari ha tancat el diàleg sense triar ruta
      return;
    }
    if (!filePath) return;

    try {
      const data = exportSessionData();
      const contents = JSON.stringify(data, null, 2);
      await invoke('write_text_file', { path: filePath, contents });
      pushNotification({
        type: 'info',
        message: `Show exported: ${filePath.split(/[\\/]/).pop()}`,
      });
    } catch (err) {
      console.error('[exportShow]', err);
      useSoundStore.getState().pushNotification({
        type: 'error',
        message: `Export failed: ${err}`,
      });
    }
  }, []);

  // Importa una sessió des d'un fitxer .ezyshow o .json triat per l'usuari.
  // Demana confirmació perquè l'operació substitueix tota la sessió actual.
  const importShow = useCallback(async (onDone) => {
    const { pushNotification, stopAll, playlistStop, clearSlot, applySlotConfig, setSlotMissing, importSessionGlobals, importSessionPlaylist } = useSoundStore.getState();

    // Diàleg natiu d'obrir fitxer (un sol arxiu, filtre .ezyshow i .json)
    let filePath;
    try {
      filePath = await open({
        multiple: false,
        filters: [
          { name: 'ezyPlayer show', extensions: ['ezyshow', 'json'] },
        ],
      });
    } catch (err) {
      return;
    }
    if (!filePath) return;

    // Llegeix i valida el fitxer ABANS de demanar confirmació (evita interrompre
    // l'operador si el fitxer és invàlid)
    let data;
    try {
      const raw = await invoke('read_text_file', { path: filePath });
      data = JSON.parse(raw);
    } catch (err) {
      console.error('[importShow] error llegint fitxer:', err);
      pushNotification({ type: 'error', message: `Cannot read show file: ${err}` });
      return;
    }

    // Validació bàsica del format
    if (!data || data.app !== 'ezyPlayer') {
      pushNotification({
        type: 'error',
        message: 'Invalid file: not an ezyPlayer show file.',
      });
      return;
    }

    // Confirmació explícita a l'operador (substitueix la sessió actual!)
    let confirmed;
    try {
      confirmed = await ask(
        'This will replace the current session (cues, playlist and globals). Continue?',
        { title: 'Import show', kind: 'warning' }
      );
    } catch {
      confirmed = false;
    }
    if (!confirmed) return;

    // ── Aplica la sessió importada ────────────────────────────────────────────

    // 1. Atura tot l'àudio en curs
    stopAll();
    playlistStop();

    // 2. Buida tots els slots
    const total = useSoundStore.getState().slots.length;
    for (let id = 1; id <= total; id++) clearSlot(id);

    // 3. Carrega cada slot de la sessió importada
    const slotConfigs = Array.isArray(data.slots) ? data.slots : [];
    let loaded = 0;
    let missing = 0;

    for (const cfg of slotConfigs) {
      if (cfg.filePath) {
        try {
          await loadFromPath(cfg.id, cfg.filePath);
          applySlotConfig(cfg.id, cfg);
          loaded++;
        } catch (err) {
          console.warn('[importShow] no s\'ha trobat el fitxer:', cfg.filePath, err);
          // Slot fantasma: desa la configuració però marca com a missing (C2)
          applySlotConfig(cfg.id, { ...cfg, filePath: null });
          setSlotMissing(cfg.id, true);
          missing++;
        }
      } else if (cfg.label) {
        // Slot amb nom però sense ruta (pot ser un slot de text o fantasma anterior)
        applySlotConfig(cfg.id, cfg);
      }
    }

    // 4. Aplica globals i playlist
    importSessionGlobals(data.globals);
    importSessionPlaylist(data.playlist);

    // 5. Notificació d'èxit amb resum
    const missMsg = missing > 0 ? ` (${missing} file${missing > 1 ? 's' : ''} not found — click to relink)` : '';
    pushNotification({
      type: 'info',
      message: `Show imported: ${loaded} cue${loaded !== 1 ? 's' : ''} loaded${missMsg}.`,
    });

    // Tanca el modal de la Library si cal
    if (typeof onDone === 'function') onDone();
  }, [loadFromPath]);

  return { exportShow, importShow };
}
