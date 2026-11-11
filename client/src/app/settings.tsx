import { StyleSheet, Text, View } from 'react-native';
import { AudioCheck, DeviceAlerts } from '../components/DeviceAlerts';
import { Loading } from '../components/Loading';
import { SettingsForm } from '../components/SettingsForm';
import { useSignOut } from '../components/TopBar';
import { Button, Card, Screen, T, text } from '../components/ui';
import { useSettings } from '../hooks';
import { color, space } from '../theme';

/** Settings: profile and call defaults (saved on the server), then this device's alerts and audio. */
export default function SettingsScreen() {
  const { config, settings, error, reload } = useSettings();
  const signOut = useSignOut();
  if (!config || !settings)
    return (
      <Screen>
        <Loading error={error} retry={reload} label="Loading settings" />
      </Screen>
    );
  const l = config.limits;
  const [, maxCall] = config.ranges.max_minutes;
  return (
    <Screen>
      <SettingsForm config={config} settings={settings} />
      <DeviceAlerts config={config} />
      <AudioCheck />
      <Card label="Limits">
        <T v="h2">Limits</T>
        <View style={s.limits}>
          {[
            `${settings.max_minutes} minutes planned per call, ${maxCall} at most`,
            `Up to ${l.max_concurrent_calls} calls at the same time`,
            `${l.daily_minute_cap} call minutes per day${l.minutes_used_today != null ? ` (${l.minutes_used_today} used today)` : ''}`,
            'US and Canada numbers only; premium and Caribbean area codes are blocked',
            `Calls are ${settings.record_calls ? '' : 'not '}recorded by default (setting above)`,
          ].map((t) => (
            <Text key={t} style={[text.base, s.limit]}>
              {t}
            </Text>
          ))}
        </View>
      </Card>
      <Button label="Sign out" kind="secondary" onPress={signOut.request} />
      {signOut.sheet}
    </Screen>
  );
}

const s = StyleSheet.create({
  limits: { gap: space.s },
  limit: { color: color.soft },
});
