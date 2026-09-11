import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { COMMANDS, HANDLERS, USAGE, commandHelp } from "../src/run-task.js";

// W1-T47: COMMANDS is the ONE source of truth `rmd --help` (USAGE) and `rmd <cmd>
// --help` (commandHelp) are BOTH generated from — these tests pin that relationship so
// a future edit can't let the two help surfaces drift apart, or add a dispatched
// command that the registry (and therefore --help) doesn't know about.

const runTaskSrc = readFileSync(fileURLToPath(new URL("../src/run-task.ts", import.meta.url)), "utf8");

test("USAGE is generated FROM COMMANDS — every registry entry's syntax + summary line appears verbatim", () => {
  for (const spec of COMMANDS) {
    assert.ok(
      USAGE.includes(spec.syntax),
      `USAGE is missing the ${spec.name} registry entry's syntax — it must be generated from COMMANDS, not hand-duplicated`,
    );
    assert.ok(
      USAGE.includes(spec.summary),
      `USAGE is missing the ${spec.name} registry entry's summary — the top level must print a summary, not the full detail`,
    );
  }
});

test("USAGE has no stray command lines beyond COMMANDS — same count of 'rmd <name>' lines as registry entries", () => {
  const usageCommandLines = USAGE.split("\n").filter((line) => /^  rmd /.test(line));
  assert.equal(
    usageCommandLines.length,
    COMMANDS.length,
    "USAGE line count must match COMMANDS.length exactly — a mismatch means USAGE has a line the registry doesn't (or vice versa)",
  );
});

test("commandHelp(spec) prints exactly that command's syntax + full detail — no other command's text leaks in", () => {
  for (const spec of COMMANDS) {
    const help = commandHelp(spec);
    assert.ok(help.includes(spec.syntax), `commandHelp for ${spec.name} must include its own syntax`);
    assert.ok(help.includes(spec.detail), `commandHelp for ${spec.name} must include its own full detail`);
    const others = COMMANDS.filter((c) => c.name !== spec.name);
    for (const other of others) {
      // A command's own syntax must not equal another's — otherwise this check is vacuous.
      assert.notEqual(other.syntax, spec.syntax);
    }
  }
});

// W1-T2893: main() no longer dispatches through a flat if-ladder (`if (cmd === "<name>") { ... }`,
// once per verb) that a regex could scan for — every verb's handler is now a HANDLERS map entry
// that src/cli/registry.ts's dispatchCommand resolves `cmd` against. The two tests below replace
// the old source-text scan with a direct structural check of that same map, in BOTH directions:
// a COMMANDS entry with no handler (help promises a verb main() can't run) is exactly as broken
// as a handler with no COMMANDS entry (a live, undocumented, unhelpable verb) — see the ~W1-T2893
// PR body for a captured red run of each direction (drop an entry from either side, run this
// file, get the failure below; restore it, get green again).

test("every COMMANDS entry has a matching HANDLERS entry — the registry can't silently drift from what's actually dispatched", () => {
  const missing = COMMANDS.map((spec) => spec.name).filter((name) => !HANDLERS.has(name));
  assert.deepEqual(
    missing,
    [],
    `COMMANDS lists these verbs but HANDLERS has no entry for them (undispatchable — buildRegistry would already throw at module load): ${JSON.stringify(missing)}`,
  );
});

test("HELP-COVERAGE (the reverse direction): every HANDLERS entry has a COMMANDS entry — no live, undocumented verb", () => {
  const registered = new Set(COMMANDS.map((c) => c.name));
  const undocumented = [...HANDLERS.keys()].filter((name) => !registered.has(name));
  assert.deepEqual(
    undocumented,
    [],
    `verb(s) dispatched via HANDLERS but MISSING a COMMANDS entry (undocumented in rmd --help / rmd <cmd> --help): ${JSON.stringify(undocumented)} — add each to COMMANDS in src/run-task.ts`,
  );
});

test("HANDLERS and COMMANDS name exactly the same number of verbs — a fast sanity check the two directions above aren't each silently vacuous", () => {
  assert.equal(HANDLERS.size, COMMANDS.length, "HANDLERS.size must equal COMMANDS.length");
});

test("`rmd <cmd> --help` is checked BEFORE any verb's business-logic dispatch, so it never spawns a side effect (e.g. `rmd notify --help` must not send a notification)", () => {
  const helpCheckIdx = runTaskSrc.indexOf("COMMANDS.find((c) => c.name === cmd)");
  const dispatchIdx = runTaskSrc.indexOf("await dispatchCommand(cmd, rest, REGISTRY, USAGE)");
  assert.ok(helpCheckIdx >= 0, "main() must look up the command spec for per-command help");
  assert.ok(dispatchIdx >= 0, "main() must still call dispatchCommand for its business-logic dispatch");
  assert.ok(helpCheckIdx < dispatchIdx, "the --help intercept must run before the registry dispatch call");
});
