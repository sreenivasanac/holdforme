// Agents page (round 2, B3): API keys, how to add CallEnvoy to an agent, connection check, what the agent can do.
import { useCallback, useEffect, useState } from 'react';
import { AppState, StyleSheet, Text, View } from 'react-native';
import { api, type ApiKey } from '../api';
import { installPrompt, setup, type Client } from '../agentSetup';
import { ago, when } from '../format';
import { border, color, font, radius, space } from '../theme';
import { Loading } from './Loading';
import { Button, Card, Chips, CopyBlock, Disclosure, Note, Pill, Sheet, Stack, T, TextField, text } from './ui';

const NAME_MAX = 40;
const MAX_KEYS = 20;
const SUGGESTIONS = ['Claude Code', 'Codex', 'Claude Desktop', 'Cursor', 'Grok bot'];
const CHECK_EVERY_MS = 3000;
const CHECK_FOR_MS = 120_000;
const PLACEHOLDER = 'YOUR_KEY';

export type FreshKey = { id: string; name: string; key: string };

/** The key list, loaded on open. */
export function useKeys() {
  const [keys, setKeys] = useState<ApiKey[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(async () => {
    setError(null);
    try {
      setKeys((await api.keys()).keys);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { keys, setKeys, error, reload };
}

/**
 * After a key is created: asks for the key list every 3 s, for at most 2 minutes and only while the page
 * is visible, until the new key has been used. Returns 'waiting' | 'connected' | 'timeout'.
 */
export function useConnectionCheck(fresh: FreshKey | null, onKeys: (k: ApiKey[]) => void) {
  const [state, setState] = useState<'waiting' | 'connected' | 'timeout'>('waiting');
  const [round, setRound] = useState(0);
  useEffect(() => {
    if (!fresh) return;
    setState('waiting');
    const until = Date.now() + CHECK_FOR_MS;
    let cancelled = false;
    let t: ReturnType<typeof setTimeout>;
    // One request at a time; an answer that arrives after cleanup is dropped.
    const tick = async () => {
      if (Date.now() > until) return setState('timeout');
      if (AppState.currentState === 'active') {
        // a hidden tab sends no requests
        try {
          const { keys } = await api.keys();
          if (cancelled) return;
          onKeys(keys);
          if (keys.find((k) => k.id === fresh.id)?.last_used_at) return setState('connected');
        } catch {
          // the next round tries again
        }
      }
      if (!cancelled) t = setTimeout(tick, CHECK_EVERY_MS);
    };
    t = setTimeout(tick, CHECK_EVERY_MS);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [fresh, onKeys, round]);
  return { state, again: () => setRound((r) => r + 1) };
}

export function KeysCard({ keys, error, reload, setKeys, onCreated, fresh, check }: {
  keys: ApiKey[] | null;
  error: string | null;
  reload: () => void;
  setKeys: (k: ApiKey[]) => void;
  onCreated: (k: FreshKey | null) => void;
  fresh: FreshKey | null;
  check: ReturnType<typeof useConnectionCheck>;
}) {
  const [adding, setAdding] = useState(false);
  const [deleting, setDeleting] = useState<ApiKey | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);

  const act = async (id: string, fn: () => Promise<unknown>) => {
    setBusy(id);
    setRowError(null);
    try {
      await fn();
      setKeys((await api.keys()).keys);
    } catch (e) {
      setRowError((e as Error).message);
    }
    setBusy(null);
  };
  const full = (keys?.length ?? 0) >= MAX_KEYS;

  return (
    <Card label="API keys">
      <Stack>
        <View style={s.head}>
          <View style={s.fill}>
            <T v="h2">API keys</T>
            <T v="muted">Each agent gets its own key. A key works for agents only; it does not open this console.</T>
          </View>
          {!adding && keys ? <Button label="New key" disabled={full} onPress={() => setAdding(true)} /> : null}
        </View>
        {full && <T v="fine">{`At most ${MAX_KEYS} keys. Delete one to add another.`}</T>}
        {adding && (
          <NewKey
            onCancel={() => setAdding(false)}
            onCreated={(k) => {
              setAdding(false);
              onCreated(k);
              void reload();
            }}
          />
        )}
        {fresh && <FreshKeyPanel fresh={fresh} check={check} onDone={() => onCreated(null)} />}
        {rowError && <Note kind="errsum">{rowError}</Note>}
        {!keys ? (
          <Loading error={error} retry={reload} label="Loading keys" />
        ) : keys.length === 0 ? (
          <T v="muted">No keys yet. Create one for each agent you use.</T>
        ) : (
          <View role="list">
            {keys.map((k) => (
              <View key={k.id} role="listitem" style={s.row}>
                <View style={s.keyText}>
                  <Text style={s.name} numberOfLines={1}>
                    {k.name}
                  </Text>
                  <Text style={text.mono}>{k.prefix}…</Text>
                  <Text style={text.fine}>
                    Created {when(k.created_at)} · {k.last_used_at ? `last used ${ago(k.last_used_at)}` : 'never used'}
                  </Text>
                </View>
                <View>
                  <Pill label={k.disabled ? 'Disabled' : 'Active'} tone={k.disabled ? 'neutral' : 'ok'} />
                </View>
                <View style={s.actions}>
                  <Button
                    label={k.disabled ? 'Enable' : 'Disable'}
                    a11yLabel={`${k.disabled ? 'Enable' : 'Disable'} the key ${k.name}`}
                    kind="secondary"
                    size="small"
                    busy={busy === k.id}
                    onPress={() => act(k.id, () => api.updateKey(k.id, { disabled: !k.disabled }))}
                  />
                  <Button label="Delete" a11yLabel={`Delete the key ${k.name}`} kind="danger" size="small" disabled={busy === k.id} onPress={() => setDeleting(k)} />
                </View>
              </View>
            ))}
          </View>
        )}
      </Stack>
      <Sheet title={`Delete "${deleting?.name ?? ''}"?`} visible={!!deleting} onClose={() => setDeleting(null)}>
        <T v="soft">Agents that use this key stop working at once.</T>
        <Button
          label="Delete key"
          kind="danger"
          full
          onPress={() => {
            const k = deleting!;
            setDeleting(null);
            if (fresh?.id === k.id) onCreated(null);
            void act(k.id, () => api.deleteKey(k.id));
          }}
        />
        <Button label="Keep the key" kind="secondary" full onPress={() => setDeleting(null)} />
      </Sheet>
    </Card>
  );
}

function NewKey({ onCancel, onCreated }: { onCancel: () => void; onCreated: (k: FreshKey) => void }) {
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const create = async () => {
    const n = name.trim();
    if (!n) return setError('Give the key a name, for example the agent that uses it.');
    setBusy(true);
    setError(null);
    try {
      const k = await api.createKey(n);
      onCreated({ id: k.id, name: k.name, key: k.key });
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <View style={s.panel}>
      <TextField label="Key name" value={name} onChangeText={setName} maxLength={NAME_MAX} error={error} autoFocus onSubmitEditing={create} help={`The agent that uses this key. At most ${NAME_MAX} characters (${name.length}/${NAME_MAX}).`} />
      <View style={s.actions} role="group" aria-label="Suggested names">
        {SUGGESTIONS.map((x) => (
          <Button key={x} label={x} a11yLabel={`Name it ${x}`} kind="secondary" size="small" pressed={name === x} onPress={() => setName(x)} />
        ))}
      </View>
      <View style={s.actions}>
        <Button label={busy ? 'Creating...' : 'Create key'} busy={busy} onPress={create} />
        <Button label="Cancel" kind="link" onPress={onCancel} />
      </View>
    </View>
  );
}

function FreshKeyPanel({ fresh, check, onDone }: { fresh: FreshKey; check: ReturnType<typeof useConnectionCheck>; onDone: () => void }) {
  return (
    <Note kind="saved" title="Copy this key now. It is not shown again.">
      <CopyBlock code={fresh.key} name={`the key ${fresh.name}`} />
      <Text style={text.base}>The set-up steps below are filled in with this key.</Text>
      <View role="status">
        {check.state === 'connected' ? (
          <Text style={[text.base, s.bold]}>{`Connected: ${fresh.name} used the key just now.`}</Text>
        ) : check.state === 'waiting' ? (
          <Text style={text.base}>Waiting for an agent to use the key...</Text>
        ) : (
          <Text style={text.base}>No agent has used the key yet.</Text>
        )}
      </View>
      <View style={s.actions}>
        {check.state === 'timeout' && <Button label="Check again" kind="secondary" size="small" onPress={check.again} />}
        <Button label="I saved the key" kind="secondary" size="small" onPress={onDone} />
      </View>
    </Note>
  );
}

const CLIENTS = [
  ['claude_code', 'Claude Code'],
  ['codex', 'Codex'],
  ['desktop', 'Claude Desktop'],
  ['cursor', 'Cursor'],
  ['url', 'Grok bot, claude.ai, ChatGPT'],
] as const;

export function SetupCard({ url, fresh }: { url: string; fresh: FreshKey | null }) {
  const [client, setClient] = useState<Client>('claude_code');
  const key = fresh?.key ?? PLACEHOLDER;
  const c = setup(url, key)[client];
  const name = CLIENTS.find(([v]) => v === client)![1];
  return (
    <Card label="Add CallEnvoy to an agent">
      <Stack>
        <View>
          <T v="h2">Add CallEnvoy to an agent</T>
          <T v="muted">Add this server to an AI agent, then ask it to make a call. You can follow every call here.</T>
        </View>
        {!fresh && <Note kind="hint">Create a key above to fill this in. Until then the steps show YOUR_KEY.</Note>}
        <View>
          <Text style={text.label}>MCP address</Text>
          <CopyBlock code={url} name="MCP address" />
        </View>
        <Chips label="Agent" value={client} options={CLIENTS} onChange={setClient} />
        <View style={s.client}>
          <Text style={[text.m, s.soft]}>{c.help}</Text>
          <CopyBlock code={c.code} name={`${name} set-up`} />
          {c.warn ? <Note kind="warn">{c.warn}</Note> : null}
        </View>
        <Text style={text.subhead}>Let the agent set it up</Text>
        <T v="soft">Paste this into the agent. It adds the server, checks the connection and asks for your first call.</T>
        <CopyBlock code={installPrompt(url, key)} name="install prompt" />
      </Stack>
    </Card>
  );
}

const TOOLS: [string, string][] = [
  ['place_call', 'Calls a business with a goal and the details the AI may share.'],
  ['get_call', 'Follows a call: where it is, the transcript, open questions, the outcome.'],
  ['hang_up', 'Ends a call.'],
  ['list_calls', 'Lists recent calls.'],
  ['answer_question', 'Answers a question the AI asks during a call.'],
  ['connect_me', 'Brings you onto a live call, by phone or in this console.'],
  ['hand_back', 'Gives the call back to the AI.'],
  ['get_recordings', 'Gets the recording links of a call.'],
  ['get_profile', 'Reads your saved profile and settings.'],
  ['save_profile', 'Changes your profile and settings.'],
  ['list_voices', 'Lists the AI voices.'],
  ['verify_number', 'Verifies your own number, so calls can show it as caller ID.'],
];
const EXAMPLES = [
  'Call Northstar Internet at (656) 240-5137 and get the plan change reversed. Ask for a reference number.',
  'Call my dentist and move my cleaning to next week. Put me on when a person answers.',
  'How did the call to City Water Billing go?',
];

export function ToolsCard() {
  return (
    <Card label="What the agent can do">
      <Disclosure title="What the agent can do">
        <Stack gap={space.sm}>
          {TOOLS.map(([n, d]) => (
            <Text key={n} style={text.base}>
              <Text style={text.mono}>callenvoy_{n}</Text>
              {'  '}
              <Text style={s.soft}>{d}</Text>
            </Text>
          ))}
          <Text style={text.subhead}>Things to say to the agent</Text>
          {EXAMPLES.map((e) => (
            <Text key={e} style={[text.base, s.soft]}>
              “{e}”
            </Text>
          ))}
        </Stack>
      </Disclosure>
    </Card>
  );
}

const s = StyleSheet.create({
  fill: { flex: 1 },
  head: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'flex-start', justifyContent: 'space-between', gap: space.ml },
  row: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: space.ml, rowGap: space.sm, paddingVertical: space.ml, borderTopWidth: border.thin, borderTopColor: color.line },
  keyText: { flexGrow: 1, flexShrink: 1, flexBasis: space.x5 * 4, gap: space.xxs },
  name: { color: color.fg, fontSize: font.size.body, fontWeight: font.weight.semi },
  actions: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: space.sm },
  panel: { gap: space.ml, backgroundColor: color.card2, borderWidth: border.thin, borderColor: color.line, borderRadius: radius.l, padding: space.l },
  client: { gap: space.sm },
  soft: { color: color.soft },
  bold: { fontWeight: font.weight.bold },
});
