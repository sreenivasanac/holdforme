// Parts of the call screen: header, transcript (with the recording player when finished), question box, outcome, call options.
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View, type PressableStateCallbackType, type ScrollViewInstance } from 'react-native';
import { api, type Call, type Line, type Question } from '../api';
import { callSeconds, clock, duration, lineAt, mergeLines, modeLine, phone, RESULT_TEXT, statusLabel, stepIndex, STEPS, when } from '../format';
import { useNow } from '../hooks';
import { focusRingProps } from '../platform/focus';
import { border, color, font, lineHeight, lineMaxWidth, radius, space, transcriptHeight, useWide } from '../theme';
import { StatusBadge } from './CallList';
import { RecordingPlayer, usePlayer, type PlayerControl } from './RecordingPlayer';
import { Button, Card, Disclosure, LiveDot, Note, Pill, T, TextField, text } from './ui';

const HAND_SCROLL_PAUSE_MS = 5000; // no automatic scrolling this long after the reader scrolled the transcript
const AUTO_SCROLL_MS = 1000; // scroll events this soon after an automatic scroll are not the reader's

export function CallHeader({ call }: { call: Call }) {
  const wide = useWide();
  const now = useNow(1000, !call.finished);
  const inbound = call.direction === 'inbound';
  const times = call.ended_at
    ? `${when(call.created_at)} – ${clock(call.ended_at)}`
    : `started ${clock(call.created_at)}`;
  return (
    <Card>
      <View style={[s.head, !wide && s.headNarrow]}>
        <View style={s.fill}>
          <T v="h2" style={s.h2}>
            {call.business}
          </T>
          <T v="muted">
            {phone(call.number)} · {times}
            {call.calling_number && !call.finished ? ` · caller ID ${phone(call.calling_number)}` : ''}
          </T>
        </View>
        <View style={[s.right, !wide && s.rightNarrow]}>
          <StatusBadge call={call} />
          <Text style={[s.timer, !wide && s.timerNarrow]} aria-label="Call length">
            {duration(callSeconds(call, now))}
          </Text>
        </View>
      </View>
      {inbound ? (
        <Text style={[text.soft, s.goal]}>A business called your CallEnvoy number. The call was forwarded to your phone, so there is no transcript.</Text>
      ) : call.finished ? null : (
        <>
          <Text style={[text.soft, s.goal]}>
            <Text style={text.muted}>Goal: </Text>
            {call.goal}
          </Text>
          <Text style={[text.fine, s.mode]}>{modeLine(call)}</Text>
          <Progress call={call} />
        </>
      )}
    </Card>
  );
}

function Progress({ call }: { call: Call }) {
  const wide = useWide();
  const at = stepIndex(call);
  return (
    <View style={[s.steps, wide && s.stepsWide]} role="list" aria-label="Call progress">
      {STEPS.map((label, i) => (
        <View key={label} role="listitem" aria-current={i === at ? 'step' : undefined} style={[s.step, wide && s.stepWide, i < at && s.stepDone, i === at && s.stepNow]}>
          <Text style={[s.stepText, i < at && s.stepTextDone, i === at && s.stepTextNow]}>{label}</Text>
        </View>
      ))}
    </View>
  );
}

/** Finished call: the recording player above the transcript, in one card. */
export function CallRecording({ call }: { call: Call }) {
  const rec = call.recorded ? call.recordings?.[0] : undefined;
  if (rec) return <PlayerTranscript call={call} url={rec.url} seconds={rec.duration_seconds} />;
  const note = !call.recorded ? (
    <T v="muted">
      <Text style={s.strong}>Not recorded.</Text> Recording was off for this call.
    </T>
  ) : (call.talk_seconds ?? 0) > 0 ? (
    <T v="muted">The recording is still being processed. It shows here in a minute or two.</T>
  ) : null;
  return <TranscriptLog call={call} top={note} />;
}

/** The recording player above the transcript, in one card. */
export function PlayerTranscript({ call, url, seconds, level }: { call: Call; url: string; seconds: number; level?: 3 }) {
  const player = usePlayer(url, seconds);
  return <TranscriptLog call={call} title="Recording and transcript" player={player} top={<RecordingPlayer player={player} url={url} />} level={level} />;
}

