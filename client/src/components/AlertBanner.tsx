import { router, usePathname } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';
import type { Call } from '../api';
import { useCalls, useNow } from '../hooks';
import { color, font, radius, space, useWide } from '../theme';
import { Button } from './ui';

export function secondsLeft(call: Call, now: number) {
  return call.owner.alert_until ? Math.max(0, Math.ceil((Date.parse(call.owner.alert_until) - now) / 1000)) : null;
}

/** Green banner on every screen while a call is alerting the owner. */
export function AlertBanner() {
  const { calls, acknowledge } = useCalls();
  const now = useNow();
  const wide = useWide();
  const path = usePathname();
  // Not on the page of that call: its owner panel shows the alert there.
  const call = calls?.find((c) => !c.finished && c.owner.state === 'alerting' && path !== `/calls/${c.id}`);
  if (!call) return null;
  const left = secondsLeft(call, now);
  const transfer = call.mode === 'transfer' || !!call.connect_when;
  const phoneNext = transfer && call.reach === 'app_then_phone' && !!left;
  const open = () => {
    acknowledge(call.id);
    router.push(`/calls/${call.id}`);
  };
  return (
    <View role="alert" style={s.banner}>
      <View style={s.textBox}>
        <Text style={s.title}>A person answered at {call.business}</Text>
        <Text style={s.sub}>
          {transfer ? 'Join now' : 'Listen in'}
          {phoneNext ? `, or your phone rings in ${left} s.` : '.'}
        </Text>
      </View>
      <View style={[s.actions, !wide && s.actionsNarrow]}>
        <View style={!wide && s.grow}>
          <Button label={transfer ? 'Join now' : 'Listen'} kind="dark" onPress={open} full />
        </View>
        <View style={!wide && s.grow}>
          <Button label="Open call" kind="outline" onPress={open} full />
        </View>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  banner: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.ml,
    backgroundColor: color.ok,
    borderRadius: radius.xl,
    paddingVertical: space.l,
    paddingHorizontal: space.xl,
  },
  textBox: { flexShrink: 1 },
  title: { color: color.okInk, fontSize: font.size.xl, fontWeight: font.weight.bold },
  sub: { color: color.okInk, fontSize: font.size.m, fontWeight: font.weight.semi },
  actions: { flexDirection: 'row', gap: space.sm },
  actionsNarrow: { width: '100%' },
  grow: { flex: 1 },
});
