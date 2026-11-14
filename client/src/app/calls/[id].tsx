import { useLocalSearchParams } from 'expo-router';
import { StyleSheet, View } from 'react-native';
import { BackLink } from '../../components/BackLink';
import { CallHeader, CallRecording, CallRequest, OutcomeCard, QuestionBox, TranscriptLog } from '../../components/CallDetail';
import { Loading } from '../../components/Loading';
import { OwnerControls } from '../../components/OwnerControls';
import { Screen } from '../../components/ui';
import { useCall, useSettings } from '../../hooks';
import { space, useWide } from '../../theme';

/** One call: live (transcript, question, owner panel) or finished (outcome, recording with transcript, options). */
export default function CallScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { call, error } = useCall(id);
  const { settings } = useSettings();
  const wide = useWide();
  if (!call)
    return (
      <Screen>
        <BackLink />
        <Loading error={error} label="Loading call" />
      </Screen>
    );

  const inbound = call.direction === 'inbound';
  if (call.finished)
    return (
      <Screen>
        <BackLink />
        <CallHeader call={call} />
        {!inbound && (
          <>
            <OutcomeCard call={call} />
            <CallRecording call={call} />
            <CallRequest call={call} />
          </>
        )}
      </Screen>
    );
  const side = inbound ? null : (
    <>
      {call.open_questions.map((q) => (
        <QuestionBox key={q.id} callId={call.id} q={q} />
      ))}
      <OwnerControls call={call} callbackNumber={settings?.callback_number || null} />
    </>
  );

  return (
    <Screen>
      <BackLink />
      <CallHeader call={call} />
      {!inbound && (
        <View style={[s.detail, wide && s.detailWide]}>
          {/* The owner panel sits right of the transcript on wide screens and above it on narrow ones. */}
          {!wide && <View style={s.side}>{side}</View>}
          <View style={wide && s.main}>
            <TranscriptLog call={call} />
          </View>
          {wide && <View style={[s.side, s.sideWide]}>{side}</View>}
        </View>
      )}
    </Screen>
  );
}

const s = StyleSheet.create({
  detail: { gap: space.xxl },
  detailWide: { flexDirection: 'row', alignItems: 'flex-start' },
  main: { flex: 1.5 },
  side: { gap: space.xxl },
  sideWide: { flex: 1 },
});