/**
 * Transcript. Live: keeps the scroll position unless the reader is at the bottom.
 * With a player: lines with `at` jump there, and the playing line is highlighted and kept in view.
 */
export function TranscriptLog({ call, title, player, top, level }: { call: Call; title?: string; player?: PlayerControl; top?: ReactNode; level?: 3 }) {
  const lines = useMemo(() => mergeLines(call.transcript ?? []), [call.transcript]);
  const ref = useRef<ScrollViewInstance>(null);
  const atBottom = useRef(true);
  const boxes = useRef<Record<number, { y: number; h: number }>>({});
  const view = useRef({ y: 0, h: 0 });
  const handAt = useRef(0);
  const autoAt = useRef(0);
  const them = call.business.split(' ')[0];
  const start = Date.parse(call.created_at);
  const heading = title ?? (call.finished ? 'Transcript' : 'Live transcript');
  const current = player ? lineAt(lines, player.time) : -1;
  const playing = !!player?.playing;

  useEffect(() => {
    if (!playing || current < 0 || Date.now() - handAt.current < HAND_SCROLL_PAUSE_MS) return;
    const box = boxes.current[current];
    const v = view.current;
    if (!box || (box.y >= v.y && box.y + box.h <= v.y + v.h)) return;
    autoAt.current = Date.now();
    ref.current?.scrollTo({ y: Math.max(0, box.y - space.ml), animated: true });
  }, [current, playing]);

  return (
    <Card label={heading}>
      <View style={s.cardHead}>
        <T v="h2" style={s.h2} level={level}>
          {heading}
        </T>
        {call.finished ? (
          <T v="fine">{`${lines.length} line${lines.length === 1 ? '' : 's'}`}</T>
        ) : (
          <View style={s.inline}>
            <LiveDot />
            <T v="fine">Updating</T>
          </View>
        )}
      </View>
      {top ? <View style={s.top}>{top}</View> : null}
      <ScrollView
        ref={ref}
        style={s.lines}
        contentContainerStyle={s.linesInner}
        role="log"
        aria-live={call.finished ? undefined : 'polite'}
        aria-label={call.finished ? 'Transcript' : heading}
        scrollEventThrottle={100}
        onLayout={(e) => (view.current.h = e.nativeEvent.layout.height)}
        onScroll={(e) => {
          const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
          view.current = { y: contentOffset.y, h: layoutMeasurement.height };
          atBottom.current = contentOffset.y + layoutMeasurement.height >= contentSize.height - space.x3;
          if (Date.now() - autoAt.current > AUTO_SCROLL_MS) handAt.current = Date.now();
        }}
        onContentSizeChange={() => !call.finished && atBottom.current && ref.current?.scrollToEnd({ animated: false })}
      >
        {lines.length === 0 ? (
          <Text style={[s.event, s.eventText]}>{call.finished ? 'No transcript for this call.' : 'Nothing said yet. Lines show here as the call goes on.'}</Text>
        ) : (
          lines.map((l, i) => (
            <View key={l.n} onLayout={(e) => (boxes.current[i] = { y: e.nativeEvent.layout.y, h: e.nativeEvent.layout.height })}>
              <LineView line={l} them={them} start={start} now={i === current} onJump={player && l.at != null ? () => player.seek(l.at!, true) : undefined} />
            </View>
          ))
        )}
      </ScrollView>
    </Card>
  );
}

