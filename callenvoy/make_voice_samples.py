"""Makes one short mp3 per voice in config.VOICES under callenvoy/static/voices/ (costs a few cents of Fish credit).

Run once: uv run python -m callenvoy.make_voice_samples [--force]
Samples are made at phone quality (8 kHz) so a voice that sounds wrong on a phone line can be spotted.
"""

import sys

import httpx

from . import config

FISH_TTS_URL = "https://api.fish.audio/v1/tts"


def main() -> None:
    key = config.env("FISH_API_KEY")
    if not key:
        raise SystemExit("FISH_API_KEY is not set")
    config.VOICES_DIR.mkdir(parents=True, exist_ok=True)
    force = "--force" in sys.argv
    with httpx.Client(timeout=60, headers={"Authorization": f"Bearer {key}", "model": config.TTS_MODEL}) as c:
        for v in config.VOICES:
            out = config.VOICES_DIR / f"{v['name'].lower()}.mp3"
            if out.exists() and not force:
                print(f"skip {out.name} (exists)")
                continue
            r = c.post(FISH_TTS_URL, json={"text": config.VOICE_SAMPLE_TEXT, "reference_id": v["reference_id"],
                                           "format": "mp3", "sample_rate": 8000})
            if r.status_code >= 400:
                print(f"FAILED {v['name']}: HTTP {r.status_code} {r.text[:200]}")
                continue
            out.write_bytes(r.content)
            print(f"wrote {out.name} ({len(r.content)} bytes)")


if __name__ == "__main__":
    main()
