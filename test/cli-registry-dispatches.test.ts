// test/cli-registry-dispatches.test.ts — W1-T2893: the command registry described the CLI (its
// syntax/summary/detail fields drove `rmd --help`) but did not DISPATCH it — `main()` in
// src/run-task.ts routed every verb through its own 300-line flat if-ladder instead of reading
// the registry. src/cli/registry.ts's `dispatchCommand` is the fix: it resolves a verb name to
// its registered handler and invokes it, so the registry is now the single place a verb turns
// into a function call.
//
// These tests exercise `dispatchCommand`/`buildRegistry` directly, against a small SYNTHETIC
// registry — the falsifying test the task record asks for: a fake handler registered under a
// test name, invoked with the parsed args; an unknown verb producing the same usage text +
// exit code `main()`'s old fallthrough always produced; and a verb whose old branch additionally
// required a positional arg (`cmd === "x" && arg`) falling to that SAME unknown-verb path when
// the arg is missing, byte-identical to today's behavior.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildRegistry,
  dispatchCommand,
  UNKNOWN_COMMAND_EXIT_CODE,
  type CommandHandler,
  type CommandSpec,
} from "../src/cli/registry.js";
import { HANDLERS, USAGE as REAL_USAGE, main } from "../src/run-task.js";

const USAGE = "usage:\n  rmd fake-verb   # a synthetic verb this test made up\n";

function spec(name: string): CommandSpec {
  return { name, syntax: `rmd ${name}`, summary: `synthetic ${name}`, detail: `synthetic ${name} detail` };
}

test("dispatchCommand resolves a verb to its registered handler and invokes it with the parsed args", async () => {
  const seen: string[][] = [];
  const handler: CommandHandler = (rest) => {
    seen.push(rest);
    return 0;
  };
  const registry = buildRegistry([spec("fake-verb")], new Map([["fake-verb", handler]]));
  const code = await dispatchCommand("fake-verb", ["--flag", "value"], registry, USAGE);
  assert.equal(code, 0, "the handler's own return value must be dispatchCommand's return value");
  assert.deepEqual(
    seen,
    [["--flag", "value"]],
    "the handler must be invoked exactly once, with argv AFTER the verb token itself (main()'s `rest`)",
  );
});

test("dispatchCommand awaits an async handler and propagates its resolved exit code", async () => {
  const handler: CommandHandler = async (rest) => {
    await Promise.resolve();
    return rest.length === 0 ? 1 : 3;
  };
  const registry = buildRegistry([spec("fake-verb")], new Map([["fake-verb", handler]]));
  assert.equal(await dispatchCommand("fake-verb", [], registry, USAGE), 1);
  assert.equal(await dispatchCommand("fake-verb", ["x"], registry, USAGE), 3);
});

test("an unknown verb prints the given usage text and returns the SAME exit code main()'s old fallthrough always produced", async () => {
  const registry = buildRegistry([spec("fake-verb")], new Map([["fake-verb", () => 0]]));
  const originalError = console.error;
  const printed: unknown[][] = [];
  console.error = (...args: unknown[]) => {
    printed.push(args);
  };
  try {
    const code = await dispatchCommand("totally-unknown-verb", ["--anything"], registry, USAGE);
    assert.equal(code, UNKNOWN_COMMAND_EXIT_CODE);
    assert.equal(code, 2, "must match the literal exit code `console.error(USAGE); process.exit(2);` always used");
    assert.deepEqual(printed, [[USAGE]], "must print exactly the usage text it was given, nothing added or dropped");
  } finally {
    console.error = originalError;
  }
});

test("an undefined cmd (argv had no verb at all) is treated the same as an unknown one, never a crash", async () => {
  const registry = buildRegistry([spec("fake-verb")], new Map([["fake-verb", () => 0]]));
  const originalError = console.error;
  console.error = () => {};
  try {
    assert.equal(await dispatchCommand(undefined, [], registry, USAGE), UNKNOWN_COMMAND_EXIT_CODE);
  } finally {
    console.error = originalError;
  }
});

test("a verb requiring a positional arg replicates that gate INSIDE its own handler — dispatchCommand itself carries no arg-arity knowledge", async () => {
  // Mirrors run-task.ts's real HANDLERS entries for run-task/review/fix/etc.: the old `if (cmd
  // === "x" && arg)` gate is now reproduced inside the handler closure itself, falling to the
  // exact same usage+exit-2 result a truly unknown verb would.
  const requiresArg: CommandHandler = (rest) => {
    const arg = rest[0];
    if (!arg) {
      console.error(USAGE);
      return UNKNOWN_COMMAND_EXIT_CODE;
    }
    return 0;
  };
  const registry = buildRegistry([spec("needs-arg")], new Map([["needs-arg", requiresArg]]));
  const originalError = console.error;
  const printed: unknown[][] = [];
  console.error = (...args: unknown[]) => printed.push(args);
  try {
    assert.equal(await dispatchCommand("needs-arg", [], registry, USAGE), 2, "missing arg falls to the usage exit code");
    assert.equal(await dispatchCommand("needs-arg", ["present"], registry, USAGE), 0, "a present arg dispatches normally");
    assert.deepEqual(printed, [[USAGE]], "only the missing-arg call prints usage");
  } finally {
    console.error = originalError;
  }
});

