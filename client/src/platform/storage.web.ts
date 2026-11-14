// Web storage.

/** Removes the API key that older console versions kept in localStorage (sign-in is now a cookie session). */
export function forgetOldKey() {
  try {
    localStorage.removeItem('callenvoy.apiKey');
  } catch {
    // storage blocked: nothing kept there either
  }
}

/** A small value kept on this device (null when storage is blocked or the value is not set). */
export function loadLocal(key: string): string | null {
  try {
    return localStorage.getItem(`callenvoy.${key}`);
  } catch {
    return null;
  }
}

export function saveLocal(key: string, value: string) {
  try {
    localStorage.setItem(`callenvoy.${key}`, value);
  } catch {
    // storage blocked: the value lasts until the page reloads
  }
}
