// Per-device parts of Settings: alert permissions, web push, microphone check (plan section 10b).
// Permission prompts are only asked from a button, after one sentence that says why.
import { useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { api, type Config } from '../api';
import {
  deviceLabel,
  notificationPermission,
  pushEndpoint,
  pushSupport,
  requestNotifications,
  startRing,
  subscribePush,
  unsubscribePush,
  type Permission,
} from '../platform/alerts';
import { checkMic, micPermission } from '../platform/audio';
import { color, space } from '../theme';
import { AudioMeter, Button, Card, MicBlocked, Note, Pill, Sheet, Stack, StatusLine, Steps, SwitchRow, T, text } from './ui';

const RING_TEST_MS = 3000;

export function DeviceAlerts({ config }: { config: Config }) {
  const support = pushSupport();
  const [perm, setPerm] = useState<Permission>(notificationPermission());
  const [endpoint, setEndpoint] = useState<string | null>(null);
  const [sheet, setSheet] = useState<'ask' | 'denied' | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const vapid = config.vapid_public_key;

  useEffect(() => {
    void pushEndpoint().then(setEndpoint).catch(() => {});
  }, []);

  const run = async (name: string, fn: () => Promise<void>) => {
    setBusy(name);
    setError(null);
    setResult(null);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    }
    setBusy(null);
  };

  const subscribe = () =>
    run('push', async () => {
      const sub = await subscribePush(vapid!);
      await api.addPushDevice(sub);
      setEndpoint(sub.endpoint);
    });
  const unsubscribe = () =>
    run('push', async () => {
      const ep = await unsubscribePush();
      if (ep) await api.removePushDevice(ep);
      setEndpoint(null);
    });

  const turnOn = async () => {
    setSheet(null);
    const p = await requestNotifications();
    setPerm(p);
    if (p === 'denied') return setSheet('denied');
    if (p === 'granted' && support === 'ok' && vapid) await subscribe();
  };

  const testSound = () => {
    const stop = startRing();
    setBusy('sound');
    setTimeout(() => {
      stop();
      setBusy(null);
    }, RING_TEST_MS);
  };

  return (
    <Card label="Alerts on this device">
      <T v="h2">Alerts on this device</T>
      <T v="muted">Permissions belong to this browser, not to your account.</T>
      <StatusLine
        title="Sound"
        help="Rings while this page is open."
        right={<Button label={busy === 'sound' ? 'Ringing...' : 'Test sound'} kind="secondary" size="small" busy={busy === 'sound'} onPress={testSound} />}
      />
      {support === 'home_screen' ? (
        <>
          <StatusLine title="Push alerts" help="Needs CallEnvoy on your home screen (iOS 16.4 or later)." right={<Pill label="Off" />} />
          <Note kind="hint" title="Add CallEnvoy to your home screen">
            <Steps items={['Tap the Share button in Safari.', 'Tap Add to Home Screen, then Add.', 'Open CallEnvoy from the home screen and come back to Settings.']} />
          </Note>
          <T v="fine">Until then your phone rings for a hand-over, after the alert time.</T>
        </>
      ) : perm === 'unsupported' ? (
        <StatusLine title="Notifications" help="This browser does not support notifications. Your phone still rings for a hand-over." right={<Pill label="Off" />} />
      ) : perm === 'default' ? (
        <Stack gap={space.m}>
          <StatusLine title="Notifications and push" help="Not turned on for this device yet." right={<Pill label="Off" />} />
          <Button label="Turn on alerts on this device" onPress={() => setSheet('ask')} />
          <T v="fine">So you hear about a person on the line even when this page is closed. Your phone still rings if you do not join.</T>
        </Stack>
      ) : perm === 'denied' ? (
        <StatusLine
          title="Notifications"
          help="Blocked in this browser."
          right={<Button label="How to allow" kind="secondary" size="small" onPress={() => setSheet('denied')} />}
        />
      ) : (
        <>
          <StatusLine title="Notifications" help="Allowed in this browser." right={<Pill label="Allowed" tone="ok" />} />
          <SwitchRow
            title="Push alerts on this device"
            help={vapid ? `${deviceLabel()}. Alerts arrive with this page closed.` : 'Web push is off on the server (no VAPID keys).'}
            value={!!endpoint}
            disabled={!vapid || support !== 'ok' || busy === 'push'}
            onChange={(on) => void (on ? subscribe() : unsubscribe())}
          />
          <StatusLine
            title="Test push"
            help="Sends a test alert to every saved device."
            right={
              <Button
                label={busy === 'test' ? 'Sending...' : 'Send test push'}
                kind="secondary"
                size="small"
                disabled={!vapid}
                busy={busy === 'test'}
                onPress={() =>
                  run('test', async () => {
                    const { sent } = await api.testPush();
                    setResult(sent === 0 ? 'No saved devices yet. Turn on push above.' : `Test push sent to ${sent} device${sent === 1 ? '' : 's'}.`);
                  })
                }
              />
            }
          />
        </>
      )}
      {result && <Note kind="saved">{result}</Note>}
      {error && (
        <Text role="alert" style={text.err}>
          {error}
        </Text>
      )}

      <Sheet title="Turn on alerts on this device?" visible={sheet === 'ask'} onClose={() => setSheet(null)}>
        <T v="soft">CallEnvoy can tell you when a person is on the line, even when this page is closed. Your browser asks next.</T>
        <Button label="Continue" full onPress={() => void turnOn()} />
        <Button label="Not now" kind="secondary" full onPress={() => setSheet(null)} />
      </Sheet>
      <Sheet title="Notifications are blocked" visible={sheet === 'denied'} onClose={() => setSheet(null)}>
        <T v="soft">This browser blocked notifications for this site. To allow them:</T>
        <Steps items={['Click the lock icon next to the address.', 'Set Notifications to Allow.', 'Come back and press Check again.']} />
        <T v="fine">Your phone still rings for a hand-over if you do not join in time.</T>
        <Button
          label="Check again"
          full
          onPress={() => {
            const p = notificationPermission();
            setPerm(p);
            if (p !== 'denied') setSheet(null);
          }}
        />
        <Button label="Close" kind="secondary" full onPress={() => setSheet(null)} />
      </Sheet>
    </Card>
  );
}

