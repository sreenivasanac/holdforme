// Settings: profile, caller ID, call defaults, alert channels, voice (plan sections 4a, 22).
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { api, ApiError, type Config, type Mode, type ProfileField, type Settings } from '../api';
import { phone, toE164 } from '../format';
import { useCallerId, useSettings } from '../hooks';
import { font, space } from '../theme';
import { CallOptions, checkNumbers, MODE_OPTIONS, type Options } from './CallOptions';
import { Button, Card, Cell, Note, Pill, Row, Segmented, Stack, StatusLine, SwitchRow, T, TextField, text } from './ui';
import { VoicePicker } from './VoicePicker';

type TextKey = ProfileField | 'name' | 'details';
// The inputs hold strings: null (not set) shows as empty, and an empty field is saved as "" (cleared).
type Form = Omit<Settings, keyof Options | TextKey | 'callback_number'> & Options & Record<TextKey | 'callback_number', string>;
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

export function SettingsForm({ config, settings }: { config: Config; settings: Settings }) {
  const { save, loadCallerId } = useSettings();
  const callerId = useCallerId();
  const [f, setF] = useState<Form>(() => {
    const x = { ...settings } as Record<string, unknown>;
    for (const k in x) if (x[k] === null) x[k] = '';
    return {
      ...(x as Form),
      callback_number: settings.callback_number ? phone(settings.callback_number) : '',
      max_minutes: String(settings.max_minutes),
      alert_wait_seconds: String(settings.alert_wait_seconds),
      phone_ring_seconds: String(settings.phone_ring_seconds),
    };
  });
  const [errors, setErrors] = useState<Errors>({});
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const set = <K extends keyof Form>(k: K) => (v: Form[K]) => {
    setSaved(false);
    setF((x) => ({ ...x, [k]: v }));
  };
  const verified = !!callerId?.verified && !!callerId.number && callerId.number === settings.callback_number;

  const submit = async () => {
    const cb = f.callback_number.trim() ? toE164(f.callback_number) : '';
    const { n, errors: e } = checkNumbers(f, config.ranges, ['max_minutes', 'alert_wait_seconds', 'phone_ring_seconds']);
    const all: Errors = e;
    if (cb == null) all.callback_number = 'Enter a US or Canada number with area code, like (503) 555-0142.';
    if (f.caller_id === 'own' && (!verified || cb !== settings.callback_number)) all.caller_id = 'Verify your callback number first.';
    setErrors(all);
    setSaved(false);
    if (Object.keys(all).length) return;
    setBusy(true);
    try {
      // An empty string removes a text field (plan section 3, save_profile).
      const next = await save({ ...f, callback_number: cb ?? '', ...(n as Pick<Settings, 'max_minutes' | 'alert_wait_seconds' | 'phone_ring_seconds'>) });
      setF((x) => ({ ...x, callback_number: next.callback_number ? phone(next.callback_number) : '' }));
      setSaved(true);
      if (next.callback_number !== settings.callback_number) void loadCallerId().catch(() => {}); // a new number: ask again
    } catch (err) {
      const field = err instanceof ApiError && err.field && err.field in f ? (err.field as keyof Settings) : 'form';
      setErrors({ [field]: (err as Error).message });
      // A field inside a closed group: open the group, so the error shows at the field.
      const g = GROUPS.find((g) => g.fields.some(([k]) => k === field));
      if (g) setOpen((o) => ({ ...o, [g.title]: true }));
    }
    setBusy(false);
  };

  const count = Object.keys(errors).filter((k) => k !== 'form').length;
  const textField = (k: TextKey, label: string, extra?: object) => (
    <TextField key={k} label={label} optional={k !== 'name'} value={f[k]} onChangeText={set(k)} error={errors[k]} maxLength={config.text_limits[k]} {...extra} />
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
            <Cell>{textField('name', 'Your name', { autoComplete: 'name' })}</Cell>
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
          <CallerIdStatus saved={settings.callback_number} />
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
          <CallOptions
            o={f}
            onChange={(patch) => {
              setSaved(false);
              setF((x) => ({ ...x, ...patch }));
            }}
            errors={errors}
            config={config}
            ownVerified={verified}
            reachHelp="App, then phone: an alert first; if you do not join in time, your phone rings."
          />
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
function CallerIdStatus({ saved }: { saved: string | null }) {
  const { callerId, loadCallerId } = useSettings();
  const [code, setCode] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const verified = !!callerId?.verified && callerId.number === saved;
  const reload = () => loadCallerId().catch((e) => setError((e as Error).message));
  const verify = async () => {
    setBusy(true);
    setError(null);
    try {
      const { validation_code } = await api.verifyCallerId();
      setCode(validation_code);
      // No code: the number is already verified with Twilio; reload the state so it shows Verified.
      if (validation_code == null) await reload();
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
            {code ? <Button label="Check again" kind="secondary" size="small" onPress={() => void reload()} /> : null}
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