test("buildRegistry throws immediately when a COMMANDS entry has no matching handler — registry/dispatch drift is a load-time crash, not a silent gap", () => {
  assert.throws(
    () => buildRegistry([spec("orphan")], new Map()),
    /no registered handler/,
    "a spec with no handler must refuse to build a registry at all",
  );
});

test("--help output is unchanged: dispatchCommand plays no part in the top-level `--help`/`-h`/`help` short-circuit", async () => {
  // `--help`/`-h`/`help` are intercepted in main() BEFORE dispatchCommand is ever called (see
  // test/help-registry.test.ts's ordering test against the real registry) — dispatchCommand has
  // no special case for them at all. Feeding one through here proves that: with no COMMANDS entry
  // named "--help", it resolves exactly like any other unrecognized verb, never like a help verb.
  const registry = buildRegistry([spec("fake-verb")], new Map([["fake-verb", () => 0]]));
  const originalError = console.error;
  const printed: unknown[][] = [];
  console.error = (...args: unknown[]) => printed.push(args);
  try {
    const code = await dispatchCommand("--help", [], registry, USAGE);
    assert.equal(code, UNKNOWN_COMMAND_EXIT_CODE, "dispatchCommand must not special-case --help");
    assert.deepEqual(printed, [[USAGE]]);
  } finally {
    console.error = originalError;
  }
});

async function captureHandler(handlerName: string, rest: string[]): Promise<{ code: number; printed: unknown[][] }> {
  const handler = HANDLERS.get(handlerName);
  assert.ok(handler, `${handlerName} must be registered in the real HANDLERS map`);
  const originalError = console.error;
  const printed: unknown[][] = [];
  console.error = (...args: unknown[]) => printed.push(args);
  try {
    return { code: await handler(rest), printed };
  } finally {
    console.error = originalError;
  }
}

test("real HANDLERS preserve the old required-positional fallthrough for arg-gated verbs", async () => {
  const requiresArg = [
    "note",
    "wipe-test",
    "run-task",
    "review",
    "dep-review",
    "receipt",
    "replay",
    "fix",
    "correct",
    "approve",
    "reframe",
  ];

  for (const name of requiresArg) {
    const { code, printed } = await captureHandler(name, []);
    assert.equal(code, 2, `${name} with no positional arg must return the usage exit code`);
    assert.deepEqual(printed, [[REAL_USAGE]], `${name} must print the same top-level usage fallback`);
  }
});

test("real HANDLERS route malformed args into their command validators before side effects", async () => {
  const cases: Array<{ name: string; rest: string[]; pattern: RegExp }> = [
    { name: "note", rest: ["W1-T2893"], pattern: /rmd note: <id> and <text\.\.\.> are both required/ },
    { name: "run-task", rest: ["W1-T2893", "--bogus"], pattern: /rmd run-task: unexpected argument '--bogus'/ },
    { name: "receipt", rest: ["1", "--bogus"], pattern: /rmd receipt: unexpected argument '--bogus'/ },
    { name: "replay", rest: ["2026-09-10"], pattern: /usage: rmd replay/ },
    { name: "fix", rest: ["not-a-number"], pattern: /not a valid PR number/ },
    { name: "correct", rest: ["W1-T2893", "--bogus"], pattern: /rmd correct: unexpected argument '--bogus'/ },
    { name: "approve", rest: ["P1", "--bogus"], pattern: /rmd approve: unexpected argument '--bogus'/ },
    { name: "reframe", rest: ["P1", "--bogus"], pattern: /rmd reframe: unexpected argument '--bogus'/ },
  ];

  for (const { name, rest, pattern } of cases) {
    const { code, printed } = await captureHandler(name, rest);
    assert.equal(code, 2, `${name} malformed args must return the usage exit code`);
    assert.match(String(printed[0]?.[0] ?? ""), pattern, `${name} should reject before real side effects`);
  }
});

test("main dispatches unknown verbs through dispatchCommand and exits with its code", async (t) => {
  class ExitCalled extends Error {
    constructor(public readonly code: number | undefined) {
      super(`process.exit(${code})`);
    }
  }

  const savedArgv = process.argv;
  const savedToken = process.env.GH_TOKEN;
  const printed: unknown[][] = [];
  t.mock.method(console, "error", (...args: unknown[]) => printed.push(args));
  t.mock.method(process, "exit", ((code?: number): never => {
    throw new ExitCalled(code);
  }) as typeof process.exit);

  try {
    process.env.GH_TOKEN = "already-present";
    process.argv = ["node", "run-task.js", "not-a-real-verb"];
    let caught: unknown;
    await main({ checkFreshness: () => ({ status: "guarded" }) }).catch((err) => {
      caught = err;
    });
    assert.ok(caught instanceof ExitCalled, `main() must exit through dispatchCommand; got ${String(caught)}`);
    assert.equal(caught.code, UNKNOWN_COMMAND_EXIT_CODE);
    assert.deepEqual(printed, [[REAL_USAGE]]);
  } finally {
    process.argv = savedArgv;
    if (savedToken === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = savedToken;
  }
});
