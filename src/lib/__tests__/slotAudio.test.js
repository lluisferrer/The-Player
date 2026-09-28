// Utilitats de slot: clip carregat, cues visuals, durada i fades efectius.
import { describe, it, expect } from 'vitest';
import { hasClip, isVisual, slotDuration, effFadeIn, effFadeOut } from '../slotAudio';

describe('hasClip', () => {
  it('buit, buffer, streaming i visuals', () => {
    expect(hasClip(null)).toBe(false);
    expect(hasClip({})).toBe(false);
    expect(hasClip({ audioBuffer: {} })).toBe(true);
    expect(hasClip({ isStreaming: true })).toBe(true);
    expect(hasClip({ mediaType: 'pdf' })).toBe(true);
  });
  it('un cue missing no té clip encara que la persistència restauri isStreaming', () => {
    expect(hasClip({ missing: true, isStreaming: true, mediaType: 'video' })).toBe(false);
  });
});

describe('isVisual / slotDuration', () => {
  it('vídeo, imatge i PDF són visuals; àudio no', () => {
    expect(['video', 'image', 'pdf'].every((t) => isVisual({ mediaType: t }))).toBe(true);
    expect(isVisual({ mediaType: 'audio' })).toBe(false);
  });
  it('durada del buffer o de les metadades', () => {
    expect(slotDuration({ audioBuffer: { duration: 12.5 } })).toBe(12.5);
    expect(slotDuration({ streamDuration: 300 })).toBe(300);
    expect(slotDuration(null)).toBe(0);
  });
});

describe('fades efectius', () => {
  it('override null → global; override 0 → tall sec explícit', () => {
    expect(effFadeIn({ fadeIn: null }, 2)).toBe(2);
    expect(effFadeIn({ fadeIn: 0 }, 2)).toBe(0);
    expect(effFadeOut({ fadeOut: 1.5 }, 3)).toBe(1.5);
    expect(effFadeOut({}, undefined)).toBe(0);
  });
});
