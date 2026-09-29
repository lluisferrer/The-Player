# User Guide

- [The main window](#the-main-window)
- [Cues](#cues)
- [Running a show with GO](#running-a-show-with-go)
- [Editing a cue](#editing-a-cue)
- [Previewing](#previewing)
- [Video, images and slides](#video-images-and-slides)
- [Playlist](#playlist)
- [Audio outputs and routing](#audio-outputs-and-routing)
- [EDIT and LIVE mode](#edit-and-live-mode)
- [Show files and backups](#show-files-and-backups)
- [Settings reference](#settings-reference)
- [Licence](#licence)

## The main window

The header contains, from left to right:

| Control | What it does |
|---|---|
| **CUES / PLAYLIST** | Switches between the cue grid and the playlist (keys **9** and **0**). |
| **EDIT / ● LIVE** | Locks the show for performance. See [EDIT and LIVE mode](#edit-and-live-mode). |
| **VIDEO** | Opens or closes the video output window on the second screen. |
| **FILES** | Saved cue sets, saved playlists and show files. |
| **SETTINGS** | Devices, routing, video, cue and playlist defaults, licence. |
| Sun / moon | Day (light) or night (dark) theme. |
| Full screen | Full-screen main window (**F11**). |

Messages (for example a file that failed to load, or a lost audio device) appear
as notifications in a corner of the window.

## Cues

### Pages and keys

The grid has **4 pages of 32 cues** (128 cues). Change page with the dots below
the grid or with **Page Up / Page Down**. Each position has the same key on every
page; the key fires the cue on the page you are looking at.

```
1 2 3 4 5 6 7 8
Q W E R T Y U I
A S D F G H J K
Z X C V B N M ,
```

### Loading media

- **Drag and drop** files onto a cue. Several files fill the following cues, up to
  the end of the page.
- **Right-click** an empty or loaded cue to choose a file.

A cue remembers the **path** of its file, not a copy of it. If you move or rename
the file, the cue shows **FILE MISSING · click to reload**: put the file back and
click the cue.

Very long audio files (DJ sets, ambiences of an hour or more) are played by
streaming from disk and show a **STREAM** badge. Memory use stays constant however
long they are.

### Playing and stopping

| Action | Result |
|---|---|
| Click a cue | Starts it. Clicking a playing cue stops it with its fade-out. |
| Press the cue's key | Starts it from the beginning (restarts it if it is already playing). |
| **P** | Pauses or resumes the selected cue. |
| **Enter** | Stops the selected cue with its fade-out. |
| **Esc** or **ALL** | Stops every cue (panic). It does not stop the playlist. |

While a cue plays, its tile glows blue and shows its level meter and a playhead.
You can drag the playhead to jump within the cue (not in LIVE mode).

### Tile controls

On a loaded tile, in EDIT mode:

- **Volume slider** at the bottom (0–100 %).
- **Loop** button: repeat the cue until it is stopped.
- **✕**: remove the file from the cue.
- **✎**: open the [cue editor](#editing-a-cue).
- **Drag handle**: drag the tile to another position. Dropping on the centre of
  another tile swaps them; dropping near its left or right edge inserts before or
  after it.

### Badges and colours

| Badge / colour | Meaning |
|---|---|
| **NEXT** | The cue that GO will fire (standby). |
| **SO** | Stop others: firing it stops the other cues. |
| **AC** | Auto-continue: the next cue fires right after this one. |
| **D** | Ducks the playlist while it plays. |
| **S** | Stops the playlist when fired. |
| **STREAM** | Long file played from disk. |
| **VIDEO / IMAGE / SLIDES** | Visual cue, shown on the video output. |
| Blue glow | Playing. |
| Amber outline | Starting; if it stays amber, the audio engine did not start the cue. |
| Red outline, **ERROR** | The cue failed to play (hover over the badge for the reason). Firing it again clears the error if it plays. |
| Red, **FILE MISSING** | The file was not found. |

## Running a show with GO

GO runs a show in order, like a cue list:

1. Select the first cue (click it, or move with the **arrow keys**). It is marked
   **NEXT**.
2. Press **Space** (or the **GO** button). ezyPlayer fires the NEXT cue and moves
   NEXT to the following loaded cue, across pages if needed.
3. Keep pressing GO.

The transport bar above the grid has **previous / next cue**, **GO**, **stop the
selected cue**, **ALL** (stop all) and the blackout button, and shows three fields:
**PREVIEW**, **NEXT** and **PLAYING**.

Each cue can shape the sequence (set them in the cue editor):

- **Pre-wait**: GO waits this many seconds before firing the cue.
- **Auto-continue**: after firing this cue, GO immediately fires the next one too.
  Chain several cues to fire them together or, with pre-waits, as a timed sequence.
- **Stop others**: firing the cue stops other playing cues, except those fired in
  the same auto-continue chain. With a **crossfade between cues** set in Settings,
  the outgoing cues fade out while the new one fades in.

Pressing GO again, or Stop All, cancels any pre-wait or chain that is still
pending.

## Editing a cue

Click **✎** on a tile (EDIT mode only).

- **Name**: the label shown on the tile. Leave it empty to use the file name.
- **Waveform**: drag the start and end handles to set the **In** and **Out** points
  (only that part plays). Zoom with **+ / −** and **Fit**.
- **Stop others**, **Auto-continue**, **Pre-wait**: see [Running a show with GO](#running-a-show-with-go).
- **Playlist**: tick it to make the cue act on the playlist, then choose **Ducking**
  (lower the playlist while the cue plays) or **Stop playing** (stop the playlist).
- **Color**: colours help you read the grid and can route cues to different outputs
  (see [Per-colour routing](#per-colour-routing)).
- **Fade in / Fade out**: per-cue fades. Until you change them the cue uses the
  global fades; **↺ global** returns to them.
- **Loop**, **Preview / Stop** (listen or watch the cue from the editor), **Reset**
  (clear the edits) and **Close**.

## Previewing

Preview lets you listen to a cue without the audience hearing it.

- Hold **Ctrl**: loaded cues get a red outline. Then press a cue key or click a cue.
- Audio plays through the **Preview** bus (set it to headphones in Settings →
  Routing). The **PREVIEW** field shows what you are hearing.
- Video previews inside its tile, not on the output.

## Video, images and slides

### The output window

Click **VIDEO** to open the output window full screen on the monitor chosen in
**Settings → Video** (**Auto** uses the first monitor that is not the main one).
Video, image and PDF cues are shown there when fired; audio cues are unaffected.

When nothing is showing, the output displays the **blackout screen**: full black,
colour bars, a test card or your own image. The blackout button in the transport
bar stops any visual cue and shows it; right-click the button to change the mode.

If the output monitor is unplugged during a show, ezyPlayer goes to black and
warns you; it does not move the picture to another screen.

### Video audio

By default a video's sound plays through the computer's audio system. In
**Settings → Video → Route video audio through the hardware engine**, the sound
goes through the native or ASIO engine instead, so it follows the cue's routing,
fades and ducking, while the picture stays in sync.

### Slides (PDF)

A PDF cue shows one page at a time on the output.

- **-** (minus) goes to the next page and **.** (full stop) to the previous page of
  the slide cue that is showing.
- The arrows on the tile let you browse the pages locally without changing what the
  audience sees.

## Playlist

The **PLAYLIST** view plays background music independently of the cues.

- **+ Add tracks** to add files; reorder with **↑ / ↓**; **✕** removes a track.
- Double-click a track, or press **Enter** on the selected one, to play it.
- Transport: previous, **play/pause** (**Space**), **stop** (**Esc**), next,
  **repeat** (off / list / track) and **shuffle**, plus the playlist volume.
- Click the progress bar to jump within the track.
- **Crossfade between tracks** is set in Settings → Playlist.

Cues can **duck** the playlist (lower it while they play) or **stop** it. Set the
default for new cues in **Settings → Cues** and override it per cue in the editor.
The ducked level, attack, release and hold time are in **Settings → Playlist**.

Stop All in the cue view does not stop the playlist: use the playlist's own stop.

Save and load playlists from **FILES** while in the playlist view.

## Audio outputs and routing

### Engines

| Engine | Where | What it gives |
|---|---|---|
| **WASAPI** (Windows) | Any Windows output | Stereo, shared with other applications. |
| **Native** | Any output | ezyPlayer's own engine: channel routing, fades and ducking on the audio device. |
| **ASIO** (Windows) | ASIO interfaces | Lowest latency and all the interface's channels. Only one ASIO driver can be active at a time, and it is used exclusively by ezyPlayer. |
| **ALSA** (Linux) | All outputs | Native engine. **Default** shares the system mixer; a sound card opens directly with all its channels, exclusively. |

### Devices

In **Settings → Devices**:

- Tick the devices you will use; only those appear in Routing.
- **Test tone** buttons play a tone on each channel so you can check the wiring.
- **OPEN** marks devices ezyPlayer is using right now.
- **ASIO driver**: choose the driver, or **None** to release the interface.
- **ASIO master volume** and **Native engine buffer size** (larger buffers are
  safer on busy computers; smaller buffers reduce latency).

### Routing

In **Settings → Routing**, choose an output for each bus: **Cues**, **Playlist**
and **Preview**. Cues and Playlist on ASIO must use the same driver.

### Per-colour routing

Also in Routing, each cue colour can go to its own output, for example red cues to
the PA and blue cues to stage monitors. Cues without a colour, or with a colour
that has no output assigned, use the Cues bus.

## EDIT and LIVE mode

Click **EDIT** to switch to **● LIVE** before the show. In LIVE mode you can fire,
stop, pause and GO as usual, but you cannot load, move, edit or remove cues, change
the playlist, seek, open FILES or change settings (Settings opens read-only).
Leaving LIVE asks for confirmation.

While LIVE mode is on, or the video output is open, ezyPlayer keeps the screen
awake. It always prevents the computer from going to sleep while it runs.

## Show files and backups

ezyPlayer saves the session automatically: when you reopen it, your cues, playlist
and settings are back.

In **FILES** (cue view):

- **Saved cue sets**: name and save the current grid, and load it later.
- **Export show… / Import show…**: the whole session (cues, playlist and settings)
  as a `.ezyshow` file, for backups and for moving a show to another computer.

A show file contains the **paths** to your media, not the media itself. To move a
show to another computer, copy the media too and keep the same folder path (for
example `D:\Shows\MyShow\` on both computers). Cues whose files are not found show
FILE MISSING.

## Settings reference

| Tab | Contents |
|---|---|
| **Devices** | Devices to use, test tones, ASIO driver and master volume, native buffer size, **Open logs folder**. |
| **Routing** | Output for the Cues, Playlist and Preview buses; per-colour outputs. |
| **Video** | Output monitor, blackout screen, live video in tiles, video audio routing. |
| **Cues** | Defaults for new cues (stop others, playlist action), global fade in/out, crossfade between cues. |
| **Playlist** | Crossfade between tracks, ducking (ducked volume, attack, release, hold). |
| **License** | Version, licence status, activate or remove the licence. |

**Live video in tiles** (Video tab) shows the moving picture inside a playing video
tile. Turn it off on slower computers.

## Licence

**Settings → License** shows the version and the licence status.

- **Activate**: paste your licence key. It works offline afterwards.
- **Remove license from this computer**: returns this computer to demo mode. Use it
  before moving your licence to another computer. A licence covers two computers.
