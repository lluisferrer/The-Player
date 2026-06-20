# Motor d'àudio natiu (Rust + ASIO) — Pla i entorn

Document viu del pas de The Player a un **motor d'àudio natiu en Rust** amb sortida
**ASIO** multicanal (i WASAPI com a fallback). Substitueix el motor Web Audio actual,
limitat a estèreo per dispositiu pel WebView2/Chromium.

> Decisió (juny 2026): un producte professional ha de poder usar **ASIO** —
> la majoria d'interfícies USB de PC l'exposen. No ens limitem a dispositius
> virtuals tipus DVS. Per tant migrem a motor natiu i, abans, a toolchain **MSVC**.

---

## Arquitectura objectiu

El motor s'inverteix: **Rust mana, el frontend controla.**

```
React (UI)  --invoke-->  Rust (motor)  --ASIO/WASAPI-->  interfície multicanal
   ^                        |
   |---- events VU/playhead-|   (30–60 Hz)
```

- **Rust**: descodifica (`symphonia`), manté un mixer propi, aplica gain/fade/seek/loop
  per veu, mescla a N canals i treu per ASIO.
- **React**: envia `play/stop/volum/seek/routing` via `invoke`; rep VU + playhead per
  events Tauri i alimenta el picòmetre i el playhead existents.
- Es jubilen com a motor: `useAudioEngine.js`, `cueStreamEngine.js`, `playlistEngine.js`
  → passen a ser clients prims.

---

## Fase 0 — Entorn (MSVC + LLVM + ASIO SDK)

ASIO via `cpal` a Windows **no funciona amb el toolchain GNU/MinGW** actual. Cal MSVC.

### 1. Visual Studio Build Tools (MSVC)
- Instal·la *Build Tools for Visual Studio* amb la càrrega **"Desktop development with C++"**
  (inclou el compilador MSVC, el linker i el Windows SDK).
- Canvia el toolchain de Rust per defecte:
  ```powershell
  rustup default stable-x86_64-pc-windows-msvc
  rustc -vV   # ha de dir host: x86_64-pc-windows-msvc
  ```

### 2. LLVM / clang (per a `bindgen`)
- `cpal` genera els bindings de l'ASIO SDK (C++) amb `bindgen`, que necessita `libclang`.
  ```powershell
  winget install LLVM.LLVM
  ```
- Si `bindgen` no troba `libclang.dll`, exposa la ruta:
  ```powershell
  $env:LIBCLANG_PATH = "C:\Program Files\LLVM\bin"
  ```

### 3. ASIO SDK de Steinberg — FET
- Instal·lat l'**ASIO SDK 2.3.3** (oficial de Steinberg) a **`C:\asio_sdk`**
  (arrel amb `asio/`, `common/`, `driver/`, `host/`).
- Variable persistida: `CPAL_ASIO_DIR = C:\asio_sdk` (àmbit User).
  ```powershell
  [Environment]::SetEnvironmentVariable("CPAL_ASIO_DIR", "C:\asio_sdk", "User")
  ```
- Llicència: SDK propietari de Steinberg; ús local per compilar permès, no redistribuïble
  (no es versiona al repo).

### 4. Driver ASIO per provar
- Una interfície USB amb driver ASIO propi, **o** ASIO4ALL com a comodí per a proves.

### 5. target-dir sense espais (es manté)
- `src-tauri/.cargo/config.toml` (local, gitignored) ja redirigeix `target-dir = "C:/tpbuild"`.
  Amb MSVC el linker ja tolera espais, però `bindgen`/clang i la compilació del SDK són
  més fràgils amb rutes amb espais; mantenim `C:\tpbuild` per seguretat.
- Amb MSVC ja **no calen** els workarounds GNU (`RUSTUP_HOME` curt, `C:\mingw64` al PATH,
  `dlltool`). Es poden deixar; no molesten.

### Verificació de la Fase 0
```powershell
npm run tauri dev -- --features asio
```
- Ha d'arrencar sense errors de build.
- `list_audio_outputs` ha de veure els dispositius ASIO (vegeu Fase A: marcar el backend).
- `play_test_tone` ha de sonar pel canal indicat d'una interfície ASIO.

---

## Fases següents (resum)

| Fase | Objectiu | Entregable verificable |
|------|----------|------------------------|
| **A — PoC sortida** | Reproduir un fitxer (`symphonia`) per ASIO, canal arbitrari | Un cue sona per natiu triant canal |
| **B — Mixer** | N veus, gain/fade/seek/loop per veu, mescla N canals | Cue Grid + Playlist amb routing per canal real |
| **C — Pont + telemetria** | API `invoke` completa + events VU/playhead | Picòmetre i playhead alimentats des de Rust |
| **D — Paritat + retirada Web Audio** | Crossfade, ducking, preview, routing per color natius | Tot l'actual amb latència ASIO |

El diagnòstic existent (`list_audio_outputs`, `play_test_tone` a `src-tauri/src/lib.rs`)
és el banc de proves de les fases 0/A.

---

## Estat

- [x] **Fase 0 — entorn MSVC/LLVM/ASIO SDK a punt i build `--features asio` verda** (juny 2026)
  - Toolchain: `stable-x86_64-pc-windows-msvc` (rustc 1.96).
  - VS Build Tools 18 + C++ Clang tools. `libclang.dll` a
    `C:\Program Files (x86)\Microsoft Visual Studio\18\BuildTools\VC\Tools\Llvm\x64\bin`.
  - Variables User persistides: `CPAL_ASIO_DIR=C:\asio_sdk`,
    `LIBCLANG_PATH=...\Llvm\x64\bin`.
  - `cargo build --features asio` → verd (cpal+asio-sys+tauri-app, ~1m).
  - NOTA: cal terminal NOU perquè reculli les variables persistides; un procés
    ja viu no les veu (per això el 1r intent va fallar amb "Unable to find libclang").
- [x] **Fase A — sortida ASIO nativa (FETA i VALIDADA, commits 85a4ee8 + 28f353d)**
  - `list_audio_outputs` (WASAPI, fil MTA), `detect_asio` (noms via `driver_names()`,
    sense carregar), `play_test_tone` (WASAPI per canal).
  - **Motor ASIO persistent**: fil dedicat `asio-engine` propietari del driver;
    carrega un cop i manté (resol el hang de re-load dels drivers USB). Comandes
    `asio_test_tone` / `asio_load` (canals reals) / `asio_release`.
  - Validat amb MixPre: WASAPI 2ch sense ASIO; ASIO natiu → 4 sortides reals, to OK
    als 4, tons repetits sense penjar-se; release torna la interfície a WASAPI.
  - ASIO i WASAPI són exclusius sobre el mateix dispositiu (esperat).
- [ ] Fase B — mixer multicanal
- [ ] Fase C — pont de control + telemetria
- [ ] Fase D — paritat i retirada de Web Audio

> `Cargo.toml` ja té la feature opt-in `asio = ["cpal/asio"]`. El build per defecte
> (GNU o MSVC sense la feature) no es veu afectat fins que s'activi `--features asio`.
