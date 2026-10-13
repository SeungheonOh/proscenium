// Image imports and `?url` imports resolve to the file's absolute path; see the
// Stage runtime. Pages import their stylesheets.
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
declare module "*?url" {
  const path: string;
  export default path;
}
declare module "*.css";
