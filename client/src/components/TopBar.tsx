import { usePathname } from 'expo-router';
import { Pressable, StyleSheet, Text, View, type PressableStateCallbackType } from 'react-native';
import { useGo } from '../hooks';
import { border, color, font, radius, space, useWide } from '../theme';
import { Button, text } from './ui';

/** App name, screen links and New call. */
export function TopBar() {
  const wide = useWide();
  const path = usePathname();
  const go = useGo();
  const nav = (href: string, label: string) => {
    const on = href === '/' ? path === '/' || path.startsWith('/calls') : path.startsWith(href);
    return (
      <Pressable
        role="link"
        aria-current={on ? 'page' : undefined}
        onPress={() => go(href)}
        style={[s.link, wide && s.linkWide, on && s.on]}
      >
        {(st: PressableStateCallbackType & { hovered?: boolean }) => (
          <Text style={[s.linkText, !wide && s.linkTextNarrow, (on || st.hovered) && s.linkTextOn]}>{label}</Text>
        )}
      </Pressable>
    );
  };

  return (
    <View style={[s.bar, wide && s.barWide]} role="banner">
      <Text style={[text.brand, s.brand, !wide && s.brandNarrow]} numberOfLines={1}>
        CallEnvoy
      </Text>
      <View style={[s.nav, wide && s.navWide]} role="navigation" aria-label="Console">
        {nav('/', 'Calls')}
        {nav('/agents', 'Agents')}
        {nav('/settings', 'Settings')}
      </View>
      <View>
        <Button label="New call" size="small" onPress={() => go('/new')} />
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    padding: space.ml,
    borderBottomWidth: border.thin,
    borderBottomColor: color.line,
    backgroundColor: color.topbar,
  },
  barWide: { paddingVertical: space.l, paddingHorizontal: space.x4, gap: space.ml },
  brand: { flexShrink: 1, minWidth: 0 }, // on the smallest phones the name is cut, not the links
  brandNarrow: { fontSize: font.size.body },
  nav: { flexDirection: 'row', alignItems: 'center', flexGrow: 1 },
  navWide: { gap: space.xs, justifyContent: 'flex-end' },
  link: { paddingVertical: space.sm, paddingHorizontal: space.sm, borderRadius: radius.m },
  linkWide: { paddingHorizontal: space.ml },
  on: { backgroundColor: color.selected },
  linkText: { color: color.muted, fontWeight: font.weight.semi, fontSize: font.size.base },
  linkTextNarrow: { fontSize: font.size.m },
  linkTextOn: { color: color.white },
});
