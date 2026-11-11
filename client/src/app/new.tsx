import { BackLink } from '../components/BackLink';
import { CallForm } from '../components/CallForm';
import { Loading } from '../components/Loading';
import { Screen } from '../components/ui';
import { useSettings } from '../hooks';

/** New call: the place_call form. */
export default function NewCallScreen() {
  const { config, settings, error, reload } = useSettings();
  return (
    <Screen>
      <BackLink />
      {config && settings ? <CallForm config={config} settings={settings} /> : <Loading error={error} retry={reload} label="Loading settings" />}
    </Screen>
  );
}
