import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { COMMANDS, USAGE, commandHelp } from "../src/run-task.js";

// W1-T47: COMMANDS is the ONE source of truth `rmd --help` (USAGE) and `rmd <cmd>
// --help` (commandHelp) are BOTH generated from — these tests pin that relationship so
// a future edit can't let the two help surfaces drift apart, or add a dispatched
// command that the registry (and therefore --help) doesn't know about.

const runTaskSrc = readFileSync(fileURLToPath(new URL("../src/run-task.ts", import.meta.url)), "utf8");

test("USAGE is generated FROM COMMANDS — every registry entry's usage line appears verbatim", () => {
  for (const spec of COMMANDS) {
    assert.ok(
      USAGE.includes(spec.usage),
      `USAGE is missing the ${spec.name} registry entry's usage line — it must be generated from COMMANDS, not hand-duplicated`,
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

test("commandHelp(spec) prints exactly that command's usage line — no other command's text leaks in", () => {
  for (const spec of COMMANDS) {
    const help = commandHelp(spec);
    assert.ok(help.includes(spec.usage), `commandHelp for ${spec.name} must include its own usage line`);
    const others = COMMANDS.filter((c) => c.name !== spec.name);
    for (const other of others) {
      // A command's own usage line must not equal another's — otherwise this check is vacuous.
      assert.notEqual(other.usage, spec.usage);
    }
  }
});

test("every COMMANDS entry has a matching `cmd === \"<name>\"` (or `cmd === \"<name>\" &&`) dispatch check in main() — the registry can't silently drift from what's actually routed", () => {
  for (const spec of COMMANDS) {
    const dispatchPattern = new RegExp(`cmd === "${spec.name}"`);
    assert.match(
      runTaskSrc,
      dispatchPattern,
      `COMMANDS lists "${spec.name}" but main() has no \`cmd === "${spec.name}"\` dispatch branch`,
    );
  }
});

test("`rmd <cmd> --help` is checked BEFORE any command's business-logic dispatch, so it never spawns a side effect (e.g. `rmd notify --help` must not send a notification)", () => {
  const helpCheckIdx = runTaskSrc.indexOf("COMMANDS.find((c) => c.name === cmd)");
  const firstDispatchIdx = runTaskSrc.indexOf('if (cmd === "run-task" && arg)');
  assert.ok(helpCheckIdx >= 0, "main() must look up the command spec for per-command help");
  assert.ok(firstDispatchIdx >= 0, "main() must still dispatch run-task");
  assert.ok(helpCheckIdx < firstDispatchIdx, "the --help intercept must run before the first business-logic dispatch");
});

// ── HELP-COVERAGE (the reverse direction): every command main() actually DISPATCHES to
// must have a COMMANDS entry, not just the other way around. Without this half, a PR could
// add a new `if (cmd === "widget") { process.exit(await widgetCommand(rest)); }` branch and
// leave the command entirely out of `rmd --help` / `rmd <cmd> --help` — undocumented,
// unhelpable, but fully live — and CI would stay green. This is what turns RED the moment
// that happens; see the PR body for a captured red run (add the branch, run this file, get
// the failure below; remove it, get green again).

function mainBody(): string {
  // `async function main(` — then its body opens at the FIRST `): Promise<void> {` after it
  // (tolerant of an optional injectable deps parameter, single- or multi-line — W1-T79).
  const sigIdx = runTaskSrc.indexOf("async function main(");
  const start = runTaskSrc.indexOf("): Promise<void> {", sigIdx);
  const end = runTaskSrc.indexOf("// Only run when invoked directly", start);
  assert.ok(
    sigIdx >= 0 && start >= 0 && end > start,
    "could not locate main()'s body in run-task.ts — has it been renamed?",
  );
  return runTaskSrc.slice(start, end);
}

/** Every `cmd === "<name>"` dispatch check inside main(), minus the --help/-h/help pseudo-commands. */
function dispatchedCommandNames(): string[] {
  const body = mainBody();
  const names = new Set<string>();
  for (const m of body.matchAll(/cmd === "([^"]+)"/g)) {
    const name = m[1];
    if (name === "--help" || name === "-h" || name === "help") continue;
    names.add(name);
  }
  return [...names];
}

test("HELP-COVERAGE: every command main() dispatches to has a COMMANDS registry entry — a dispatched-but-unregistered command fails this check", () => {
  const dispatched = dispatchedCommandNames();
  assert.ok(dispatched.length > 0, "sanity: dispatch-name extraction must find at least one command");
  const registered = new Set(COMMANDS.map((c) => c.name));
  const undocumented = dispatched.filter((name) => !registered.has(name));
  assert.deepEqual(
    undocumented,
    [],
    `command(s) dispatched in main() but MISSING a COMMANDS entry (undocumented in rmd --help / rmd <cmd> --help): ${JSON.stringify(undocumented)} — add each to COMMANDS in src/run-task.ts`,
  );
});

test("HELP-COVERAGE is exhaustive over main(): dispatchedCommandNames() finds every known command (no silent under-extraction)", () => {
  const dispatched = new Set(dispatchedCommandNames());
  for (const spec of COMMANDS) {
    assert.ok(dispatched.has(spec.name), `dispatchedCommandNames() did not find "${spec.name}" — the extraction regex/boundary may be wrong, which would make the help-coverage check above vacuous`);
  }
});
