import { router } from 'expo-router';
import { Pressable, StyleSheet, Text, View, type PressableStateCallbackType } from 'react-native';
import type { Call } from '../api';
import { callSeconds, duration, ownerLabel, phone, statusLabel, when } from '../format';
import { useNow } from '../hooks';
import { border, callColumns, color, font, space, useWide } from '../theme';
import { Pill, text } from './ui';

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
          {['Business', 'Number', 'Status', 'Length', 'Started'].map((h, i) => (
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

function CallRow({ call, now, first }: { call: Call; now: number; first: boolean }) {
  const wide = useWide();
  const len = duration(callSeconds(call, now));
  const started = when(call.created_at);
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
              <Text style={[s.biz, { flex: callColumns[0] }]} numberOfLines={2}>
                {call.business}
              </Text>
              <Text style={[s.small, { flex: callColumns[1] }]}>{phone(call.number)}</Text>
              <View style={{ flex: callColumns[2] }}>
                <StatusBadge call={call} />
              </View>
              <Text style={[s.small, { flex: callColumns[3] }]}>{len}</Text>
              <Text style={[s.small, { flex: callColumns[4] }]}>{started}</Text>
            </>
          ) : (
            <>
              <View style={s.narrowTop}>
                <Text style={[s.biz, s.fill]}>{call.business}</Text>
                <StatusBadge call={call} />
              </View>
              <Text style={s.small}>
                {started} · {len}
              </Text>
            </>
          )}
      </Pressable>
    </View>
  );
}

/** "No calls yet" message. */
export function EmptyCalls() {
  return (
    <View style={s.empty}>
      <Text style={[text.body, s.emptyTitle]}>No calls yet</Text>
      <Text style={[text.muted, s.center]}>Start one with New call, or connect an agent below and ask it to call a business for you.</Text>
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
});
