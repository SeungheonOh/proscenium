// A director the compositor reads slower than it commits: commits wait and
// merge, so the compositor gets the latest scene and the director no backlog.
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createElement as h } from "react";
import { Group, Rect } from "../dist/components.js";
import { Container, createRoot, reconciler } from "../dist/host.js";
import { instant } from "../dist/motion.js";
import { Session } from "../dist/session.js";

const squares = (t, count = 3) => h(Group, null, Array.from({ length: count }, (_, i) =>
  h(Rect, { key: i, x: t * 10 + i, y: t, width: 12, height: 12, fill: "#3478f6", transition: instant })));

test("commits wait while the receiver is full, then go as one with the latest values", () => {
  const sent = [];
  let full = false;
  const container = new Container({ send: (ops) => { sent.push(ops); return !full; } });
  const root = createRoot(container, (error) => { throw error; });
  const render = (element) => {
    reconciler.updateContainerSync(element, root, null, null);
    reconciler.flushSyncWork();
    container.flush();
  };
  render(squares(0));
  full = true;
  render(squares(1));
  assert.equal(sent.length, 2, "the commit that fills the receiver is sent");
  render(squares(2));
  render(squares(3, 4));
  assert.equal(sent.length, 2, "later commits wait");
  full = false;
  container.resume();
  assert.equal(sent.length, 3, "what waited goes as one commit");
  assert.deepEqual(sent[2].map((op) => [op.op, op.id, op.props && { x: op.props.x, y: op.props.y }]), [
    ["set", 1, { x: 30, y: 3 }], ["set", 2, { x: 31, y: 3 }], ["set", 3, { x: 32, y: 3 }],
    ["create", 5, { x: 33, y: 3 }], ["insert", 5, undefined],
  ], "one set per node, with its latest values, and what was created meanwhile");
  container.resume();
  render(squares(3, 4));
  assert.equal(sent.length, 3, "nothing waits any more, and nothing changed");

  full = true;
  render(squares(4, 4));
  render(squares(5, 4));
  container.requestResync();
  container.flush();
  assert.equal(sent.length, 5);
  assert.ok(sent.at(-1).some((op) => op.op === "reset"), "a reconnect's replay waits for nothing");
});

test("a director the compositor cannot keep up with holds one commit, not a backlog", async () => {
  const path = join(tmpdir(), `prs-backpressure-${process.pid}.sock`);
  rmSync(path, { force: true });
  let compositor = null;
  let received = "";
  const server = createServer((socket) => {
    compositor = socket;
    socket.setEncoding("utf8");
    socket.once("data", () => {
      socket.write(JSON.stringify({ type: "welcome", protocol: 3, instance: "test", display: "wayland-test",
                                    outputs: [], windows: [], cameras: [], focus: [], shares: [], modifiers: [] })
                   + "\n");
      socket.on("data", (chunk) => { received += chunk; });
    });
  });
  await new Promise((resolve) => server.listen(path, resolve));
  const session = new Session({ socket: path, onError: (error) => { throw error; } });
  const until = async (condition) => {
    for (let tries = 0; !condition(); tries++) {
      assert.ok(tries < 500, "timed out");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };
  try {
    session.start();
    await until(() => session.connection.connected);
    const count = 2000;
    const frames = 25;
    session.render(squares(0, count));
    await until(() => received.includes('"op":"create"') && session.connection.socket.writableLength === 0);
    // Busy elsewhere: the compositor reads nothing more for now.
    compositor.pause();
    for (let frame = 1; frame < frames; frame++) {
      session.render(squares(frame, count));
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    // About 150 kB a commit: queued whole, these would be some 3.5 MB.
    const queued = session.connection.socket.writableLength;
    assert.ok(queued < 200_000, `the director holds ${queued} bytes`);

    compositor.resume();
    let scene = new Map();
    let commits = 0;
    await until(() => {
      const lines = received.split("\n");
      received = lines.pop();
      for (const line of lines) {
        const message = JSON.parse(line);
        if (message.type !== "commit") continue;
        commits++;
        for (const op of message.ops) {
          if (op.op === "reset") scene = new Map();
          if (op.op === "create" || op.op === "set") scene.set(op.id, { ...scene.get(op.id), ...op.props });
        }
      }
      return scene.size > 0 && [...scene.values()].every((node) => node.y === undefined || node.y === frames - 1);
    });
    assert.ok(commits < frames, `${commits} commits for ${frames} frames`);
    assert.equal([...scene.values()].filter((node) => node.y === frames - 1).length, count,
                 "the compositor ends with the latest scene");
  } finally {
    session.stop();
    server.close();
    rmSync(path, { force: true });
  }
});
