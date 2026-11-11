// Settings: profile, caller ID, call defaults, alert channels, voice (plan sections 4a, 22).
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { api, ApiError, type CallerId, type Config, type Mode, type NoAnswer, type ProfileField, type Reach, type Settings } from '../api';
import { phone, toE164 } from '../format';
import type { CallerIdState } from '../hooks';
import { font, space } from '../theme';
import { CALLER_ID_OPTIONS, intIn, MODE_OPTIONS, NO_ANSWER_OPTIONS, REACH_OPTIONS } from './CallForm';
import { Button, Card, Cell, Note, Pill, Row, Segmented, Stack, StatusLine, SwitchRow, T, TextField, text } from './ui';
import { VoicePicker } from './VoicePicker';

type Form = Omit<Settings, 'max_minutes' | 'alert_wait_seconds' | 'phone_ring_seconds'> & {
  max_minutes: string;
  alert_wait_seconds: string;
  phone_ring_seconds: string;
};
type Errors = Partial<Record<keyof Settings | 'form', string>>;

const GROUPS: { title: string; fields: [ProfileField, string][] }[] = [
  {
    title: 'Insurance',
    fields: [
      ['insurance_carrier', 'Health insurance carrier'],
      ['insurance_member_id', 'Member ID'],
      ['insurance_group_number', 'Group number'],
      ['dental_insurance_carrier', 'Dental insurance carrier'],
      ['dental_insurance_member_id', 'Dental member ID'],
    ],
  },
  {
    title: 'Vehicle',
    fields: [
      ['vehicle', 'Vehicle (year, make, model)'],
      ['vin', 'VIN'],
    ],
  },
  {
    title: 'Travel',
    fields: [
      ['frequent_flyer_numbers', 'Frequent flyer numbers'],
      ['known_traveler_number', 'Known Traveler Number'],
      ['redress_number', 'Redress number'],
    ],
  },
];

