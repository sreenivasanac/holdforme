import { usePathname } from 'expo-router';
import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, useWindowDimensions, View, type PressableStateCallbackType } from 'react-native';
import { useGo, useSession } from '../hooks';
import { barBreakpoint, border, color, emailMaxWidth, font, radius, space, useWide } from '../theme';
import { Button, text } from './ui';

/** The bar at the top of every page: the app name, then `children` (on the right). `below`: a second row (phone widths). */
export function AppBar({ children, below }: { children: ReactNode; below?: ReactNode }) {
  const wide = useWide();
  return (
    <View style={[s.bar, wide && s.barWide]} role="banner">
      <View style={[s.row, wide && s.rowWide]}>
        <Text style={[text.brand, s.brand, !wide && s.brandNarrow]} numberOfLines={1}>
          CallEnvoy
        </Text>
        {children}
      </View>
      {below}
    </View>
  );
}

/** Console: screen links, who is signed in (wide screens), and New call. The admin also gets People. */
export function TopBar() {
  const wide = useWide();
  const roomy = useWindowDimensions().width >= barBreakpoint;
  const path = usePathname();
  const go = useGo();
  const { me } = useSession();
  const admin = !!me?.is_admin;
  const twoRows = admin && !wide; // four links and New call do not fit one phone-width row
  const link = (href: string, label: string) => {
    const on = href === '/' ? path === '/' || path.startsWith('/calls') : path.startsWith(href);
    return (
      <Pressable
        key={href}
        role="link"
        aria-current={on ? 'page' : undefined}
        onPress={() => go(href)}
        style={[s.link, wide && s.linkWide, twoRows && s.fill, on && s.on]}
      >
        {(st: PressableStateCallbackType & { hovered?: boolean }) => (
          <Text style={[s.linkText, !wide && s.linkTextNarrow, twoRows && s.center, (on || st.hovered) && s.linkTextOn]}>{label}</Text>
        )}
      </Pressable>
    );
  };
  const nav = (
    <View style={[s.nav, wide && s.navWide, twoRows && s.navRow]} role="navigation" aria-label="Console">
      {link('/', 'Calls')}
      {link('/agents', 'Agents')}
      {link('/settings', 'Settings')}
      {admin && link('/people', 'People')}
    </View>
  );

  return (
    <AppBar below={twoRows ? nav : null}>
      {twoRows ? <View style={s.fill} /> : nav}
      {roomy && me?.email ? (
        <View style={s.email}>
          <Text style={text.fine}>Signed in as</Text>
          <Text style={s.emailText} numberOfLines={1}>
            {me.email}
          </Text>
        </View>
      ) : null}
      <View>
        <Button label="New call" size="small" onPress={() => go('/new')} />
      </View>
    </AppBar>
  );
}

const s = StyleSheet.create({
  fill: { flex: 1 },
  bar: { padding: space.ml, gap: space.sm, borderBottomWidth: border.thin, borderBottomColor: color.line, backgroundColor: color.topbar },
  barWide: { paddingVertical: space.l, paddingHorizontal: space.x4 },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  rowWide: { gap: space.ml },
  brand: { flexShrink: 1, minWidth: 0 }, // on the smallest phones the name is cut, not the links
  brandNarrow: { fontSize: font.size.body },
  nav: { flexDirection: 'row', alignItems: 'center', flexGrow: 1 },
  navWide: { gap: space.xs, justifyContent: 'flex-end' },
  navRow: { gap: space.xs },
  link: { paddingVertical: space.sm, paddingHorizontal: space.sm, borderRadius: radius.m },
  linkWide: { paddingHorizontal: space.ml },
  on: { backgroundColor: color.selected },
  linkText: { color: color.muted, fontWeight: font.weight.semi, fontSize: font.size.base },
  linkTextNarrow: { fontSize: font.size.m },
  linkTextOn: { color: color.white },
  center: { textAlign: 'center' },
  email: { maxWidth: emailMaxWidth, paddingHorizontal: space.ml, borderLeftWidth: border.thin, borderLeftColor: color.line },
  emailText: { color: color.soft, fontSize: font.size.m },
});
