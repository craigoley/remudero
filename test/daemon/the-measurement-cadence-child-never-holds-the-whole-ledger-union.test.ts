// W1-T11178: the cadence child died "JavaScript heap out of memory" because two of its verbs kept
// union lines they only fold. The fixture here is a few dozen synthetic rows; the shape, not the size,
// is what the reads must get right.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { getHeapStatistics } from "node:v8";
import { gzipSync } from "node:zlib";
import { censusHandRuns, mineHandRunRecurrences, parseOperatorLedgerRows, type HandRunUnionOptions } from "#src/lib/hand-run-census.js";
import { resolveLedgerUnion, type LedgerGrepFsDeps, type LedgerUnionResult } from "#src/lib/ledger-grep.js";
// Namespace import: a name this build adds reads undefined at base, so the test fails on its own assertion.
import * as cadence from "#src/lib/measurement-cadence.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";

type UnionCall = (stateDir: string, pattern: RegExp, fsDeps?: LedgerGrepFsDeps, opts?: HandRunUnionOptions) => LedgerUnionResult;

function scratch(label: string): string {
  return mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1-t11178-${label}-`));
}

const operatorLine = (ts: string, pid: number, step: string, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ ts, actor: "operator_human", actor_pid: pid, step, run_id: "r", task_id: "t", ...extra });
const daemonLine = (ts: string, step: string): string => JSON.stringify({ ts, actor: "daemon", step, run_id: "d", task_id: "DAEMON" });

/** Two gzip archives and a live file. One row is in both an archive and the live file, as a rotation
 *  carry leaves it, and one line is torn. Operator rows: `operators` distinct; daemon rows: the rest. */
function writeUnion(stateDir: string, operators: string[], daemon: string[]): void {
  mkdirSync(stateDir, { recursive: true });
  const half = Math.ceil(daemon.length / 2);
  const gz = (name: string, lines: string[]) => writeFileSync(join(stateDir, name), gzipSync(Buffer.from(lines.join("\n") + "\n", "utf8")));
  gz("ledger.2026-09-01T00-00-00-000Z.ndjson.gz", [...operators.slice(0, 2), ...daemon.slice(0, half)]);
  gz("ledger.2026-09-02T00-00-00-000Z.ndjson.gz", [...operators.slice(2), daemon[half]]);
  writeFileSync(join(stateDir, "ledger.ndjson"), [daemon[half], ...daemon.slice(half + 1), '{"ts":"2026-09-03T00:00:00.000Z","step":"torn'].join("\n") + "\n");
}

/** The same union read with the line filter ignored: the read every cadence verb made at base. */
const ignoringKeep: UnionCall = (stateDir, pattern) => resolveLedgerUnion(stateDir, pattern);

function recordingUnion(): { read: UnionCall; returned: string[] } {
  const returned: string[] = [];
  const read: UnionCall = (stateDir, pattern, fsDeps, opts) => {
    const union = resolveLedgerUnion(stateDir, pattern, fsDeps, opts);
    returned.push(...union.matches);
    return union;
  };
  return { read, returned };
}

const isOperatorRow = (line: string): boolean => {
  try {
    const actor = (JSON.parse(line) as { actor?: unknown }).actor;
    return actor === "operator_human" || actor === "operator_ai";
  } catch {
    return false; // the torn line: never an operator row
  }
};

test("W1-T11178 criterion 1: the hand-run census's union reads return only operator rows, and its result is the one base computed", () => {
  const dir = scratch("census");
  try {
    const operators = [
      operatorLine("2026-09-01T09:00:00.000Z", 100, "status"),
      operatorLine("2026-09-01T09:01:00.000Z", 100, "triage"),
      operatorLine("2026-09-02T09:00:00.000Z", 200, "status"),
      operatorLine("2026-09-02T09:01:00.000Z", 200, "triage"),
    ];
    const daemon = Array.from({ length: 24 }, (_, i) => daemonLine(`2026-09-01T10:${String(i).padStart(2, "0")}:00.000Z`, `daemon.tick${i % 5}`));
    writeUnion(join(dir, "mostly-daemon"), operators, daemon);
    const { read, returned } = recordingUnion();
    const result = censusHandRuns(join(dir, "mostly-daemon"), read);
    assert.ok(returned.length > 0, "the census read the fixture union");
    assert.deepEqual(returned.filter((line) => !isOperatorRow(line)), [], "a union read kept a line that is not an operator row");
    assert.deepEqual(result, { status: "refused", refusedReason: "mostly non-human ledger input: 4 operator rows of 28" });
    assert.deepEqual(result, censusHandRuns(join(dir, "mostly-daemon"), ignoringKeep), "the same answer as base's whole-union read");

    writeUnion(join(dir, "mostly-operator"), operators, daemon.slice(0, 3));
    const measured = recordingUnion();
    const mined = censusHandRuns(join(dir, "mostly-operator"), measured.read);
    assert.deepEqual(measured.returned.filter((line) => !isOperatorRow(line)), []);
    assert.deepEqual(mined, { status: "measured", recurrences: mineHandRunRecurrences(parseOperatorLedgerRows(operators)), operatorRowCount: 4 });
    assert.deepEqual(mined, censusHandRuns(join(dir, "mostly-operator"), ignoringKeep));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W1-T11178 criterion 2: the verb census's union reads return no line, and its verb lists and counts are the ones base computed", () => {
  const dir = scratch("verbs");
  try {
    const source = join(dir, "source");
    mkdirSync(join(source, "src", "lib"), { recursive: true });
    writeFileSync(join(source, "src", "run-task.ts"),
      'const COMMANDS: readonly CommandSpec[] = [\n  { name: "alpha", usage: "alpha" },\n  { name: "beta", usage: "beta" },\n  { name: "delta", usage: "delta" },\n] as const;\n');
    writeFileSync(join(source, "src", "lib", "steps.ts"), 'log("alpha.thing", {});\nlog("beta.thing", {});\n');
    const stateDir = join(dir, "state");
    writeUnion(stateDir, [operatorLine("2026-09-01T09:00:00.000Z", 100, "status")],
      Array.from({ length: 12 }, (_, i) => daemonLine(`2026-09-01T10:${String(i).padStart(2, "0")}:00.000Z`, i % 3 === 0 ? "alpha.thing" : "daemon.tick")));
    const { read, returned } = recordingUnion();
    const result = cadence.runVerbCensus({ checkoutDir: source, stateDir, ledgerUnion: read, allowlist: new Map() });
    assert.deepEqual(returned, [], "the verb census kept union lines it only counts");
    assert.deepEqual(result, { status: "measured", measurableCount: 2, unmeasurableCount: 1, silentCount: 1, silentVerbs: ["beta"], unmeasurableVerbs: ["delta"] });
    assert.deepEqual(result, cadence.runVerbCensus({ checkoutDir: source, stateDir, ledgerUnion: ignoringKeep, allowlist: new Map() }), "the same answer as base's read");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W1-T11178 criterion 3: a child that exits without a result names the last verb it entered and its heap, or that it entered none", async () => {
  const dir = scratch("child");
  try {
    for (const verb of ["hand_run_census", undefined]) {
      const statePath = join(dir, `child-${verb ?? "none"}.json`);
      let alive = true;
      const runner = cadence.measurementCadenceChildRunner({ statePath, spawn: () => 424242, isAlive: () => alive, pollMs: 5 });
      const outcome = runner.start({ fire: true });
      assert.equal(outcome.kind, "started");
      if (outcome.kind !== "started") return;
      const death = outcome.settled!.then(() => assert.fail("a dead child produced a result"), (e: Error) => e);
      const child = cadence.measurementCadenceChildMain(statePath, outcome.runId, async () => {
        if (verb) cadence.noteMeasurementCadencePhase(verb);
        alive = false; // the heap abort: the process is gone and wrote no result
        await death;
        throw new Error("the fixture child is already dead");
      });
      const error = await death;
      await child;
      if (verb) {
        const limit = Math.round(getHeapStatistics().heap_size_limit / (1024 * 1024));
        assert.match(error.message, new RegExp(`exited without a result; stderr: [\\s\\S]*; last verb ${verb}, heap \\d+ of ${limit} MB at \\d{4}-`));
        const recorded = JSON.parse(readFileSync(statePath, "utf8")) as { phase?: { verb?: string; heapUsedMb?: number; heapLimitMb?: number } };
        assert.equal(recorded.phase?.verb, verb, "the verb is in the child's own state file");
        assert.ok((recorded.phase?.heapUsedMb ?? 0) > 0 && recorded.phase?.heapLimitMb === limit);
      } else {
        assert.match(error.message, /exited without a result; stderr: [\s\S]*; it died before the report's first verb$/);
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
