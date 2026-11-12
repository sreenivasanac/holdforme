// Recording player: play/pause, a seek bar (drag, click or arrow keys), current / total time. No speed, no skip buttons.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Linking, StyleSheet, Text, View, type GestureResponderEvent } from 'react-native';
import { duration as fmt } from '../format';
import { openPlayer, type Player } from '../platform/audio';
import { border, color, font, radius, seekBar, space } from '../theme';
import { Button, Note, T } from './ui';

const KEY_STEP = 5; // seconds per arrow key
const PAGE_STEP = 30; // seconds per Page Up / Page Down

export type PlayerControl = {
  time: number;
  duration: number;
  playing: boolean;
  loading: boolean;
  error: boolean;
  toggle: () => void;
  /** Moves to `t` seconds; `play` starts playing from there. */
  seek: (t: number, play?: boolean) => void;
};

/** One recording. `knownDuration` (from the server) shows until the file says its own length. */
export function usePlayer(url: string, knownDuration: number): PlayerControl {
  const [time, setTime] = useState(0);
  const [length, setLength] = useState(knownDuration);
  const [playing, setPlaying] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const player = useRef<Player | null>(null);
  useEffect(() => {
    const p = openPlayer(url, { onTime: setTime, onDuration: setLength, onPlaying: setPlaying, onLoading: setLoading, onError: () => setError(true) });
    player.current = p;
    return () => p.close();
  }, [url]);
  return useMemo(() => {
    const play = () => {
      setError(false);
      player.current?.play();
    };
    return {
      time,
      duration: length,
      playing,
      loading,
      error,
      toggle: () => (playing ? player.current?.pause() : play()),
      seek: (t, andPlay) => {
        player.current?.seek(Math.max(0, Math.min(length, t)));
        if (andPlay && !playing) play();
      },
    };
  }, [time, length, playing, loading, error]);
}

export function RecordingPlayer({ player, url }: { player: PlayerControl; url: string }) {
  const p = player;
  return (
    <View style={s.box}>
      <View style={s.row}>
        <Button
          label={p.playing ? 'Pause' : 'Play'}
          a11yLabel={p.playing ? 'Pause recording' : 'Play recording'}
          size="small"
          busy={p.loading}
          onPress={p.toggle}
        />
        <SeekBar time={p.time} duration={p.duration} onSeek={(t) => p.seek(t)} />
        <Text style={s.time} aria-hidden>
          {fmt(p.time)} / {fmt(p.duration)}
        </Text>
      </View>
      {p.error ? (
        <View style={s.row}>
          <View style={s.fill}>
            <Note kind="errsum">The recording could not be loaded. Try again.</Note>
          </View>
          <View>
            <Button label="Try again" kind="secondary" size="small" onPress={p.toggle} />
          </View>
        </View>
      ) : (
        <View style={s.row}>
          <T v="fine">{p.loading ? 'Loading the recording...' : 'Both sides of the call'}</T>
          <Button label="Download mp3" kind="link" onPress={() => void Linking.openURL(url)} />
        </View>
      )}
    </View>
  );
}

/** Slider: drag or click the track, or use the arrow keys, Page Up/Down, Home and End. */
function SeekBar({ time, duration, onSeek }: { time: number; duration: number; onSeek: (t: number) => void }) {
  const [drag, setDrag] = useState<number | null>(null);
  const width = useRef(1);
  const left = useRef(0);
  const at = (e: GestureResponderEvent) => Math.max(0, Math.min(1, (e.nativeEvent.pageX - left.current) / width.current)) * duration;
  const shown = drag ?? time;
  const pct = `${duration ? Math.min(100, (shown / duration) * 100) : 0}%` as const;
  const keys: Record<string, number> = {
    ArrowLeft: time - KEY_STEP,
    ArrowDown: time - KEY_STEP,
    ArrowRight: time + KEY_STEP,
    ArrowUp: time + KEY_STEP,
    PageDown: time - PAGE_STEP,
    PageUp: time + PAGE_STEP,
    Home: 0,
    End: duration,
  };
  return (
    <View
      role="slider"
      focusable
      aria-label="Position in the recording"
      aria-valuemin={0}
      aria-valuemax={Math.round(duration)}
      aria-valuenow={Math.round(shown)}
      aria-valuetext={`${fmt(shown)} of ${fmt(duration)}`}
      style={s.seek}
      onLayout={(e) => (width.current = e.nativeEvent.layout.width || 1)}
      onStartShouldSetResponder={() => true}
      onMoveShouldSetResponder={() => true}
      onResponderTerminationRequest={() => false}
      onResponderGrant={(e) => {
        left.current = e.nativeEvent.pageX - e.nativeEvent.locationX;
        setDrag(at(e));
      }}
      onResponderMove={(e) => setDrag(at(e))}
      onResponderRelease={(e) => {
        onSeek(at(e));
        setDrag(null);
      }}
      onResponderTerminate={() => setDrag(null)}
      {...({
        onKeyDown: (e: KeyboardEvent) => {
          if (!(e.key in keys)) return;
          e.preventDefault(); // no page scroll
          onSeek(keys[e.key]);
        },
      } as object)}
    >
      <View style={s.track} pointerEvents="none">
        <View style={[s.done, { width: pct }]} />
      </View>
      <View style={[s.thumb, { left: pct }]} pointerEvents="none" />
    </View>
  );
}

const s = StyleSheet.create({
  box: { gap: space.sm, userSelect: 'none' }, // dragging the seek bar must not select text
  row: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: space.ml },
  fill: { flex: 1 },
  time: { color: color.soft, fontSize: font.size.m, fontVariant: ['tabular-nums'] },
  seek: { flex: 1, minWidth: seekBar.minWidth, height: seekBar.hit, justifyContent: 'center', cursor: 'pointer' },
  track: { height: seekBar.track, borderRadius: radius.pill, backgroundColor: color.line, overflow: 'hidden' },
  done: { height: '100%', backgroundColor: color.brand },
  thumb: {
    position: 'absolute',
    width: seekBar.thumb,
    height: seekBar.thumb,
    marginLeft: -seekBar.thumb / 2,
    borderRadius: radius.pill,
    backgroundColor: color.fg,
    borderWidth: border.outline,
    borderColor: color.brand,
  },
});
