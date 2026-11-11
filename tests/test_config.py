import pytest

from callenvoy import config


def test_voices():
    assert len(config.VOICES) == 10
    names = [v["name"] for v in config.VOICES]
    assert len(set(names)) == 10
    assert config.DEFAULT_VOICE in names
    indian = [v for v in config.VOICES if v["accent"] == "Indian English"]
    assert sorted(v["gender"] for v in indian) == ["female", "male", "male"]
    assert all(len(v["reference_id"]) == 32 for v in config.VOICES)


def test_voice_samples():
    files = list(config.VOICES_DIR.glob("*.mp3"))
    if not files:
        pytest.skip("voice samples not made yet: uv run python -m callenvoy.make_voice_samples")
    for v in config.VOICES:
        assert (config.VOICES_DIR / f"{v['name'].lower()}.mp3").is_file(), v["name"]


def test_setting_defaults():
    d = config.SETTING_DEFAULTS
    assert d["voice"] == "Hannah" and d["record_calls"] is True and d["max_minutes"] == 30
    assert d["mode"] == "handle" and d["reach"] == "app_then_phone" and d["alert_wait_seconds"] == 20
    assert d["phone_ring_seconds"] == 25 and d["no_answer"] == "ai_handles" and d["listen_in"] is False
    assert d["caller_id"] == "callenvoy" and d["leave_voicemail"] is True
