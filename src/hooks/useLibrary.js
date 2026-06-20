import { useState, useCallback } from 'react';
import { useSoundStore } from '../store/useSoundStore';
import { useAudioEngine } from './useAudioEngine';

const KEY = 'the-player-sets';

function readSets() {
  try { return JSON.parse(localStorage.getItem(KEY)) || {}; }
  catch { return {}; }
}
function writeSets(obj) {
  localStorage.setItem(KEY, JSON.stringify(obj));
}

// Gestió de la Set Library: sets de soundboard amb configuracions, desats a
// localStorage. En carregar, recarrega els àudios des de les rutes guardades.
export function useLibrary() {
  const [sets, setSets] = useState(() => readSets());
  const { loadFromPath } = useAudioEngine();

  const saveSet = useCallback((name) => {
    const slots = useSoundStore.getState().slots;
    const config = slots
      .map((s) => ({
        id: s.id,
        filePath: s.filePath,
        label: s.label,
        mediaType: s.mediaType,
        volume: s.volume,
        startPoint: s.startPoint,
        stopPoint: s.stopPoint,
        fadeIn: s.fadeIn,
        fadeOut: s.fadeOut,
        loop: s.loop,
        color: s.color,
        stopOthers: s.stopOthers,
        duck: s.duck,
        stopPlaylist: s.stopPlaylist,
        preWait: s.preWait,
        continueMode: s.continueMode,
      }))
      .filter((s) => s.filePath || s.label); // només slots ocupats
    const all = readSets();
    all[name] = { savedAt: Date.now(), slots: config };
    writeSets(all);
    setSets({ ...all });
  }, []);

  const deleteSet = useCallback((name) => {
    const all = readSets();
    delete all[name];
    writeSets(all);
    setSets({ ...all });
  }, []);

  const loadSet = useCallback(async (name) => {
    const all = readSets();
    const set = all[name];
    if (!set) return;
    const { clearSlot, applySlotConfig } = useSoundStore.getState();

    // Buida tots els slots (totes les pàgines) abans de carregar el set
    const total = useSoundStore.getState().slots.length;
    for (let id = 1; id <= total; id++) clearSlot(id);

    for (const cfg of set.slots) {
      if (cfg.filePath) {
        try {
          await loadFromPath(cfg.id, cfg.filePath);
          applySlotConfig(cfg.id, cfg);
        } catch (err) {
          console.warn('No s\'ha pogut recarregar', cfg.filePath, err);
          // Queda com a slot fantasma (nom desat, sense àudio) per reassignar
          applySlotConfig(cfg.id, { ...cfg, filePath: null });
        }
      } else {
        applySlotConfig(cfg.id, cfg);
      }
    }
  }, [loadFromPath]);

  return { sets, saveSet, loadSet, deleteSet };
}
