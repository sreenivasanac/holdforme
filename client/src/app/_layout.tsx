import { router, Slot, usePathname } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import type { Call } from '../api';
import { Loading } from '../components/Loading';
import { Landing } from '../components/Landing';
import { TopBar } from '../components/TopBar';
import { Button, Gate, Sheet, T } from '../components/ui';
import {
  CallsContext,
  LeaveGuardContext,
  SessionContext,
  SettingsContext,
  useCallsState,
  useLatest,
  useSessionState,
  useSettingsState,
} from '../hooks';
import { closeNotification, setupAlerts, showNotification, startRing } from '../platform/alerts';
import { color } from '../theme';

export default function RootLayout() {
  const session = useSessionState();
  const path = usePathname();
  const { me } = session;
  return (
    <SessionContext.Provider value={session}>
      <View style={s.root}>
        {path === '/signin' ? (
          <Slot /> // the emailed link's page, signed in or not
        ) : !me ? (
          <Gate>
            <Loading error={session.error} retry={() => void session.reload()} label="Loading" />
          </Gate>
        ) : me.signed_in ? (
          <Console />
        ) : (
          <Landing />
        )}
      </View>
    </SessionContext.Provider>
  );
}

function Console() {
  const calls = useCallsState(true);
  const settings = useSettingsState();
  const [guarded, setGuarded] = useState(false);
  const [leaveTo, setLeaveTo] = useState<string | null>(null);
  const go = (href: string) => (guarded ? setLeaveTo(href) : router.push(href as '/'));
  const goRef = useLatest(go);
  const p = settings.settings;
  useAlerts(calls.calls, calls.acknowledged, p?.alert_sound ?? true, p?.alert_notification ?? true, p?.push_shows_business ?? true);
  useEffect(() => setupAlerts((path) => goRef.current(path)), [goRef]);
  return (
    <SettingsContext.Provider value={settings}>
      <CallsContext.Provider value={calls}>
        <LeaveGuardContext.Provider value={{ guarded, setGuarded, go }}>
          <TopBar />
          <View style={s.fill}>
            <Slot />
          </View>
          <Sheet title="Leave this call?" visible={leaveTo != null} onClose={() => setLeaveTo(null)}>
            <T v="soft">You have the call. If you leave this page, the call goes back to the AI.</T>
            <Button
              label="Leave"
              kind="danger"
              full
              onPress={() => {
                const to = leaveTo!;
                setLeaveTo(null);
                router.push(to as '/');
              }}
            />
            <Button label="Stay on the call" kind="secondary" full onPress={() => setLeaveTo(null)} />
          </Sheet>
        </LeaveGuardContext.Provider>
      </CallsContext.Provider>
    </SettingsContext.Provider>
  );
}

/** Ring and notify while a call is alerting the owner (plan section 10b). */
function useAlerts(calls: Call[] | null, acknowledged: Set<string>, sound: boolean, notify: boolean, showBusiness: boolean) {
  const notified = useRef(new Set<string>());
  const alerting = (calls ?? []).filter((c) => !c.finished && c.owner.state === 'alerting');
  const ringing = sound && alerting.some((c) => !acknowledged.has(c.id));

  useEffect(() => {
    if (!ringing) return;
    return startRing();
  }, [ringing]);

  const ids = alerting.map((c) => c.id).join(',');
  useEffect(() => {
    for (const c of alerting) {
      if (notified.current.has(c.id)) continue;
      notified.current.add(c.id);
      if (notify) {
        const body = showBusiness ? `A person answered at ${c.business}. Tap to join.` : 'A person is on the line. Tap to join.';
        void showNotification('CallEnvoy', body, c.id);
      }
    }
    // An alert that ended may alert again later (a new hand-over).
    for (const id of notified.current) {
      if (!alerting.some((c) => c.id === id)) {
        notified.current.delete(id);
        closeNotification(id);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids, notify, showBusiness]);
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.bg },
  fill: { flex: 1 },
});
