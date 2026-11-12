// Web storage.

/** Removes the API key that older console versions kept in localStorage (sign-in is now a cookie session). */
export function forgetOldKey() {
  try {
    localStorage.removeItem('callenvoy.apiKey');
  } catch {
    // storage blocked: nothing kept there either
  }
}
