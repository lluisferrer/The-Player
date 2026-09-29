# Quick Start

From installation to your first GO in about ten minutes.

## 1. Install

**Windows 10 or 11 (64-bit).** Run `ezyPlayer_<version>_x64-setup.exe`, accept the
licence agreement and choose whether to install for yourself or for all users of
the computer. ezyPlayer uses Microsoft WebView2, which is already present on
up-to-date Windows 10 and 11; if it is missing, the installer downloads it (this
needs an internet connection once).

**Linux (Ubuntu 22.04 or later).** Install the `.deb` package:

```
sudo apt install ./ezyPlayer_<version>_amd64.deb
```

Only one copy of ezyPlayer runs at a time. Opening it again brings the running
window to the front.

## 2. Activate your licence

Without a licence ezyPlayer runs in **demo mode**: everything works, but the
sound briefly mutes every few minutes and the video output shows a watermark.

1. Click **SETTINGS → License**.
2. Paste the licence key from your purchase email and click **Activate**.

The licence is stored on the computer and works offline from then on. You do not
need internet to start a show.

## 3. Choose your audio outputs

1. Click **SETTINGS → Devices**. Tick the sound cards you will use. Use the
   numbered **Test tone** buttons to check which physical output each channel is.
   On Windows with an ASIO interface, choose the driver under **ASIO driver** for
   the lowest latency and all its channels.
2. Open the **Routing** tab and pick an output for each bus:
   - **Cues**: where the cue grid plays.
   - **Playlist**: where the background music plays.
   - **Preview**: where you listen to a cue privately (for example headphones).

If you are unsure, leave everything on **Default**: ezyPlayer plays through the
computer's default output.

## 4. Load some cues

The **CUES** view shows a grid of 32 cues (8 × 4). Each cue has a keyboard key:

```
1 2 3 4 5 6 7 8
Q W E R T Y U I
A S D F G H J K
Z X C V B N M ,
```

- **Drag** audio, video, image or PDF files from your file explorer onto a cue.
  Dropping several files fills the following cues in order.
- Or **right-click** a cue to choose a file.

Supported files: MP3, WAV, FLAC, OGG, M4A/AAC · MP4, MOV, M4V, WebM · JPG, PNG,
WebP, GIF, BMP · PDF.

## 5. Play

- **Click** a cue to start it; click it again to stop it with a fade.
- Press its **key** to start it from the beginning.
- Press **Space** for **GO**: it fires the cue marked **NEXT** and moves NEXT to
  the following cue. This is how you run a show in order.
- Press **Esc** to **stop all cues** (panic).

## 6. Video and slides

Connect a second screen (projector, LED processor) and click **VIDEO** in the
header. The output window opens full screen on the second monitor. Video, image
and PDF cues now appear there when fired.

## 7. Save your work

ezyPlayer saves your session automatically and restores it the next time it
opens. To keep a copy or move a show to another computer, use **FILES → Export
show…** (see [Show files](user-guide.md#show-files-and-backups)).

## Next steps

- Lock the show before the audience arrives: click **EDIT** to switch to
  **LIVE** mode.
- Read the [Show-Day Checklist](show-day-checklist.md).
- Learn the rest in the [User Guide](user-guide.md).
