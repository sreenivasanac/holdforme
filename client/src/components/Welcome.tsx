// First-run welcome card on Calls (round 3 B2): name, a first call (the demo line), an agent.
import { type ReactNode, useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { ApiError } from '../api';
import { toE164 } from '../format';
import { useCalls, useGo, useSession, useSettings } from '../hooks';
import { loadLocal, saveLocal } from '../platform/storage';
import { space } from '../theme';
import { useKeys } from './Agents';
import { CALLBACK_HELP } from './SettingsForm';
import { Button, Card, Cell, Pill, Row, StepNumber, T, TextField } from './ui';


/** Shown from the first sign-in (first_run) until the user hides it; remembered on this device. */
export function useWelcome(): [boolean, () => void] {
  const { me } = useSession();
  const key = `welcome.${me?.email ?? ''}`;
  const [open, setOpen] = useState(() => !!me?.first_run || loadLocal(key) === 'open');
  useEffect(() => {
    if (me?.first_run) saveLocal(key, 'open');
  }, [me?.first_run, key]);
  return [
    open,
    () => {
      saveLocal(key, 'hidden');
      setOpen(false);
    },
  ];
}

export function WelcomeCard({ onHide }: { onHide: () => void }) {
  const go = useGo();
  const { settings } = useSettings();
  const { calls } = useCalls();
  const { keys } = useKeys();
  const named = !!settings?.name;
  const called = !!calls?.some((c) => c.direction === 'outbound');
  const connected = !!keys?.some((k) => k.last_used_at);
  return (
    <Card label="Welcome">
      <View style={s.head}>
        <View style={s.fill}>
          <T v="h2">Welcome to CallEnvoy</T>
          <T v="muted">Three steps to your first call.</T>
        </View>
        {named ? <Button label="Hide" a11yLabel="Hide the welcome steps" kind="link" onPress={onHide} /> : null}
      </View>
      <View role="list" style={s.steps}>
        <Step n={1} done={named} title="Tell the AI who it calls for">
          {named ? <T v="soft">{`The AI says: “I am calling on behalf of ${settings!.name}.”`}</T> : <NameForm />}
        </Step>
        <Step n={2} done={called} title="Make a first call">
          <T v="soft">Try the demo line: a test phone line of CallEnvoy that answers like a business, with a menu and a short hold. Or call a real business.</T>
          <View style={s.actions}>
            <Button label="Try the demo line" disabled={!named} onPress={() => go('/new?demo=1')} />
            <Button label="New call" kind="secondary" disabled={!named} onPress={() => go('/new')} />
          </View>
          {!named ? <T v="fine">Save your name first.</T> : null}
        </Step>
        <Step n={3} done={connected} title="Connect an AI agent">
          <T v="soft">Add CallEnvoy to Claude Code, Codex, Claude Desktop, or Cursor. Then ask your agent to make a call.</T>
          <View style={s.actions}>
            <Button label="Set up an agent" kind="secondary" onPress={() => go('/agents')} />
          </View>
        </Step>
      </View>
    </Card>
  );
}

function Step({ n, done, title, children }: { n: number; done: boolean; title: string; children: ReactNode }) {
  return (
    <View role="listitem" style={s.step}>
      <StepNumber n={n} done={done} />
      <View style={[s.fill, s.body]}>
        <View style={s.title}>
          <T v="h3">{title}</T>
          {done ? <Pill label="Done" tone="ok" /> : null}
        </View>
        {children}
      </View>
    </View>
  );
}

/** Step 1: the profile name (required to place a call) and, optionally, the callback number. */
function NameForm() {
  const { save, config } = useSettings();
  const [name, setName] = useState('');
  const [callback, setCallback] = useState('');
  const [errors, setErrors] = useState<{ name?: string; callback_number?: string }>({});
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    const cb = callback.trim() ? toE164(callback) : null;
    const e: typeof errors = {};
    if (!name.trim()) e.name = 'Enter your name. The AI says it to the person who answers.';
    if (callback.trim() && !cb) e.callback_number = 'Enter a US or Canada number with area code, like (503) 555-0142.';
    setErrors(e);
    if (Object.keys(e).length) return;
    setBusy(true);
    try {
      await save({ name: name.trim(), ...(cb ? { callback_number: cb } : {}) }); // step 1 shows done once the name is saved
    } catch (err) {
      const field = err instanceof ApiError && err.field === 'callback_number' ? 'callback_number' : 'name';
      setErrors({ [field]: (err as Error).message });
      setBusy(false);
    }
  };
  return (
    <View style={s.form}>
      <Row>
        <Cell>
          <TextField label="Your name" value={name} onChangeText={setName} autoComplete="name" maxLength={config?.text_limits.name} error={errors.name} onSubmitEditing={submit} />
        </Cell>
        <Cell>
          <TextField
            label="Callback number"
            optional
            value={callback}
            onChangeText={setCallback}
            inputMode="tel"
            autoComplete="tel"
            error={errors.callback_number}
            help={CALLBACK_HELP}
          />
        </Cell>
      </Row>
      <Button label={busy ? 'Saving...' : 'Save'} busy={busy} onPress={submit} />
    </View>
  );
}

const s = StyleSheet.create({
  fill: { flex: 1 },
  head: { flexDirection: 'row', alignItems: 'flex-start', gap: space.ml },
  steps: { gap: space.xxl, marginTop: space.xl },
  step: { flexDirection: 'row', gap: space.l, alignItems: 'flex-start' },
  body: { gap: space.sm },
  title: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: space.sm },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: space.ml },
  form: { gap: space.ml },
});
