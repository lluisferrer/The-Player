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
