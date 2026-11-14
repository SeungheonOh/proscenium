// Requests from a page answered by the world, for answers larger than props
// can carry: a page's props reach it in one compositor command of at most
// 60 kB. (A page cannot fetch from a server on the loopback instead: Chromium
// holds requests from its origin to local addresses for a permission prompt
// that a page in the compositor has nowhere to show.)
//
// The page sends `request` {id, action, args}; the world gzips the answer's
// JSON, base64-encodes it and hands it over as the `reply` prop one part at a
// time, each part acknowledged with `ack` {id, part} before the next. A page
// that (re)loads sends `hello`, which drops whatever was on its way to it.
// The page's half is pages/code-viewer/channel.ts.

import { useRef, useState } from "react";
import { gzipSync } from "node:zlib";

/** One part of an answer, as the page receives it. */
export interface Reply {
  id: number;
  part: number;
  parts: number;
  data: string;
}

/** Base64 characters per part, well inside a command with the page's other props. */
const partSize = 40_000;

interface Pending {
  id: number;
  parts: string[];
  part: number;
}

function encode(value: unknown): string[] {
  const data = gzipSync(Buffer.from(JSON.stringify(value) ?? "null")).toString("base64");
  const parts: string[] = [];
  for (let at = 0; at < data.length || parts.length === 0; at += partSize) parts.push(data.slice(at, at + partSize));
  return parts;
}

/**
 * Answers a page's requests with HANDLE. Spread `reply` into the page's props
 * and pass its messages to `onMessage`, which says whether it took them.
 */
export function usePageChannel(handle: (action: string, args: Record<string, unknown>) => Promise<unknown>) {
  const [reply, setReply] = useState<Reply | null>(null);
  const queue = useRef<Pending[]>([]);
  const sending = useRef<Pending | null>(null);
  const handler = useRef(handle);
  handler.current = handle;

  function show(pending: Pending) {
    setReply({ id: pending.id, part: pending.part, parts: pending.parts.length, data: pending.parts[pending.part] });
  }

  function pump() {
    if (sending.current) return;
    const next = queue.current.shift();
    if (!next) return;
    sending.current = next;
    show(next);
  }

  function onMessage(name: string, value: unknown): boolean {
    if (name === "hello") {
      queue.current = [];
      sending.current = null;
      setReply(null);
      return true;
    }
    if (name === "request") {
      const { id, action, args } = value as { id: number; action: string; args: Record<string, unknown> };
      handler.current(action, args).then(
        (answer) => ({ answer }),
        (error: Error) => ({ error: error.message }),
      ).then((result) => {
        queue.current.push({ id, parts: encode(result), part: 0 });
        pump();
      });
      return true;
    }
    if (name === "ack") {
      const { id, part } = value as { id: number; part: number };
      const current = sending.current;
      if (!current || current.id !== id || current.part !== part) return true;
      current.part++;
      if (current.part < current.parts.length) show(current);
      else {
        sending.current = null;
        pump();
      }
      return true;
    }
    return false;
  }

  return { reply, onMessage };
}
