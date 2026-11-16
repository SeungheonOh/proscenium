#!/usr/bin/env node
// The editable text keymaps, table by table: each case is a field with a starting text,
// the keys played into it (proscenium-drive commands) and the text it must end with.
// Movement is checked by typing a marker where the caret ends up. All cases run in one
// headless session (tests/shot.sh), one field each, and the world logs their texts.
//
//   node tests/edit-keys.mjs [OUTDIR]       (needs GPU device access, as shot.sh does)
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = resolve(process.argv[2] ?? join(root, "build/edit-keys"));
mkdirSync(out, { recursive: true });

// [name, keymap, multiline, text, keys, expected]. Keys run after a click in the field
// and Ctrl+End (the caret at the end); "home" is Ctrl+Home.
const E = "emacs", S = "standard";
const cases = [
  ["C-a line start", E, false, "hello world", ["chord ctrl+a", "type X"], "Xhello world"],
  ["C-e line end", E, false, "hello world", ["home", "chord ctrl+e", "type X"], "hello worldX"],
  ["C-b back", E, false, "hello world", ["chord ctrl+b", "chord ctrl+b", "type X"], "hello worXld"],
  ["C-f forward", E, false, "hello world", ["home", "chord ctrl+f", "chord ctrl+f", "type X"], "heXllo world"],
  ["M-b word back", E, false, "hello world", ["chord alt+b", "type X"], "hello Xworld"],
  ["M-f word forward", E, false, "hello world", ["home", "chord alt+f", "type X"], "helloX world"],
  ["C-p C-n lines", E, true, "ab\ncd\nef", ["chord ctrl+p", "chord ctrl+p", "type X", "chord ctrl+n", "type Y"],
   "abX\ncdY\nef"],
  ["M-< M-> ends", E, false, "abc", ["chord alt+shift+less", "type X", "chord alt+shift+greater", "type Y"], "XabcY"],
  ["C-d delete forward", E, false, "hello", ["home", "chord ctrl+d", "chord ctrl+d"], "llo"],
  ["C-h delete back", E, false, "hello", ["chord ctrl+h", "chord ctrl+h"], "hel"],
  ["M-d kill word", E, false, "hello world", ["home", "chord alt+d"], " world"],
  ["M-BackSpace kill word back", E, false, "hello world", ["chord alt+BackSpace"], "hello "],
  ["C-w kill word back", E, false, "hello world", ["chord ctrl+w"], "hello "],
  ["C-w kills the region", E, false, "hello world", ["home", "chord ctrl+space", "chord alt+f", "chord ctrl+w"],
   " world"],
  ["C-k kill line", E, false, "hello world", ["home", "chord alt+f", "chord ctrl+k"], "hello"],
  ["C-k at a line's end kills the break", E, true, "ab\ncd", ["home", "chord ctrl+e", "chord ctrl+k"], "abcd"],
  ["C-u kill to line start", E, false, "hello world", ["chord alt+b", "chord ctrl+u"], "world"],
  ["C-y yanks the kill", E, false, "hello world", ["home", "chord alt+d", "chord ctrl+e", "chord ctrl+y"],
   " worldhello"],
  ["kills in a row join", E, false, "one two three",
   ["home", "chord alt+d", "chord alt+d", "chord ctrl+e", "chord ctrl+y"], " threeone two"],
  ["M-y cycles the ring", E, false, "aa bb cc",
   ["home", "chord alt+d", "chord ctrl+f", "chord alt+d", "chord ctrl+e", "chord ctrl+y", "chord alt+y"], "  ccaa"],
  ["C-t transposes at the end", E, false, "abcd", ["chord ctrl+t"], "abdc"],
  ["C-t transposes inside", E, false, "abcd", ["home", "chord ctrl+f", "chord ctrl+t", "type X"], "baXcd"],
  ["M-t transposes words", E, false, "one two", ["home", "chord alt+t"], "two one"],
  ["M-u upcases a word", E, false, "hello world", ["home", "chord alt+u"], "HELLO world"],
  ["M-l downcases a word", E, false, "HELLO WORLD", ["home", "chord alt+l"], "hello WORLD"],
  ["M-c capitalises a word", E, false, "hello world", ["home", "chord alt+f", "chord alt+c"], "hello World"],
  ["C-g cancels the mark", E, false, "hello", ["home", "chord ctrl+space", "chord ctrl+f", "chord ctrl+g", "type X"],
   "hXello"],
  ["C-/ undoes", E, false, "abc", ["type XY", "chord ctrl+slash"], "abc"],
  ["C-_ undoes", E, false, "abc", ["type XY", "chord ctrl+shift+underscore"], "abc"],
  ["C-o opens a line", E, true, "ab", ["chord ctrl+o", "type X"], "abX\n"],
  ["C-j types a line break", E, true, "ab", ["chord ctrl+j", "type X"], "ab\nX"],
  ["Ctrl+Shift+A selects all", E, false, "abc", ["chord ctrl+shift+a", "type X"], "X"],
  ["Ctrl+C and Ctrl+V", E, false, "ab", ["chord ctrl+shift+a", "chord ctrl+c", "chord ctrl+e", "chord ctrl+v"], "abab"],
  ["Ctrl+X cuts a selection", E, false, "abc", ["chord shift+Left", "chord ctrl+x", "home", "chord ctrl+v"], "cab"],
  ["Shift with C-b selects", E, false, "abc", ["chord ctrl+shift+b", "chord ctrl+shift+b", "type X"], "aX"],
  ["Alt chords type nothing", E, false, "ab", ["chord alt+x", "chord alt+q"], "ab"],
  ["Ctrl+Z, Ctrl+Shift+Z", E, false, "ab", ["type X", "chord ctrl+z", "chord ctrl+shift+z"], "abX"],
  ["standard: Ctrl+A selects all", S, false, "abc", ["chord ctrl+a", "type X"], "X"],
  ["standard: Ctrl+Y redoes", S, false, "ab", ["type X", "chord ctrl+z", "chord ctrl+y"], "abX"],
  ["standard: no C-e", S, false, "ab", ["home", "chord ctrl+e", "type X"], "Xab"],
  ["standard: no C-k", S, false, "ab", ["home", "chord ctrl+k"], "ab"],
  ["standard: arrows and words", S, false, "one two", ["chord ctrl+Left", "type X", "chord Home", "type Y"], "Yone Xtwo"],
];

