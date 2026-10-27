import assert from "node:assert/strict";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fixedClock } from "#src/lib/clock.js";
import { FIXTURE_CONFIG_PATH_SEGMENTS } from "#src/lib/config.js";
import { readLedgerUnionRecordsSync } from "#src/lib/ledger-union.js";
import type { ProcedureCensus } from "#src/lib/procedure-census.js";
import {
  PROCEDURES_LEDGER_STEPS,
  PROCEDURES_USAGE,
  proceduresCommand,
  proceduresProductionInput,
  type ProceduresCommandInput,
} from "#src/lib/procedures-command.js";
import { GATHER_RUNS_LEDGER_STEPS } from "#src/lib/retro.js";
import { writeLedger } from "#test/helpers/ledger-fixture.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";

// `rmd procedures` reads the ledger union once, builds the procedure census over the merged runs that started in the
// window, prints it, and writes nothing. The fixture clock is a fixed instant; rows are stamped relative to it.

const NOW = Date.parse("2026-10-20T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const iso = (ms: number): string => new Date(ms).toISOString();

/** One merged run of `steps` that started `startMs`, each tool row one second apart. */
function mergedRun(runId: string, startMs: number, steps: readonly string[], fixes = 0): Array<Record<string, unknown>> {
  const taskId = `W1-T${runId}`;
  let offset = 0;
  const row = (fields: Record<string, unknown>) => ({ ts: iso(startMs + 1000 * offset++), run_id: runId, task_id: taskId, ...fields });
  return [
    row({ step: "run.start", type: "implement" }),
    ...steps.map((signature) => row({ step: "worker.activity", event_kind: "tool-executing", tool_name: signature.split(":")[0],
      tool_signature: signature })),
    ...Array.from({ length: fixes }, (_, i) => row({ step: "fix.dispatch", strike: i + 1 })),
    row({ step: "verdict", verdict: "merged" }),
  ];
}

const IN_DEFAULT_WINDOW = mergedRun("A", NOW - 13 * DAY, ["Read:CLAUDE.md", "Edit:src/lib/review.ts"]);
const OUTSIDE_DEFAULT_WINDOW = mergedRun("B", NOW - 15 * DAY, ["Read:CLAUDE.md", "Bash:npm test"], 1);
/** Started after the clock's now: inside the union's `sinceTs` but past the window's end. */
const AFTER_THE_WINDOW = mergedRun("C", NOW + 60 * 60 * 1000, ["Grep"]);

function capture(stateDir: string, readLedger: ProceduresCommandInput["readLedger"] = readLedgerUnionRecordsSync) {
  const out: string[] = [];
  const err: string[] = [];
  const input: ProceduresCommandInput = { stateDir: () => stateDir, readLedger, clock: fixedClock(NOW),
    print: (text) => out.push(text), printError: (text) => err.push(text) };
  return { input, out, err };
}

/** Every file under `dir` with its bytes, so a run that writes anything — a row, a new file — shows as a difference. */
function snapshot(dir: string): Map<string, string> {
  const files = new Map<string, string>();
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) {
      const path = join(entry.parentPath, entry.name);
      files.set(path, readFileSync(path).toString("base64"));
    }
  }
  return files;
}

function ledger(t: TestContext) {
  return writeLedger([...OUTSIDE_DEFAULT_WINDOW, ...IN_DEFAULT_WINDOW, ...AFTER_THE_WINDOW], { scope: t });
}

test("PROCEDURES_LEDGER_STEPS is what gatherRuns reads plus worker.activity and fix.dispatch", () => {
  assert.deepEqual(PROCEDURES_LEDGER_STEPS, [...GATHER_RUNS_LEDGER_STEPS, "worker.activity", "fix.dispatch"]);
});

test("rmd procedures defaults to a 14-day window ending at the clock's now", (t) => {
  const { dir } = ledger(t);
  const { input, out, err } = capture(dir);
  assert.equal(proceduresCommand([], input), 0, err.join("\n"));
  assert.equal(out.length, 1);
  assert.ok(out[0]!.includes(`Window: ${iso(NOW - 14 * DAY)} to ${iso(NOW)}. Merged runs: 1.`), out[0]);
  // Run A only: B started before the window and C after its end.
  assert.ok(out[0]!.includes("- 2 of 2 tool-call rows carry a tool_signature (100%)."), out[0]);
  assert.ok(out[0]!.includes("## implement\n\n- Clean runs (zero fix rounds): 1. Repaired runs: 0."), out[0]);
  assert.deepEqual(err, []);
});

test("rmd procedures --days widens the window and counts the repaired run it reaches", (t) => {
  const { dir } = ledger(t);
  const { input, out } = capture(dir);
  assert.equal(proceduresCommand(["--days", "16", "--json"], input), 0);
  const census = JSON.parse(out[0]!) as ProcedureCensus;
  assert.equal(census.mergedRuns, 2);
  assert.deepEqual(census.taskTypes.map((t) => [t.taskType, t.cleanRuns, t.repairedRuns]), [["implement", 1, 1]]);
  assert.deepEqual(census.taskTypes[0]!.steps.find((s) => s.step === "Edit:src/lib/*.ts"),
    { step: "Edit:src/lib/*.ts", cleanShare: 1, repairedShare: 0, lift: 1 });
});

test("rmd procedures --json prints the census object", (t) => {
  const { dir } = ledger(t);
  const { input, out } = capture(dir);
  assert.equal(proceduresCommand(["--json"], input), 0);
  const census = JSON.parse(out[0]!) as ProcedureCensus;
  assert.deepEqual(census.signatureCoverage, { toolRows: 2, withSignature: 2 });
  assert.equal(census.mergedRuns, 1);
  assert.deepEqual(census.taskTypes[0]!.steps.map((s) => s.step), ["Edit:src/lib/*.ts", "Read:CLAUDE.md"]);
});

