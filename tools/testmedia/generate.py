"""
Generador de contingut de PROVA per a ezyPlayer (cues, playlist, vídeo, imatges, PDF).

Crea una carpeta amb material pensat per provar l'app de punta a punta:
  01 Comptatge  — 128 cues curts parlats (one…one hundred twenty-eight), un
                  format per pàgina (WAV / MP3 / OGG / FLAC): stress de 128 cues
                  i tots els descodificadors.
  02 Llargs     — >60 s (streaming): to de referència, soroll rosa, pad musical,
                  click de loop de durada exacta, i una pista d'1 hora.
  03 Canals     — WAV multicanal (8 i 16 canals) on cada canal diu el seu número:
                  routing ASIO / RAVENNA.
  04 Playlist   — 5 pistes de 3-4 min (tonalitats i tempos diferents): crossfade,
                  ducking.
  05 Video      — compte enrere amb flaix + bip SINCRONITZATS (sync A/V), loop
                  1080p, MOV, WebM (VP9/Opus), vídeo sense àudio, vídeo vertical.
  06 Imatges    — barres de color, 4K, vertical, WebP.
  07 PDF        — deck de 10 slides 16:9 i document A4 de 3 pàgines.

Requisits: Windows (veus SAPI per al text parlat), Python 3 amb numpy i Pillow,
i `pip install imageio-ffmpeg` (porta un ffmpeg complet, sense instal·lar res al
sistema).

Ús:  python tools/testmedia/generate.py "C:/ruta/de/sortida"
"""

import shutil
import subprocess
import sys
import tempfile
import wave
from pathlib import Path

import imageio_ffmpeg
import numpy as np
from PIL import Image, ImageDraw, ImageFont

SR = 48000  # freqüència de tot el material (la de l'AES67 / RAVENNA)
FF = imageio_ffmpeg.get_ffmpeg_exe()
FONT = "C:/Windows/Fonts/arialbd.ttf"


# ── Utilitats ────────────────────────────────────────────────────────────────

def ff(*args, cwd=None):
    """Executa ffmpeg (silenciós; peta si falla)."""
    subprocess.run([FF, "-hide_banner", "-loglevel", "error", "-y", *args], check=True, cwd=cwd)


def write_wav(path, data, sr=SR):
    """Escriu un WAV PCM 16 bits. `data` = float [-1,1], forma (mostres, canals)."""
    if data.ndim == 1:
        data = data[:, None]
    pcm = (np.clip(data, -1, 1) * 32767).astype("<i2")
    with wave.open(str(path), "wb") as w:
        w.setnchannels(pcm.shape[1])
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(pcm.tobytes())


def read_wav_mono(path):
    """Llegeix un WAV 16 bits (mono o estèreo) a float mono."""
    with wave.open(str(path), "rb") as w:
        n, ch = w.getnframes(), w.getnchannels()
        x = np.frombuffer(w.readframes(n), dtype="<i2").astype(np.float32) / 32768
    return x.reshape(-1, ch).mean(axis=1)


def encode(src_wav, dst, extra=()):
    """Converteix un WAV al format que indica l'extensió de `dst`."""
    codec = {
        ".mp3": ["-c:a", "libmp3lame", "-b:a", "192k"],
        ".ogg": ["-c:a", "libvorbis", "-q:a", "5"],
        ".flac": ["-c:a", "flac"],
        ".wav": ["-c:a", "pcm_s16le"],
    }[Path(dst).suffix.lower()]
    ff("-i", str(src_wav), *codec, *extra, str(dst))


# ── Veu (SAPI de Windows) ────────────────────────────────────────────────────

def tts_batch(phrases, outdir, voice="Microsoft Zira Desktop"):
    """Genera un WAV (48 kHz mono) per frase amb les veus de Windows. Retorna rutes."""
    outdir.mkdir(parents=True, exist_ok=True)
    lines = [
        "Add-Type -AssemblyName System.Speech",
        "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer",
        f"$s.SelectVoice('{voice}')",
        "$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(48000, "
        "[System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, "
        "[System.Speech.AudioFormat.AudioChannel]::Mono)",
    ]
    paths = []
    for i, text in enumerate(phrases):
        p = outdir / f"tts_{i:03d}.wav"
        paths.append(p)
        safe = text.replace("'", "''")
        lines += [f"$s.SetOutputToWaveFile('{p}', $fmt)", f"$s.Speak('{safe}')"]
    lines.append("$s.SetOutputToNull()")
    ps1 = outdir / "tts.ps1"
    ps1.write_text("\n".join(lines), encoding="utf-8-sig")
    subprocess.run(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(ps1)], check=True)
    return paths


