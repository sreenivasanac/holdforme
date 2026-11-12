// Design tokens, copied from the approved mockups' CSS (/code/.plans/designs, v6 globals.css).
// Use only these values in styles. One dark theme.
import { useWindowDimensions } from 'react-native';

export const color = {
  bg: '#0b1020',
  card: '#141a2e',
  card2: '#10162a',
  line: '#26304f',
  fg: '#e8ecf8',
  muted: '#8f99b8',
  soft: '#c5cde6', // secondary body text
  link: '#9fb6ff',
  brand: '#5b84ff',
  ok: '#22c55e',
  warn: '#f59e0b',
  bad: '#ef4444',
  info: '#38bdf8',
  white: '#ffffff',
  secondary: '#27315a', // secondary button, neutral pill, switch off
  danger: '#5a2330', // danger button, error box border
  selected: '#22306a', // selected tab / segmented choice
  err: '#ff8a8a',
  errBg: '#2a1418',
  blockedInk: '#ffd0d0',
  okInk: '#04210f', // text on green
  okSoft: '#0f2a1b', // saved box, alert panel, owner line
  okLine: '#1f6d40',
  okText: '#b8f0cd',
  infoBg: '#0f3b52',
  infoInk: '#bfe9ff',
  bubble: '#1b2340',
  bubbleAi: '#1e2f66',
  questionBg: '#2a2210',
  questionInk: '#ffe2a8',
  scrim: 'rgba(11,16,32,0.8)',
  topbar: 'rgba(11,16,32,0.6)',
} as const;

export const space = { xxs: 2, bar: 3, xs: 4, s: 6, sm: 8, seg: 9, m: 10, input: 11, ml: 12, l: 14, xl: 16, btn: 18, xxl: 20, x3: 24, x4: 32, x5: 48 } as const;

export const radius = { bar: 2, s: 8, m: 10, l: 12, xl: 16, pill: 999 } as const;

export const font = {
  size: { xs: 12, s: 13, m: 14, base: 15, body: 16, l: 17, xl: 18, h3: 16, big: 20, h2: 22, h1: 26 },
  weight: { normal: '400', semi: '600', bold: '700', heavy: '800' },
  mono: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  monoLineHeight: 1.5,
  tracking: { brand: 0.44, subhead: 0.52 }, // .02em of 22 px, .04em of 13 px
} as const;

export const lineHeight = 1.55;
export const border = { thin: 1, edge: 3, outline: 2 } as const;
export const meter = { height: 22, bars: [6, 12, 18, 10, 20, 14, 8, 16, 22, 12] } as const;
export const countdownHeight = 8;
export const callColumns = [2.4, 1.2, 0.5, 0.9] as const; // call list columns on wide screens: business, status, length, started
export const seekBar = { hit: 28, track: 6, thumb: 16, minWidth: 120 } as const; // recording seek bar
export const transcriptHeight = 460;
export const lineMaxWidth = '88%';
export const pressedOpacity = 0.85;
export const disabledOpacity = 0.5;
export const maxContent = 1000;
export const gateWidth = 420;
export const breakpoint = 768;

/** Wide layout (desktop) at 768 px and up, as in the mockups. */
export function useWide() {
  return useWindowDimensions().width >= breakpoint;
}
