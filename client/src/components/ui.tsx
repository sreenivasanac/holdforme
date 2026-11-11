// Small shared UI parts. All values come from theme.ts.
import { type ReactNode, useId } from 'react';
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
  type PressableStateCallbackType,
  type StyleProp,
  type TextInputProps,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import type { Tone } from '../format';
import { AlertBanner } from './AlertBanner';
import { border, color, disabledOpacity, font, gateWidth, lineHeight, maxContent, meter, pressedOpacity, radius, space, useWide } from '../theme';

// react-native-web also reports hover and focus in the Pressable state.
type PressState = PressableStateCallbackType & { hovered?: boolean };

/** Scrolling page body: centred column, max 1000 px. */
export function Screen({ children }: { children: ReactNode }) {
  const wide = useWide();
  return (
    <ScrollView style={s.fill} contentContainerStyle={[s.main, wide && s.mainWide]}>
      <AlertBanner />
      {children}
    </ScrollView>
  );
}

/** Centred narrow card for the sign-in gate. */
export function Gate({ children }: { children: ReactNode }) {
  return (
    <ScrollView style={s.fill} contentContainerStyle={s.gate}>
      <View style={[s.card, s.stack, s.gateCard]}>{children}</View>
    </ScrollView>
  );
}

export function Card({ children, style, label }: { children: ReactNode; style?: StyleProp<ViewStyle>; label?: string }) {
  return (
    <View style={[s.card, style]} role={label ? 'region' : undefined} aria-label={label}>
      {children}
    </View>
  );
}

/** Vertical stack with the standard 14 px gap. */
export function Stack({ children, gap = space.l, style }: { children: ReactNode; gap?: number; style?: StyleProp<ViewStyle> }) {
  return <View style={[{ gap }, style]}>{children}</View>;
}

/** Side by side on wide screens, stacked below 768 px. */
export function Row({ children }: { children: ReactNode }) {
  const wide = useWide();
  return <View style={[s.row, wide && s.rowWide]}>{children}</View>;
}

/** Equal-width cell inside a Row. */
export function Cell({ children }: { children: ReactNode }) {
  const wide = useWide();
  return <View style={wide ? s.fill : undefined}>{children}</View>;
}

type TVariant = keyof typeof text;

export function T({
  children,
  v = 'body',
  style,
  id,
}: {
  children: ReactNode;
  v?: TVariant;
  style?: StyleProp<TextStyle>;
  id?: string;
}) {
  const heading = v === 'h1' ? 1 : v === 'h2' ? 2 : v === 'h3' ? 3 : undefined;
  return (
    <Text
      nativeID={id}
      style={[text[v], style]}
      role={heading ? 'heading' : v === 'err' ? 'alert' : undefined}
      aria-level={heading}
    >
      {children}
    </Text>
  );
}

type Kind = 'primary' | 'secondary' | 'danger' | 'go' | 'link' | 'dark' | 'outline';

export function Button({
  label,
  onPress,
  kind = 'primary',
  size,
  disabled,
  busy,
  a11yLabel,
  pressed,
  expanded,
  full,
}: {
  label: string;
  onPress?: () => void;
  kind?: Kind;
  size?: 'small' | 'big';
  disabled?: boolean;
  busy?: boolean;
  a11yLabel?: string;
  pressed?: boolean; // toggle buttons (aria-pressed)
  expanded?: boolean; // disclosure buttons (aria-expanded)
  full?: boolean;
}) {
  const off = disabled || busy;
  return (
    <Pressable
      onPress={off ? undefined : onPress}
      role="button"
      aria-label={a11yLabel}
      aria-disabled={off}
      aria-busy={busy}
      aria-pressed={pressed}
      aria-expanded={expanded}
      style={(st: PressState) => [
        s.btn,
        btn[kind],
        size === 'small' && s.btnSmall,
        size === 'big' && s.btnBig,
        full && s.btnFull,
        (st.pressed || st.hovered) && !off && kind !== 'link' && s.btnActive,
        off && s.btnOff,
      ]}
    >
      <Text style={[s.btnText, btnText[kind], size === 'small' && s.btnTextSmall, size === 'big' && s.btnTextBig]}>{label}</Text>
    </Pressable>
  );
}

