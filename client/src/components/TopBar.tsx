import { router, usePathname } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View, type PressableStateCallbackType } from 'react-native';
import { useCalls, useSession } from '../hooks';
import { border, color, font, radius, space, useWide } from '../theme';
import { Button, Sheet, T, text } from './ui';

/** App name, screen links and Sign out (asks first when a call is live). */
export function TopBar() {
  const wide = useWide();
  const path = usePathname();
  const signOut = useSignOut();

  const nav = (href: '/' | '/settings', label: string) => {
    const on = href === '/' ? path === '/' || path.startsWith('/calls') || path === '/new' : path.startsWith(href);
    return (
      <Pressable
        role="link"
        aria-current={on ? 'page' : undefined}
        onPress={() => router.push(href)}
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
      <Text style={[text.brand, !wide && s.brandNarrow]}>CallEnvoy</Text>
      <View style={[s.nav, wide && s.navWide]} role="navigation" aria-label="Console">
        {nav('/', 'Calls')}
        {nav('/settings', 'Settings')}
        <Pressable role="button" onPress={signOut.request} style={[s.link, wide && s.linkWide]}>
          {(st: PressableStateCallbackType & { hovered?: boolean }) => (
            <Text style={[s.linkText, !wide && s.linkTextNarrow, st.hovered && s.linkTextOn]}>Sign out</Text>
          )}
        </Pressable>
      </View>
      {signOut.sheet}
    </View>
  );
}

/** Sign out, asking first when a call is live. Returns the action and its confirmation sheet. */
export function useSignOut() {
  const { signOut } = useSession();
  const { calls } = useCalls();
  const [confirm, setConfirm] = useState(false);
  const live = calls?.some((c) => !c.finished);
  return {
    request: () => (live ? setConfirm(true) : signOut()),
    sheet: (
      <Sheet title="Sign out while a call is live?" visible={confirm} onClose={() => setConfirm(false)}>
        <T v="soft">The call goes on. You will not get alerts in this browser until you sign in again.</T>
        <Button label="Sign out" kind="danger" full onPress={signOut} />
        <Button label="Stay signed in" kind="secondary" full onPress={() => setConfirm(false)} />
      </Sheet>
    ),
  };
}

const s = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.ml,
    padding: space.ml,
    borderBottomWidth: border.thin,
    borderBottomColor: color.line,
    backgroundColor: color.topbar,
  },
  barWide: { paddingVertical: space.l, paddingHorizontal: space.x4 },
  brandNarrow: { fontSize: font.size.body },
  nav: { flexDirection: 'row', alignItems: 'center' },
  navWide: { gap: space.xs },
  link: { paddingVertical: space.sm, paddingHorizontal: space.m, borderRadius: radius.m },
  linkWide: { paddingHorizontal: space.ml },
  on: { backgroundColor: color.selected },
  linkText: { color: color.muted, fontWeight: font.weight.semi, fontSize: font.size.base },
  linkTextNarrow: { fontSize: font.size.m },
  linkTextOn: { color: color.white },
});