ONES = "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen".split()
TENS = "_ _ twenty thirty forty fifty sixty seventy eighty ninety".split()


def words(n):
    """Número en anglès (fins a 999)."""
    if n < 20:
        return ONES[n]
    if n < 100:
        return TENS[n // 10] + ("" if n % 10 == 0 else "-" + ONES[n % 10])
    rest = n % 100
    return ONES[n // 100] + " hundred" + ("" if rest == 0 else " " + words(rest))


# ── Síntesi musical senzilla (numpy) ─────────────────────────────────────────

def note_hz(semis_from_a4):
    return 440.0 * 2 ** (semis_from_a4 / 12)


def pad_track(seconds, chords, bpm, seed=0, drums=True, bass=True):
    """Pista estèreo amb pad d'acords, baix i bateria simples. Retorna float (n, 2)."""
    rng = np.random.default_rng(seed)
    n = int(seconds * SR)
    t = np.arange(n) / SR
    out = np.zeros((n, 2), np.float32)
    beat = 60.0 / bpm
    bar = beat * 4
    for i in range(int(np.ceil(seconds / bar))):
        a, b = int(i * bar * SR), min(n, int((i + 1) * bar * SR))
        if a >= n:
            break
        tt = t[a:b] - t[a]
        env = np.minimum(1, tt / 0.4) * np.minimum(1, (tt[-1] - tt + 1e-9) / 0.4)
        chord = chords[i % len(chords)]
        for k, semi in enumerate(chord):
            f = note_hz(semi)
            det = 1 + 0.003 * (k - 1)
            voice = 0.5 * np.sin(2 * np.pi * f * det * tt) + 0.2 * np.sin(2 * np.pi * 2 * f * tt)
            pan = 0.3 + 0.4 * (k / max(1, len(chord) - 1))
            out[a:b, 0] += 0.07 * voice * env * (1 - pan)
            out[a:b, 1] += 0.07 * voice * env * pan
        if bass:
            fb = note_hz(chord[0] - 24)
            out[a:b] += (0.12 * np.sin(2 * np.pi * fb * tt) * env)[:, None]
    if drums:
        for k in range(int(seconds / beat)):
            s = int(k * beat * SR)
            L = min(int(0.25 * SR), n - s)
            if L <= 0:
                break
            tt = np.arange(L) / SR
            kick = np.sin(2 * np.pi * (50 + 80 * np.exp(-tt * 30)) * tt) * np.exp(-tt * 12) * 0.35
            out[s:s + L] += kick[:, None]
            h = s + int(beat / 2 * SR)
            Lh = min(int(0.05 * SR), n - h)
            if Lh > 0:
                hat = rng.standard_normal(Lh) * np.exp(-np.arange(Lh) / SR * 80) * 0.05
                out[h:h + Lh] += hat[:, None]
    fade = int(2 * SR)
    ramp = np.linspace(0, 1, fade)[:, None]
    out[:fade] *= ramp
    out[-fade:] *= ramp[::-1]
    return out / max(1e-9, np.abs(out).max()) * 0.7


# ── Imatges ──────────────────────────────────────────────────────────────────

def font(size):
    return ImageFont.truetype(FONT, size)


def centered(draw, xy_box, text, size, fill):
    f = font(size)
    l, t, r, b = draw.textbbox((0, 0), text, font=f)
    x0, y0, x1, y1 = xy_box
    draw.text(((x0 + x1 - (r - l)) / 2 - l, (y0 + y1 - (b - t)) / 2 - t), text, font=f, fill=fill)


def slide(w, h, title, subtitle, bg, fg="white"):
    img = Image.new("RGB", (w, h), bg)
    d = ImageDraw.Draw(img)
    centered(d, (0, 0, w, h * 0.62), title, int(h * 0.22), fg)
    centered(d, (0, h * 0.55, w, h * 0.85), subtitle, int(h * 0.05), fg)
    return img


# ── Seccions ─────────────────────────────────────────────────────────────────

def gen_counting(out, tmp):
    d = out / "01 Comptatge"
    d.mkdir(parents=True, exist_ok=True)
    wavs = tts_batch([words(i) for i in range(1, 129)], tmp / "count")
    fmts = [".wav", ".mp3", ".ogg", ".flac"]  # un format per pàgina de 32 cues
    for i, src in enumerate(wavs, start=1):
        x = read_wav_mono(src)
        pad = np.zeros(int(0.05 * SR), np.float32)
        x = np.concatenate([pad, x / max(1e-9, np.abs(x).max()) * 0.7, pad])
        stereo = tmp / "c.wav"
        write_wav(stereo, np.stack([x, x], axis=1))
        ext = fmts[(i - 1) // 32]
        encode(stereo, d / f"{i:03d} {words(i)}{ext}")
    print("  01 Comptatge: 128 cues")


def gen_long(out, tmp):
    d = out / "02 Llargs"
    d.mkdir(parents=True, exist_ok=True)
    # To de referència: el `sine` d'ffmpeg té amplitud 1/8 = -18 dBFS exactes.
    ff("-f", "lavfi", "-i", f"sine=f=1000:d=90:r={SR}", "-ac", "2", "-c:a", "pcm_s16le",
       str(d / "Tone 1kHz -18dBFS 90s.wav"))
    ff("-f", "lavfi", "-i", f"anoisesrc=c=pink:a=0.1:d=120:r={SR}", "-ac", "2", "-c:a", "flac",
       str(d / "Pink noise 2min.flac"))
    # Pad musical (Am - F - C - G) de 3 minuts.
    am, f, c, g = [0, 3, 7], [-4, 0, 3], [3, 7, 10], [-2, 2, 5]
    write_wav(tmp / "pad.wav", pad_track(180, [am, f, c, g], 90, drums=False))
    encode(tmp / "pad.wav", d / "Pad Am-F-C-G 3min.mp3")
    # Click de loop: EXACTAMENT 8,000 s (2 compassos a 120 bpm). Accent al primer
    # temps: si el loop no és gapless se sent el salt al tornar a començar.
    n = 8 * SR
    loop = np.zeros(n, np.float32)
    for k in range(16):
        s = int(k * 0.5 * SR)
        L = int(0.03 * SR)
        tt = np.arange(L) / SR
        f0 = 1600 if k % 8 == 0 else (1000 if k % 4 == 0 else 700)
        loop[s:s + L] += np.sin(2 * np.pi * f0 * tt) * np.exp(-tt * 120) * (0.8 if k % 8 == 0 else 0.5)
    write_wav(d / "Loop click 120bpm exact 8s.wav", np.stack([loop, loop], axis=1))
    # Pista d'1 hora (streaming llarg / app oberta hores): drone suau generat per
    # ffmpeg directament (sense carregar-la a memòria).
    expr = ("0.12*sin(2*PI*110*t)*(0.7+0.3*sin(2*PI*0.03*t))"
            "+0.08*sin(2*PI*165*t)*(0.7+0.3*sin(2*PI*0.05*t))"
            "+0.05*sin(2*PI*220.5*t)")
    ff("-f", "lavfi", "-i", f"aevalsrc={expr}|{expr}:s={SR}:d=3600",
       "-c:a", "libmp3lame", "-b:a", "128k", str(d / "Drone 60min.mp3"))
    print("  02 Llargs: to, soroll rosa, pad, loop, 1 h")


def gen_channels(out, tmp):
    d = out / "03 Canals"
    d.mkdir(parents=True, exist_ok=True)
    wavs = tts_batch([f"channel {words(i)}" for i in range(1, 17)], tmp / "chan")
    names = [read_wav_mono(p) for p in wavs]
    for nch, slot in ((8, 2.0), (16, 1.6)):
        n = int(nch * slot * SR)
        data = np.zeros((n, nch), np.float32)
        for c in range(nch):
            x = names[c] / max(1e-9, np.abs(names[c]).max()) * 0.7
            s = int(c * slot * SR)
            data[s:s + len(x), c] = x[: n - s]
        write_wav(d / f"Channel ident {nch}ch.wav", data)
    print("  03 Canals: 8 i 16 canals")


def gen_playlist(out, tmp):
    d = out / "04 Playlist"
    d.mkdir(parents=True, exist_ok=True)
    songs = [
        ("Track 1 - A minor 90bpm", 200, 90, [[0, 3, 7], [-4, 0, 3], [3, 7, 10], [-2, 2, 5]]),
        ("Track 2 - C major 110bpm", 180, 110, [[3, 7, 10], [-2, 2, 5], [0, 3, 7], [-4, 0, 3]]),
        ("Track 3 - D minor 75bpm", 240, 75, [[5, 8, 12], [1, 5, 8], [-2, 1, 5], [0, 4, 7]]),
        ("Track 4 - E major 124bpm", 190, 124, [[7, 11, 14], [2, 6, 9], [4, 7, 11], [0, 4, 7]]),
        ("Track 5 - F major 96bpm", 210, 96, [[-4, 0, 3], [1, 5, 8], [3, 7, 10], [-4, 0, 3]]),
    ]
    for k, (name, secs, bpm, chords) in enumerate(songs):
        write_wav(tmp / "song.wav", pad_track(secs, chords, bpm, seed=k))
        encode(tmp / "song.wav", d / f"{name}.mp3")
    print("  04 Playlist: 5 pistes")


def gen_video(out, tmp):
    d = out / "05 Video"
    d.mkdir(parents=True, exist_ok=True)
    shutil.copy(FONT, tmp / "font.ttf")  # ruta relativa per a drawtext (sense 'C:')
    x264 = ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p"]
    aac = ["-c:a", "aac", "-b:a", "192k"]
    # Compte enrere 10 s: a cada segon, FLAIX blanc (2 fotogrames) i BIP de 50 ms
    # alhora. Si la imatge i el so arriben separats, es veu/sent el desfasament.
    ff("-f", "lavfi", "-i", "color=c=black:s=1920x1080:r=30:d=10",
       "-f", "lavfi", "-i", f"aevalsrc=if(lt(mod(t\\,1)\\,0.05)\\,0.5*sin(2*PI*1000*t)\\,0)|if(lt(mod(t\\,1)\\,0.05)\\,0.5*sin(2*PI*1000*t)\\,0):s={SR}:d=10",
       "-vf", "drawbox=c=white:t=fill:enable='lt(mod(t,1),0.067)',"
              "drawtext=fontfile=font.ttf:text='%{eif\\:10-floor(t)\\:d}':fontsize=400:fontcolor=gray:x=(w-tw)/2:y=(h-th)/2,"
              "drawtext=fontfile=font.ttf:text='AV SYNC':fontsize=48:fontcolor=gray:x=(w-tw)/2:y=h-120",
       *x264, *aac, "-shortest", str((d / "Countdown 10s AV sync.mp4").resolve()), cwd=tmp)
    # Loop de 2 minuts 1080p amb el pad musical i el temps sobreimprès.
    write_wav(tmp / "vpad.wav", pad_track(120, [[0, 3, 7], [-4, 0, 3], [3, 7, 10], [-2, 2, 5]], 100, seed=9))
    tc = "drawtext=fontfile=font.ttf:text='%{pts\\:hms}':fontsize=64:fontcolor=white:box=1:boxcolor=black@0.5:x=40:y=40"
    ff("-f", "lavfi", "-i", "testsrc2=s=1920x1080:r=30:d=120", "-i", "vpad.wav",
       "-vf", tc, *x264, *aac, "-shortest", str((d / "Loop 2min 1080p.mp4").resolve()), cwd=tmp)
    ff("-f", "lavfi", "-i", "testsrc=s=1280x720:r=25:d=30", "-f", "lavfi", "-i", f"sine=f=440:d=30:r={SR}",
       "-vf", tc, *x264, *aac, "-ac", "2", str((d / "Clip 30s 720p.mov").resolve()), cwd=tmp)
    ff("-f", "lavfi", "-i", "testsrc2=s=1280x720:r=30:d=10", "-f", "lavfi", "-i", f"sine=f=660:d=10:r={SR}",
       "-vf", tc, "-c:v", "libvpx-vp9", "-b:v", "2M", "-c:a", "libopus", "-ac", "2",
       str((d / "Clip 10s VP9-Opus.webm").resolve()), cwd=tmp)
    ff("-f", "lavfi", "-i", "testsrc2=s=1920x1080:r=30:d=15",
       "-vf", tc + ",drawtext=fontfile=font.ttf:text='NO AUDIO TRACK':fontsize=72:fontcolor=yellow:x=(w-tw)/2:y=h-150",
       *x264, "-an", str((d / "Silent 15s no audio.mp4").resolve()), cwd=tmp)
    ff("-f", "lavfi", "-i", "testsrc2=s=1080x1920:r=30:d=10", "-f", "lavfi", "-i", f"sine=f=550:d=10:r={SR}",
       "-vf", tc, *x264, *aac, "-ac", "2", str((d / "Portrait 10s 1080x1920.mp4").resolve()), cwd=tmp)
    print("  05 Video: sync, loop, mov, webm, sense àudio, vertical")


def gen_images(out):
    d = out / "06 Imatges"
    d.mkdir(parents=True, exist_ok=True)
    # Barres de color (SMPTE simplificades).
    bars = Image.new("RGB", (1920, 1080))
    dr = ImageDraw.Draw(bars)
    cols = ["#c0c0c0", "#c0c000", "#00c0c0", "#00c000", "#c000c0", "#c00000", "#0000c0"]
    for i, c in enumerate(cols):
        dr.rectangle([i * 1920 // 7, 0, (i + 1) * 1920 // 7, 820], fill=c)
    dr.rectangle([0, 820, 1920, 1080], fill="#101010")
    centered(dr, (0, 820, 1920, 1080), "ezyPlayer · colour bars 1920x1080", 56, "white")
    bars.save(d / "Colour bars 1080p.png")
    slide(1920, 1080, "Welcome", "ezyPlayer test image · 1920x1080", "#1e3a8a").save(d / "Welcome 1080p.jpg", quality=92)
    # 4K amb degradat.
    w, h = 3840, 2160
    x = np.linspace(0, 1, w)[None, :, None]
    y = np.linspace(0, 1, h)[:, None, None]
    grad = (np.concatenate([x * 255 * np.ones_like(y), y * 255 * np.ones_like(x), (1 - x) * 200 * np.ones_like(y)], axis=2)).astype(np.uint8)
    img4k = Image.fromarray(grad)
    centered(ImageDraw.Draw(img4k), (0, 0, w, h), "4K 3840x2160", 260, "white")
    img4k.save(d / "Gradient 4K.jpg", quality=90)
    slide(1080, 1920, "9:16", "portrait 1080x1920", "#7c2d12").save(d / "Portrait 1080x1920.png")
    slide(1280, 720, "WebP", "1280x720", "#14532d").save(d / "Small 720p.webp", quality=85)
    print("  06 Imatges: 5")


def gen_pdf(out):
    d = out / "07 PDF"
    d.mkdir(parents=True, exist_ok=True)
    colors = ["#1e3a8a", "#7c2d12", "#14532d", "#4c1d95", "#831843", "#0f766e", "#854d0e", "#1f2937", "#9a3412", "#155e75"]
    pages = [slide(1920, 1080, f"Slide {i}", f"ezyPlayer test deck · page {i} of 10", c) for i, c in enumerate(colors, 1)]
    pages[0].save(d / "Deck 10 slides 16-9.pdf", save_all=True, append_images=pages[1:], resolution=144)
    a4 = []
    for i in range(1, 4):
        p = Image.new("RGB", (1240, 1754), "white")
        dr = ImageDraw.Draw(p)
        centered(dr, (0, 100, 1240, 300), f"Page {i} / 3", 110, "black")
        for k in range(18):
            dr.rectangle([140, 420 + k * 70, 1100 - (k % 4) * 120, 450 + k * 70], fill="#d4d4d8")
        a4.append(p)
    a4[0].save(d / "Document A4 3 pages.pdf", save_all=True, append_images=a4[1:], resolution=150)
    print("  07 PDF: deck 16:9 i A4")


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(2)
    out = Path(sys.argv[1])
    out.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as t:
        tmp = Path(t)
        gen_counting(out, tmp)
        gen_long(out, tmp)
        gen_channels(out, tmp)
        gen_playlist(out, tmp)
        gen_video(out, tmp)
        gen_images(out)
        gen_pdf(out)
    print(f"Fet: {out}")


if __name__ == "__main__":
    main()
