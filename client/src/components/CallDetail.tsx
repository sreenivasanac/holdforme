// Parts of the call screen: header, transcript, question box, outcome, recording, answered questions.
import { useRef, useState } from 'react';
import { Linking, ScrollView, StyleSheet, Text, View, type ScrollViewInstance } from 'react-native';
import { api, type Call, type Line, type Question } from '../api';
import { callSeconds, clock, duration, modeLine, phone, RESULT_TEXT, statusLabel, stepIndex, STEPS, when } from '../format';
import { useNow } from '../hooks';
import { playUrl } from '../platform/audio';
import { border, color, font, lineHeight, lineMaxWidth, radius, space, transcriptHeight, useWide } from '../theme';
import { StatusBadge } from './CallList';
import { Button, Card, LiveDot, Note, Pill, T, TextField, text } from './ui';

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
            {call.calling_number ? ` · caller ID ${phone(call.calling_number)}` : ''}
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
      ) : (
        <>
          <Text style={[text.soft, s.goal]}>
            <Text style={text.muted}>Goal: </Text>
            {call.goal}
          </Text>
          <Text style={[text.fine, s.mode]}>{modeLine(call)}</Text>
          {(!call.finished || call.outcome?.result === 'handed_to_owner') && <Progress call={call} />}
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

/** Transcript; keeps the scroll position unless the reader is at the bottom. */
export function TranscriptLog({ call }: { call: Call }) {
  const lines = call.transcript ?? [];
  const ref = useRef<ScrollViewInstance>(null);
  const atBottom = useRef(true);
  const them = call.business.split(' ')[0];
  const start = Date.parse(call.created_at);
  const title = call.finished ? 'Transcript' : 'Live transcript';
  return (
    <Card label={title}>
      <View style={s.cardHead}>
        <T v="h2" style={s.h2}>
          {title}
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
      <ScrollView
        ref={ref}
        style={s.lines}
        contentContainerStyle={s.linesInner}
        role="log"
        aria-live="polite"
        aria-label={title}
        scrollEventThrottle={100}
        onScroll={(e) => {
          const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
          atBottom.current = contentOffset.y + layoutMeasurement.height >= contentSize.height - space.x3;
        }}
        onContentSizeChange={() => atBottom.current && ref.current?.scrollToEnd({ animated: false })}
      >
        {lines.length === 0 ? (
          <Text style={[s.event, s.eventText]}>{call.finished ? 'No transcript for this call.' : 'Nothing said yet. Lines show here as the call goes on.'}</Text>
        ) : (
          lines.map((l) => <LineView key={l.n} line={l} them={them} start={start} />)
        )}
      </ScrollView>
    </Card>
  );
}

function LineView({ line, them, start }: { line: Line; them: string; start: number }) {
  if (line.who === 'event')
    return (
      <View style={s.event}>
        <Text style={s.eventText}>{line.text}</Text>
      </View>
    );
  const at = Date.parse(line.t);
  return (
    <View style={[s.line, line.who === 'ai' && s.lineAi, line.who === 'owner' && s.lineOwner]}>
      <Text style={s.who}>
        {line.who === 'them' ? them : line.who === 'ai' ? 'AI' : 'You'}
        {Number.isNaN(at) ? null : <Text style={s.whoTime}>{'  ' + duration((at - start) / 1000)}</Text>}
      </Text>
      <Text style={text.base}>{line.text}</Text>
    </View>
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

export function OutcomeCard({ call }: { call: Call }) {
  const st = statusLabel(call);
  const o = call.outcome;
  const details = Object.entries(o?.details ?? {}).filter(([, v]) => v != null && v !== '');
  if (call.owner_seconds) details.push(['you_on_the_call', duration(call.owner_seconds)]);
  return (
    <Card label="Outcome">
      <T v="h2">Outcome</T>
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
    </Card>
  );
}

const label = (k: string) => (k.charAt(0).toUpperCase() + k.slice(1)).replace(/_/g, ' ');

export function RecordingPlayer({ call }: { call: Call }) {
  const [playing, setPlaying] = useState(false);
  const stop = useRef<(() => void) | null>(null);
  const rec = call.recordings?.[0];
  return (
    <Card label="Recording">
      <T v="h2">Recording</T>
      {!call.recorded ? (
        <T v="muted">
          <Text style={s.strong}>Not recorded.</Text> Recording was off for this call.
        </T>
      ) : !rec ? (
        <T v="muted">The recording is still being processed. It shows here in a minute or two.</T>
      ) : (
        <View style={s.recRow}>
          <Button
            label={playing ? 'Stop' : 'Play recording'}
            kind="secondary"
            a11yLabel={playing ? 'Stop recording' : `Play recording, ${duration(rec.duration_seconds)}`}
            onPress={() => {
              if (playing) return stop.current?.();
              setPlaying(true);
              stop.current = playUrl(rec.url, () => setPlaying(false));
            }}
          />
          <T v="fine">{duration(rec.duration_seconds)} · both sides</T>
          <Button label="Download mp3" kind="link" onPress={() => void Linking.openURL(rec.url)} />
        </View>
      )}
    </Card>
  );
}

export function AnsweredQuestions({ questions }: { questions: Question[] }) {
  if (!questions.length) return null;
  return (
    <Card label="Questions">
      <T v="h2">Questions</T>
      {questions.map((q, i) => (
        <View key={q.id} style={i > 0 && s.answered}>
          <Text style={[text.m, s.strong]}>{q.question}</Text>
          <Text style={[text.m, { color: color.soft }]}>{q.answer}</Text>
        </View>
      ))}
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
  line: { maxWidth: lineMaxWidth, alignSelf: 'flex-start', paddingVertical: space.sm, paddingHorizontal: space.ml, borderRadius: radius.l, backgroundColor: color.bubble },
  lineAi: { alignSelf: 'flex-end', backgroundColor: color.bubbleAi },
  lineOwner: { alignSelf: 'flex-end', backgroundColor: color.okSoft, borderWidth: border.thin, borderColor: color.okLine },
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
  recRow: { gap: space.sm },
  answered: { borderTopWidth: border.thin, borderTopColor: color.line, paddingTop: space.m, marginTop: space.m },
});
