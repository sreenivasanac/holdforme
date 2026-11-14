// Product page for signed-out visitors (round 3 B1): what CallEnvoy does, a real sample call as proof, and the email sign-in.
import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { WEB_BASE } from '../api';
import { setTitle } from '../platform/head';
import { scrollToId } from '../platform/scroll';
import { sampleToCall, type SampleCall } from '../sample';
import { border, color, font, gateWidth, gridMinWidth, heroWidth, lineHeight, maxContent, sampleColumns, space, useWide } from '../theme';
import { OutcomeCard, PlayerTranscript } from './CallDetail';
import { Loading } from './Loading';
import { SignInForm } from './SignIn';
import { AppBar } from './TopBar';
import { Button, Card, Cell, Note, Row, Stack, StatusLine, StepNumber, T, text } from './ui';

const SAMPLE = `${WEB_BASE}/sample`;
const ID = { sample: 'sample-call', start: 'get-started', email: 'signin-email' };

const STEPS = [
  ['Tell it who to call and what to get done', 'A phone number, the business, and the goal in a sentence or two. Add details it may share, like an account number.'],
  ['It handles the menu, the hold, and the talk', 'It presses the menu keys and waits on hold. When a person answers, you get an alert and can listen in or take over.'],
  ['You get the result', 'A short outcome with details such as a reference number, plus the transcript and the recording.'],
];
const EXAMPLES = [
  'Dispute a wrong charge on a bill',
  'Book, move, or cancel an appointment',
  'Ask about an order, a delivery, or a refund',
  'Wait on hold and bring you in when a person answers',
  'Ask a question and bring back the answer',
  'Check on a claim or a repair',
];
const GOOD_TO_KNOW = [
  ['US and Canada numbers', 'It calls numbers in the US and Canada only.'],
  ['Calls can be recorded', 'Recording is a setting: on at first, and you can turn it off. Some states require everyone on a call to agree to a recording.'],
  ['It calls for you, not as you', 'The AI says it is calling on your behalf. It does not claim to be you.'],
  ['Your calls stay yours', 'Your calls, recordings, and details are visible only to your account.'],
  ['No card needed', 'This is a small private service. All accounts share one daily limit of call minutes.'],
];

export function Landing() {
  const wide = useWide();
  const start = () => scrollToId(ID.start, ID.email);
  useEffect(() => setTitle('CallEnvoy: an AI that makes your phone calls'), []);
  return (
    <View style={s.fill}>
      <AppBar>
        <View style={s.fill} />
        <Button label="Sign in" kind="secondary" size="small" onPress={start} />
      </AppBar>
      <ScrollView style={s.fill} contentContainerStyle={s.page}>
        <View role="main" style={s.main}>
          <View style={[s.hero, wide && s.heroWide]}>
            <T v="hero" style={!wide && s.heroNarrow}>
              An AI that makes your phone calls
            </T>
            <Text style={s.lead}>It gets through the phone menu, waits on hold, talks to the person, and tells you the result.</Text>
            <T v="muted">Start a call from your AI agent through MCP, or from this web page. You can listen in and take over at any time.</T>
            <View style={s.actions}>
              <Button label="Get started" onPress={start} />
              <Button label="Hear a real call" kind="secondary" onPress={() => scrollToId(ID.sample)} />
            </View>
            <T v="fine">Sign in with an email link. No password, no card.</T>
          </View>

          <Section id={ID.sample} title="Hear a real call" intro="A real call to our demo phone line. The names are fictional.">
            <SampleCallView />
          </Section>

          <Section title="How it works">
            <Row>
              {STEPS.map(([title, body], i) => (
                <Cell key={title}>
                  <Card style={s.tile}>
                    <StepNumber n={i + 1} />
                    <T v="h3">{title}</T>
                    <T v="soft">{body}</T>
                  </Card>
                </Cell>
              ))}
            </Row>
          </Section>

          <Section title="Two ways to use it">
            <Row>
              <Cell>
                <Card style={s.tile}>
                  <T v="h3">From your AI agent</T>
                  <T v="soft">Add CallEnvoy to Claude Code, Codex, Claude Desktop, or Cursor through MCP. Then ask your agent, for example:</T>
                  <Note kind="hint">“Call my internet provider and get the wrong $30 charge taken off my October bill. Ask for a reference number.”</Note>
                </Card>
              </Cell>
              <Cell>
                <Card style={s.tile}>
                  <T v="h3">From this web page</T>
                  <T v="soft">Fill in the New call form: the number, the business, and the goal. Follow the call live with its transcript, and join it from your browser or your phone.</T>
                </Card>
              </Cell>
            </Row>
          </Section>

          <Section title="What you can ask it to do">
            <View role="list" style={s.grid}>
              {EXAMPLES.map((e) => (
                <View key={e} role="listitem" style={s.gridItem}>
                  <Card style={s.example}>
                    <T v="body">{e}</T>
                  </Card>
                </View>
              ))}
            </View>
          </Section>

          <Section title="Good to know">
            <Card>
              <View role="list">
                {GOOD_TO_KNOW.map(([title, help], i) => (
                  <View key={title} role="listitem">
                    <StatusLine title={title} help={help} first={i === 0} />
                  </View>
                ))}
              </View>
            </Card>
          </Section>

          <View nativeID={ID.start} role="region" aria-labelledby="get-started-title" style={s.start}>
            <Card>
              <Stack>
                <View>
                  <T v="h1" level={2} id="get-started-title">
                    Get started
                  </T>
                  <T v="muted">Enter your email. We send a one-time link. No password.</T>
                </View>
                <SignInForm fieldId={ID.email} />
              </Stack>
            </Card>
          </View>
        </View>
        <View role="contentinfo" style={s.footer}>
          <T v="fine">CallEnvoy: an AI that makes phone calls for you.</T>
        </View>
      </ScrollView>
    </View>
  );
}

