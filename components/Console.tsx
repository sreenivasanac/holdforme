"use client";
import { useEffect, useRef, useState } from "react";
import { APP_NAME, BASE_PATH } from "@/lib/config";
import type { PublicCall } from "@/lib/store";
import TryIt from "./TryIt";
import CallPanel from "./CallPanel";
import { startAlarm } from "./audio";

const done = (c: PublicCall) => !!c.endedAt || c.state === "FAILED";

/** Owns the current call: starts it, keeps ?call=<id> in the URL (refresh-safe), polls, and raises the human alarm. */
export default function Console() {
  const [call, setCall] = useState<PublicCall | null>(null);
  const [alarmOn, setAlarmOn] = useState(false);
  const stopAlarm = useRef<null | (() => void)>(null);
  const alerted = useRef("");

  useEffect(() => {
    const id = new URLSearchParams(location.search).get("call");
    if (id) fetch(`${BASE_PATH}/api/calls/${id}`).then((r) => (r.ok ? r.json() : null)).then((c) => c && setCall(c));
  }, []);

  useEffect(() => {
    if (!call || done(call)) return;
    const t = setInterval(async () => {
      const r = await fetch(`${BASE_PATH}/api/calls/${call.id}`).catch(() => null);
      if (r?.ok) setCall(await r.json());
    }, 1000);
    return () => clearInterval(t);
  }, [call?.id, call && done(call)]);

  useEffect(() => {
    if (!call?.humanAt || alerted.current === call.id) return;
    alerted.current = call.id;
    if (Date.now() - call.humanAt > 60_000) return; // reopened an old call: no alarm
    setAlarmOn(true);
    try { stopAlarm.current = startAlarm(); } catch { /* autoplay blocked: the banner still shows */ }
    if ("Notification" in window && Notification.permission === "granted") new Notification(`${APP_NAME}: a human picked up!`, { body: call.company });
    document.title = `Human on the line! · ${APP_NAME}`;
  }, [call?.humanAt]);

  function silence() { stopAlarm.current?.(); stopAlarm.current = null; setAlarmOn(false); document.title = APP_NAME; }
  useEffect(() => { if (call && done(call)) silence(); }, [call && done(call)]);

  function onStart(c: PublicCall) {
    silence(); setCall(c);
    history.replaceState(null, "", `?call=${c.id}`);
    setTimeout(() => document.getElementById("call")?.scrollIntoView({ behavior: "smooth" }), 50);
  }

  return (
    <>
      <TryIt busy={!!call && !done(call)} onStart={onStart} />
      {call && <CallPanel call={call} alarmOn={alarmOn} onSilence={silence} />}
    </>
  );
}
