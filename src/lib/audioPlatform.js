import { invoke } from '@tauri-apps/api/core';

// Plataforma d'àudio (Rust `audio_platform`): { os, native_host, asio }.
// Serveix perquè la UI anomeni bé els backends: a Windows el Web Audio i el
// motor natiu van per WASAPI (i hi pot haver ASIO), a Mac per CoreAudio i a
// Linux el Web Audio va per PulseAudio i el motor natiu per ALSA.
let cached = null;

export function getAudioPlatform() {
  if (!cached) {
    cached = invoke('audio_platform').catch(() => ({ os: 'windows', native_host: 'WASAPI', asio: false }));
  }
  return cached;
}

// Nom del camí Web Audio (estèreo, el que tria el WebView) per a cada SO.
export function webAudioLabel(platform) {
  switch (platform?.os) {
    case 'linux': return 'PulseAudio';
    case 'macos': return 'CoreAudio';
    default: return 'WASAPI';
  }
}
