"""Per-beat Kokoro narration for the demo video. Writes one WAV per scene and timing.json."""
import json
import pathlib

import numpy as np
import soundfile as sf
from kokoro import KPipeline

RATE = 24000
root = pathlib.Path(__file__).resolve().parents[2]
out = root / ".local/demo-video/audio"
out.mkdir(parents=True, exist_ok=True)
script = json.loads((root / "scripts/demo-video/script.json").read_text())
pipe = KPipeline(lang_code="a", repo_id="hexgrad/Kokoro-82M", device="cuda")
gap = np.zeros(int(script["beatGapSeconds"] * RATE))
timing = {}
for scene in script["scenes"]:
    parts, beats, cursor = [], [], 0.0
    for text in scene["beats"]:
        audio = np.concatenate(
            [r.audio.cpu().numpy() for r in pipe(text, voice=script["voice"], speed=script["speed"])]
        )
        duration = len(audio) / RATE
        beats.append({"start": round(cursor, 3), "duration": round(duration, 3), "text": text})
        parts += [audio, gap]
        cursor += duration + script["beatGapSeconds"]
    sf.write(out / f"{scene['id']}.wav", np.concatenate(parts), RATE)
    timing[scene["id"]] = {"beats": beats, "total": round(cursor, 3)}
    print(scene["id"], round(cursor, 1))
(root / ".local/demo-video/timing.json").write_text(json.dumps(timing, indent=1))
print("total", round(sum(s["total"] for s in timing.values()), 1))
