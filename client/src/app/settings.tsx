import { Loading } from '../components/Loading';
import { SettingsForm } from '../components/SettingsForm';
import { Screen } from '../components/ui';
import { useSettings } from '../hooks';

/** Settings: profile and call defaults (saved on the server), this device's alerts and audio, account. */
export default function SettingsScreen() {
  const { config, settings, error, reload } = useSettings();
  if (!config || !settings)
    return (
      <Screen>
        <Loading error={error} retry={reload} label="Loading settings" />
      </Screen>
    );
  return <SettingsForm config={config} settings={settings} />;
}