/** A text link that runs an action (navigation is done by the caller). */
export function TextLink({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable role="link" onPress={onPress}>
      <Text style={text.link}>{label}</Text>
    </Pressable>
  );
}

export function Pill({ label, tone = 'neutral', live }: { label: string; tone?: Tone; live?: boolean }) {
  return (
    <View style={[s.pill, pill[tone]]}>
      {live && <View style={[s.dot, tone === 'ok' && s.dotOnOk]} aria-hidden />}
      <Text style={[s.pillText, pillText[tone]]}>{label}</Text>
    </View>
  );
}

export function LiveDot() {
  return <View style={s.dot} aria-hidden />;
}

type NoteKind = 'hint' | 'warn' | 'saved' | 'errsum' | 'blocked';

/** Boxed message: hint (blue edge), warn, saved (green), error summary, blocked (red). */
export function Note({ kind, children, title }: { kind: NoteKind; children?: ReactNode; title?: string }) {
  const role = kind === 'saved' ? 'status' : kind === 'errsum' || kind === 'blocked' ? 'alert' : undefined;
  return (
    <View style={[s.note, note[kind]]} role={role}>
      {title ? <Text style={[s.noteText, noteText[kind], s.bold, kind === 'blocked' && { color: color.err }]}>{title}</Text> : null}
      {typeof children === 'string' ? <Text style={[s.noteText, noteText[kind]]}>{children}</Text> : children}
    </View>
  );
}

/** Numbered steps inside a Note or Sheet. */
export function Steps({ items, tone = 'soft' }: { items: string[]; tone?: 'soft' | 'blocked' }) {
  return (
    <View style={s.steps}>
      {items.map((it, i) => (
        <Text key={i} style={[text.base, { color: tone === 'blocked' ? color.blockedInk : color.soft }]}>
          {i + 1}. {it}
        </Text>
      ))}
    </View>
  );
}

/** "Microphone blocked." with the steps to allow it; `again` is the last step. */
export function MicBlocked({ what, again }: { what: string; again: string }) {
  return (
    <Note kind="blocked" title="Microphone blocked.">
      <Text style={[text.base, { color: color.blockedInk }]}>{what}</Text>
      <Steps tone="blocked" items={['Click the lock icon next to the address.', 'Set Microphone to Allow.', again]} />
    </Note>
  );
}

/** Label, control, help text and an error that is announced next to the field. */
export function Field({
  label,
  optional,
  help,
  error,
  children,
  labelId,
}: {
  label: string;
  optional?: boolean;
  help?: ReactNode;
  error?: string | null;
  children: ReactNode;
  labelId?: string;
}) {
  return (
    <View>
      <Text nativeID={labelId} style={text.label}>
        {label}
        {optional ? <Text style={s.optional}> (optional)</Text> : null}
      </Text>
      {children}
      {error ? (
        <Text role="alert" style={[text.err, s.fieldMsg]}>
          {error}
        </Text>
      ) : help ? (
        <Text style={[text.fine, s.fieldMsg]}>{help}</Text>
      ) : null}
    </View>
  );
}

export function TextField({
  label,
  optional,
  help,
  error,
  rows,
  numeric,
  ...input
}: { label: string; optional?: boolean; help?: ReactNode; error?: string | null; rows?: number; numeric?: boolean } & TextInputProps) {
  return (
    <Field label={label} optional={optional} help={help} error={error}>
      <TextInput
        aria-label={label}
        aria-invalid={error ? true : undefined}
        placeholderTextColor={color.muted}
        multiline={!!rows}
        numberOfLines={rows}
        inputMode={numeric ? 'numeric' : input.inputMode}
        style={[s.input, rows ? { minHeight: rows * font.size.body * lineHeight + 2 * space.m } : null, error ? s.inputBad : null]}
        {...input}
      />
    </Field>
  );
}