/** Microphone permission and a level meter. */
export function AudioCheck() {
  const [state, setState] = useState<'granted' | 'denied' | 'prompt' | 'error'>('prompt');
  const [level, setLevel] = useState(0);
  const [on, setOn] = useState(false);
  const stop = useRef<(() => void) | null>(null);
  useEffect(() => {
    void micPermission().then(setState);
    return () => stop.current?.();
  }, []);

  const toggle = async () => {
    if (on) {
      stop.current?.();
      stop.current = null;
      setOn(false);
      setLevel(0);
      return;
    }
    const r = await checkMic(setLevel);
    if (typeof r === 'string') return setState(r);
    stop.current = r.stop;
    setState('granted');
    setOn(true);
  };

  const label =
    state === 'granted' ? (on ? 'Microphone: allowed. Say something to see the level.' : 'Microphone: allowed.') : state === 'prompt' ? 'Microphone: not asked yet.' : 'Microphone: not available.';
  return (
    <Card label="Audio check">
      <Stack>
        <T v="h2" style={s.noMargin}>
          Audio check
        </T>
        <AudioMeter level={level} label={label} />
        {state === 'denied' && (
          <MicBlocked what="You can listen to calls, but you cannot talk from this browser." again="Press Check microphone again." />
        )}
        {state === 'error' && <Note kind="errsum">The microphone could not be opened. Check that one is connected.</Note>}
        <Button label={on ? 'Stop check' : 'Check microphone'} kind="secondary" pressed={on} onPress={() => void toggle()} />
        <T v="fine">Headphones recommended when you take over a call.</T>
      </Stack>
    </Card>
  );
}

const s = StyleSheet.create({
  noMargin: { marginBottom: 0 },
});