export function SettingsForm({
  config,
  settings,
  callerId,
  save,
  reloadCallerId,
}: {
  config: Config;
  settings: Settings;
  callerId: CallerIdState | null;
  save: (patch: Partial<Settings>) => Promise<Settings>;
  reloadCallerId: () => Promise<void>;
}) {
  const [f, setF] = useState<Form>(() => ({
    ...settings,
    callback_number: settings.callback_number ? phone(settings.callback_number) : '',
    max_minutes: String(settings.max_minutes),
    alert_wait_seconds: String(settings.alert_wait_seconds),
    phone_ring_seconds: String(settings.phone_ring_seconds),
  }));
  const [errors, setErrors] = useState<Errors>({});
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const set = <K extends keyof Form>(k: K) => (v: Form[K]) => {
    setSaved(false);
    setF((x) => ({ ...x, [k]: v }));
  };
  const maxCall = config.limits.max_call_minutes;
  const verified = !!callerId?.verified && !!callerId.number && callerId.number === settings.callback_number;

  const submit = async () => {
    const e: Errors = {};
    const cb = f.callback_number.trim() ? toE164(f.callback_number) : '';
    if (cb == null) e.callback_number = 'Enter a US or Canada number with area code, like (503) 555-0142.';
    const max = intIn(f.max_minutes, 1, maxCall);
    if (max == null) e.max_minutes = `Enter a number from 1 to ${maxCall}.`;
    const wait = intIn(f.alert_wait_seconds, 5, 120);
    if (wait == null) e.alert_wait_seconds = 'Enter a number from 5 to 120.';
    const ring = intIn(f.phone_ring_seconds, 10, 60);
    if (ring == null) e.phone_ring_seconds = 'Enter a number from 10 to 60.';
    if (f.caller_id === 'own' && (!verified || cb !== settings.callback_number)) e.caller_id = 'Verify your callback number first.';
    setErrors(e);
    setSaved(false);
    if (Object.keys(e).length) return;
    setBusy(true);
    try {
      // An empty string removes a text field (plan section 3, save_profile).
      const next = await save({ ...f, callback_number: cb ?? '', max_minutes: max!, alert_wait_seconds: wait!, phone_ring_seconds: ring! });
      setF((x) => ({ ...x, callback_number: next.callback_number ? phone(next.callback_number) : '' }));
      setSaved(true);
      if (next.callback_number !== settings.callback_number) void reloadCallerId().catch(() => {});
    } catch (err) {
      const field = err instanceof ApiError && err.field && err.field in f ? (err.field as keyof Settings) : 'form';
      setErrors({ [field]: (err as Error).message });
    }
    setBusy(false);
  };

  const count = Object.keys(errors).filter((k) => k !== 'form').length;
  const textField = (k: ProfileField | 'name' | 'details', label: string, extra?: object) => (
    <TextField key={k} label={label} optional={k !== 'name'} value={f[k]} onChangeText={set(k)} error={errors[k]} {...extra} />
  );

  return (
    <>
      <Card label="Profile">
        <Stack>
          <View>
            <T v="h2">Profile</T>
            <T v="muted">The AI uses this on every call. Agents can read and update it too.</T>
          </View>
          <Text style={text.subhead}>About you</Text>
          <Row>
            <Cell>{textField('name', 'Your name', { autoComplete: 'name', maxLength: 80 })}</Cell>
            <Cell>
              <TextField
                label="Callback number"
                value={f.callback_number}
                onChangeText={set('callback_number')}
                inputMode="tel"
                autoComplete="tel"
                error={errors.callback_number}
                help="Your phone rings on this number for a hand-over. The AI may also give it to a business that asks for it."
              />
            </Cell>
          </Row>
          <CallerIdStatus callerId={callerId} saved={settings.callback_number} reload={reloadCallerId} />
          <Row>
            <Cell>{textField('name_pronunciation', 'How to say your name', { help: 'For example: DAH-nuh RAY-ess' })}</Cell>
            <Cell>{textField('assistant_name', 'A first name for the AI', { help: 'Empty: the AI does not give itself a name.' })}</Cell>
          </Row>
          <Row>
            <Cell>{textField('email', 'Email', { inputMode: 'email', autoComplete: 'email' })}</Cell>
            <Cell>{textField('date_of_birth', 'Date of birth')}</Cell>
          </Row>
          {textField('address', 'Address', { autoComplete: 'street-address' })}
          {textField('details', 'Anything else the AI may share', {
            rows: 4,
            maxLength: 3000,
            help: 'Only what is written here, in the call request, or in your answers is shared. Leave out anything you would not say to a support agent.',
          })}
          {GROUPS.map((g) => (
            <View key={g.title}>
              <Button
                label={`${open[g.title] ? '▾' : '▸'} ${g.title}`}
                kind="link"
                expanded={!!open[g.title]}
                onPress={() => setOpen((o) => ({ ...o, [g.title]: !o[g.title] }))}
              />
              {open[g.title] && <Stack>{g.fields.map(([k, label]) => textField(k, label))}</Stack>}
            </View>
          ))}
        </Stack>
      </Card>

      <Card label="Call defaults">
        <Stack>
          <View>
            <T v="h2">Call defaults</T>
            <T v="muted">Used for every new call. A call can change any of them.</T>
          </View>
          <Segmented label="When a person answers" value={f.mode} options={MODE_OPTIONS} onChange={(v) => set('mode')(v as Mode)} />
          <Segmented
            label="How to reach me"
            value={f.reach}
            options={REACH_OPTIONS}
            onChange={(v) => set('reach')(v as Reach)}
            help="App, then phone: an alert first; if you do not join in time, your phone rings."
          />
          <Row>
            <Cell>
              <TextField label="Wait for me after an alert (seconds)" numeric value={f.alert_wait_seconds} onChangeText={set('alert_wait_seconds')} error={errors.alert_wait_seconds} />
            </Cell>
            <Cell>
              <TextField label="Let my phone ring (seconds)" numeric value={f.phone_ring_seconds} onChangeText={set('phone_ring_seconds')} error={errors.phone_ring_seconds} />
            </Cell>
          </Row>
          <Row>
            <Cell>
              <Segmented label="If I do not answer" value={f.no_answer} options={NO_ANSWER_OPTIONS} onChange={(v) => set('no_answer')(v as NoAnswer)} />
            </Cell>
            <Cell>
              <TextField
                label="Planned minutes per call"
                numeric
                value={f.max_minutes}
                onChangeText={set('max_minutes')}
                error={errors.max_minutes}
                help={`Extended while on hold, never past ${maxCall}.`}
              />
            </Cell>
          </Row>
          <Segmented
            label="Caller ID"
            value={f.caller_id}
            options={CALLER_ID_OPTIONS}
            onChange={(v) => set('caller_id')(v as CallerId)}
            disabled={verified ? [] : ['own']}
            help={verified ? 'The number the business sees. With your own number, a business calls you back directly.' : 'To show your own number, verify your callback number above first.'}
            error={errors.caller_id ? <Text role="alert" style={[text.err, s.err]}>{errors.caller_id}</Text> : null}
          />
          <View>
            <SwitchRow title="Alert me when a person answers" help="When the AI handles the call, so you can listen in." value={f.alert_on_human} onChange={set('alert_on_human')} />
            <SwitchRow title="Listen from the start" help="Alert me as soon as the business picks up." value={f.listen_in} onChange={set('listen_in')} />
            <SwitchRow
              title="Record calls"
              help="Default for new calls. An agent can set this for a single call. Some US states require all parties to agree to a recording."
              value={f.record_calls}
              onChange={set('record_calls')}
            />
            <SwitchRow title="Leave a voicemail" help="If voicemail answers, the AI leaves one short message with your callback number." value={f.leave_voicemail} onChange={set('leave_voicemail')} />
          </View>
          <Text style={text.subhead}>Alert me with</Text>
          <View>
            <SwitchRow title="Sound" help="A ring while the console is open." value={f.alert_sound} onChange={set('alert_sound')} />
            <SwitchRow title="Browser notification" value={f.alert_notification} onChange={set('alert_notification')} />
            <SwitchRow title="Push to my devices" value={f.alert_push} onChange={set('alert_push')} />
            <SwitchRow
              title="Show the business name in push alerts"
              help="Off: the lock screen only says a person is on the line."
              value={f.push_shows_business}
              onChange={set('push_shows_business')}
            />
          </View>
        </Stack>
      </Card>

      <Card label="AI voice">
        <Stack>
          <T v="h2" style={s.noMargin}>
            AI voice
          </T>
          <VoicePicker label="Default voice" voices={config.voices} value={f.voice} onChange={set('voice')} help="An agent can still pick a different voice for a single call." />
          {count > 0 && <Note kind="errsum">{`Fix ${count} field${count > 1 ? 's' : ''} to save.`}</Note>}
          {errors.form && <Note kind="errsum">{errors.form}</Note>}
          {saved && <Note kind="saved">Saved.</Note>}
          <Button label={busy ? 'Saving...' : 'Save settings'} busy={busy} onPress={submit} />
        </Stack>
      </Card>
    </>
  );
}

