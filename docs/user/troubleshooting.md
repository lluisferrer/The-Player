# Troubleshooting

## No sound

- Check **Settings → Routing**: which output is the **Cues** bus (or the cue's
  colour) going to?
- Use **Settings → Devices → Test tone** to check the output reaches your mixer.
- Check the cue's volume slider and, for ASIO, the **ASIO master volume**.
- If the output is set to **Default**, check the Windows (or Linux) sound settings:
  the default device may have changed.
- In demo mode the sound mutes briefly every few minutes; activate your licence.

## A cue shows FILE MISSING

The file is not at the path the cue remembers: it was moved, renamed, or is on a
drive that is not connected. Put the file back at the same path (or connect the
drive) and click the cue to reload it. Otherwise load the file again by dragging it
onto the cue or with right-click.

## A cue shows ERROR, or stays amber

The audio engine could not play the cue. Hover over the **ERROR** badge to read the reason.
Usually the output device is not available: check it is connected and selected in
Settings. Firing the cue again clears the error if it plays.

## "ASIO device lost"

The ASIO interface stopped responding (for example the USB cable was unplugged).
The affected cues are marked in error.

1. Reconnect the interface.
2. Press **GO** or fire a cue: this restarts the driver. ezyPlayer shows a
   "reconnected" message and clears the errors.

If the driver does not come back, choose **None** under **Settings → Devices →
ASIO driver**, then choose your driver again.

## An audio device was disconnected (Native engine)

Cues playing on that device are stopped and marked in error, and you are warned.
When the device is connected again, fire the cue and it plays on it again.

## Another program cannot use the audio interface

ASIO drivers, and sound cards opened directly on Linux, are used **exclusively**
by ezyPlayer while it uses them. Choose **None** as ASIO driver (or route to
**Default** on Linux) to release the interface, or close ezyPlayer.

## Crackles or dropouts

- Increase **Settings → Devices → Native engine buffer size**, or the buffer size in
  your ASIO driver's control panel.
- Close other applications, especially browsers and video calls.
- Turn off **Settings → Video → Live video in tiles** on slower computers.
- Use the computer on mains power with a high-performance power plan.

## The video output does not appear on the right screen

- Choose the monitor in **Settings → Video → Monitor**, then close and reopen the
  output with **VIDEO**.
- If the output monitor is unplugged during a show, the output goes to black and
  you are warned. Reconnect it and reopen the output if needed.

## Video and audio are out of sync

With **Route video audio through the hardware engine** enabled, ezyPlayer keeps
the sound in sync with the picture automatically. Latency added by the projector
or LED processor is outside ezyPlayer; check whether the display has a low-latency
or "game" mode.

## ezyPlayer does not start, or starts with an error screen

- Restart the computer and try again.
- On Windows, check that Microsoft Edge WebView2 Runtime is installed
  (Settings → Apps). Reinstalling ezyPlayer installs it if it is missing.
- Send us the log files (see below).

## Sending us a report

1. Open **Settings → Devices → Open logs folder**. If ezyPlayer does not start, the
   folder is `%LOCALAPPDATA%\app.ezyrider.ezyplayer\logs` on Windows.
2. Send the most recent log file with: what you were doing, what you expected, what
   happened, and the approximate time.

Log files can contain the names and paths of your media files. Review them before
sending if that matters to you.
