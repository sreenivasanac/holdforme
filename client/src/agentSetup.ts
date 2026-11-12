// MCP set-up text for each agent client, and the install prompt. Pure functions (tested in test/agentSetup.test.mjs).

export type Client = 'claude_code' | 'codex' | 'desktop' | 'cursor' | 'url';

/** The set-up text for each client, with the key (or YOUR_KEY). */
export function setup(url: string, key: string): Record<Client, { help: string; code: string; warn?: string }> {
  return {
    claude_code: { help: 'Run once in a terminal.', code: `claude mcp add --scope user --transport http callenvoy ${url} --header "Authorization: Bearer ${key}"` },
    codex: { help: 'Add to ~/.codex/config.toml.', code: `[mcp_servers.callenvoy]\nurl = "${url}"\nhttp_headers = { Authorization = "Bearer ${key}" }` },
    desktop: {
      help: 'Add to claude_desktop_config.json, then restart Claude Desktop.',
      // mcp-remote's documented form: no space inside an argument (Windows splits it), the key comes from env.
      code: `{"mcpServers": {"callenvoy": {\n  "command": "npx",\n  "args": ["-y", "mcp-remote", "${url}",\n    "--header", "Authorization:\${AUTH_HEADER}"],\n  "env": {"AUTH_HEADER": "Bearer ${key}"}\n}}}`,
    },
    cursor: {
      help: 'Add to ~/.cursor/mcp.json.',
      code: `{"mcpServers": {"callenvoy": {\n  "url": "${url}",\n  "headers": {"Authorization": "Bearer ${key}"}\n}}}`,
    },
    url: {
      help: 'For clients without headers (Grok bot, claude.ai or ChatGPT custom connector): paste this as the server address.',
      code: `${url}/${key}`,
      warn: 'The key is part of this address. Anyone with it can place calls. Use a header form when the client supports it.',
    },
  };
}

export function installPrompt(url: string, key: string) {
  return [
    'Add the CallEnvoy MCP server to your MCP settings, so you can place phone calls for me.',
    `Server address: ${url}`,
    `Send this header: Authorization: Bearer ${key}`,
    `If you cannot send headers, use this address instead: ${url}/${key}`,
    'Then call the tool callenvoy_get_profile to check that the connection works, and tell me the name it shows.',
    'Then ask me what the first call should be.',
  ].join('\n');
}
