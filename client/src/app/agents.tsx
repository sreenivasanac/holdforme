import { useState } from 'react';
import { KeysCard, SetupCard, ToolsCard, useConnectionCheck, useKeys, type FreshKey } from '../components/Agents';
import { Loading } from '../components/Loading';
import { Screen } from '../components/ui';
import { useSettings } from '../hooks';

/** Agents: API keys, how to add CallEnvoy to an agent, and what the agent can do. */
export default function AgentsScreen() {
  const { config, error, reload } = useSettings();
  const keys = useKeys();
  const [fresh, setFresh] = useState<FreshKey | null>(null); // the key just created; shown once
  const check = useConnectionCheck(fresh, keys.setKeys);
  return (
    <Screen>
      <KeysCard {...keys} reload={() => void keys.reload()} onCreated={setFresh} fresh={fresh} check={check} />
      {config ? <SetupCard url={config.mcp_url} fresh={fresh} /> : <Loading error={error} retry={reload} label="Loading the MCP address" />}
      <ToolsCard />
    </Screen>
  );
}
