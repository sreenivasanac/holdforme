import { router } from 'expo-router';
import { Pressable, StyleSheet, Text, View, type PressableStateCallbackType } from 'react-native';
import type { Call } from '../api';
import { callSeconds, duration, ownerLabel, phone, statusLabel, when } from '../format';
import { useGo, useNow } from '../hooks';
import { border, callColumns, color, font, space, useWide } from '../theme';
import { Button, Card, Pill, text } from './ui';

/** Status pill plus the owner-state pill of a call. */
export function StatusBadge({ call }: { call: Call }) {
  const st = statusLabel(call);
  const owner = ownerLabel(call);
  return (
    <View style={s.badges}>
      {call.direction === 'inbound' && <Pill label="Incoming" tone="info" />}
      <Pill label={st.text} tone={st.tone} live={st.live} />
      {owner && <Pill label={owner.text} tone={owner.tone} />}
    </View>
  );
}

export function CallList({ calls }: { calls: Call[] }) {
  const wide = useWide();
  const now = useNow(1000, calls.some((c) => !c.finished));
  return (
    <View>
      {wide && (
        <View style={[s.cols, s.head]} aria-hidden>
          {['Business', 'Status', 'Length', 'Started'].map((h, i) => (
            <Text key={h} style={[s.headText, { flex: callColumns[i] }]}>
              {h}
            </Text>
          ))}
        </View>
      )}
      <View role="list">
        {calls.map((c, i) => (
          <CallRow key={c.id} call={c} now={now} first={i === 0} />
        ))}
      </View>
    </View>
  );
}

/** One line about the result: the outcome summary, or the error. */
const summary = (c: Call) => c.outcome?.summary || c.error || null;

function CallRow({ call, now, first }: { call: Call; now: number; first: boolean }) {
  const wide = useWide();
  const len = duration(callSeconds(call, now));
  const started = when(call.created_at);
  const sum = summary(call);
  return (
    <View role="listitem" style={!first && s.divider}>
      <Pressable
        role="link"
        aria-label={`${call.business}, ${statusLabel(call).text}`}
        onPress={() => router.push(`/calls/${call.id}`)}
        style={(st: PressableStateCallbackType & { hovered?: boolean }) => [s.row, wide && s.cols, (st.hovered || st.pressed) && s.hover]}
      >
        {wide ? (
          <>
            <View style={{ flex: callColumns[0] }}>
              <Text style={s.biz} numberOfLines={1}>
                {call.business}
              </Text>
              {sum ? (
                <Text style={s.small} numberOfLines={1}>
                  {sum}
                </Text>
              ) : null}
            </View>
            <View style={{ flex: callColumns[1] }}>
              <StatusBadge call={call} />
            </View>
            <Text style={[s.small, { flex: callColumns[2] }]}>{len}</Text>
            <Text style={[s.small, { flex: callColumns[3] }]}>{started}</Text>
          </>
        ) : (
          <>
            <View style={s.narrowTop}>
              <Text style={[s.biz, s.fill]}>{call.business}</Text>
              <StatusBadge call={call} />
            </View>
            {sum ? (
              <Text style={s.small} numberOfLines={1}>
                {sum}
              </Text>
            ) : null}
            <Text style={s.small}>
              {started} · {len}
            </Text>
          </>
        )}
      </Pressable>
    </View>
  );
}

/** A live call at the top of Calls: where it is, how long, and Open. */
export function LiveCallCard({ call }: { call: Call }) {
  const now = useNow();
  const go = useGo();
  const wide = useWide();
  const name = (
    <View style={s.liveText}>
      <Text style={s.biz} numberOfLines={1}>
        {call.business}
      </Text>
      <Text style={s.small}>{phone(call.number)}</Text>
    </View>
  );
  const timer = (
    <Text style={s.timer} aria-label="Call length">
      {duration(callSeconds(call, now))}
    </Text>
  );
  const open = (
    <View>
      <Button label="Open" a11yLabel={`Open the call to ${call.business}`} size="small" onPress={() => go(`/calls/${call.id}`)} />
    </View>
  );
  return (
    <Card label={`Live call: ${call.business}`} style={s.live}>
      {wide ? (
        <View style={s.liveRow}>
          {name}
          <StatusBadge call={call} />
          {timer}
          {open}
        </View>
      ) : (
        <View style={s.liveStack}>
          <View style={s.liveRow}>
            {name}
            {timer}
          </View>
          <View style={s.liveRow}>
            <View style={s.fill}>
              <StatusBadge call={call} />
            </View>
            {open}
          </View>
        </View>
      )}
    </Card>
  );
}

/** "No calls yet" with the two ways to start one. */
export function EmptyCalls() {
  const go = useGo();
  return (
    <View style={s.empty}>
      <Text style={[text.body, s.emptyTitle]}>No calls yet</Text>
      <Text style={[text.muted, s.center]}>Start a call here, or add CallEnvoy to an AI agent and ask it to call a business for you.</Text>
      <View style={s.emptyActions}>
        <Button label="New call" onPress={() => go('/new')} />
        <Button label="Add to an agent" kind="secondary" onPress={() => go('/agents')} />
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  fill: { flex: 1 },
  badges: { flexDirection: 'row', flexWrap: 'wrap', gap: space.s, alignItems: 'center', flexShrink: 1 },
  cols: { flexDirection: 'row', alignItems: 'center', gap: space.ml },
  head: { paddingHorizontal: space.xs, paddingBottom: space.sm, borderBottomWidth: border.thin, borderBottomColor: color.line },
  headText: { color: color.muted, fontSize: font.size.s, fontWeight: font.weight.semi },
  divider: { borderTopWidth: border.thin, borderTopColor: color.line },
  row: { paddingVertical: space.ml, paddingHorizontal: space.xs, gap: space.xxs },
  hover: { backgroundColor: color.card2 },
  narrowTop: { flexDirection: 'row', alignItems: 'flex-start', gap: space.ml },
  biz: { color: color.fg, fontSize: font.size.body, fontWeight: font.weight.semi },
  small: { color: color.muted, fontSize: font.size.m, fontVariant: ['tabular-nums'] },
  empty: { alignItems: 'center', paddingVertical: space.x4 - space.xs, paddingHorizontal: space.ml },
  emptyTitle: { fontSize: font.size.l, fontWeight: font.weight.bold, marginBottom: space.xs },
  center: { textAlign: 'center' },
  emptyActions: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: space.ml, marginTop: space.xl },
  live: { borderColor: color.okLine, paddingVertical: space.l },
  liveRow: { flexDirection: 'row', alignItems: 'center', gap: space.l },
  liveStack: { gap: space.ml },
  liveText: { flex: 1 },
  timer: { color: color.fg, fontSize: font.size.big, fontWeight: font.weight.bold, fontVariant: ['tabular-nums'] },
});
