import { existsSync } from "node:fs";
import fetched from "./assets/.fetched?url";

/** Whether scripts/fetch-persona has fetched the art, video and fonts the pages are built from. */
export const assetsReady = existsSync(fetched);
