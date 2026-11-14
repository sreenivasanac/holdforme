// People (round 3 B3, admin only): usage of each account, disable / enable / remove, and the sign-ups switch.
import { useCallback, useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { api, type AdminUser } from '../api';
import { ago, day } from '../format';
import { useSettings } from '../hooks';
import { border, color, font, peopleColumns, space, useWide } from '../theme';
import { Loading } from './Loading';
import { Button, Card, Note, Pill, Sheet, Stack, SwitchRow, T, TableHead, text } from './ui';

const HEADERS = ['Person', 'Joined', 'Last active', 'Calls', 'Minutes', 'State', ''];

export function PeopleCard() {
  const wide = useWide();
  const { config } = useSettings();
  const [data, setData] = useState<{ signups_open: boolean; users: AdminUser[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null); // a user id, or 'signups'
  const [removing, setRemoving] = useState<AdminUser | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setData(await api.users());
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const act = async (id: string, fn: () => Promise<unknown>) => {
    setBusy(id);
    setActionError(null);
    try {
      await fn();
      setData(await api.users());
    } catch (e) {
      setActionError((e as Error).message);
    }
    setBusy(null);
  };

  const cap = config?.limits.daily_minute_cap;
  const today = data?.users.reduce((n, u) => n + u.minutes_today, 0) ?? 0;
  return (
    <Card label="People">
      <Stack>
        <View>
          <T v="h2">People</T>
          <T v="muted">You can see usage only. Calls, transcripts and recordings of other people are private.</T>
        </View>
        {!data ? (
          <Loading error={error} retry={() => void load()} label="Loading people" />
        ) : (
          <>
            <Text style={text.body}>{cap ? `${today} of ${cap} minutes used today` : `${today} minutes used today`}</Text>
            <SwitchRow
              title="New sign-ups"
              help={data.signups_open ? 'On: anyone with an email address can make an account.' : 'Off: only people who already have an account can sign in.'}
              value={data.signups_open}
              disabled={busy === 'signups'}
              onChange={(v) => void act('signups', () => api.setSignups(v))}
            />
            {actionError ? <Note kind="errsum">{actionError}</Note> : null}
            {data.users.length <= 1 ? <T v="muted">Only you so far. People who sign up show here.</T> : null}
            <View>
              {wide && <TableHead titles={HEADERS} flex={peopleColumns} />}
              <View role="list" aria-label="People">
                {data.users.map((u, i) => (
                  <PersonRow key={u.id} u={u} first={i === 0} busy={busy === u.id} onToggle={() => void act(u.id, () => api.updateUser(u.id, !u.disabled))} onRemove={() => setRemoving(u)} />
                ))}
              </View>
            </View>
          </>
        )}
      </Stack>
      <Sheet title={`Remove ${removing?.email ?? ''}?`} visible={!!removing} onClose={() => setRemoving(null)}>
        <T v="soft">This deletes all calls, recordings, keys and settings of this person. It cannot be undone. Their live calls are hung up.</T>
        <Button
          label="Remove"
          kind="danger"
          full
          onPress={() => {
            const u = removing!;
            setRemoving(null);
            void act(u.id, () => api.removeUser(u.id));
          }}
        />
        <Button label="Keep" kind="secondary" full onPress={() => setRemoving(null)} />
      </Sheet>
    </Card>
  );
}

function PersonRow({ u, first, busy, onToggle, onRemove }: { u: AdminUser; first: boolean; busy: boolean; onToggle: () => void; onRemove: () => void }) {
  const wide = useWide();
  const state = u.disabled ? (
    <Pill label="Disabled" />
  ) : u.live_calls ? (
    <Pill label="On a call" tone="ok" live />
  ) : (
    <Pill label="Active" tone="ok" />
  );
  const who = (
    <View>
      <Text style={s.name}>
        {u.name ?? <Text style={s.you}>No name yet</Text>}
        {u.is_admin ? <Text style={s.you}> (you)</Text> : null}
      </Text>
      <Text style={s.small}>{u.email}</Text>
    </View>
  );
  const last = u.last_seen_at ? ago(u.last_seen_at) : 'never';
  const minutes = `${u.minutes} min · ${u.minutes_today} today`;
  const actions = u.is_admin ? null : (
    <View style={s.actions}>
      <Button
        label={u.disabled ? 'Enable' : 'Disable'}
        a11yLabel={`${u.disabled ? 'Enable' : 'Disable'} ${u.email}`}
        kind="secondary"
        size="small"
        busy={busy}
        onPress={onToggle}
      />
      <Button label="Remove" a11yLabel={`Remove ${u.email}`} kind="danger" size="small" disabled={busy} onPress={onRemove} />
    </View>
  );
  return (
    <View role="listitem" style={[s.row, wide && s.cols, !first && s.divider]}>
      {wide ? (
        <>
          <View style={{ flex: peopleColumns[0] }}>{who}</View>
          <Text style={[s.small, { flex: peopleColumns[1] }]}>{day(u.created_at)}</Text>
          <Text style={[s.small, { flex: peopleColumns[2] }]}>{last}</Text>
          <Text style={[s.small, { flex: peopleColumns[3] }]}>{u.calls}</Text>
          <Text style={[s.small, { flex: peopleColumns[4] }]}>{minutes}</Text>
          <View style={{ flex: peopleColumns[5] }}>{state}</View>
          <View style={{ flex: peopleColumns[6] }}>{actions}</View>
        </>
      ) : (
        <>
          <View style={s.narrowTop}>
            <View style={s.fill}>{who}</View>
            {state}
          </View>
          <Text style={s.small}>{`Joined ${day(u.created_at)} · last active ${last}`}</Text>
          <Text style={s.small}>{`${u.calls} call${u.calls === 1 ? '' : 's'} · ${minutes}`}</Text>
          {actions}
        </>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  fill: { flex: 1 },
  cols: { flexDirection: 'row', alignItems: 'center', gap: space.ml },
  divider: { borderTopWidth: border.thin, borderTopColor: color.line },
  row: { paddingVertical: space.ml, paddingHorizontal: space.xs, gap: space.s },
  narrowTop: { flexDirection: 'row', alignItems: 'flex-start', gap: space.ml },
  name: { color: color.fg, fontSize: font.size.body, fontWeight: font.weight.semi },
  you: { color: color.muted, fontWeight: font.weight.normal },
  small: { color: color.muted, fontSize: font.size.m, fontVariant: ['tabular-nums'] },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
});
