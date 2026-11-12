// Web: in-page jumps (Settings section list).

/** Scrolls to the element with this nativeID and moves keyboard focus to it. */
export function scrollToId(id: string) {
  const el = document.getElementById(id);
  if (!el) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  el.tabIndex = -1;
  el.focus({ preventScroll: true });
}
