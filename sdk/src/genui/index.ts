// proscenium/genui: interfaces a model or a program writes as json-render specs
// (https://github.com/vercel-labs/json-render), drawn natively with
// proscenium/ui. A Surface holds a spec and its state and takes the JSON patches
// they stream; GeneratedView draws one; catalogPrompt() teaches a model the
// components it may use.

export { catalog, catalogPrompt, schema } from "./catalog.js";
export type { ComponentName } from "./catalog.js";
export { componentNames, GeneratedView, MarkdownView, ownStatePath } from "./render.js";
export type { ActionHandler, GeneratedViewProps } from "./render.js";
export { inlineMarkup, markdownBlocks } from "./markdown.js";
export type { InlineColors, MarkdownBlock } from "./markdown.js";
export { parsePointer, Surface, SurfaceState } from "./surface.js";
export type { JsonPatch, Spec, StateModel, UIElement } from "./surface.js";
