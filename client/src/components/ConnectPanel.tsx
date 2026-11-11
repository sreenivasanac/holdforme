import { useState } from 'react';
import { Clipboard, StyleSheet, Text, View } from 'react-native';
import { useSession } from '../hooks';
import { border, color, font, radius, space, useWide } from '../theme';
import { Button, Card, Note, T, text } from './ui';

const MASK = '••••••••••••••••';
export const DEFAULT_MCP_URL = 'https://pragnyalabs.com/callenvoy/mcp';

/** MCP install steps. The key is masked until "Show key"; Copy always copies the real key. */
export function ConnectPanel({ mcpUrl = DEFAULT_MCP_URL }: { mcpUrl?: string }) {
  const { key } = useSession();
  const wide = useWide();
  const [show, setShow] = useState(false);
  const k = key ?? '';
  const view = (s: string) => (show ? s : s.split(k).join(MASK));

  const clients = [
    { title: 'Claude Code', help: 'Run once in a terminal.', name: 'Claude Code command', code: `claude mcp add --transport http callenvoy ${mcpUrl} --header "Authorization: Bearer ${k}"` },
    {
      title: 'Codex',
      help: 'Add to ~/.codex/config.toml.',
      name: 'Codex config',
      code: `[mcp_servers.callenvoy]\nurl = "${mcpUrl}"\nhttp_headers = { Authorization = "Bearer ${k}" }`,
    },
    {
      title: 'Claude Desktop',
      help: 'Add to claude_desktop_config.json, then restart Claude Desktop.',
      name: 'Claude Desktop config',
      code: `{"mcpServers": {"callenvoy": {\n  "command": "npx",\n  "args": ["mcp-remote", "${mcpUrl}",\n    "--header", "Authorization: Bearer ${k}"]\n}}}`,
    },
    {
      title: 'Grok bot and other clients without headers',
      help: 'Paste this URL as the MCP server address. The key is part of the URL.',
      name: 'URL with key',
      code: `${mcpUrl}/${k}`,
      warn: 'Anyone with this URL can place calls. Use the header form when the client supports it.',
    },
  ];

  return (
    <Card label="Connect an agent">
      <View style={s.stack}>
        <View>
          <T v="h2">Connect an agent</T>
          <T v="muted">Add this server to an AI agent, then ask it to make a call. The agent places the call and you can follow it here.</T>
        </View>
        <View style={s.keyline}>
          <Text style={text.muted}>MCP URL</Text>
          <Text style={s.code}>{mcpUrl}</Text>
          <Text style={text.muted}>Key</Text>
          <Text style={s.code}>{show ? k : MASK}</Text>
          <Button label={show ? 'Hide key' : 'Show key'} kind="secondary" size="small" pressed={show} onPress={() => setShow(!show)} />
        </View>
        <View style={[s.clients, wide && s.clientsWide]}>
          {clients.map((c) => (
            <View key={c.title} style={[s.client, wide && s.clientWide]}>
              <T v="h3">{c.title}</T>
              <Text style={[text.m, { color: color.soft }]}>{c.help}</Text>
              <CopyBlock shown={view(c.code)} copy={c.code} name={c.name} />
              {c.warn ? <Note kind="warn">{c.warn}</Note> : null}
            </View>
          ))}
        </View>
      </View>
    </Card>
  );
}

/** A code block with a Copy button. */
export function CopyBlock({ shown, copy, name }: { shown: string; copy: string; name: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <View style={s.block}>
      <Text style={[text.mono, s.blockText]} selectable>
        {shown}
      </Text>
      <View style={s.copy}>
        <Button
          label={copied ? 'Copied' : 'Copy'}
          a11yLabel={`Copy ${name}`}
          kind="secondary"
          size="small"
          onPress={() => {
            Clipboard.setString(copy);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          }}
        />
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  stack: { gap: space.l },
  keyline: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: space.sm },
  code: {
    flexShrink: 1,
    color: color.fg,
    fontFamily: font.mono,
    fontSize: font.size.m,
    backgroundColor: color.card2,
    borderWidth: border.thin,
    borderColor: color.line,
    borderRadius: radius.s,
    paddingVertical: space.s,
    paddingHorizontal: space.m,
  },
  clients: { gap: space.l },
  clientsWide: { flexDirection: 'row', flexWrap: 'wrap' },
  client: { backgroundColor: color.card2, borderWidth: border.thin, borderColor: color.line, borderRadius: radius.l, padding: space.l, gap: space.sm },
  clientWide: { flexBasis: '45%', flexGrow: 1 },
  block: { backgroundColor: color.bg, borderWidth: border.thin, borderColor: color.line, borderRadius: radius.m, paddingVertical: space.m, paddingHorizontal: space.ml, paddingRight: space.x5 + space.x3 + space.xs },
  blockText: { lineHeight: font.size.s * font.monoLineHeight },
  copy: { position: 'absolute', top: space.s, right: space.s },
});
