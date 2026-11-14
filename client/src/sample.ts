// The product page's sample call (public/sample/call.json): a real recorded call to CallEnvoy's demo line.
import type { Call, Line } from './api';

export type SampleCall = {
  business: string;
  goal: string;
  duration_seconds: number;
  outcome: NonNullable<Call['outcome']>;
  lines: { n: number; who: Line['who']; text: string; at: number | null }[];
};

/** The sample as a finished call, so the call screen's transcript and outcome parts show it as they show any call.
 *  Times count from 0 (the start of the recording). */
export function sampleToCall(s: SampleCall): Call {
  const at = (sec: number) => new Date(sec * 1000).toISOString();
  return {
    id: 'sample',
    direction: 'outbound',
    calling_number: null,
    leave_voicemail: false,
    status: 'completed',
    phase: null,
    finished: true,
    business: s.business,
    number: '',
    goal: s.goal,
    mode: 'handle',
    connect_when: null,
    reach: 'app',
    listen_in: false,
    alert_on_human: true,
    recorded: true,
    human_at: null,
    owner: { state: 'none', via: null, alert_until: null, unreachable: false },
    open_questions: [],
    answered_questions: [],
    outcome: s.outcome,
    talk_seconds: s.duration_seconds,
    owner_seconds: null,
    error: null,
    created_at: at(0),
    ended_at: at(s.duration_seconds),
    transcript: s.lines.map((l) => ({ ...l, t: at(l.at ?? 0) })),
  };
}
