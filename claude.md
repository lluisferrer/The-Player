# The-Player — Prompt inicial per Claude Code

## Context del projecte
Estem construint una aplicació de desktop multiplataforma (Mac i Windows) anomenada "The Player". És un reproductor d'àudio professional per a ús en events en directe, similar a QLab, amb una interfície de botonera tipus Bitfocus Companion (8 columnes × 4 files = 32 slots).

## Stack tècnic
- **Framework:** Tauri v2 (Rust backend + WebView frontend)
- **Frontend:** React + Vite
- **Estat global:** Zustand
- **Àudio:** Web Audio API (AudioContext natiu)
- **Estils:** CSS pur amb variables (sense Tailwind ni frameworks CSS)
- **Tipografia:** JetBrains Mono (Google Fonts)

## Estructura de carpetes objectiu
```
The-Player/
├── src-tauri/
│   ├── src/main.rs
│   └── tauri.conf.json
├── src/
│   ├── components/
│   │   ├── SoundBoard.jsx
│   │   ├── SoundButton.jsx
│   │   └── VuMeter.jsx
│   ├── hooks/
│   │   └── useAudioEngine.js
│   ├── store/
│   │   └── useSoundStore.js
│   ├── App.jsx
│   ├── App.css
│   └── main.jsx
├── package.json
└── index.html
```

## Arquitectura de l'audio engine
Cada slot té el seu propi graf d'àudio independent:
```
AudioBuffer → AudioBufferSourceNode → GainNode → AnalyserNode → AudioContext.destination
                                                       ↓
                                               Canvas VU Meter
```
- **AudioBufferSourceNode** — reprodueix el buffer decodicat
- **GainNode** — control de volum individual per slot (0.0 a 1.0)
- **AnalyserNode** — alimenta el picometre en temps real
- Un únic AudioContext global compartit per tots els slots
- El AudioContext ha de suportar `setSinkId()` per selecció global de dispositiu de sortida

## Estat Zustand per slot (32 total)
```javascript
{
  id: number,           // 1-32
  label: string,        // nom del fitxer (truncat)
  audioUrl: string,     // blob URL creat amb URL.createObjectURL()
  audioBuffer: AudioBuffer | null,
  gainNode: GainNode | null,
  analyserNode: AnalyserNode | null,
  sourceNode: AudioBufferSourceNode | null,
  isPlaying: boolean,
  volume: number,       // 0.0 a 1.0
}

// Estat global
{
  mode: 'single' | 'continuous',
  activeSlot: number | null,   // només rellevant en mode single
  audioDevices: MediaDeviceInfo[],
  selectedDeviceId: string,
  audioContext: AudioContext | null,
}
```

## Disseny visual
**Paleta de colors:**
- `--bg-primary: #0f0f0f` — fons principal
- `--bg-button: #1c1c1e` — botó en repòs
- `--bg-button-hover: #2a2a2e` — botó hover
- `--accent: #3b82f6` — actiu / accent (blau)
- `--text-primary: #f4f4f5`
- `--text-secondary: #71717a`
- `--vu-green: #22c55e`
- `--vu-yellow: #eab308`
- `--vu-red: #ef4444`

**Tipografia:** JetBrains Mono per tot (display + UI + labels)

**Anatomia d'un botó (estat carregat i reproduint):**
```
┌─────────────────────┐
│ nom_fitxer.wav      │  ← label truncat
│                     │
│  ║  ║              │  ← VU meter canvas (L+R)
│  ║║ ║║             │
│  ║║ ║║▌            │
│                     │
│ ────────●────────── │  ← slider volum
└─────────────────────┘
```

**Estats visuals del botó:**
- Buit: fons `--bg-button`, text `--text-secondary`, sense LED
- Carregat + aturat: text `--text-primary`, LED verd apagat
- Reproduint: `box-shadow` glow blau pulsant, LED blau, VU meter actiu

**VU meter (picometre):**
- Canvas petit dins cada botó
- Dues barres verticals (L + R)
- Color per nivell: verd → groc → vermell
- Animat via `requestAnimationFrame` quan el slot reprodueix
- Aturat: barres a zero

## Funcionalitats fase 1 (construir ara)

### Grid
- 8 columnes × 4 files = 32 slots
- Layout mínim 900px d'ample
- Capçalera amb: títol "THE PLAYER", toggle de mode, selector de dispositiu d'àudio

### Drag & Drop per slot
- L'usuari arrossega un fitxer d'àudio (MP3, WAV, OGG, FLAC) directament sobre un botó
- Es llegeix amb FileReader, es decoding amb `audioContext.decodeAudioData()`
- Es crea el blob URL i s'emmagatzema al store
- Acceptar també click dret → selector de fitxer natiu

### Modes de reproducció
- **Single Play:** prémer un botó atura qualsevol altre que soni, i comença el nou
- **Continuous:** múltiples slots poden sonar simultàniament. Prémer un botó que ja sona l'atura (toggle). Loop activat (`sourceNode` es recrea en acabar)

### Control de volum per slot
- Slider horitzontal a la part inferior de cada botó
- Rang 0% a 100%, afecta el GainNode del slot
- Mostrar valor numèric en hover

### Selector global de dispositiu d'àudio
- `navigator.mediaDevices.enumerateDevices()` per llistar sortides de so
- Dropdown a la capçalera
- Aplicar amb `audioContext.setSinkId(deviceId)` en canviar

### Persistència de sessió
- Guardar l'assignació de fitxers i volums a `localStorage`
- Els blob URLs no es poden persistir — guardar el nom del fitxer i mostrar avís per reasignar si no es troba

## Fases del projecte

| Fase | Contingut |
|------|-----------|
| **1 — Ara** | App Tauri · Grid 8×4 · Drag & drop · Play/Stop · Modes Single/Continuous · GainNode + slider volum · Picometre per slot · Selector global de dispositiu d'àudio |
| **2** | Editor per slot: fade in/out · Punt d'inici i stop · Waveform estàtic com a timeline |
| **3** | Vídeo output · Finestra secundària per segon monitor |
| **4** | Servidor WebSocket intern · Mòdul Companion natiu · Feedback a StreamDeck |

## Prerequisits del sistema (verificar abans de crear el projecte)
1. Node.js >= 18
2. Rust instal·lat (`rustc --version`)
3. En Mac: Xcode Command Line Tools (`xcode-select --install`)
4. En Windows: WebView2 Runtime

## Primer pas
Inicialitza el projecte amb:
```bash
npm create tauri-app@latest . -- --template react --manager npm
```
Després instal·la les dependències addicionals:
```bash
npm install zustand
```
Verifica que `npm run tauri dev` funciona abans de continuar amb cap component.

## Normes de desenvolupament
- No usar Tailwind ni cap framework CSS — CSS pur amb variables
- No usar TypeScript — JavaScript pur (JSX)
- Tots els comentaris al codi en català
- Missatges de commit en català
- Construir per fases, verificar que cada funcionalitat funciona abans de continuar amb la següent
- Fer commit després de cada funcionalitat completada i verificada
