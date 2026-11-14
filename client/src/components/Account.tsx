import { useState } from 'react';
import { Text } from 'react-native';
import { useCalls, useSession } from '../hooks';
import { Button, Card, Sheet, Stack, StatusLine, T, text } from './ui';

/** Settings > Account: who is signed in, and Sign out (asks first when a call is live). */
export function AccountCard({ id }: { id?: string }) {
  const { me, signOut } = useSession();
  const { calls } = useCalls();
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const live = calls?.some((c) => !c.finished);
  const out = async () => {
    setConfirm(false);
    setError(null);
    try {
      await signOut();
    } catch {
      setError('Could not sign out. Try again.');
    }
  };
  return (
    <Card label="Account" id={id}>
      <Stack gap={0}>
        <T v="h2">Account</T>
        <StatusLine
          title="Signed in"
          help={me?.email ?? undefined}
          right={<Button label="Sign out" kind="secondary" size="small" onPress={() => (live ? setConfirm(true) : void out())} />}
        />
        {error ? (
          <Text role="alert" style={text.err}>
            {error}
          </Text>
        ) : null}
      </Stack>
      <Sheet title="Sign out while a call is live?" visible={confirm} onClose={() => setConfirm(false)}>
        <T v="soft">The call goes on. You will not get alerts in this browser until you sign in again.</T>
        <Button label="Sign out" kind="danger" full onPress={() => void out()} />
        <Button label="Stay signed in" kind="secondary" full onPress={() => setConfirm(false)} />
      </Sheet>
    </Card>
  );
}