function LineView({ line, them, start, now, onJump }: { line: Line; them: string; start: number; now: boolean; onJump?: () => void }) {
  if (line.who === 'event')
    return (
      <View style={s.event}>
        <Text style={s.eventText}>{line.text}</Text>
      </View>
    );
  const who = line.who === 'them' ? them : line.who === 'ai' ? 'AI' : 'You';
  const t = Date.parse(line.t);
  // Time from the start of the recording when known, else from the start of the call.
  const at = line.at != null ? duration(line.at) : Number.isNaN(t) ? null : duration((t - start) / 1000);
  const bubble = [s.line, line.who === 'ai' && s.lineAi, line.who === 'owner' && s.lineOwner];
  const body = (
    <>
      <Text style={s.who}>
        {who}
        {at ? <Text style={s.whoTime}>{'  ' + at}</Text> : null}
      </Text>
      <Text style={text.base}>{line.text}</Text>
    </>
  );
  if (!onJump) return <View style={[bubble, now && s.lineNow]}>{body}</View>;
  return (
    <Pressable
      role="button"
      aria-label={`Jump to ${at}. ${who}: ${line.text}`}
      aria-current={now ? 'true' : undefined}
      onPress={onJump}
      {...focusRingProps()}
      style={(st: PressableStateCallbackType & { hovered?: boolean }) => [bubble, s.lineJump, st.hovered && s.lineHover, now && s.lineNow]}
    >
      {body}
    </Pressable>
  );
}

/** Open question from the AI with an answer box. Works while the owner listens. */
export function QuestionBox({ callId, q }: { callId: string; q: Question }) {
  const [answer, setAnswer] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const send = async () => {
    if (!answer.trim()) return setError('Type an answer first.');
    setBusy(true);
    setError(null);
    try {
      await api.answer(callId, q.id, answer.trim());
      setSent(true); // the question leaves the list on the next update
    } catch (e) {
      setError((e as Error).message);
    }
    setBusy(false);
  };
  return (
    <View style={s.question} role="region" aria-label="Question from the AI">
      <Text style={s.qTitle}>The AI needs an answer. The person on the phone is waiting.</Text>
      <Text style={s.q}>{q.question}</Text>
      {sent ? (
        <Note kind="saved">Answer sent. The AI tells them now.</Note>
      ) : (
        <>
          <TextField label="Your answer" rows={2} value={answer} onChangeText={setAnswer} maxLength={1000} error={error} />
          <Button label={busy ? 'Sending...' : 'Send answer'} busy={busy} onPress={send} />
        </>
      )}
    </View>
  );
}

export function OutcomeCard({ call, level }: { call: Call; level?: 3 }) {
  const st = statusLabel(call);
  const o = call.outcome;
  const details = Object.entries(o?.details ?? {}).filter(([, v]) => v != null && v !== '');
  if (call.owner_seconds) details.push(['you_on_the_call', duration(call.owner_seconds)]);
  return (
    <Card label="Outcome">
      <T v="h2" level={level}>
        Outcome
      </T>
      <View style={[s.inline, s.result]}>
        <Pill label={st.text} tone={st.tone} />
        <T v="muted">{o ? RESULT_TEXT[o.result] ?? '' : call.status === 'failed' ? 'The call did not go through' : 'Ended without an outcome'}</T>
      </View>
      {call.error ? <Note kind="errsum">{call.error}</Note> : null}
      {o?.summary ? <Text style={[text.soft, s.summary]}>{o.summary}</Text> : null}
      {details.map(([k, v]) => (
        <View key={k} style={s.kv}>
          <Text style={[text.base, s.kvKey]}>{label(k)}</Text>
          <Text style={[text.base, s.fill]}>{typeof v === 'string' ? v : JSON.stringify(v)}</Text>
        </View>
      ))}
      {call.answered_questions.length ? (
        <>
          <Text style={[text.subhead, s.subhead]}>Questions asked</Text>
          {call.answered_questions.map((q, i) => (
            <View key={q.id} style={i > 0 && s.answered}>
              <Text style={[text.m, s.strong]}>{q.question}</Text>
              <Text style={[text.m, { color: color.soft }]}>{q.answer}</Text>
            </View>
          ))}
        </>
      ) : null}
    </Card>
  );
}

const label = (k: string) => (k.charAt(0).toUpperCase() + k.slice(1)).replace(/_/g, ' ');

