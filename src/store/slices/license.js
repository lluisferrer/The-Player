// Slice de llicència (L1). L'estat valid/demo és FONT DE VERITAT del Rust: aquí
// només l'emmagatzemem per pintar la UI (banner, pestanya Settings, watermark).
// Mai decidim valid/demo al JS; sempre ve de les comandes Tauri.
import { invoke } from '@tauri-apps/api/core';

export function createLicenseSlice(set, get) {
  return {
    // { state: 'valid'|'demo', name?, email?, tier?, covers?, message? }
    // Arrenca en 'demo' fins que refreshLicense() consulti el Rust.
    licenseState: { state: 'demo' },

    // Consulta l'estat real (amb dades) al Rust. Cridat al boot i després
    // d'activar/desactivar. La finestra de sortida també el crida al muntar.
    refreshLicense: async () => {
      try {
        const status = await invoke('license_info');
        set({ licenseState: status || { state: 'demo' } });
        return status;
      } catch {
        set({ licenseState: { state: 'demo' } });
        return { state: 'demo' };
      }
    },

    // Verifica i desa una clau. Retorna l'estat resultant (el Rust decideix).
    activateLicense: async (key) => {
      try {
        const status = await invoke('activate_license', { key });
        set({ licenseState: status || { state: 'demo' } });
        return status;
      } catch (e) {
        const status = { state: 'demo', message: String(e) };
        set({ licenseState: status });
        return status;
      }
    },

    // Esborra la llicència i torna a demo (proves / traspàs de màquina).
    deactivateLicense: async () => {
      try {
        const status = await invoke('deactivate_license');
        set({ licenseState: status || { state: 'demo' } });
        return status;
      } catch {
        const status = { state: 'demo' };
        set({ licenseState: status });
        return status;
      }
    },
  };
}