/** A titled part of the page (h2), a landmark region named by its title. */
function Section({ id, title, intro, children }: { id?: string; title: string; intro?: string; children: ReactNode }) {
  const titleId = `${(id ?? title).toLowerCase().replace(/\W+/g, '-')}-title`;
  return (
    <View nativeID={id} role="region" aria-labelledby={titleId} style={s.section}>
      <View>
        <T v="h1" level={2} id={titleId} style={intro ? s.titleWithIntro : undefined}>
          {title}
        </T>
        {intro ? <T v="muted">{intro}</T> : null}
      </View>
      {children}
    </View>
  );
}

/** The sample call: what it was asked, the recording with the transcript (click a line to jump), and the outcome. */
function SampleCallView() {
  const wide = useWide();
  const [sample, setSample] = useState<SampleCall | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let stop = false;
    setError(null);
    fetch(`${SAMPLE}/call.json`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((j: SampleCall) => !stop && setSample(j))
      .catch(() => !stop && setError('The sample call could not be loaded. Check your connection and try again.'));
    return () => {
      stop = true;
    };
  }, [tick]);
  const call = useMemo(() => (sample ? sampleToCall(sample) : null), [sample]);
  if (!sample || !call) return <Loading error={error} retry={() => setTick((t) => t + 1)} label="Loading the sample call" />;

  const request = (
    <Card label="What it was asked">
      <T v="h2" level={3}>
        What it was asked
      </T>
      <Text style={text.label}>Business</Text>
      <T v="body">{sample.business}</T>
      <Text style={[text.label, s.gap]}>Goal</Text>
      <T v="soft">{sample.goal}</T>
    </Card>
  );
  const recording = <PlayerTranscript call={call} url={`${SAMPLE}/call.mp3`} seconds={sample.duration_seconds} level={3} />;
  const outcome = <OutcomeCard call={call} level={3} />;
  return wide ? (
    <View style={s.cols}>
      <View style={[s.col, { flex: sampleColumns[0] }]}>
        {request}
        {outcome}
      </View>
      <View style={[s.col, { flex: sampleColumns[1] }]}>{recording}</View>
    </View>
  ) : (
    <View style={s.col}>
      {request}
      {recording}
      {outcome}
    </View>
  );
}

const s = StyleSheet.create({
  fill: { flex: 1 },
  page: { width: '100%', maxWidth: maxContent, alignSelf: 'center', paddingHorizontal: space.xl, paddingBottom: space.x4 },
  main: { gap: space.x5 },
  hero: { maxWidth: heroWidth, gap: space.xl, paddingTop: space.x4 },
  heroWide: { paddingTop: space.x5 + space.x4 },
  heroNarrow: { fontSize: font.size.heroNarrow, lineHeight: font.size.heroNarrow * font.heroLineHeight },
  lead: { color: color.soft, fontSize: font.size.big, lineHeight: font.size.big * lineHeight },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: space.ml, marginTop: space.xs },
  section: { gap: space.xl },
  titleWithIntro: { marginBottom: space.xs },
  cols: { flexDirection: 'row', alignItems: 'flex-start', gap: space.xxl },
  col: { gap: space.xxl },
  gap: { marginTop: space.ml },
  tile: { gap: space.ml, flexGrow: 1 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: space.l },
  gridItem: { flexGrow: 1, flexBasis: gridMinWidth, minWidth: gridMinWidth },
  example: { flexGrow: 1, paddingVertical: space.xl },
  start: { alignSelf: 'center', width: '100%', maxWidth: gateWidth + space.x5 * 2 },
  footer: { marginTop: space.x5, paddingTop: space.xl, borderTopWidth: border.thin, borderTopColor: color.line },
});
