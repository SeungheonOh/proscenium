import { iconFile, type ApplicationInfo } from "../lib/system/applications.js";

/** Colours for apps, picked by name, as TrellisWM tints a window too small to show. */
const palette = ["#3478f6", "#30b0c7", "#34c759", "#ff9f0a", "#ff453a", "#bf5af2", "#ff375f", "#64d2ff", "#5e5ce6", "#ac8e68"];

export interface AppLook {
  name: string;
  color: string;
  /** Its icon's file, or null. */
  icon: string | null;
}

/** The application APP ID belongs to, by its desktop entry where one matches. */
export function appLook(appId: string, applications: readonly ApplicationInfo[]): AppLook {
  const id = appId.toLowerCase();
  const entry = applications.find((application) => {
    const candidate = application.id.toLowerCase();
    return candidate === id || candidate.endsWith(`.${id}`) || application.name.toLowerCase() === id;
  });
  let hash = 0;
  for (const char of id || "?") hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return {
    name: entry?.name ?? appId,
    color: palette[Math.abs(hash) % palette.length]!,
    icon: iconFile(entry?.icon ?? appId),
  };
}
