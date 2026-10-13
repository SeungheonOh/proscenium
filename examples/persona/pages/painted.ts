/** Calls CALLBACK once what the page shows now has been drawn; returns a cancel function. */
export function afterPaint(callback: () => void): () => void {
  let frame = requestAnimationFrame(() => {
    frame = requestAnimationFrame(callback);
  });
  return () => cancelAnimationFrame(frame);
}
