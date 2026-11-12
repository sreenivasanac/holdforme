// Console sign-in by a one-time email link (plan round 2, B1). The session is an HttpOnly cookie.
import { router } from 'expo-router';
import { useState } from 'react';
import { Text } from 'react-native';
import { api, ApiError } from '../api';
import { useNow, useSession } from '../hooks';
import { Button, CopyBlock, Gate, Note, T, TextField, text } from './ui';

const RESEND_SECONDS = 30;
const SIGNIN_COMMAND = 'uv run python -m callenvoy.signin';

/** Email field and "Send sign-in link", then "Check your email". */
export function SignInGate() {
  const { me } = useSession();
  const [email, setEmail] = useState('');
  const [sentAt, setSentAt] = useState<number | null>(null); // the last link request; kept when going back to the address
  const [checking, setChecking] = useState(false); // "Check your email" shown
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const left = (t: number) => (sentAt ? Math.min(RESEND_SECONDS, Math.max(0, RESEND_SECONDS - Math.floor((t - sentAt) / 1000))) : 0);
  const now = useNow(1000, left(Date.now()) > 0); // ticks only while there is a wait
  const wait = left(now);

  const send = async () => {
    if (left(Date.now()) > 0) return; // Enter in the field during the wait
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) return setError('Enter your email address, like name@example.com.');
    setBusy(true);
    setError(null);
    try {
      await api.requestLink(email.trim());
      setSentAt(Date.now());
      setChecking(true);
    } catch (e) {
      setError((e as Error).message);
    }
    setBusy(false);
  };

  if (me && !me.mail_ready)
    return (
      <Gate>
        <Text style={text.brand}>CallEnvoy</Text>
        <T v="h1">Sign in</T>
        <T v="muted">Email sign-in is not set up on this server. Run this command on the server to get a one-time sign-in link, then open the link in this browser.</T>
        <CopyBlock code={SIGNIN_COMMAND} name="sign-in command" />
        <T v="fine">To get links by email, set OWNER_EMAIL and the SMTP settings in the server's .env file.</T>
      </Gate>
    );

  if (checking)
    return (
      <Gate>
        <Text style={text.brand}>CallEnvoy</Text>
        <T v="h1">Check your email</T>
        <T v="muted">{`If ${email.trim()} is the owner address, a sign-in link is on its way. The link works once, for 15 minutes.`}</T>
        {error ? <Note kind="errsum">{error}</Note> : null}
        <Button
          label={busy ? 'Sending...' : wait ? `Send again (${wait} s)` : 'Send again'}
          kind="secondary"
          busy={busy}
          disabled={wait > 0}
          onPress={send}
        />
        <Button label="Use another address" kind="link" onPress={() => setChecking(false)} />
      </Gate>
    );

  return (
    <Gate>
      <Text style={text.brand}>CallEnvoy</Text>
      <T v="h1">Sign in</T>
      <T v="muted">This is the private console. We email a one-time sign-in link to the owner address.</T>
      <TextField
        label="Email"
        value={email}
        onChangeText={setEmail}
        inputMode="email"
        autoComplete="email"
        autoCapitalize="none"
        autoFocus
        onSubmitEditing={send}
        error={error}
      />
      <Button label={busy ? 'Sending...' : wait ? `Send sign-in link (${wait} s)` : 'Send sign-in link'} busy={busy} disabled={wait > 0} onPress={send} />
      <T v="fine">{`No email? Run ${SIGNIN_COMMAND} on the server for a link.`}</T>
    </Gate>
  );
}

/** The page of the emailed link. Opening it does nothing by itself (mail scanners open links): the button signs in. */
export function SignInLink({ token }: { token: string | undefined }) {
  const { reload } = useSession();
  const [busy, setBusy] = useState(false);
  const [bad, setBad] = useState(!token);
  const [error, setError] = useState<string | null>(null);
  const [verified, setVerified] = useState(false); // the link is used up: a retry only loads the account

  const signIn = async () => {
    setBusy(true);
    setError(null);
    try {
      if (!verified) {
        await api.verifyLink(token!);
        setVerified(true);
      }
      if (await reload()) {
        router.replace('/');
        return;
      }
      setError('You are signed in, but the console could not load. Check your connection and try again.');
    } catch (e) {
      if (e instanceof ApiError && e.code === 'bad_link') setBad(true);
      else setError((e as Error).message);
    }
    setBusy(false);
  };

  return (
    <Gate>
      <Text style={text.brand}>CallEnvoy</Text>
      {bad ? (
        <>
          <T v="h1">This link does not work</T>
          <T v="muted">A sign-in link works once, for 15 minutes. This one was used, has expired, or is incomplete.</T>
          <Button label="Send a new link" onPress={() => router.replace('/')} />
        </>
      ) : (
        <>
          <T v="h1">Sign in to CallEnvoy</T>
          <T v="muted">Press the button to sign in on this browser. You stay signed in for 30 days.</T>
          {error ? <Note kind="errsum">{error}</Note> : null}
          <Button label={busy ? 'Signing in...' : 'Sign in to CallEnvoy'} busy={busy} onPress={signIn} />
        </>
      )}
    </Gate>
  );
}
