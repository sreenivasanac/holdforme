// Web: in-page jumps (Settings section list, product page).

/** Scrolls to the element with this nativeID and moves keyboard focus to it, or to the element `focusId` inside it. */
export function scrollToId(id: string, focusId = id) {
  const el = document.getElementById(id);
  const target = document.getElementById(focusId);
  if (!el || !target) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  if (target.tabIndex < 0) target.tabIndex = -1; // a section can take focus; a field keeps its place in the tab order
  target.focus({ preventScroll: true });
}