const rowHeight = 16, top = 8;
const world = `
import { useEffect, useState } from "react";
import { Box, Text } from "proscenium";
const cases = ${JSON.stringify(cases.map(([name, keymap, multiline, text]) => ({ name, keymap, multiline, text })))};
export default function Keys() {
  const [texts, setTexts] = useState(cases.map((c) => c.text));
  const [revisions, setRevisions] = useState(cases.map(() => 0));
  useEffect(() => {
    const timer = setInterval(() => console.error("texts " + JSON.stringify(texts)), 500);
    return () => clearInterval(timer);
  }, [texts]);
  return (
    <Box x={10} y={${top}} flexDirection="column" width={600}>
      {cases.map((c, i) => (
        <Text key={i} editable tabIndex={0} keymap={c.keymap} multiline={c.multiline} text={texts[i]}
              valueRevision={revisions[i]} width={600} height={${rowHeight}} size={10} color="#ddd"
              onInput={(event) => {
                setTexts((list) => list.map((t, j) => (j === i ? event.text : t)));
                setRevisions((list) => list.map((r, j) => (j === i ? event.revision : r)));
              }} />
      ))}
    </Box>
  );
}
`;
const drive = ["extent 1280 720", "sleep 300"];
cases.forEach(([, , , , keys], i) => {
  drive.push(`move 300 ${top + i * rowHeight + rowHeight / 2}`, "click left", "sleep 40", "chord ctrl+End");
  for (const key of keys) {
    drive.push(key === "home" ? "chord ctrl+Home" : key);
    drive.push("sleep 25");
  }
  drive.push("sleep 60");
});
drive.push("sleep 1500");
writeFileSync(join(out, "keys.tsx"), world);
writeFileSync(join(out, "keys.drive"), drive.join("\n") + "\n");
const seconds = Math.ceil(drive.length * 0.05 + 6);
execFileSync(join(root, "tests/shot.sh"), [join(out, "keys.tsx"), out, join(out, "keys.drive")], {
  env: { ...process.env, SHOT_AT: "500", RUN_FOR: String(seconds) }, stdio: "inherit",
});
const lines = readFileSync(join(out, "log"), "utf8").split("\n").filter((line) => line.includes("texts ["));
if (!lines.length) throw new Error(`no texts logged; see ${join(out, "log")}`);
const texts = JSON.parse(lines.at(-1).slice(lines.at(-1).indexOf("texts ") + 6));
let failed = 0;
cases.forEach(([name, keymap, , , , expected], i) => {
  const ok = texts[i] === expected;
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"} ${keymap.padEnd(8)} ${name}${ok ? "" : `: got ${JSON.stringify(texts[i])}, want ${JSON.stringify(expected)}`}`);
});
console.log(`${cases.length - failed} of ${cases.length} passed`);
process.exit(failed ? 1 : 0);
