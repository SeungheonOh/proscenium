// Image imports and `?url` imports resolve to the file's absolute path; see the
// Stage runtime. In a page, an imported image, font, video or sound is copied
// next to the page and resolves to its URL. Pages import their stylesheets.
declare module "*.png" {
  const path: string;
  export default path;
}
declare module "*.jpg" {
  const path: string;
  export default path;
}
declare module "*.jpeg" {
  const path: string;
  export default path;
}
declare module "*.webp" {
  const path: string;
  export default path;
}
declare module "*.gif" {
  const path: string;
  export default path;
}
declare module "*.svg" {
  const path: string;
  export default path;
}
declare module "*.webm" {
  const path: string;
  export default path;
}
declare module "*?url" {
  const path: string;
  export default path;
}
declare module "*.css";
