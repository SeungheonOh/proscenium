/** A 16×16 single-path icon in the current text color. */
export function Icon({ path }: { path: string }) {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
      <path d={path} />
    </svg>
  );
}

export const icons = {
  previous: "M4 3h1.6v10H4zM13 3.2v9.6L6.4 8z",
  next: "M10.4 3H12v10h-1.6zM3 3.2v9.6L9.6 8z",
  play: "M5.2 2.8l8 5.2-8 5.2z",
  pause: "M4.5 3h2.6v10H4.5zM8.9 3h2.6v10H8.9z",
};