/** Choice of 2-3 values, as a radio group. */
export function Segmented<V extends string>({
  label,
  value,
  options,
  onChange,
  help,
  error,
  disabled = [],
}: {
  label: string;
  value: V;
  options: readonly (readonly [V, string])[];
  onChange: (v: V) => void;
  help?: ReactNode;
  error?: ReactNode;
  disabled?: readonly V[];
}) {
  return (
    <Field label={label} help={help}>
      <View role="radiogroup" aria-label={label} style={[s.seg, error ? s.inputBad : null]}>
        {options.map(([v, text]) => {
          const on = v === value;
          const off = disabled.includes(v);
          return (
            <Pressable
              key={v}
              role="radio"
              aria-checked={on}
              aria-disabled={off}
              onPress={off ? undefined : () => onChange(v)}
              style={(st: PressState) => [s.segBtn, on && s.segOn, !on && !off && st.hovered && s.segHover, off && s.btnOff]}
            >
              <Text style={[s.segText, on && s.segTextOn]}>{text}</Text>
            </Pressable>
          );
        })}
      </View>
      {error}
    </Field>
  );
}

/** On/off setting with a title and a short line of help. */
export function SwitchRow({
  title,
  help,
  value,
  onChange,
  disabled,
}: {
  title: string;
  help?: string;
  value: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <View style={s.lineRow}>
      <View style={s.fill}>
        <Text style={[text.body, s.semi]}>{title}</Text>
        {help ? <Text style={text.fine}>{help}</Text> : null}
      </View>
      <Switch
        role="switch"
        aria-label={title}
        aria-checked={value}
        value={value}
        onValueChange={onChange}
        disabled={disabled}
        trackColor={{ false: color.secondary, true: color.brand }}
        thumbColor={color.fg}
        // react-native-web: colour of the thumb when on
        {...({ activeThumbColor: color.fg } as object)}
      />
    </View>
  );
}

/** A labelled status line with something on the right (a pill or a small button). */
export function StatusLine({ title, help, right }: { title: string; help?: string; right?: ReactNode }) {
  return (
    <View style={s.lineRow}>
      <View style={s.fill}>
        <Text style={[text.body, s.semi]}>{title}</Text>
        {help ? <Text style={text.fine}>{help}</Text> : null}
      </View>
      {right}
    </View>
  );
}

/** Bottom sheet dialog (permission explainers, confirmations). */
export function Sheet({ title, visible, onClose, children }: { title: string; visible: boolean; onClose: () => void; children: ReactNode }) {
  const id = useId();
  const wide = useWide();
  return (
    <Modal transparent visible={visible} onRequestClose={onClose} animationType="none">
      <View style={[s.scrim, wide && s.scrimWide]}>
        <View style={[s.sheet, wide && s.sheetWide]} role="dialog" aria-modal aria-labelledby={id}>
          <T v="h2" id={id} style={s.noMargin}>
            {title}
          </T>
          {children}
        </View>
      </View>
    </Modal>
  );
}

/** Ten bars that light up with the audio level (0..1). */
export function AudioMeter({ level, label }: { level: number; label: string }) {
  const heights = meter.bars;
  const on = Math.round(Math.min(1, level) * heights.length);
  return (
    <View style={s.meterRow}>
      <View style={s.meter} aria-hidden>
        {heights.map((h, i) => (
          <View key={i} style={[s.bar, { height: h }, i < on && s.barOn]} />
        ))}
      </View>
      <Text style={[text.m, { color: color.soft }]}>{label}</Text>
    </View>
  );
}

