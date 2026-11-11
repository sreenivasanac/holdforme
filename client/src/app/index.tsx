import { router } from 'expo-router';
import { StyleSheet, View } from 'react-native';
import { Loading } from '../components/Loading';
import { CallList, EmptyCalls } from '../components/CallList';
import { ConnectPanel } from '../components/ConnectPanel';
import { Button, Card, Screen, T } from '../components/ui';
import { useCalls, useSettings } from '../hooks';
import { space } from '../theme';

/** Calls (home): New call, the call list, and the MCP install steps. */
export default function CallsScreen() {
  const { calls, error, refresh } = useCalls();
  const { config } = useSettings();
  return (
    <Screen>
      <Card label="Calls">
        <View style={s.head}>
          <T v="h2" style={s.noMargin}>
            Calls
          </T>
          <Button label="New call" onPress={() => router.push('/new')} />
        </View>
        {!calls ? (
          <Loading error={error} retry={refresh} label="Loading calls" />
        ) : calls.length === 0 ? (
          <EmptyCalls />
        ) : (
          <CallList calls={calls} />
        )}
      </Card>
      <ConnectPanel mcpUrl={config?.mcp_url} />
    </Screen>
  );
}

const s = StyleSheet.create({
  head: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: space.ml, marginBottom: space.ml },
  noMargin: { marginBottom: 0 },
});
