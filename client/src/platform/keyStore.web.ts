// Web: the API key lives in localStorage until Sign out (plan section 15).
// TODO: keyStore.native.ts with expo-secure-store for the native app.
const KEY = 'callenvoy.apiKey';

export function loadKey(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function saveKey(key: string) {
  localStorage.setItem(KEY, key);
}

export function clearKey() {
  localStorage.removeItem(KEY);
}
