"""Builds the final demo MP4 and SRT from recorded scene frames and narration."""
import json
import pathlib
import subprocess
import textwrap

root = pathlib.Path(__file__).resolve().parents[2]
out = root / ".local/demo-video"
build = out / "build"
build.mkdir(exist_ok=True)
script = json.loads((root / "scripts/demo-video/script.json").read_text())
timing = json.loads((out / "timing.json").read_text())
FONT = root / "apps/api/assets/fonts"
FPS = 30
TITLE, END = 4.0, 5.0


def ffmpeg(*args):
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", *map(str, args)], check=True)


def escape(text):
    return text.replace("\\", "\\\\").replace(":", "\\:").replace("'", "’").replace("%", "\\%")


def card(path, seconds, line1, line2):
    bold, regular = FONT / "DejaVuSans-Bold.ttf", FONT / "DejaVuSans.ttf"
    ffmpeg(
        "-f", "lavfi", "-i", f"color=c=0x1f3a33:s=1920x1080:r={FPS}:d={seconds}",
        "-f", "lavfi", "-i", f"anullsrc=r=48000:cl=stereo:d={seconds}",
        "-vf",
        f"drawtext=fontfile={bold}:text='{escape(line1)}':fontcolor=white:fontsize=52:x=(w-tw)/2:y=470,"
        f"drawtext=fontfile={regular}:text='{escape(line2)}':fontcolor=0xcfe0d8:fontsize=30:x=(w-tw)/2:y=570,"
        f"fade=in:0:12,fade=out:{int(seconds * FPS) - 12}:12,format=yuv420p",
        "-c:v", "libx264", "-preset", "medium", "-crf", "16", "-c:a", "aac", "-b:a", "192k", "-shortest", path,
    )


def stamp(seconds, srt=False):
    total = int(round(seconds * 100))
    h, m, s, c = total // 360000, total // 6000 % 60, total // 100 % 60, total % 100
    return f"{h:02}:{m:02}:{s:02},{c * 10:03}" if srt else f"{h}:{m:02}:{s:02}.{c:02}"


clips, cues, overlays, cursor = [build / "title.mp4"], [], [], TITLE
card(clips[0], TITLE, script["title"]["line1"], script["title"]["line2"])
for scene in script["scenes"]:
    sid = scene["id"]
    frames = out / "frames" / sid
    meta = json.loads((frames / "scene.json").read_text())
    clip = build / f"{sid}.mp4"
    ffmpeg(
        "-f", "concat", "-safe", "0", "-i", frames / "frames.ffconcat",
        "-i", out / "audio" / f"{sid}.wav",
        "-filter_complex",
        f"[0:v]fps={FPS},scale=1920:1080,format=yuv420p[v];"
        f"[1:a]aresample=48000,aformat=channel_layouts=stereo,apad[a]",
        "-map", "[v]", "-map", "[a]", "-t", f"{meta['duration']:.3f}",
        "-c:v", "libx264", "-preset", "medium", "-crf", "16", "-c:a", "aac", "-b:a", "192k", clip,
    )
    clips.append(clip)
    for beat in timing[sid]["beats"]:
        lines = textwrap.wrap(beat["text"], 92)
        chunks = [lines[i:i + 2] for i in range(0, len(lines), 2)]
        words = sum(len(" ".join(c).split()) for c in chunks)
        at = beat["start"]
        for chunk in chunks:
            share = beat["duration"] * len(" ".join(chunk).split()) / words
            cues.append((cursor + at, cursor + at + share, chunk))
            at += share
    if scene.get("lens"):
        overlays.append((cursor + 0.2, cursor + 5.2, scene["lens"], "Lens"))
    for note in meta["notes"]:
        real = note["realSeconds"]
        if real < 10:
            continue
        length = f"{real // 60}m {real % 60:02}s" if real >= 60 else f"{real}s"
        overlays.append((cursor + note["start"], cursor + note["end"] + 0.5, f"Shortened · {length} real time", "Note"))
    cursor += meta["duration"]
clips.append(build / "end.mp4")
card(clips[-1], END, script["end"]["line1"], script["end"]["line2"])
(build / "list.txt").write_text("".join(f"file '{c}'\n" for c in clips))

ass = [
    "[Script Info]", "ScriptType: v4.00+", "PlayResX: 1920", "PlayResY: 1080", "",
    "[V4+ Styles]",
    "Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding",
    "Style: Caption,DejaVu Sans,30,&H00FFFFFF,&H00FFFFFF,&H50182A25,&H50182A25,0,0,0,0,100,100,0,0,3,10,0,2,240,240,44,1",
    "Style: Lens,DejaVu Sans,40,&H00FFFFFF,&H00FFFFFF,&H00335E50,&H00335E50,1,0,0,0,100,100,0,0,3,16,0,8,0,0,70,1",
    "Style: Note,DejaVu Sans,28,&H00FFFFFF,&H00FFFFFF,&H30182A25,&H30182A25,0,0,0,0,100,100,0,0,3,10,0,9,0,60,60,1",
    "", "[Events]", "Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text",
]
for start, end, chunk in cues:
    ass.append(f"Dialogue: 0,{stamp(start)},{stamp(end)},Caption,,0,0,0,,{(chr(92) + 'N').join(chunk)}")
for start, end, text, style in overlays:
    ass.append(f"Dialogue: 1,{stamp(start)},{stamp(end)},{style},,0,0,0,,{text}")
(build / "captions.ass").write_text("\n".join(ass) + "\n")

srt = []
for i, (start, end, chunk) in enumerate(cues, 1):
    srt.append(f"{i}\n{stamp(start, True)} --> {stamp(end, True)}\n" + "\n".join(chunk) + "\n")
(out / "urban-planning-demo.srt").write_text("\n".join(srt))

final = out / "urban-planning-demo.mp4"
ffmpeg(
    "-f", "concat", "-safe", "0", "-i", build / "list.txt",
    "-vf", f"subtitles={build / 'captions.ass'}:fontsdir={FONT},format=yuv420p",
    "-af", "loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000",
    "-c:v", "libx264", "-preset", "slow", "-crf", "18", "-c:a", "aac", "-b:a", "192k",
    "-movflags", "+faststart", final,
)
print(final, round(cursor + END, 1), "s")
