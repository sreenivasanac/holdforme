import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { Call } from '../api';
import { CallList, EmptyCalls, LiveCallCard } from '../components/CallList';
import { Loading } from '../components/Loading';
import { Card, Chips, Screen, T, text } from '../components/ui';
import { useCalls } from '../hooks';
import { space } from '../theme';

type Filter = 'all' | 'live' | 'done' | 'not_done';
const FILTERS = [
  ['all', 'All'],
  ['live', 'Live'],
  ['done', 'Done'],
  ['not_done', 'Not done'],
] as const;
// "Done" is a finished call whose goal was reached; every other finished call is "Not done".
const shows = (c: Call, f: Filter) =>
  f === 'all' || (f === 'live' ? !c.finished : c.finished && (c.outcome?.result === 'done') === (f === 'done'));

/** Calls (home): live calls on top, then the call list with status filters. */
export default function CallsScreen() {
  const { calls, error, refresh } = useCalls();
  const [filter, setFilter] = useState<Filter>('all');
  const live = calls?.filter((c) => !c.finished) ?? [];
  const shown = calls?.filter((c) => shows(c, filter)) ?? [];
  return (
    <Screen>
      {live.map((c) => (
        <LiveCallCard key={c.id} call={c} />
      ))}
      <Card label="Calls">
        <View style={s.head}>
          <T v="h2" style={s.noMargin}>
            Calls
          </T>
          {calls?.length ? <Chips label="Show calls" value={filter} options={FILTERS} onChange={setFilter} /> : null}
        </View>
        {!calls ? (
          <Loading error={error} retry={refresh} label="Loading calls" />
        ) : calls.length === 0 ? (
          <EmptyCalls />
        ) : shown.length === 0 ? (
          <Text style={[text.muted, s.none]}>No calls with this status.</Text>
        ) : (
          <CallList calls={shown} />
        )}
      </Card>
    </Screen>
  );
}

const s = StyleSheet.create({
  head: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: space.ml, marginBottom: space.ml },
  noMargin: { marginBottom: 0 },
  none: { paddingVertical: space.xl, textAlign: 'center' },
});
