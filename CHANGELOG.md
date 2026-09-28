# Changelog

All notable changes to ezyPlayer are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the
project uses [Semantic Versioning](https://semver.org/).

## [0.9.0] — 2026-09-28 · Beta

First feature-complete beta, ahead of the 1.0 release on Windows.

### Cues
- Cue grid of 4 pages × 32 cues with QWERTY hot-keys, colours and drag-to-reorder.
- GO sequencing (QLab style): standby cue, pre-wait, auto-continue chains, Stop Others.
- Per-cue editor: in/out points, fades, loop, waveform timeline and scrubbing.
- Audio, video, still images and PDF slides as cues.
- EDIT / LIVE (show) mode: LIVE locks the show against accidental changes.

### Playlist
- Background playlist with crossfades, repeat/shuffle and ducking under cues.
- Long tracks (DJ sets, hours) play by streaming with constant memory use.

### Audio
- Native audio engine with multichannel routing per bus (Cues, Playlist, Preview)
  and per cue colour.
- ASIO support on Windows (low latency, all channels of the interface).
- Preview (PFL) bus to listen to a cue before firing it.
- Follows the system default output device when it changes (Windows / macOS).
- Device loss is detected mid-show and reported; the engine recovers when the
  device comes back.
- Linux: everything plays through the native ALSA engine, including AES67/RAVENNA
  devices with more than 32 channels.

### Video
- Video, image and slides output to a second screen, with fades, blackout and a
  custom idle image.
- Video sound can be routed through the audio engine (routing, fades, ducking),
  kept in sync with the picture.
- Optional live video preview in the tiles (off by default on Linux).

### Reliability
- The computer and screen do not go to sleep while ezyPlayer runs a show.
- Only one instance can run at a time (two would fight over the audio devices).
- Rotating log files for support (Settings → Devices → Open logs folder).
- Show files (`.ezyshow`) to save and move a complete session between computers.
- Much lower CPU use when idle and while playing (important on older laptops).

### Licensing
- Offline licence keys; the app runs fully without internet. Demo mode until a
  key is activated (Settings → License).
