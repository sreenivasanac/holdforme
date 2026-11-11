import { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View, type PressableStateCallbackType } from 'react-native';
import type { Voice } from '../api';
import { playUrl } from '../platform/audio';
import { border, color, font, radius, space } from '../theme';
import { Button, Field } from './ui';

/** Radio list of the voices, with a Play sample button per voice. */
export function VoicePicker({ label, voices, value, onChange, help }: { label: string; voices: Voice[]; value: string; onChange: (v: string) => void; help?: string }) {
  const [playing, setPlaying] = useState<string | null>(null);
  const stop = useRef<(() => void) | null>(null);
  useEffect(() => () => stop.current?.(), []);

  const play = (v: Voice) => {
    if (playing === v.name) return stop.current?.();
    setPlaying(v.name);
    stop.current = playUrl(v.sample_url, () => setPlaying((p) => (p === v.name ? null : p)));
  };

  const groups = [
    ['Standard', voices.filter((v) => !/indian/i.test(v.accent))],
    ['Indian English', voices.filter((v) => /indian/i.test(v.accent))],
  ] as const;

  return (
    <Field label={label} help={help}>
      <View role="radiogroup" aria-label={label} style={s.list}>
        {groups.map(([group, list]) =>
          list.length ? (
            <View key={group}>
              <Text style={s.group}>{group}</Text>
              {list.map((v) => {
                const on = v.name === value;
                const desc = [v.name, v.gender, /indian/i.test(v.accent) ? null : v.accent, v.style].filter(Boolean).join(' · ');
                return (
                  <View key={v.name} style={s.row}>
                    <Pressable
                      role="radio"
                      aria-checked={on}
                      onPress={() => onChange(v.name)}
                      style={(st: PressableStateCallbackType & { hovered?: boolean }) => [s.choice, on && s.on, !on && st.hovered && s.hover]}
                    >
                      <View style={[s.radio, on && s.radioOn]} aria-hidden />
                      <Text style={[s.text, on && s.textOn]}>
                        {desc}
                        {v.default ? ' (default)' : ''}
                      </Text>
                    </Pressable>
                    <Button
                      label={playing === v.name ? 'Stop' : 'Play sample'}
                      a11yLabel={playing === v.name ? `Stop ${v.name} sample` : `Play ${v.name} sample`}
                      kind="secondary"
                      size="small"
                      onPress={() => play(v)}
                    />
                  </View>
                );
              })}
            </View>
          ) : null,
        )}
      </View>
    </Field>
  );
}

const s = StyleSheet.create({
  list: { gap: space.sm },
  group: { color: color.muted, fontSize: font.size.s, fontWeight: font.weight.bold, marginVertical: space.xs },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.sm, marginBottom: space.xs },
  choice: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.m,
    paddingVertical: space.sm,
    paddingHorizontal: space.ml,
    borderRadius: radius.m,
    borderWidth: border.thin,
    borderColor: color.line,
    backgroundColor: color.card2,
  },
  on: { backgroundColor: color.selected, borderColor: color.brand },
  hover: { backgroundColor: color.card },
  radio: { width: space.l, height: space.l, borderRadius: radius.pill, borderWidth: border.outline, borderColor: color.muted },
  radioOn: { borderColor: color.brand, backgroundColor: color.brand },
  text: { flex: 1, color: color.soft, fontSize: font.size.m },
  textOn: { color: color.white },
});
