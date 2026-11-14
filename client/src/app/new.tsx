import { useLocalSearchParams } from 'expo-router';
import { BackLink } from '../components/BackLink';
import { CallForm } from '../components/CallForm';
import { Loading } from '../components/Loading';
import { Screen } from '../components/ui';
import { useSettings } from '../hooks';

/** New call: the place_call form. `?demo=1` fills in CallEnvoy's demo line. */
export default function NewCallScreen() {
  const { config, settings, error, reload } = useSettings();
  const { demo } = useLocalSearchParams<{ demo?: string }>();
  return (
    <Screen>
      <BackLink />
      {config && settings ? <CallForm key={demo} config={config} settings={settings} demo={demo === '1' ? config.demo : undefined} /> : <Loading error={error} retry={reload} label="Loading settings" />}
    </Screen>
  );
}
