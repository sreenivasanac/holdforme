import { router, Slot } from 'expo-router';
import { useEffect, useRef } from 'react';
import { StyleSheet, View } from 'react-native';
import { KeyGate } from '../components/KeyGate';
import { TopBar } from '../components/TopBar';
import type { Call } from '../api';
import { CallsContext, SessionContext, useCallsState, useSessionState, useSettings } from '../hooks';
import { closeNotification, setupAlerts, showNotification, startRing } from '../platform/alerts';
import { color } from '../theme';

export default function RootLayout() {
  const session = useSessionState();
  return (
    <SessionContext.Provider value={session}>
      <View style={s.root}>{session.key ? <Console key={session.key} /> : <KeyGate />}</View>
    </SessionContext.Provider>
  );
}

function Console() {
  const calls = useCallsState(true);
  const { settings } = useSettings();
  useAlerts(calls.calls, calls.acknowledged, settings?.alert_sound ?? true, settings?.alert_notification ?? true, settings?.push_shows_business ?? true);
  useEffect(() => setupAlerts((path) => router.push(path as '/')), []);
  return (
    <CallsContext.Provider value={calls}>
      <TopBar />
      <View style={s.fill}>
        <Slot />
      </View>
    </CallsContext.Provider>
  );
}

/** Ring and notify while a call is alerting the owner (plan section 10b). */
function useAlerts(
  calls: Call[] | null,
  acknowledged: Set<string>,
  sound: boolean,
  notify: boolean,
  showBusiness: boolean,
) {
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
