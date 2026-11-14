// The set-up snippets carry the MCP address and the key in the form each client expects.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installPrompt, setup } from '../src/agentSetup.ts';

const URL = 'https://example.com/callenvoy/mcp';
const KEY = 'ce_live_abcdefghjkmnpqrstuvwxyz2345678';
const s = setup(URL, KEY);

test('Claude Code: one command with the address and a Bearer header', () => {
  assert.equal(s.claude_code.code, `claude mcp add --scope user --transport http callenvoy ${URL} --header "Authorization: Bearer ${KEY}"`);
});

test('Codex: config.toml block with url and http_headers', () => {
  assert.equal(s.codex.code, `[mcp_servers.callenvoy]\nurl = "${URL}"\nhttp_headers = { Authorization = "Bearer ${KEY}" }`);
});

test('Claude Desktop: valid JSON, mcp-remote with no space inside an argument, key in env', () => {
  const cfg = JSON.parse(s.desktop.code).mcpServers.callenvoy;
  assert.equal(cfg.command, 'npx');
  assert.deepEqual(cfg.args, ['-y', 'mcp-remote', URL, '--header', 'Authorization:${AUTH_HEADER}']);
  assert.ok(cfg.args.every((a) => !a.includes(' ')));
  assert.deepEqual(cfg.env, { AUTH_HEADER: `Bearer ${KEY}` });
});

test('Cursor: valid JSON with url and headers', () => {
  assert.deepEqual(JSON.parse(s.cursor.code).mcpServers.callenvoy, { url: URL, headers: { Authorization: `Bearer ${KEY}` } });
});

test('clients without headers: the key in the address, with a warning', () => {
  assert.equal(s.url.code, `${URL}/${KEY}`);
  assert.ok(s.url.warn);
});

test('install prompt: address, header, key-in-address fallback and the check tool', () => {
  const p = installPrompt(URL, KEY);
  for (const part of [`Server address: ${URL}`, `Authorization: Bearer ${KEY}`, `${URL}/${KEY}`, 'callenvoy_get_profile']) assert.ok(p.includes(part), part);
});
