// Web: a focus-visible ring of its own (theme focusRing) for elements marked with dataSet={FOCUS_RING}.
// The default ring (index.html) is the brand colour, which the playing transcript line also uses.
import { focusRing } from '../theme';

const FOCUS_RING = { focus: 'ring' } as const;

function installFocusRing() {
  if (document.getElementById('ce-focus-ring')) return;
  const style = document.createElement('style');
  style.id = 'ce-focus-ring';
  const { color, width, offset } = focusRing;
  style.textContent = `[data-focus="ring"]:focus-visible { outline: ${width}px solid ${color} !important; outline-offset: ${offset}px; }`;
  document.head.appendChild(style);
}

/** Props for an element that gets the ring. The style is added to the page on first use. */
export function focusRingProps() {
  installFocusRing();
  return { dataSet: FOCUS_RING };
}
