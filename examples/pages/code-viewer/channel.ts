// The page's half of herdr/channel.ts: requests to the world, answered in
// gzipped, base64-encoded parts through the `reply` prop.

import { useEffect, useRef } from "react";
import { sendMessage } from "../shared.js";

export interface Reply {
  id: number;
  part: number;
  parts: number;
  data: string;
}

interface Waiting {
  parts: string[];
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

async function decode(data: string): Promise<unknown> {
  const bytes = Uint8Array.from(atob(data), (char) => char.charCodeAt(0));
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return JSON.parse(await new Response(stream).text());
}

/** A `request(action, args)` to the world; feed it the page's `reply` prop. */
export function useWorldChannel(reply: Reply | null | undefined) {
  const next = useRef(1);
  const waiting = useRef(new Map<number, Waiting>());

  // A page that (re)loads tells the world to forget what it was sending to the old one.
  useEffect(() => sendMessage({ name: "hello" }), []);

  useEffect(() => {
    if (!reply) return;
    const entry = waiting.current.get(reply.id);
    if (!entry) return;
    // Props come again on any re-render; take each part once.
    if (entry.parts.length === reply.part) entry.parts.push(reply.data);
    sendMessage({ name: "ack", value: { id: reply.id, part: reply.part } });
    if (entry.parts.length < reply.parts) return;
    waiting.current.delete(reply.id);
    decode(entry.parts.join("")).then((result) => {
      const { answer, error } = result as { answer?: unknown; error?: string };
      if (error !== undefined) entry.reject(new Error(error));
      else entry.resolve(answer);
    }, entry.reject);
  }, [reply?.id, reply?.part]);

  return function request<T>(action: string, args: Record<string, unknown>): Promise<T> {
    const id = next.current++;
    return new Promise<T>((resolve, reject) => {
      waiting.current.set(id, { parts: [], resolve: resolve as (value: unknown) => void, reject });
      sendMessage({ name: "request", value: { id, action, args } });
    });
  };
}