export const text = StyleSheet.create({
  h1: { color: color.fg, fontSize: font.size.h1, fontWeight: font.weight.bold, marginBottom: space.ml },
  h2: { color: color.fg, fontSize: font.size.h2, fontWeight: font.weight.bold, marginBottom: space.ml },
  h3: { color: color.fg, fontSize: font.size.h3, fontWeight: font.weight.bold },
  body: { color: color.fg, fontSize: font.size.body, lineHeight: font.size.body * lineHeight },
  base: { color: color.fg, fontSize: font.size.base, lineHeight: font.size.base * lineHeight },
  m: { color: color.fg, fontSize: font.size.m },
  soft: { color: color.soft, fontSize: font.size.body, lineHeight: font.size.body * lineHeight },
  muted: { color: color.muted, fontSize: font.size.body, lineHeight: font.size.body * lineHeight },
  fine: { color: color.muted, fontSize: font.size.s },
  label: { color: color.muted, fontSize: font.size.s, marginBottom: space.xs },
  err: { color: color.err, fontSize: font.size.m },
  link: { color: color.link, fontSize: font.size.base, textDecorationLine: 'underline' },
  mono: { color: color.soft, fontSize: font.size.s, fontFamily: font.mono },
  brand: { color: color.link, fontSize: font.size.h2, fontWeight: font.weight.heavy, letterSpacing: font.tracking.brand },
  subhead: { color: color.muted, fontSize: font.size.s, fontWeight: font.weight.bold, textTransform: 'uppercase', letterSpacing: font.tracking.subhead, marginTop: space.sm },
});

const s = StyleSheet.create({
  fill: { flex: 1 },
  main: { width: '100%', maxWidth: maxContent, alignSelf: 'center', paddingHorizontal: space.xl, paddingTop: space.x3, paddingBottom: space.x5, gap: space.xxl },
  mainWide: { paddingTop: space.x4 },
  gate: { flexGrow: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: space.x3, paddingHorizontal: space.xl },
  gateCard: { width: '100%', maxWidth: gateWidth },
  card: { backgroundColor: color.card, borderWidth: border.thin, borderColor: color.line, borderRadius: radius.xl, padding: space.xxl },
  stack: { gap: space.l },
  row: { gap: space.l },
  rowWide: { flexDirection: 'row' },
  btn: { borderRadius: radius.m, paddingVertical: space.input, paddingHorizontal: space.btn, alignItems: 'center', justifyContent: 'center', alignSelf: 'flex-start' },
  btnSmall: { paddingVertical: space.s, paddingHorizontal: space.ml },
  btnBig: { padding: space.l, alignSelf: 'stretch' },
  btnFull: { alignSelf: 'stretch' },
  btnActive: { opacity: pressedOpacity },
  btnOff: { opacity: disabledOpacity },
  btnText: { fontSize: font.size.body, fontWeight: font.weight.semi },
  btnTextSmall: { fontSize: font.size.m },
  btnTextBig: { fontSize: font.size.l },
  pill: { flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start', maxWidth: '100%', paddingVertical: space.xs, paddingHorizontal: space.ml, borderRadius: radius.pill },
  pillText: { fontSize: font.size.s, fontWeight: font.weight.bold, flexShrink: 1 },
  dot: { width: space.sm, height: space.sm, borderRadius: radius.pill, backgroundColor: color.ok, marginRight: space.s },
  dotOnOk: { backgroundColor: color.okInk },
  note: { borderRadius: radius.m, paddingVertical: space.m, paddingHorizontal: space.ml, gap: space.xs },
  noteText: { fontSize: font.size.base, lineHeight: font.size.base * lineHeight },
  bold: { fontWeight: font.weight.bold },
  semi: { fontWeight: font.weight.semi },
  steps: { gap: space.xxs, marginTop: space.s },
  optional: { color: color.muted, fontWeight: font.weight.normal },
  fieldMsg: { marginTop: space.s },
  input: {
    width: '100%',
    paddingVertical: space.input,
    paddingHorizontal: space.ml,
    borderRadius: radius.m,
    borderWidth: border.thin,
    borderColor: color.line,
    backgroundColor: color.card2,
    color: color.fg,
    fontSize: font.size.body,
  },
  inputBad: { borderColor: color.bad },
  seg: { flexDirection: 'row', gap: space.xs, padding: space.xs, backgroundColor: color.card2, borderWidth: border.thin, borderColor: color.line, borderRadius: radius.l },
  segBtn: { flex: 1, paddingVertical: space.seg, paddingHorizontal: space.m, borderRadius: radius.s, alignItems: 'center', justifyContent: 'center' },
  segOn: { backgroundColor: color.selected, borderWidth: border.thin, borderColor: color.brand },
  segHover: { backgroundColor: color.card },
  segText: { color: color.muted, fontSize: font.size.body, fontWeight: font.weight.semi, textAlign: 'center' },
  segTextOn: { color: color.white },
  lineRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.l, paddingVertical: space.ml, borderTopWidth: border.thin, borderTopColor: color.line },
  scrim: { flex: 1, backgroundColor: color.scrim, justifyContent: 'flex-end', padding: space.ml },
  scrimWide: { justifyContent: 'center', alignItems: 'center' },
  sheet: { width: '100%', backgroundColor: color.card, borderWidth: border.thin, borderColor: color.line, borderRadius: radius.xl, padding: space.xxl, gap: space.ml },
  sheetWide: { maxWidth: gateWidth },
  noMargin: { marginBottom: 0 },
  meterRow: { flexDirection: 'row', alignItems: 'center', gap: space.ml, backgroundColor: color.card2, borderWidth: border.thin, borderColor: color.line, borderRadius: radius.m, paddingVertical: space.m, paddingHorizontal: space.ml },
  meter: { flexDirection: 'row', alignItems: 'flex-end', gap: space.bar, height: meter.height },
  bar: { width: space.s, borderRadius: radius.bar, backgroundColor: color.line },
  barOn: { backgroundColor: color.ok },
});

