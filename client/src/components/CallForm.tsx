import { router } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { api, ApiError, type Config, type Mode, type NewCall, type Settings } from '../api';
import { phone, toE164 } from '../format';
import { useCallerId } from '../hooks';
import { space, useWide } from '../theme';
import { CallOptions, checkNumbers, MODE_OPTIONS, type Options } from './CallOptions';
import { Button, Card, Note, Segmented, Stack, T, TextField, text } from './ui';
import { VoicePicker } from './VoicePicker';

type Errors = Partial<Record<keyof NewCall | keyof Options | 'form', string>>;

/** The place_call form. Every option starts from the saved settings. */
// The server's field names for the two options whose settings name differs.
const TO_SETTING: Record<string, keyof Options> = { record: 'record_calls', from: 'caller_id' };

export function CallForm({ config, settings }: { config: Config; settings: Settings }) {
  const wide = useWide();
  const callerId = useCallerId();
  const ownVerified = !!callerId?.verified && !!callerId.number && callerId.number === settings.callback_number;
  const [f, setF] = useState({
    to: '',
    business: '',
    goal: '',
    facts: '',
    menu_tips: '',
    flexibility: '',
    on_behalf_of: '',
    connect_when: '',
    mode: settings.mode as Mode,
    voice: settings.voice,
    reach: settings.reach,
    no_answer: settings.no_answer,
    caller_id: settings.caller_id,
    alert_on_human: settings.alert_on_human,
    listen_in: settings.listen_in,
    record_calls: settings.record_calls,
    leave_voicemail: settings.leave_voicemail,
    alert_wait_seconds: String(settings.alert_wait_seconds),
    phone_ring_seconds: String(settings.phone_ring_seconds),
    max_minutes: String(settings.max_minutes),
  });
  // Own caller ID only once the number is verified (the state loads after the form opens).
  const from = f.caller_id === 'own' && ownVerified ? 'own' : 'callenvoy';
  const [more, setMore] = useState(false);
  const [errors, setErrors] = useState<Errors>({});
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof typeof f>(k: K) => (v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }));

  const needsPhone = f.reach === 'phone' && (f.mode === 'transfer' || !!f.connect_when.trim() || f.listen_in);

  const submit = async () => {
    const { n, errors: e } = checkNumbers(f, config.ranges, ['alert_wait_seconds', 'max_minutes']) as { n: Record<string, number>; errors: Errors };
    const to = toE164(f.to);
    if (!to) e.to = 'Enter a US or Canada number with area code, like (503) 555-0142.';
    if (!f.business.trim()) e.business = 'Say who you are calling.';
    if (f.goal.trim().length < 5) e.goal = 'Say what the call should get done (at least 5 characters).';
    if (needsPhone && !settings.callback_number) e.reach = 'Transfer by phone needs a callback number. Add one in Settings, or choose App.';
    setErrors(e);
    if (Object.keys(e).length) {
      if (e.alert_wait_seconds || e.max_minutes || e.reach || e.caller_id) setMore(true);
      return;
    }
    const opt = (s: string) => s.trim() || undefined;
    const body: NewCall = {
      to: to!,
      business: f.business.trim(),
      goal: f.goal.trim(),
      facts: opt(f.facts),
      menu_tips: opt(f.menu_tips),
      flexibility: opt(f.flexibility),
      on_behalf_of: opt(f.on_behalf_of),
      connect_when: opt(f.connect_when),
      mode: f.mode,
      reach: f.reach,
      no_answer: f.no_answer,
      alert_on_human: f.alert_on_human,
      listen_in: f.listen_in,
      record: f.record_calls,
      from,
      leave_voicemail: f.leave_voicemail,
      voice: f.voice,
      alert_wait_seconds: n.alert_wait_seconds,
      max_minutes: n.max_minutes,
    };
    setBusy(true);
    try {
      const { id } = await api.placeCall(body);
      router.replace(`/calls/${id}`);
    } catch (err) {
      setBusy(false);
      const name = err instanceof ApiError && err.field ? (TO_SETTING[err.field] ?? err.field) : '';
      const field = name in f ? (name as keyof Errors) : 'form';
      setErrors({ [field]: err instanceof Error ? err.message : 'The call could not be placed.' });
      if (field !== 'form' && !['to', 'business', 'goal', 'facts', 'mode'].includes(field)) setMore(true);
    }
  };

  const count = Object.keys(errors).filter((k) => k !== 'form').length;
  const modeHelp =
    f.mode === 'transfer'
      ? 'The AI gets through the menu and the hold, then brings you on the line.'
      : 'The AI does the whole call. You can still listen or join.';
  const reachHelp = `App: an alert in this console and on your devices. Phone: rings ${settings.callback_number ? phone(settings.callback_number) : 'your callback number'}.`;

  return (
    <Card label="New call">
      <Stack>
        <View>
          <T v="h2">New call</T>
          <T v="muted">Every option starts from your Settings.</T>
        </View>
        {count > 0 && <Note kind="errsum">{`Fix ${count} field${count > 1 ? 's' : ''} to place the call.`}</Note>}
        {errors.form && <Note kind="errsum">{errors.form}</Note>}
        <TextField
          label="Number to call"
          value={f.to}
          onChangeText={set('to')}
          inputMode="tel"
          autoComplete="off"
          placeholder="+1 (555) 555-0100"
          help="US or Canada numbers only."
          error={errors.to}
        />
        <TextField label="Business" value={f.business} onChangeText={set('business')} placeholder="For example Northstar Internet" maxLength={120} error={errors.business} />
        <TextField
          label="Goal"
          rows={3}
          value={f.goal}
          onChangeText={set('goal')}
          placeholder="What should the call get done?"
          maxLength={1500}
          help="The AI says this in one short sentence to the person who answers."
          error={errors.goal}
        />
        <TextField
          label="Details the AI may share"
          optional
          rows={3}
          value={f.facts}
          onChangeText={set('facts')}
          placeholder="Account number, dates, anything the AI may say"
          maxLength={3000}
          help="Added to the details in Settings for this call only."
          error={errors.facts}
        />
        <Segmented label="When a person answers" value={f.mode} options={MODE_OPTIONS} onChange={set('mode')} help={modeHelp} />

        <Button
          label={more ? '▾ Fewer options' : '▸ More options (voice, recording, how to reach you)'}
          kind="link"
          expanded={more}
          onPress={() => setMore(!more)}
        />
        {more && (
          <Stack>
            <Text style={text.subhead}>The call</Text>
            <TextField
              label="Menu tips"
              optional
              value={f.menu_tips}
              onChangeText={set('menu_tips')}
              maxLength={300}
              placeholder="For example: billing is option 1"
              help="Hints only. The AI still waits for the real menu."
              error={errors.menu_tips}
            />
            <TextField
              label="What the AI may accept without asking you"
              optional
              rows={2}
              value={f.flexibility}
              onChangeText={set('flexibility')}
              maxLength={1500}
              error={errors.flexibility}
            />
            <TextField
              label="On behalf of"
              value={f.on_behalf_of}
              onChangeText={set('on_behalf_of')}
              placeholder={settings.name || 'Your name'}
              maxLength={80}
              help="From Settings when empty."
              error={errors.on_behalf_of}
            />
            <Text style={text.subhead}>Hand-over</Text>
            <TextField
              label="Also hand over when"
              optional
              value={f.connect_when}
              onChangeText={set('connect_when')}
              maxLength={300}
              placeholder="For example: if they need to speak to me"
              help="Optional custom condition, in your words."
              error={errors.connect_when}
            />
            <CallOptions
              o={f}
              onChange={(patch) => setF((x) => ({ ...x, ...patch }))}
              errors={errors}
              config={config}
              ownVerified={ownVerified}
              perCall
              reachHelp={reachHelp}
            />
            <VoicePicker label="AI voice" voices={config.voices} value={f.voice} onChange={set('voice')} />
          </Stack>
        )}

        <View style={[s.foot, wide && s.footWide]}>
          <Button label={busy ? 'Calling...' : 'Call now'} size="big" busy={busy} onPress={submit} full={!wide} />
          <T v="fine">The number is dialed right away.</T>
        </View>
      </Stack>
    </Card>
  );
}

const s = StyleSheet.create({
  foot: { gap: space.l },
  footWide: { flexDirection: 'row', alignItems: 'center' },
});
