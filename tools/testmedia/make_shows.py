"""
Crea fitxers .ezyshow de prova amb el material de tools/testmedia/generate.py.

Genera, per a cada plataforma (Windows i Linux), dos shows:
  · Stress 128 cues — les 4 pàgines plenes amb el comptatge (un format d'àudio
    per pàgina) + playlist amb el drone d'1 h i les 5 pistes en repeat.
  · Stress auto 128 cues — el mateix, però un GO ho dispara tot en cadena
    (auto-continue, 30 s entre cues, ducking alterna) per a proves de hores.
  · Demo show — pàgina 1: seqüència GO amb tota mena de mèdia (imatge, compte
    enrere AV sync, pad amb fades i ducking, slides, loops, vídeos de tots els
    formats, idents de canals); pàgina 2: cadena d'auto-continue i stop-others.

IMPORTANT: importar un show SOBREESCRIU el routing (globals). Per això el routing
de cada variant és el de la seva màquina:
  · Windows: tot pel motor natiu, sortida per defecte del sistema.
  · Linux (AES67): tot per ravenna_out, un parell de canals per bus.

Ús:  python tools/testmedia/make_shows.py "<carpeta del material a Windows>"
     (escriu els .ezyshow a <carpeta>/Shows; la variant Linux apunta a
     /home/lluis/Music/ezyPlayer Test Media)
"""

import json
import sys
import time
from pathlib import Path, PureWindowsPath, PurePosixPath

RED, ORANGE, YELLOW, GREEN, BLUE, PURPLE = (
    "#ef4444", "#f97316", "#eab308", "#22c55e", "#3b82f6", "#a855f7")

ONES = "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen".split()
TENS = "_ _ twenty thirty forty fifty sixty seventy eighty ninety".split()


