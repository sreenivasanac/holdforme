// The call options shared by Settings (the defaults) and the New call form (this call only).
// Field names are the settings names; the New call form maps record_calls and caller_id to record and from.
import type { ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { CallerId, Config, NoAnswer, Reach } from '../api';
import { useGo } from '../hooks';
import { space } from '../theme';
import { Cell, Row, Segmented, SwitchRow, TextField, TextLink, text } from './ui';

export const MODE_OPTIONS = [
  ['handle', 'AI handles the call'],
  ['transfer', 'Transfer to me when a person answers'],
] as const;
const REACH_OPTIONS = [
  ['app', 'App'],
  ['phone', 'Phone'],
  ['app_then_phone', 'App, then phone'],
] as const;
const CALLER_ID_OPTIONS = [
  ['callenvoy', 'CallEnvoy number'],
  ['own', 'My own number'],
] as const;
const NO_ANSWER_OPTIONS = [
  ['ai_handles', 'AI carries on'],
  ['end_politely', 'End politely'],
] as const;

export type Options = {
  reach: Reach;
  no_answer: NoAnswer;
  caller_id: CallerId;
  alert_wait_seconds: string;
  phone_ring_seconds: string;
  max_minutes: string;
  alert_on_human: boolean;
  listen_in: boolean;
  record_calls: boolean;
  leave_voicemail: boolean;
};
export type OptionErrors = Partial<Record<keyof Options, string>>;
type Ranged = 'max_minutes' | 'alert_wait_seconds' | 'phone_ring_seconds';

/** Integer in [min, max], or null. */
const intIn = (v: string, min: number, max: number) => {
  const n = Number(v);
  return v.trim() !== '' && Number.isInteger(n) && n >= min && n <= max ? n : null;
};

/** Checks the number fields against the server's ranges. Returns the numbers and the errors. */
export function checkNumbers(o: Options, ranges: Config['ranges'], keys: Ranged[]) {
  const errors: OptionErrors = {};
  const n: Partial<Record<Ranged, number>> = {};
  for (const k of keys) {
    const [lo, hi] = ranges[k];
    const v = intIn(o[k], lo, hi);
    if (v == null) errors[k] = `Enter a number from ${lo} to ${hi}.`;
    else n[k] = v;
  }
  return { n, errors };
}

export function CallOptions({
  o,
  onChange,
  errors,
  config,
  ownVerified,
  perCall,
  reachHelp,
}: {
  o: Options;
  onChange: (patch: Partial<Options>) => void;
  errors: OptionErrors;
  config: Config;
  ownVerified: boolean;
  /** The New call form: no phone-ring field, and the reach error links to Settings. */
  perCall?: boolean;
  reachHelp: string;
}) {
  const go = useGo();
  const set =
    <K extends keyof Options>(k: K) =>
    (v: Options[K]) =>
      onChange({ [k]: v } as Partial<Options>);
  const maxCall = config.ranges.max_minutes[1];
  const err = (m: string | undefined, extra?: ReactNode) =>
    m ? (
      <View style={s.err}>
        <Text role="alert" style={text.err}>
          {m}
        </Text>
        {extra}
      </View>
    ) : null;
  return (
    <>
      <Segmented
        label="How to reach me"
        value={o.reach}
        options={REACH_OPTIONS}
        onChange={set('reach')}
        help={reachHelp}
        error={err(errors.reach, perCall ? <TextLink label="Open Settings" onPress={() => go('/settings')} /> : null)}
      />
      <Row>
        <Cell>
          <TextField label="Wait for me after an alert (seconds)" numeric value={o.alert_wait_seconds} onChangeText={set('alert_wait_seconds')} error={errors.alert_wait_seconds} />
        </Cell>
        <Cell>
          {perCall ? (
            <Segmented label="If I do not answer" value={o.no_answer} options={NO_ANSWER_OPTIONS} onChange={set('no_answer')} />
          ) : (
            <TextField label="Let my phone ring (seconds)" numeric value={o.phone_ring_seconds} onChangeText={set('phone_ring_seconds')} error={errors.phone_ring_seconds} />
          )}
        </Cell>
      </Row>
      <Row>
        {!perCall && (
          <Cell>
            <Segmented label="If I do not answer" value={o.no_answer} options={NO_ANSWER_OPTIONS} onChange={set('no_answer')} />
          </Cell>
        )}
        <Cell>
          <TextField
            label={perCall ? 'Planned minutes' : 'Planned minutes per call'}
            numeric
            value={o.max_minutes}
            onChangeText={set('max_minutes')}
            error={errors.max_minutes}
            help={`Extended while on hold, never past ${maxCall}.`}
          />
        </Cell>
      </Row>
      <View>
        <SwitchRow title="Alert me when a person answers" help="When the AI handles the call, so you can listen in." value={o.alert_on_human} onChange={set('alert_on_human')} />
        <SwitchRow title="Listen from the start" help="Alert me as soon as the business picks up." value={o.listen_in} onChange={set('listen_in')} />
        <SwitchRow
          title={perCall ? 'Record this call' : 'Record calls'}
          help={(perCall ? '' : 'Default for new calls. An agent can set this for a single call. ') + 'Some US states require all parties to agree to a recording.'}
          value={o.record_calls}
          onChange={set('record_calls')}
        />
        <SwitchRow title="Leave a voicemail" help="If voicemail answers, the AI leaves one short message with your callback number." value={o.leave_voicemail} onChange={set('leave_voicemail')} />
      </View>
      <Segmented
        label="Caller ID"
        value={o.caller_id}
        options={CALLER_ID_OPTIONS}
        onChange={set('caller_id')}
        disabled={ownVerified ? [] : ['own']}
        help={
          ownVerified
            ? 'The number the business sees. With your own number, a business calls you back directly.'
            : `To show your own number, verify your callback number ${perCall ? 'in Settings' : 'above'} first.`
        }
        error={err(errors.caller_id)}
      />
    </>
  );
}

const s = StyleSheet.create({
  err: { marginTop: space.s, gap: space.xs },
});
