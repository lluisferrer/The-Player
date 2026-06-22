// Patrons de prova per a la pantalla de sortida quan no hi ha vídeo (alternativa
// al blackout negre). Tots dos omplen la finestra sencera sobre fons negre.

// Barres de color tipus SMPTE/EBU: 7 barres verticals + franja inferior.
// preserveAspectRatio="none": s'estiren per omplir qualsevol resolució.
const BARS = ['#ffffff', '#ffff00', '#00ffff', '#00ff00', '#ff00ff', '#ff0000', '#0000ff'];

export function ColorBars() {
  return (
    <svg
      className="video-output-pattern"
      viewBox="0 0 700 100"
      preserveAspectRatio="none"
    >
      {/* 7 barres principals (ocupen el 75% superior) */}
      {BARS.map((c, i) => (
        <rect key={i} x={i * 100} y="0" width="100" height="75" fill={c} />
      ))}
      {/* Franja inferior: barres invertides fosques (referència de nivells) */}
      {BARS.slice().reverse().map((c, i) => (
        <rect key={`b-${i}`} x={i * 100} y="75" width="100" height="25" fill={c} opacity="0.35" />
      ))}
    </svg>
  );
}

// Carta d'ajust: graella, cercles concèntrics, creu central i marques de
// registre a les cantonades. preserveAspectRatio="xMidYMid meet" perquè els
// cercles quedin rodons (centrada amb marges negres si la pantalla no és 16:9).
export function TestCard() {
  const W = 1600, H = 900, cx = W / 2, cy = H / 2;
  const grid = [];
  for (let x = 0; x <= W; x += 100) grid.push(<line key={`v${x}`} x1={x} y1="0" x2={x} y2={H} />);
  for (let y = 0; y <= H; y += 100) grid.push(<line key={`h${y}`} x1="0" y1={y} x2={W} y2={y} />);

  return (
    <svg
      className="video-output-pattern"
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="xMidYMid meet"
    >
      <rect x="0" y="0" width={W} height={H} fill="#111" />
      {/* Graella */}
      <g stroke="#3a3a3a" strokeWidth="1">{grid}</g>
      {/* Cercles concèntrics */}
      <g fill="none" stroke="#777" strokeWidth="2">
        <circle cx={cx} cy={cy} r="430" />
        <circle cx={cx} cy={cy} r="300" />
        <circle cx={cx} cy={cy} r="160" />
      </g>
      {/* Creu central */}
      <g stroke="#fff" strokeWidth="2">
        <line x1={cx - 60} y1={cy} x2={cx + 60} y2={cy} />
        <line x1={cx} y1={cy - 60} x2={cx} y2={cy + 60} />
      </g>
      {/* Marques de registre a les cantonades */}
      <g stroke="#fff" strokeWidth="3" fill="none">
        <path d={`M40 40 H140 M40 40 V140`} />
        <path d={`M${W - 40} 40 H${W - 140} M${W - 40} 40 V140`} />
        <path d={`M40 ${H - 40} H140 M40 ${H - 40} V${H - 140}`} />
        <path d={`M${W - 40} ${H - 40} H${W - 140} M${W - 40} ${H - 40} V${H - 140}`} />
      </g>
      {/* Tira de grisos a sota del centre */}
      <g>
        {Array.from({ length: 6 }, (_, i) => (
          <rect key={i} x={cx - 300 + i * 100} y={cy + 200} width="100" height="60"
            fill={`rgb(${i * 51},${i * 51},${i * 51})`} />
        ))}
      </g>
      <text x={cx} y={cy - 220} fill="#fff" fontFamily="'JetBrains Mono', monospace"
        fontSize="40" textAnchor="middle" letterSpacing="6">THE PLAYER</text>
    </svg>
  );
}
