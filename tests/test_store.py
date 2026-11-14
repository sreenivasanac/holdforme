from callenvoy import calls, store

from .conftest import CALL, run, uid


def test_call_lines_questions():
    v = run(calls.place_call(uid(), calls.PlaceCallInput(**CALL)))
    cid = v["id"]
    assert store.get_call(cid)["status"] == "dialing"
    assert store.add_line(cid, "them", "hello") == 0
    assert store.add_line(cid, "ai", "hi") == 1
    assert [l["text"] for l in store.lines(cid, 1)] == ["hi"]
    assert store.next_line(cid) == 2
    qid = store.add_question(cid, "What is the address?")
    assert store.get_question(qid)["answer"] is None
    store.answer_question(qid, "1 Main St")
    assert store.questions(cid)[0]["answer"] == "1 Main St"


def test_profile_merge_and_remove():
    store.save_profile(uid(), {"name": "Alex", "voice": "Sarah"})
    store.save_profile(uid(), {"details": "x"})
    assert store.get_profile(uid()) == {"name": "Alex", "voice": "Sarah", "details": "x"}
    store.save_profile(uid(), {"name": None})
    assert "name" not in store.get_profile(uid())


def test_restart_cleanup_hangs_up_orphans(fresh):
    v = run(calls.place_call(uid(), calls.PlaceCallInput(**CALL)))
    store.update_call(v["id"], owner_twilio_sid="CAowner")
    calls.LIVE.clear()
    run(calls.restart_cleanup())
    row = store.get_call(v["id"])
    assert row["status"] == "failed" and row["error"] == "server restarted"
    assert {sid for sid, kw in fresh.updated if kw.get("hang_up")} == {row["twilio_sid"], "CAowner"}


def test_data_dir_and_files_are_private(tmp_path):
    """Fix 5: data/ is 700; with the service's umask 077 the db, -wal and -shm files are 600."""
    import os

    old = os.umask(0o077)
    try:
        store.open_db(tmp_path / "data" / "callenvoy.db")
        store.save_profile(uid(), {"name": "Alex"})
        assert (tmp_path / "data").stat().st_mode & 0o777 == 0o700
        for f in (tmp_path / "data").iterdir():
            assert f.stat().st_mode & 0o077 == 0, f.name
    finally:
        os.umask(old)