/** Callback number state for caller ID, with Verify (plan section 22.2). */
function CallerIdStatus({ callerId, saved, reload }: { callerId: CallerIdState | null; saved: string; reload: () => Promise<void> }) {
  const [code, setCode] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const verified = !!callerId?.verified && callerId.number === saved;
  const verify = async () => {
    setBusy(true);
    setError(null);
    try {
      setCode((await api.verifyCallerId()).validation_code);
    } catch (e) {
      setError((e as Error).message);
    }
    setBusy(false);
  };
  return (
    <View>
      <StatusLine
        title="Your number as caller ID"
        help={saved ? phone(saved) : 'Save a callback number first.'}
        right={verified ? <Pill label="Verified" tone="ok" /> : <Pill label="Not verified" />}
      />
      {!verified && saved ? (
        <Stack gap={space.sm}>
          {code ? (
            <Note kind="hint">
              <Text style={[text.base, s.code]}>Your code: {code}</Text>
              <Text style={text.base}>{`Twilio now calls ${phone(saved)} and asks for this code. Type it on the phone keypad.`}</Text>
            </Note>
          ) : null}
          <View style={s.inline}>
            <Button label={busy ? 'Starting...' : code ? 'Send a new code' : 'Verify'} kind="secondary" size="small" busy={busy} onPress={verify} />
            {code ? <Button label="Check again" kind="secondary" size="small" onPress={() => void reload().catch((e) => setError((e as Error).message))} /> : null}
          </View>
          {error ? (
            <Text role="alert" style={text.err}>
              {error}
            </Text>
          ) : null}
        </Stack>
      ) : null}
    </View>
  );
}

const s = StyleSheet.create({
  noMargin: { marginBottom: 0 },
  err: { marginTop: space.s },
  inline: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  code: { fontWeight: font.weight.bold },
});
