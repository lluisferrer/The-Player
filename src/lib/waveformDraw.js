// Dibuixa només el tram [startIdx, endIdx) d'un canal d'àudio, ocupant tota
// l'amplada w. Permet zoom de viewport (es renderitza la finestra visible a
// resolució completa, sense ampliar el canvas), igual per a mostres i per a
// pics reduïts (streaming).
export function drawWavePathRange(ctx, channel, startIdx, endIdx, w, h, color) {
  const s0 = Math.max(0, Math.floor(startIdx));
  const e0 = Math.min(channel.length, Math.ceil(endIdx));
  const span = Math.max(1, e0 - s0);
  const buckets = Math.max(1, Math.floor(w));
  const mid = h / 2;

  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i = 0; i < buckets; i++) {
    const a = s0 + Math.floor((i * span) / buckets);
    const b = Math.min(s0 + Math.floor(((i + 1) * span) / buckets), e0);
    let min = 1, max = -1;
    for (let j = a; j < b; j++) {
      const v = channel[j];
      if (v < min) min = v;
      if (v > max) max = v;
    }
    if (b <= a) { min = 0; max = 0; }
    const x = i + 0.5;
    ctx.moveTo(x, mid - max * mid);
    ctx.lineTo(x, mid - min * mid);
  }
  ctx.stroke();
}

// Dibuixa la forma d'ona (min/max per columna de píxel) d'un canal d'àudio
// dins el context de canvas donat, ocupant l'amplada w i l'alçada h.
export function drawWavePath(ctx, channel, w, h, color) {
  const buckets = Math.max(1, Math.floor(w));
  const step    = Math.max(1, Math.floor(channel.length / buckets));
  const mid     = h / 2;

  ctx.strokeStyle = color;
  ctx.lineWidth   = 1;
  ctx.beginPath();
  for (let i = 0; i < buckets; i++) {
    let min = 1, max = -1;
    const start = i * step;
    const end   = Math.min(start + step, channel.length);
    for (let j = start; j < end; j++) {
      const v = channel[j];
      if (v < min) min = v;
      if (v > max) max = v;
    }
    const x = i + 0.5;
    ctx.moveTo(x, mid - max * mid);
    ctx.lineTo(x, mid - min * mid);
  }
  ctx.stroke();
}