const btn = StyleSheet.create({
  primary: { backgroundColor: color.brand },
  secondary: { backgroundColor: color.secondary },
  danger: { backgroundColor: color.danger },
  go: { backgroundColor: color.ok },
  link: { backgroundColor: 'transparent', paddingHorizontal: 0, paddingVertical: space.sm },
  dark: { backgroundColor: color.okInk },
  outline: { backgroundColor: 'transparent', borderWidth: border.outline, borderColor: color.okInk },
});
const btnText = StyleSheet.create({
  primary: { color: color.white },
  secondary: { color: color.white },
  danger: { color: color.white },
  go: { color: color.okInk },
  link: { color: color.link },
  dark: { color: color.white },
  outline: { color: color.okInk },
});
const pill = StyleSheet.create({
  neutral: { backgroundColor: color.secondary },
  ok: { backgroundColor: color.ok },
  bad: { backgroundColor: color.bad },
  info: { backgroundColor: color.infoBg },
  alert: { backgroundColor: color.ok },
});
const pillText = StyleSheet.create({
  neutral: { color: color.fg },
  ok: { color: color.okInk },
  bad: { color: color.fg },
  info: { color: color.infoInk },
  alert: { color: color.okInk },
});
const note = StyleSheet.create({
  hint: { backgroundColor: color.card2, borderLeftWidth: border.edge, borderLeftColor: color.brand, borderRadius: radius.s, paddingVertical: space.ml, paddingHorizontal: space.l },
  warn: { backgroundColor: color.card2, borderLeftWidth: border.edge, borderLeftColor: color.warn, borderRadius: radius.s, paddingVertical: space.ml, paddingHorizontal: space.l },
  saved: { backgroundColor: color.okSoft, borderWidth: border.thin, borderColor: color.okLine },
  errsum: { backgroundColor: color.errBg, borderWidth: border.thin, borderColor: color.danger },
  blocked: { backgroundColor: color.errBg, borderWidth: border.thin, borderColor: color.danger, borderRadius: radius.l, paddingHorizontal: space.l },
});
const noteText = StyleSheet.create({
  hint: { color: color.soft },
  warn: { color: color.soft, fontSize: font.size.m },
  saved: { color: color.fg },
  errsum: { color: color.err },
  blocked: { color: color.blockedInk },
});
