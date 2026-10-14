/**
 * Excalidraw's drawing fonts, served with the page. Excalidraw asks for its
 * fonts by URL, from a CDN unless told otherwise, so the page swaps in its own
 * copies as each FontFace is made: the drawing works offline and draws
 * straight away. The names carry the version's hashes; the package is pinned.
 */

import font1 from "../../../node_modules/@excalidraw/excalidraw/dist/prod/fonts/Excalifont/Excalifont-Regular-349fac6ca4700ffec595a7150a0d1e1d.woff2";
import font2 from "../../../node_modules/@excalidraw/excalidraw/dist/prod/fonts/Excalifont/Excalifont-Regular-3f2c5db56cc93c5a6873b1361d730c16.woff2";
import font3 from "../../../node_modules/@excalidraw/excalidraw/dist/prod/fonts/Excalifont/Excalifont-Regular-41b173a47b57366892116a575a43e2b6.woff2";
import font4 from "../../../node_modules/@excalidraw/excalidraw/dist/prod/fonts/Excalifont/Excalifont-Regular-623ccf21b21ef6b3a0d87738f77eb071.woff2";
import font5 from "../../../node_modules/@excalidraw/excalidraw/dist/prod/fonts/Excalifont/Excalifont-Regular-a88b72a24fb54c9f94e3b5fdaa7481c9.woff2";
import font6 from "../../../node_modules/@excalidraw/excalidraw/dist/prod/fonts/Excalifont/Excalifont-Regular-b9dcf9d2e50a1eaf42fc664b50a3fd0d.woff2";
import font7 from "../../../node_modules/@excalidraw/excalidraw/dist/prod/fonts/Excalifont/Excalifont-Regular-be310b9bcd4f1a43f571c46df7809174.woff2";
import font8 from "../../../node_modules/@excalidraw/excalidraw/dist/prod/fonts/Nunito/Nunito-Regular-XRXI3I6Li01BKofiOc5wtlZ2di8HDIkhdTA3j6zbXWjgevT5.woff2";
import font9 from "../../../node_modules/@excalidraw/excalidraw/dist/prod/fonts/Nunito/Nunito-Regular-XRXI3I6Li01BKofiOc5wtlZ2di8HDIkhdTQ3j6zbXWjgeg.woff2";
import font10 from "../../../node_modules/@excalidraw/excalidraw/dist/prod/fonts/Nunito/Nunito-Regular-XRXI3I6Li01BKofiOc5wtlZ2di8HDIkhdTk3j6zbXWjgevT5.woff2";
import font11 from "../../../node_modules/@excalidraw/excalidraw/dist/prod/fonts/Nunito/Nunito-Regular-XRXI3I6Li01BKofiOc5wtlZ2di8HDIkhdTo3j6zbXWjgevT5.woff2";
import font12 from "../../../node_modules/@excalidraw/excalidraw/dist/prod/fonts/Nunito/Nunito-Regular-XRXI3I6Li01BKofiOc5wtlZ2di8HDIkhdTs3j6zbXWjgevT5.woff2";
import font13 from "../../../node_modules/@excalidraw/excalidraw/dist/prod/fonts/ComicShanns/ComicShanns-Regular-279a7b317d12eb88de06167bd672b4b4.woff2";
import font14 from "../../../node_modules/@excalidraw/excalidraw/dist/prod/fonts/ComicShanns/ComicShanns-Regular-6e066e8de2ac57ea9283adb9c24d7f0c.woff2";
import font15 from "../../../node_modules/@excalidraw/excalidraw/dist/prod/fonts/ComicShanns/ComicShanns-Regular-dc6a8806fa96795d7b3be5026f989a17.woff2";
import font16 from "../../../node_modules/@excalidraw/excalidraw/dist/prod/fonts/ComicShanns/ComicShanns-Regular-fcb0fc02dcbee4c9846b3e2508668039.woff2";

const urls = [font1, font2, font3, font4, font5, font6, font7, font8, font9, font10, font11, font12, font13, font14, font15, font16];
/** Each copy by its file name, which is how Excalidraw names it in its URLs. */
const local = new Map(urls.map((url) => [url.replace(/^.*\/|-[A-Z0-9]{8}(\.woff2)$/g, "$1"), url]));

const Native = FontFace;
globalThis.FontFace = class extends Native {
  constructor(family: string, source: string | BufferSource, descriptors?: FontFaceDescriptors) {
    const file = typeof source === "string" ? /fonts\/[^/]+\/([^/)\s'"]+\.woff2)/.exec(source)?.[1] : undefined;
    const url = file && local.get(file);
    super(family, url ? `url(${url}) format('woff2')` : source, descriptors);
  }
};
