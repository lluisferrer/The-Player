import { useSoundStore } from '../store/useSoundStore';

export function useAudioEngine() {
  const initAudioContext = useSoundStore((s) => s.initAudioContext);
  const loadAudio = useSoundStore((s) => s.loadAudio);

  const decodeAndLoad = async (slotId, file) => {
    const ctx = initAudioContext();
    if (ctx.state === 'suspended') await ctx.resume();

    const arrayBuffer = await file.arrayBuffer();
    const audioBuffer = await ctx.decodeAudioData(arrayBuffer);
    const audioUrl = URL.createObjectURL(file);
    loadAudio(slotId, file, audioBuffer, audioUrl);
  };

  return { decodeAndLoad };
}
