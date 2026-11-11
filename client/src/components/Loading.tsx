import { ActivityIndicator, View } from 'react-native';
import { color, space } from '../theme';
import { Button, Note } from './ui';

/** Loading spinner, or the error with Try again. */
export function Loading({ error, retry, label }: { error?: string | null; retry?: () => void; label: string }) {
  if (error)
    return (
      <View style={{ gap: space.ml }}>
        <Note kind="errsum">{error}</Note>
        {retry && <Button label="Try again" kind="secondary" onPress={retry} />}
      </View>
    );
  return <ActivityIndicator color={color.brand} aria-label={label} />;
}