def words(n):
    if n < 20:
        return ONES[n]
    if n < 100:
        return TENS[n // 10] + ("" if n % 10 == 0 else "-" + ONES[n % 10])
    rest = n % 100
    return ONES[n // 100] + " hundred" + ("" if rest == 0 else " " + words(rest))


def count_file(i):
    ext = [".wav", ".mp3", ".ogg", ".flac"][(i - 1) // 32]
    return f"01 Comptatge/{i:03d} {words(i)}{ext}"


PLAYLIST_TRACKS = [
    "04 Playlist/Track 1 - A minor 90bpm.mp3",
    "04 Playlist/Track 2 - C major 110bpm.mp3",
    "04 Playlist/Track 3 - D minor 75bpm.mp3",
    "04 Playlist/Track 4 - E major 124bpm.mp3",
    "04 Playlist/Track 5 - F major 96bpm.mp3",
]


def cue(id_, rel, label, media="audio", **opts):
    c = {
        "id": id_, "rel": rel, "label": label, "mediaType": media,
        "volume": 0.8, "startPoint": 0, "stopPoint": None, "fadeIn": None, "fadeOut": None,
        "loop": False, "color": None, "stopOthers": False, "duck": False,
        "stopPlaylist": False, "preWait": 0, "continueMode": "none",
    }
    c.update(opts)
    return c


def stress_cues():
    colors = [RED, ORANGE, YELLOW, GREEN]  # un color per pàgina (= format)
    return [cue(i, count_file(i), f"{i} {words(i)}", color=colors[(i - 1) // 32]) for i in range(1, 129)]


def stress_auto_cues(wait=30):
    """Stress en mode automàtic: un sol GO dispara els 128 cues en cadena
    (auto-continue, `wait` s de pre-wait entre cues), amb ducking de la playlist un
    cue sí i un no. El 128 queda en loop perquè, acabada la cadena (~64 min amb
    30 s), segueixi sonant alguna cosa a més de la playlist."""
    cues = stress_cues()
    for c in cues:
        i = c["id"]
        c["continueMode"] = "auto" if i < 128 else "none"
        c["preWait"] = 0 if i == 1 else wait
        c["duck"] = (i % 2 == 1)
        c["loop"] = (i == 128)
    return cues


def demo_cues():
    p1 = [
        cue(1, "06 Imatges/Welcome 1080p.jpg", "Welcome", "image", color=PURPLE, fadeIn=1, fadeOut=1),
        cue(2, "05 Video/Countdown 10s AV sync.mp4", "Countdown AV sync", "video", color=BLUE),
        cue(3, "02 Llargs/Pad Am-F-C-G 3min.mp3", "Pad (fade + duck)", color=GREEN, fadeIn=3, fadeOut=4, duck=True),
        cue(4, "07 PDF/Deck 10 slides 16-9.pdf", "Slides deck", "pdf", color=PURPLE),
        cue(5, "05 Video/Loop 2min 1080p.mp4", "Video loop", "video", color=BLUE, loop=True, fadeOut=2),
        cue(6, "02 Llargs/Loop click 120bpm exact 8s.wav", "Click loop (gapless?)", color=GREEN, loop=True),
        cue(7, "02 Llargs/Tone 1kHz -18dBFS 90s.wav", "Tone 1k -18", color=YELLOW, volume=0.5),
        cue(8, "02 Llargs/Pink noise 2min.flac", "Pink noise", color=YELLOW, fadeIn=2, fadeOut=2),
        cue(9, "06 Imatges/Colour bars 1080p.png", "Colour bars", "image", color=PURPLE),
        cue(10, "05 Video/Clip 30s 720p.mov", "Clip MOV", "video", color=BLUE),
        cue(11, "05 Video/Clip 10s VP9-Opus.webm", "Clip WebM (VP9/Opus)", "video", color=BLUE),
        cue(12, "05 Video/Silent 15s no audio.mp4", "Video no audio", "video", color=BLUE),
        cue(13, "05 Video/Portrait 10s 1080x1920.mp4", "Video portrait", "video", color=BLUE),
        cue(14, "06 Imatges/Gradient 4K.jpg", "Image 4K", "image", color=PURPLE),
        cue(15, "06 Imatges/Portrait 1080x1920.png", "Image portrait", "image", color=PURPLE),
        cue(16, "06 Imatges/Small 720p.webp", "Image WebP", "image", color=PURPLE),
        cue(17, "07 PDF/Document A4 3 pages.pdf", "PDF A4", "pdf", color=PURPLE),
        cue(18, "03 Canals/Channel ident 8ch.wav", "Ident 8ch", color=RED),
        cue(19, "03 Canals/Channel ident 16ch.wav", "Ident 16ch", color=RED),
        cue(20, "02 Llargs/Drone 60min.mp3", "Drone 1h (streaming)", color=YELLOW, loop=True, fadeIn=5, fadeOut=5),
        cue(21, "02 Llargs/Pad Am-F-C-G 3min.mp3", "Pad segment 30-60s", color=GREEN, startPoint=30, stopPoint=60, fadeIn=1, fadeOut=1),
        cue(22, "04 Playlist/Track 4 - E major 124bpm.mp3", "Stop playlist + play", color=ORANGE, stopPlaylist=True),
    ]
    # Pàgina 2: cadena d'auto-continue (un GO dispara one→ten amb 0,5 s de pre-wait)
    # i tres cues amb stop-others.
    p2 = []
    for k in range(1, 11):
        p2.append(cue(32 + k, count_file(k), f"Chain {k}", color=ORANGE,
                      preWait=0.5 if k > 1 else 0, continueMode="auto" if k < 10 else "none"))
    for j, k in enumerate((11, 12, 13)):
        p2.append(cue(49 + j, count_file(k), f"Stop others {k}", color=RED, stopOthers=True))
    return p1 + p2


def globals_for(platform):
    if platform == "windows":
        cues = playlist = preview = "native:|0,1"
        colors = {}
    else:
        # Un sol PCM (ravenna_out, exclusiu) repartit per canals entre busos.
        cues, playlist, preview = "native:ravenna_out|0,1", "native:ravenna_out|2,3", "native:ravenna_out|4,5"
        colors = {GREEN: "native:ravenna_out|6,7"}
    return {
        "globalFadeIn": 0, "globalFadeOut": 0.5,
        "cuesStopOthers": False, "cuesCrossfade": 0, "cuesDuck": False, "cuesStopPlaylist": False,
        "cuesDeviceId": cues, "playlistDeviceId": playlist, "previewDeviceId": preview,
        "colorOutputs": colors,
        "duckEnabled": True, "duckAmount": 0.3, "duckAttack": 0.3, "duckRelease": 1.0, "duckHold": 0.5,
        "asioMasterGain": 1, "nativeBufferSize": 0, "enabledOutputs": [],
        "videoMonitorName": None, "videoIdlePattern": "black", "videoIdleImage": None,
        "videoIdleImageFit": "cover", "videoOutputOpen": False,
        # Àudio dels vídeos pel motor natiu (per validar el sync amb el compte enrere).
        "separateVideoAudio": True,
    }


def build_show(cues, tracks, root, pathcls, platform, repeat="list", crossfade=4):
    def full(rel):
        return str(pathcls(root, *rel.split("/")))
    slots = []
    for c in cues:
        s = {k: v for k, v in c.items() if k != "rel"}
        s["filePath"] = full(c["rel"])
        slots.append(s)
    return {
        "app": "ezyPlayer", "kind": "show", "version": 1,
        "savedAt": int(time.time() * 1000),
        "slots": slots,
        "globals": globals_for(platform),
        "playlist": {
            "tracks": [{"filePath": full(t), "label": t.split("/")[-1].rsplit(".", 1)[0]} for t in tracks],
            "crossfade": crossfade, "repeatMode": repeat, "shuffle": False, "volume": 0.7,
        },
    }


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(2)
    win_root = Path(sys.argv[1])
    out = win_root / "Shows"
    out.mkdir(parents=True, exist_ok=True)
    targets = {
        "windows": (str(PureWindowsPath(win_root)), PureWindowsPath),
        "linux": ("/home/lluis/Music/ezyPlayer Test Media", PurePosixPath),
    }
    stress_tracks = ["02 Llargs/Drone 60min.mp3", *PLAYLIST_TRACKS]
    for platform, (root, pathcls) in targets.items():
        tag = "Windows" if platform == "windows" else "Linux"
        # Comprova (a Windows) que tots els fitxers referenciats existeixen.
        for c in stress_cues() + demo_cues():
            assert (win_root / c["rel"]).exists(), c["rel"]
        shows = {
            f"{tag} - Stress 128 cues.ezyshow": build_show(stress_cues(), stress_tracks, root, pathcls, platform),
            f"{tag} - Demo show.ezyshow": build_show(demo_cues(), PLAYLIST_TRACKS, root, pathcls, platform),
            f"{tag} - Stress auto 128 cues.ezyshow": build_show(stress_auto_cues(), stress_tracks, root, pathcls, platform),
        }
        for name, data in shows.items():
            (out / name).write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
            print(f"  {name}: {len(data['slots'])} cues, {len(data['playlist']['tracks'])} pistes")


if __name__ == "__main__":
    main()