test("rmd procedures accepts --days at both ends of 1..60", (t) => {
  const { dir } = ledger(t);
  for (const argv of [["--days", "1"], ["--days=60"]]) {
    const { input, err } = capture(dir);
    assert.equal(proceduresCommand(argv, input), 0, `${argv.join(" ")}: ${err.join("\n")}`);
  }
});

test("rmd procedures refuses a --days outside 1..60, a non-integer, or a stray argument with exit 2, reading nothing", () => {
  for (const argv of [["--days", "0"], ["--days", "61"], ["--days", "abc"], ["--days", "1.5"], ["--days", "-3"], ["--days"],
    ["--bogus"], ["extra"]]) {
    const err: string[] = [];
    const input: ProceduresCommandInput = {
      stateDir: () => assert.fail(`${argv.join(" ")} must refuse before naming a state dir`),
      readLedger: () => assert.fail(`${argv.join(" ")} must refuse before reading the ledger`),
      clock: fixedClock(NOW), print: (text) => assert.fail(`${argv.join(" ")} printed a report: ${text}`),
      printError: (text) => err.push(text),
    };
    assert.equal(proceduresCommand(argv, input), 2, argv.join(" "));
    assert.ok(err.join("\n").includes(PROCEDURES_USAGE), `${argv.join(" ")}: ${err.join("\n")}`);
  }
});

test("rmd procedures refuses an incomplete ledger union with exit 2 and names each unread source", (t) => {
  const { dir } = writeLedger(IN_DEFAULT_WINDOW, { scope: t, rotations: [{ at: iso(NOW - DAY), rows: OUTSIDE_DEFAULT_WINDOW, gz: true }] });
  const archive = readdirSync(dir).find((name) => name.endsWith(".ndjson.gz"))!;
  writeFileSync(join(dir, archive), "this rotation is not gzip");
  const { input, out, err } = capture(dir);
  assert.equal(proceduresCommand([], input), 2);
  assert.deepEqual(out, [], "no census is printed from a partial corpus");
  assert.match(err.join("\n"), /incomplete; refusing to count a partial corpus/);
  assert.ok(err.join("\n").includes(`  ${join(dir, archive)}`), err.join("\n"));
});

test("rmd procedures passes the window start, its step list and refuseIncomplete to the union read", (t) => {
  const { dir } = ledger(t);
  const calls: Array<Parameters<typeof readLedgerUnionRecordsSync>> = [];
  const { input } = capture(dir, (...args) => {
    calls.push(args);
    return readLedgerUnionRecordsSync(...args);
  });
  assert.equal(proceduresCommand(["--days", "3"], input), 0);
  assert.equal(calls.length, 1, "the union is read once");
  assert.equal(calls[0]![0], dir);
  assert.deepEqual(calls[0]![1], { sinceTs: iso(NOW - 3 * DAY), step: PROCEDURES_LEDGER_STEPS, refuseIncomplete: true });
});

test("rmd procedures writes nothing: the ledger's bytes are unchanged and no file appears in the state dir", (t) => {
  const { dir } = writeLedger([...IN_DEFAULT_WINDOW, ...AFTER_THE_WINDOW], { scope: t,
    rotations: [{ at: iso(NOW - 14 * DAY), rows: OUTSIDE_DEFAULT_WINDOW, gz: true }] });
  const before = snapshot(dir);
  assert.equal(before.size, 2, "the control: the live ledger and one rotation are both seen");
  for (const argv of [[], ["--json"], ["--days", "60"], ["--days", "0"]]) proceduresCommand(argv, capture(dir).input);
  assert.deepEqual(snapshot(dir), before);
});

test("the production input reads the configured root's state dir with the real reader, clock and console", (t) => {
  const root = ownedFixtureDir(t, "procedures-production").dir;
  const config = { root, claudeBin: "/bin/true" };
  const configFile = join(root, ...FIXTURE_CONFIG_PATH_SEGMENTS);
  mkdirSync(join(configFile, ".."), { recursive: true });
  writeFileSync(configFile, JSON.stringify(config));
  // Stamped relative to the real clock the production input reads, so it never ages out of the window.
  const startMs = Date.now() - 60 * 60 * 1000;
  writeLedger(mergedRun("P", startMs, ["Read:CLAUDE.md", "Bash:git status"]), { dir: join(root, "state") });
  const before = snapshot(root);
  const log = t.mock.method(console, "log", () => {});
  const error = t.mock.method(console, "error", () => {});
  const home = process.env.HOME;
  process.env.HOME = root;
  try {
    assert.equal(proceduresCommand([], proceduresProductionInput()), 0, error.mock.calls.map((c) => String(c.arguments[0])).join("\n"));
    assert.equal(proceduresCommand(["--days", "0"], proceduresProductionInput()), 2);
  } finally {
    process.env.HOME = home;
  }
  assert.equal(log.mock.callCount(), 1);
  const report = String(log.mock.calls[0]!.arguments[0]);
  assert.ok(report.includes("Merged runs: 1.") && report.includes("- 2 of 2 tool-call rows carry a tool_signature (100%)."), report);
  assert.equal(error.mock.callCount(), 1);
  assert.ok(String(error.mock.calls[0]!.arguments[0]).includes(PROCEDURES_USAGE));
  assert.deepEqual(snapshot(root), before, "the production wiring writes nothing either");
});