/** What the call was asked to do and how, collapsed (finished calls). */
export function CallRequest({ call }: { call: Call }) {
  return (
    <Card label="Call options">
      <Disclosure title="Call options">
        <View style={s.request}>
          <Text style={text.soft}>
            <Text style={text.muted}>Goal: </Text>
            {call.goal}
          </Text>
          <Text style={text.fine}>{modeLine(call)}</Text>
          <Text style={text.fine}>
            {call.calling_number ? `Caller ID ${phone(call.calling_number)} · ` : ''}
            {call.recorded ? 'Recorded' : 'Not recorded'}
          </Text>
        </View>
      </Disclosure>
    </Card>
  );
}

const s = StyleSheet.create({
  fill: { flex: 1 },
  h2: { marginBottom: space.xs },
  head: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: space.ml },
  headNarrow: { flexDirection: 'column' },
  right: { alignItems: 'flex-end', gap: space.s },
  rightNarrow: { flexDirection: 'row', alignItems: 'center', gap: space.ml, flexWrap: 'wrap' },
  timer: { color: color.fg, fontSize: font.size.h1, fontWeight: font.weight.bold, fontVariant: ['tabular-nums'] },
  timerNarrow: { fontSize: font.size.h2 },
  goal: { marginTop: space.ml },
  mode: { marginTop: space.s, fontSize: font.size.m },
  steps: { flexDirection: 'row', flexWrap: 'wrap', gap: space.s, marginTop: space.xl },
  stepsWide: { flexWrap: 'nowrap' },
  step: { borderWidth: border.thin, borderColor: color.line, borderRadius: radius.m, paddingVertical: space.s, paddingHorizontal: space.m },
  stepWide: { flex: 1, paddingVertical: space.sm },
  stepDone: { borderColor: color.okLine },
  stepNow: { borderColor: color.warn, backgroundColor: color.questionBg },
  stepText: { color: color.muted, fontSize: font.size.s, fontWeight: font.weight.semi },
  stepTextDone: { color: color.okText },
  stepTextNow: { color: color.white },
  cardHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', gap: space.ml, marginBottom: space.ml },
  inline: { flexDirection: 'row', alignItems: 'center', gap: space.xs },
  lines: { maxHeight: transcriptHeight, backgroundColor: color.card2, borderRadius: radius.l },
  linesInner: { padding: space.ml, gap: space.sm },
  top: { marginBottom: space.ml },
  line: { maxWidth: lineMaxWidth, alignSelf: 'flex-start', paddingVertical: space.sm, paddingHorizontal: space.ml, borderRadius: radius.l, backgroundColor: color.bubble, borderWidth: border.thin, borderColor: color.bubble },
  lineAi: { alignSelf: 'flex-end', backgroundColor: color.bubbleAi, borderColor: color.bubbleAi },
  lineOwner: { alignSelf: 'flex-end', backgroundColor: color.okSoft, borderColor: color.okLine },
  lineJump: { cursor: 'pointer' },
  lineHover: { borderColor: color.line },
  lineNow: { borderColor: color.brand, backgroundColor: color.selected },
  request: { gap: space.s, marginTop: space.xs },
  subhead: { marginTop: space.l, marginBottom: space.xs },
  event: { alignSelf: 'center', paddingHorizontal: space.sm },
  eventText: { color: color.muted, fontSize: font.size.s, textAlign: 'center' },
  who: { color: color.muted, fontSize: font.size.xs, fontWeight: font.weight.semi },
  whoTime: { fontWeight: font.weight.normal },
  question: { borderWidth: border.thin, borderColor: color.warn, backgroundColor: color.questionBg, borderRadius: radius.xl, padding: space.xl, gap: space.m },
  qTitle: { color: color.questionInk, fontSize: font.size.m, fontWeight: font.weight.bold },
  q: { color: color.fg, fontSize: font.size.xl, fontWeight: font.weight.semi, lineHeight: font.size.xl * lineHeight },
  result: { gap: space.m, marginBottom: space.m },
  summary: { marginBottom: space.m },
  kv: { flexDirection: 'row', gap: space.l, marginTop: space.s },
  kvKey: { color: color.muted, minWidth: space.x5 * 2 },
  strong: { color: color.fg, fontWeight: font.weight.bold },
  answered: { borderTopWidth: border.thin, borderTopColor: color.line, paddingTop: space.m, marginTop: space.m },
});
