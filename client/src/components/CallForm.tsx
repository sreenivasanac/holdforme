import { router } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { api, ApiError, type CallerId, type Config, type Mode, type NewCall, type NoAnswer, type Reach, type Settings } from '../api';
import { phone, toE164 } from '../format';
import { space, useWide } from '../theme';
import { Button, Card, Cell, Note, Row, Segmented, Stack, SwitchRow, T, TextField, TextLink, text } from './ui';
import { VoicePicker } from './VoicePicker';

export const MODE_OPTIONS = [
  ['handle', 'AI handles the call'],
  ['transfer', 'Transfer to me when a person answers'],
] as const;
export const REACH_OPTIONS = [
  ['app', 'App'],
  ['phone', 'Phone'],
  ['app_then_phone', 'App, then phone'],
] as const;
export const CALLER_ID_OPTIONS = [
  ['callenvoy', 'CallEnvoy number'],
  ['own', 'My own number'],
] as const;
export const NO_ANSWER_OPTIONS = [
  ['ai_handles', 'AI carries on'],
  ['end_politely', 'End politely'],
] as const;

type Errors = Partial<Record<keyof NewCall | 'form', string>>;

/** Integer in [min, max], or null. */
export const intIn = (v: string, min: number, max: number) => {
  const n = Number(v);
  return v.trim() !== '' && Number.isInteger(n) && n >= min && n <= max ? n : null;
};

/** The place_call form. Every option starts from the saved settings. */
export function CallForm({ config, settings, ownVerified }: { config: Config; settings: Settings; ownVerified: boolean }) {
  const wide = useWide();
  const maxCall = config.limits.max_call_minutes;
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
    reach: settings.reach as Reach,
    no_answer: settings.no_answer as NoAnswer,
    alert_on_human: settings.alert_on_human,
    listen_in: settings.listen_in,
    record: settings.record_calls,
    from: (settings.caller_id === 'own' && ownVerified ? 'own' : 'callenvoy') as CallerId,
    leave_voicemail: settings.leave_voicemail,
    voice: settings.voice,
    alert_wait_seconds: String(settings.alert_wait_seconds),
    max_minutes: String(settings.max_minutes),
  });
  const [more, setMore] = useState(false);
  const [errors, setErrors] = useState<Errors>({});
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof typeof f>(k: K) => (v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }));

  const needsPhone = f.reach === 'phone' && (f.mode === 'transfer' || !!f.connect_when.trim() || f.listen_in);

  const submit = async () => {
    const e: Errors = {};
    const to = toE164(f.to);
    if (!to) e.to = 'Enter a US or Canada number with area code, like (503) 555-0142.';
    if (!f.business.trim()) e.business = 'Say who you are calling.';
    if (f.goal.trim().length < 5) e.goal = 'Say what the call should get done (at least 5 characters).';
    const wait = intIn(f.alert_wait_seconds, 5, 120);
    if (wait == null) e.alert_wait_seconds = 'Enter a number from 5 to 120.';
    const max = intIn(f.max_minutes, 1, maxCall);
    if (max == null) e.max_minutes = `Enter a number from 1 to ${maxCall}.`;
    if (needsPhone && !settings.callback_number) e.reach = 'Transfer by phone needs a callback number. Add one in Settings, or choose App.';
    setErrors(e);
    if (Object.keys(e).length) {
      if (e.alert_wait_seconds || e.max_minutes || e.reach) setMore(true);
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
      record: f.record,
      from: f.from,
      leave_voicemail: f.leave_voicemail,
      voice: f.voice,
      alert_wait_seconds: wait!,
      max_minutes: max!,
    };
    setBusy(true);
    try {
      const { id } = await api.placeCall(body);
      router.replace(`/calls/${id}`);
    } catch (err) {
      setBusy(false);
      const field = err instanceof ApiError && err.field && err.field in f ? (err.field as keyof NewCall) : 'form';
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
            <Row>
              <Cell>
                <TextField
                  label="On behalf of"
                  value={f.on_behalf_of}
                  onChangeText={set('on_behalf_of')}
                  placeholder={settings.name || 'Your name'}
                  maxLength={80}
                  help="From Settings when empty."
                  error={errors.on_behalf_of}
                />
              </Cell>
              <Cell>
                <TextField
                  label="Planned minutes"
                  numeric
                  value={f.max_minutes}
                  onChangeText={set('max_minutes')}
                  help={`Extended while on hold, never past ${maxCall}.`}
                  error={errors.max_minutes}
                />
              </Cell>
            </Row>
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
            <Segmented
              label="How to reach me"
              value={f.reach}
              options={REACH_OPTIONS}
              onChange={set('reach')}
              help={reachHelp}
              error={
                errors.reach ? (
                  <View style={s.inlineErr}>
                    <Text role="alert" style={text.err}>
                      {errors.reach}
                    </Text>
                    <TextLink label="Open Settings" onPress={() => router.push('/settings')} />
                  </View>
                ) : null
              }
            />
            <Row>
              <Cell>
                <TextField
                  label="Seconds to wait for you after an alert"
                  numeric
                  value={f.alert_wait_seconds}
                  onChangeText={set('alert_wait_seconds')}
                  error={errors.alert_wait_seconds}
                />
              </Cell>
              <Cell>
                <Segmented label="If I do not answer" value={f.no_answer} options={NO_ANSWER_OPTIONS} onChange={set('no_answer')} />
              </Cell>
            </Row>
            <View>
              <SwitchRow title="Alert me when a person answers" help="In AI-handles mode, so you can listen in." value={f.alert_on_human} onChange={set('alert_on_human')} />
              <SwitchRow title="Listen from the start" help="Alert me as soon as the business picks up." value={f.listen_in} onChange={set('listen_in')} />
              <SwitchRow title="Record this call" help="Some US states require all parties to agree to a recording." value={f.record} onChange={set('record')} />
              <SwitchRow title="Leave a voicemail" help="If voicemail answers, the AI leaves one short message with your callback number." value={f.leave_voicemail} onChange={set('leave_voicemail')} />
            </View>
            <Segmented
              label="Caller ID"
              value={f.from}
              options={CALLER_ID_OPTIONS}
              onChange={set('from')}
              disabled={ownVerified ? [] : ['own']}
              help={ownVerified ? 'The number the business sees.' : 'To show your own number, verify your callback number in Settings first.'}
              error={errors.from ? <Text role="alert" style={[text.err, s.inlineErr]}>{errors.from}</Text> : null}
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
  inlineErr: { marginTop: space.s, gap: space.xs },
  foot: { gap: space.l },
  footWide: { flexDirection: 'row', alignItems: 'center' },
});
