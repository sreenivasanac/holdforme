// The owner panel: listen, join, take over, hand back, hang up (plan section 10, 10a).
// The panel follows the server: it changes only on the server's state message or the call's long-poll.
import { type ReactNode, useContext, useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { api, type Call, type OwnerState } from '../api';
import { phone } from '../format';
import { LeaveGuardContext, useCalls, useLatest, useNow, useSettings } from '../hooks';
import { guardLeave, micPermission, openAudio, watchMicPermission, type AudioLink } from '../platform/audio';
import { color, countdownHeight, font, radius, space, useWide } from '../theme';
import { secondsLeft } from './AlertBanner';
import { AudioMeter, Button, Card, MicBlocked, Note, Sheet, T, text } from './ui';

type Link = 'off' | 'connecting' | 'open' | 'failed';
const RECONNECT_TRIES = 3; // the server waits 5 s (OWNER_DROP_GRACE_SECONDS) before it hands back

export function OwnerControls({ call, callbackNumber }: { call: Call; callbackNumber: string | null }) {
  const wide = useWide();
  const now = useNow();
  const { acknowledged, acknowledge } = useCalls();
  const { settings } = useSettings();
  const { setGuarded } = useContext(LeaveGuardContext);
  const [link, setLink] = useState<Link>('off');
  const [owner, setOwner] = useState<OwnerState>('none'); // state from our own socket
  const [callLevel, setCallLevel] = useState(0);
  const [micLevel, setMicLevel] = useState(0);
  const [micDenied, setMicDenied] = useState(false);
  const [muted, setMuted] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [moved, setMoved] = useState(false);
  const [askMic, setAskMic] = useState(false);
  const [confirmHangUp, setConfirmHangUp] = useState(false);
  const audio = useRef<AudioLink | null>(null);
  const alive = useRef(true);
  const retries = useRef(RECONNECT_TRIES);
  const ownerRef = useLatest(owner);
  const alertMax = useRef({ until: null as string | null, max: 0 });

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      audio.current?.close();
      audio.current = null;
    };
  }, []);
  useEffect(() => {
    if (call.finished) audio.current?.close();
  }, [call.finished]);
  // Take over stays disabled while the microphone is blocked, until the browser allows it.
  useEffect(() => (micDenied ? watchMicPermission((p) => p !== 'denied' && setMicDenied(false)) : undefined), [micDenied]);
  // Leaving the page while you have the call hands it back to the AI: ask first, in the app and in the browser.
  const onCall = link === 'open' && owner === 'on_call';
  useEffect(() => {
    setGuarded(onCall);
    const off = guardLeave(onCall);
    return () => {
      off();
      setGuarded(false);
    };
  }, [onCall, setGuarded]);

  /** Opens the audio socket. `thenJoin` takes the call as soon as it is open. */
  const connect = async (thenJoin: boolean): Promise<void> => {
    setLink('connecting');
    setError(null);
    setMoved(false);
    let ticket: string;
    try {
      ({ ticket } = await api.audioTicket(call.id));
    } catch (e) {
      if (!alive.current) return;
      setLink('failed');
      setBusy(null);
      setError((e as Error).message);
      return;
    }
    if (!alive.current) return; // the page closed while the ticket was on its way
    const a: AudioLink = openAudio(call.id, ticket, {
      onState: (o) => {
        retries.current = RECONNECT_TRIES; // connected again: a later drop gets the full budget
        setLink('open');
        setOwner(o);
        setBusy(null);
      },
      onEnded: () => setBusy(null),
      onReplaced: () => setMoved(true),
      onError: (m) => {
        setError(m);
        setBusy(null);
      },
      onLevel: setCallLevel,
      onMicLevel: setMicLevel,
      onClose: (unexpected) => {
        if (audio.current !== a) return; // an older link
        const wasOnCall = ownerRef.current === 'on_call';
        audio.current = null;
        if (!alive.current) return;
        setOwner('none');
        setCallLevel(0);
        setBusy(null);
        // Only a link that had the call reconnects (the server keeps it for 5 s); a listener just stops.
        if (unexpected && wasOnCall && retries.current > 0) {
          retries.current -= 1;
          return void connect(true);
        }
        setLink(unexpected ? 'failed' : 'off');
      },
    });
    audio.current = a;
    if (thenJoin) await takeOver(a);
  };

  /** Opens the microphone (asking first if needed) and sends join. */
  const takeOver = async (a: AudioLink) => {
    const r = await a.startMic();
    if (!alive.current || r === 'closed') return void (alive.current && setBusy(null));
    if (r === 'denied') {
      setMicDenied(true);
      setBusy(null);
      return;
    }
    if (r === 'error') {
      setError('The microphone could not be opened. Check that one is connected, then try again.');
      setBusy(null);
      return;
    }
    setMicDenied(false);
    setMuted(false);
    a.setMuted(false);
    a.join();
  };

  /** Join now / Take over: explain the microphone first if the browser has not asked yet. */
  const join = async () => {
    if ((await micPermission()) === 'prompt') return setAskMic(true);
    void doJoin();
  };
  const doJoin = async () => {
    setAskMic(false);
    setBusy('join');
    if (audio.current) await takeOver(audio.current);
    else await connect(true);
  };

  const listen = () => {
    setBusy('listen');
    void connect(false);
  };

  const stopListening = () => audio.current?.close();

  const handBack = async () => {
    setBusy('hand_back');
    if (audio.current && owner === 'on_call') return audio.current.handBack();
    try {
      await api.handBack(call.id); // phone path
    } catch (e) {
      setError((e as Error).message);
    }
    setBusy(null);
  };

  /** Ring my phone / Join by phone instead. The browser link closes first, so the phone takes over cleanly. */
  const ringPhone = async () => {
    setBusy('phone');
    setError(null);
    audio.current?.close();
    try {
      await api.connect(call.id, 'join', 'phone');
    } catch (e) {
      setError((e as Error).message);
    }
    setBusy(null);
  };

  const hangUp = async () => {
    setConfirmHangUp(false);
    setBusy('hang_up');
    try {
      await api.hangUp(call.id);
    } catch (e) {
      setError((e as Error).message);
      setBusy(null);
    }
  };

  // What to show: our own socket wins; otherwise the server's owner state from the long-poll.
  const server = call.owner;
  const byPhone = server.via === 'phone' && (server.state === 'on_call' || server.state === 'listening');
  const state: 'none' | 'alerting' | 'ringing' | 'listening' | 'on_call' | 'phone' =
    link === 'open' ? (owner === 'on_call' ? 'on_call' : 'listening') : byPhone ? 'phone' : server.state === 'alerting' || server.state === 'ringing' ? server.state : 'none';

  const left = secondsLeft(call, now);
  // The countdown bar is relative to the longest wait seen for this alert; a new alert starts over.
  if (alertMax.current.until !== call.owner.alert_until) alertMax.current = { until: call.owner.alert_until, max: 0 };
  // A hand-over is pending while alert_until is set: alerting, or listening here with the audio open.
  // The server's fallback (phone ring or unreachable) still fires at alert_until, so the countdown stays.
  const pending = (state === 'alerting' || state === 'listening') && left != null;
  if (pending) alertMax.current.max = Math.max(alertMax.current.max, left);
  const transfer = call.mode === 'transfer' || !!call.connect_when;
  const phoneNext = transfer && call.reach !== 'app';
  const noPhone = !callbackNumber;
  const connecting = link === 'connecting';

  const hangUpRow = (
    <View style={s.actions}>
      <Button label={busy === 'hang_up' ? 'Hanging up...' : 'Hang up'} kind="danger" busy={busy === 'hang_up'} onPress={() => setConfirmHangUp(true)} />
      <T v="fine" style={s.center}>
        Asks you to confirm first.
      </T>
    </View>
  );
  const countdown = pending ? (
    <View>
      <View
        style={s.countdown}
        role="progressbar"
        aria-label={phoneNext ? 'Time before your phone rings' : 'Time left to join'}
        aria-valuemin={0}
        aria-valuemax={alertMax.current.max || 1}
        aria-valuenow={left}
      >
        <View style={[s.countdownFill, { width: `${Math.round((left / (alertMax.current.max || 1)) * 100)}%` }]} />
      </View>
      <Text style={[text.fine, s.countdownText]}>{phoneNext && !noPhone ? `Your phone rings in ${left} s` : `${left} s left`}</Text>
    </View>
  ) : null;
  const stack = (children: ReactNode) => <View style={[s.buttons, wide && s.buttonsWide]}>{children}</View>;

  let body: ReactNode;
  if (state === 'on_call') {
    body = (
      <>
        <T v="h2" style={s.h2}>
          You are on the call
        </T>
        <AudioMeter level={micLevel} label={muted ? 'Microphone muted' : 'Your microphone'} />
        <T v="muted">The AI is silent. Say who you are, so they know they are talking to you now.</T>
        {stack(
          <>
            <Button
              label={muted ? 'Unmute' : 'Mute'}
              kind="secondary"
              pressed={muted}
              full={!wide}
              onPress={() => {
                audio.current?.setMuted(!muted);
                setMuted(!muted);
              }}
            />
            <Button label={busy === 'hand_back' ? 'Handing back...' : 'Hand back to AI'} busy={busy === 'hand_back'} full={!wide} onPress={handBack} />
          </>,
        )}
        <Note kind="hint">Use headphones, so the other person does not hear an echo of themselves.</Note>
        <T v="fine">Hand back: the AI says one short line and carries on. You keep listening.</T>
      </>
    );
  } else if (state === 'listening') {
    body = (
      <>
        <T v="h2" style={s.h2}>
          You are listening
        </T>
        <AudioMeter level={callLevel} label="Call audio" />
        {countdown}
        {server.state === 'ringing' && <Note kind="hint">Your phone is ringing. Answer it and press 1, or take over here.</Note>}
        {micDenied ? (
          <MicBlocked what="You can listen, but you cannot talk from this browser." again="Press Take over again." />
        ) : (
          <T v="muted">Nobody on the call hears you. The AI carries on.</T>
        )}
        {stack(
          <>
            <Button label={busy === 'join' ? 'Taking over...' : 'Take over'} busy={busy === 'join'} disabled={micDenied} full={!wide} onPress={join} />
            {micDenied && <Button label="Join by phone instead" kind="secondary" full={!wide} disabled={noPhone} busy={busy === 'phone'} onPress={ringPhone} />}
            <Button label="Stop listening" kind="secondary" full={!wide} onPress={stopListening} />
          </>,
        )}
        {!micDenied && <T v="fine">Headphones recommended before you take over.</T>}
      </>
    );
  } else if (state === 'phone') {
    body = (
      <>
        <T v="h2" style={s.h2}>
          {server.state === 'on_call' ? 'You are on the call by phone' : 'You are listening by phone'}
        </T>
        <T v="muted">{server.state === 'on_call' ? 'Press * on the phone, or hang up, to give the call back to the AI.' : 'Press 1 on the phone to take over.'}</T>
        {server.state === 'on_call' && stack(<Button label={busy === 'hand_back' ? 'Handing back...' : 'Hand back to AI'} busy={busy === 'hand_back'} full={!wide} onPress={handBack} />)}
      </>
    );
  } else if (state === 'ringing') {
    body = (
      <>
        <T v="h2" style={s.h2}>
          Ringing your phone
        </T>
        <T v="muted">{`Answer ${callbackNumber ? phone(callbackNumber) : 'your phone'} and press 1 to join. You can also join here.`}</T>
        <Button label={connecting ? 'Connecting audio...' : 'Join now'} kind="go" size="big" busy={connecting || busy === 'join'} onPress={join} />
      </>
    );
  } else if (state === 'alerting') {
    const ringingHere = !!settings?.alert_sound && !acknowledged.has(call.id);
    body = (
      <>
        <Text style={s.big}>A person is on the line</Text>
        <Text style={text.soft}>{transfer ? 'The AI is keeping them company until you join.' : 'The AI carries on with the call. Listen in, or join.'}</Text>
        {countdown}
        <Button label={connecting && busy === 'join' ? 'Connecting audio...' : 'Join now'} kind="go" size="big" busy={busy === 'join'} onPress={join} />
        {stack(
          <>
            <Button label={connecting && busy === 'listen' ? 'Connecting audio...' : 'Listen first'} kind="secondary" full={!wide} busy={busy === 'listen'} onPress={listen} />
            <Button label="Ring my phone instead" kind="secondary" full={!wide} disabled={noPhone} busy={busy === 'phone'} onPress={ringPhone} />
          </>,
        )}
        {ringingHere && <Button label="Stop ringing" kind="secondary" size="small" onPress={() => acknowledge(call.id)} />}
        <T v="fine">{noPhone ? 'Add a callback number in Settings to be rung by phone.' : `Headphones recommended. Your phone is ${phone(callbackNumber!)}.`}</T>
      </>
    );
  } else {
    body = (
      <>
        <T v="h2" style={s.h2}>
          Listen or join
        </T>
        <T v="muted">The AI is handling the call. Nobody on the call hears you while you listen.</T>
        {stack(
          <>
            <Button label={connecting && busy === 'listen' ? 'Connecting audio...' : 'Listen'} full={!wide} busy={busy === 'listen'} onPress={listen} />
            <Button label={connecting && busy === 'join' ? 'Connecting audio...' : 'Join now'} kind="secondary" full={!wide} busy={busy === 'join'} onPress={join} />
          </>,
        )}
      </>
    );
  }

  return (
    <Card label="You" style={[s.panel, state === 'alerting' && s.alerting]}>
      {body}
      {link === 'failed' && (
        <Note kind="errsum">
          <Text style={[text.base, { color: color.err }]}>{error ?? 'The call audio was cut off.'}</Text>
          <Button label="Try again" kind="secondary" size="small" onPress={() => void connect(false)} />
        </Note>
      )}
      {moved && link === 'off' && <Note kind="hint">The call moved to your phone or another tab.</Note>}
      {link !== 'failed' && error ? (
        <Text role="alert" style={text.err}>
          {error}
        </Text>
      ) : null}
      {hangUpRow}

      <Sheet title="Use your microphone?" visible={askMic} onClose={() => setAskMic(false)}>
        <T v="soft">You need it to talk on the call. It is on only while you have the call; Hand back turns it off. Your browser asks next.</T>
        <T v="fine">Headphones recommended, so the other person does not hear an echo.</T>
        <Button label="Continue" full onPress={doJoin} />
        <Button label="Not now" kind="secondary" full onPress={() => setAskMic(false)} />
      </Sheet>
      <Sheet title="Hang up this call?" visible={confirmHangUp} onClose={() => setConfirmHangUp(false)}>
        <T v="soft">{`The call with ${call.business} ends now, for the AI and for you. This cannot be undone.`}</T>
        <Button label="Hang up" kind="danger" full onPress={hangUp} />
        <Button label="Keep the call" kind="secondary" full onPress={() => setConfirmHangUp(false)} />
      </Sheet>
    </Card>
  );
}

const s = StyleSheet.create({
  panel: { gap: space.ml },
  alerting: { borderColor: color.ok, backgroundColor: color.okSoft },
  h2: { marginBottom: 0 },
  big: { color: color.fg, fontSize: font.size.big, fontWeight: font.weight.heavy },
  buttons: { gap: space.sm },
  buttonsWide: { flexDirection: 'row', flexWrap: 'wrap' },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  center: { alignSelf: 'center' },
  countdown: { height: countdownHeight, backgroundColor: color.okLine, borderRadius: radius.pill, overflow: 'hidden' },
  countdownFill: { height: '100%', backgroundColor: color.ok },
  countdownText: { marginTop: space.s, color: color.okText },
});
