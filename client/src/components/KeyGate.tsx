import { useState } from 'react';
import { ApiError } from '../api';
import { useSession } from '../hooks';
import { Button, Gate, T, TextField, text } from './ui';
import { Text } from 'react-native';

/** Paste the API key once; it is checked with GET /api/profile. */
export function KeyGate() {
  const { signIn } = useSession();
  const [key, setKey] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!key.trim()) return setError('Paste your API key.');
    setBusy(true);
    setError(null);
    try {
      await signIn(key.trim());
    } catch (e) {
      setError(e instanceof ApiError && e.status !== 401 ? e.message : 'That key was not accepted. Check it and try again.');
      setBusy(false);
    }
  };

  return (
    <Gate>
      <Text style={text.brand}>CallEnvoy</Text>
      <T v="h1">Enter your API key</T>
      <T v="muted">This is the private console. The key is kept in this browser until you sign out.</T>
      <TextField
        label="API key"
        value={key}
        onChangeText={setKey}
        secureTextEntry
        autoComplete="current-password"
        autoFocus
        onSubmitEditing={submit}
        error={error}
      />
      <Button label={busy ? 'Signing in...' : 'Sign in'} busy={busy} onPress={submit} />
      <T v="fine">The key is CALLENVOY_API_KEY from the server's .env file.</T>
    </Gate>
  );
}
