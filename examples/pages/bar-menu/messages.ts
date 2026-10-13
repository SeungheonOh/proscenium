import { sendMessage } from "../shared.js";

export type MediaCommand = "PlayPause" | "Next" | "Previous";

/** What the bar menu asks the world to do. */
export type BarMenuMessage =
  | { name: "volume"; value: number }
  | { name: "mute" }
  | { name: "media"; value: MediaCommand }
  | { name: "brightness"; value: number }
  | { name: "profile"; value: string }
  | { name: "clear" }
  | { name: "copy"; value: string }
  | { name: "close" };

export const sendBarMenuMessage: (message: BarMenuMessage) => void = sendMessage;
