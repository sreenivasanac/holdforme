// Web: the document title of a page.

/** Sets the browser tab title while a page is shown; returns a function that puts the old title back. */
export function setTitle(title: string): () => void {
  const old = document.title;
  document.title = title;
  return () => {
    document.title = old;
  };
}
