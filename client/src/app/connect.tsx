import { ConnectPanel } from '../components/ConnectPanel';
import { Screen } from '../components/ui';
import { useSettings } from '../hooks';

/** Connect: the MCP install steps on their own page. */
export default function ConnectScreen() {
  const { config } = useSettings();
  return (
    <Screen>
      <ConnectPanel mcpUrl={config?.mcp_url} />
    </Screen>
  );
}
