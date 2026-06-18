// Genera una versió reduïda (pics min/max) de la forma d'ona d'un AudioBuffer.
// Es desa en comptes del buffer sencer per als cues en streaming: ocupa molt
// poca memòria (uns quants milers de valors) i n'hi ha prou per dibuixar-la.
//
// Retorna un Float32Array amb parells [min, max] intercalats. drawWavePath el
// pot consumir directament com si fos un canal d'àudio.
export function computePeaks(audioBuffer, buckets = 8000) {
  const ch = audioBuffer.getChannelData(0);
  const step = Math.max(1, Math.floor(ch.length / buckets));
  const out = new Float32Array(buckets * 2);
  let bi = 0;
  for (let i = 0; i < buckets; i++) {
    let min = 1, max = -1;
    const start = i * step;
    const end = Math.min(start + step, ch.length);
    for (let j = start; j < end; j++) {
      const v = ch[j];
      if (v < min) min = v;
      if (v > max) max = v;
    }
    if (end <= start) { min = 0; max = 0; }
    out[bi++] = min;
    out[bi++] = max;
  }
  return out;
}
