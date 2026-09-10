import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { test } from "node:test";

// `scripts/**` sits OUTSIDE tsconfig's `include`, so a static import is a TS7016 — the same reason
// test/docs-index.test.ts and test/clock-sweep.test.ts reach their scripts through a runtime
// import. A dynamic specifier loads the REAL module with no shadow copy to drift from it.
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CENSUS_URL = pathToFileURL(join(REPO_ROOT, "scripts", "union-retention-census.mjs")).href;

const {
  ACKNOWLEDGED,
  ACKNOWLEDGED_UNRESOLVED,
  RETENTION_SET_NAMES,
  assertRetentionSetsResolved,
  censusFindings,
  contradictions,
  main,
  retentionSetFrom,
  staleAcknowledgements,
  stepsInPatternText,
  trackedSourceFiles,
} = (await import(CENSUS_URL)) as {
  ACKNOWLEDGED: Map<string, string>;
  ACKNOWLEDGED_UNRESOLVED: Map<string, string>;
  RETENTION_SET_NAMES: string[];
  assertRetentionSetsResolved: (sets: Map<string, Set<string>>) => void;
  censusFindings: (
    files: string[],
    readFile: (p: string) => string,
    retention: Map<string, Set<string>>,
  ) => Array<{ file: string; arg: string; unresolved: boolean; steps: Array<{ step: string; retainedBy?: string }> }>;
  contradictions: (
    findings: ReturnType<typeof censusFindings>,
    acknowledged?: Map<string, string>,
  ) => Array<{ file: string; pattern: string; step: string }>;
  main: (argv: string[], deps: Record<string, unknown>) => number;
  retentionSetFrom: (src: string, name: string) => Set<string>;
  staleAcknowledgements: (findings: ReturnType<typeof censusFindings>, acknowledged?: Map<string, string>) => string[];
  stepsInPatternText: (text: string) => string[];
  trackedSourceFiles: (root: string, exec?: unknown) => string[];
};

// ── W1-T3360: a union read of a step retention discards ────────────────────────────────────────
//
// THE OUTAGE THIS EXISTS TO PREVENT. On 2026-09-10 the fleet daemon OOM-crash-looped for eight
// hours — 66 restarts, exit 134, zero builds dispatched — on a 4.0 GB `resolveLedgerUnion` scan
// against an 8 GB heap. The row at the centre of it, `sweep.fix.uncreditable_head`, is written by
// the sweep, then classified as pure noise by `rotateLedger` because it is absent from
// `DECISION_RELEVANT_LEDGER_STEPS`, then archived wholesale, then read back out of 954 archives on
// every cycle. MEASURED: 0 of its 324 rows were in the live ledger.
//
// Finding that took a person reading two files and noticing they disagreed. This suite is the gate
// that reads them instead.

const RETENTION = (): Map<string, Set<string>> => {
  const src = readFileSync(join(REPO_ROOT, "src", "lib", "ledger.ts"), "utf8");
  return new Map(RETENTION_SET_NAMES.map((n) => [n, retentionSetFrom(src, n)]));
};
const readReal = (rel: string): string => readFileSync(join(REPO_ROOT, rel), "utf8");

// ── the gate, against the real tree ─────────────────────────────────────────────────────────────

test("W1-T3360: the census passes on the committed tree — every union-read step is retained or acknowledged", () => {
  const lines: string[] = [];
  const code = main([], { repoRoot: REPO_ROOT, log: (s: string) => lines.push(s) });
  assert.equal(code, 0, lines.join("\n"));
  assert.match(lines.join("\n"), /OK -- every step-keyed union read is retained or acknowledged/);
});

test("W1-T3360: it SEES the corpus — the real tree yields step-keyed union reads and named steps", () => {
  const findings = censusFindings(
    trackedSourceFiles(REPO_ROOT).filter((f) => f !== "src/lib/ledger-union.ts"),
    readReal,
    RETENTION(),
  );
  const keyed = findings.filter((f) => !f.unresolved && f.steps.length > 0);
  // POSITIVE CONTROL. A zero here would make every assertion below vacuously true, which is the
  // shape that lets a gate pass while checking nothing.
  assert.ok(keyed.length >= 4, `expected several step-keyed union reads; got ${keyed.length}`);
  assert.ok(
    keyed.reduce((n, f) => n + f.steps.length, 0) >= 15,
    "expected the real patterns to name a substantial set of steps",
  );
  // The outage's own row must still be found, or the gate has stopped watching the thing it was built for.
  assert.ok(
    findings.some((f) => f.steps.some((s) => s.step === "sweep.fix.uncreditable_head")),
    "the census no longer finds sweep.fix.uncreditable_head — the read moved and this gate went blind",
  );
});

// ── it refuses a NEW contradiction ──────────────────────────────────────────────────────────────

const FAKE_LEDGER = `
export const DECISION_RELEVANT_LEDGER_STEPS: ReadonlySet<string> = new Set([
  "run.start",
  "pr.opened",
]);
export const RENDER_RELEVANT_LEDGER_STEPS: ReadonlySet<string> = new Set([
  "daemon.headroom",
]);
`;

function runOnFixture(
  readerSource: string,
  opts: { ledger?: string; acknowledged?: Map<string, string>; acknowledgedUnresolved?: Map<string, string> } = {},
): { code: number; out: string } {
  const lines: string[] = [];
  const code = main([], {
    repoRoot: "/fixture",
    files: ["src/lib/fake-reader.ts"],
    readFile: (rel: string) => (rel === "src/lib/ledger.ts" ? (opts.ledger ?? FAKE_LEDGER) : readerSource),
    log: (s: string) => lines.push(s),
    // A fixture tree contains none of the real acknowledged steps, so the real map would read
    // entirely STALE and every fixture would fail for a reason unrelated to what it tests.
    acknowledged: opts.acknowledged ?? new Map<string, string>(),
    acknowledgedUnresolved: opts.acknowledgedUnresolved ?? new Map<string, string>(),
  });
  return { code, out: lines.join("\n") };
}

test("W1-T3360 (falsifier): a NEW union read of an unretained step is REFUSED, naming file, pattern and step", () => {
  const { code, out } = runOnFixture(
    'const NEW_PATTERN = \'"step":"brand.new_unretained"\';\nresolveLedgerUnion(dir, NEW_PATTERN);\n',
  );
  assert.equal(code, 1);
  assert.match(out, /CONTRADICTION/);
  assert.match(out, /src\/lib\/fake-reader\.ts/);
  assert.match(out, /brand\.new_unretained/);
  assert.match(out, /NEW_PATTERN/);
  // and it must say what to do about it, in both legitimate directions
  assert.match(out, /add the step to one of/i);
  assert.match(out, /keep a projection and stop/i);
});

test("W1-T3360 (control): the SAME shape over a RETAINED step passes — the gate is not refusing everything", () => {
  const { code, out } = runOnFixture('const P = \'"step":"run.start"\';\nresolveLedgerUnion(dir, P);\n');
  assert.equal(code, 0, out);
  assert.doesNotMatch(out, /CONTRADICTION/);
});

test("W1-T3360: a step hidden inside a regex ALTERNATION is found — the blind spot that hid three real rows", () => {
  // This is the shape src/lib/autonomy.ts really uses. The gate's first draft reported ZERO steps
  // for it and silently missed fix.exhausted, fix.stood_down and panel.operator_note_added.
  const steps = stepsInPatternText(
    '/"step":"(?:automerge\\.armed|review\\.posted|fix\\.stood_down|panel\\.operator_note_added)"/',
  );
  assert.deepEqual(steps, ["automerge.armed", "review.posted", "fix.stood_down", "panel.operator_note_added"]);

  const { code, out } = runOnFixture(
    'const ALT = /"step":"(?:run\\.start|hidden\\.in_alternation)"/;\nresolveLedgerUnion(dir, ALT);\n',
  );
  assert.equal(code, 1, out);
  assert.match(out, /hidden\.in_alternation/);
  // …and the retained sibling in the same alternation is NOT reported
  assert.doesNotMatch(out, /CONTRADICTION.*run\.start/);
});

test("W1-T3360: a RUNTIME-BUILT pattern is refused as a blind spot rather than passing as 'not step-keyed'", () => {
  const { code, out } = runOnFixture("resolveLedgerUnion(dir, buildPatternAtRuntime(x));\n");
  assert.equal(code, 1, out);
  assert.match(out, /UNRESOLVED PATTERN/);
  assert.match(out, /cannot see what this reads/);
});

test("W1-T3360 (control): an ACKNOWLEDGED runtime pattern passes — the blind-spot rule is clearable, not absolute", () => {
  const { code, out } = runOnFixture("resolveLedgerUnion(dir, buildPatternAtRuntime(x));\n", {
    acknowledgedUnresolved: new Map([["src/lib/fake-reader.ts", "built at runtime from RegExp data"]]),
  });
  assert.equal(code, 0, out);
  assert.doesNotMatch(out, /UNRESOLVED PATTERN/);
});

test("W1-T3360: a STALE acknowledgement is REFUSED — the map may not outlive what it covers", () => {
  // An acknowledgement for a step that is no longer read as unretained covers nothing, and a gate
  // whose carve-out list only ever grows stops meaning anything. So it must redden, not linger.
  const { code, out } = runOnFixture('const P = \'"step":"run.start"\';\nresolveLedgerUnion(d, P);\n', {
    acknowledged: new Map([["no.longer_read", "W1-T3352 — union=1 row, kept for the test"]]),
  });
  assert.equal(code, 1, out);
  assert.match(out, /STALE acknowledgement for "no\.longer_read"/);
  assert.match(out, /only grows/);
});

test("W1-T3360 (control): an acknowledgement that DOES cover a live contradiction is not called stale", () => {
  const { code, out } = runOnFixture(
    'const P = \'"step":"still.unretained"\';\nresolveLedgerUnion(d, P);\n',
    { acknowledged: new Map([["still.unretained", "W1-T3352 — union=5 rows, covered"]]) },
  );
  assert.equal(code, 0, out);
  assert.doesNotMatch(out, /STALE/);
  assert.doesNotMatch(out, /CONTRADICTION/);
});

// ── the gate's own input, controlled ────────────────────────────────────────────────────────────

test("W1-T3360: a RENAMED retention set REFUSES rather than reporting every step as unretained", () => {
  assert.throws(
    () => assertRetentionSetsResolved(new Map([["DECISION_RELEVANT_LEDGER_STEPS", new Set<string>()]])),
    /resolved to ZERO members/,
  );
  // and the real sets are non-empty, so the guard above is not masking a live breakage
  for (const [name, set] of RETENTION()) {
    assert.ok(set.size > 0, `${name} resolved to zero members against the real ledger.ts`);
  }
});

test("W1-T3360: a tree with NO union call site at all refuses instead of passing vacuously", () => {
  const { code, out } = runOnFixture("const nothing = 1;\n");
  assert.equal(code, 1, out);
  assert.match(out, /no resolveLedgerUnion call site found at all/);
  assert.match(out, /pass vacuously/);
});

// ── the acknowledgements are evidence, not decoration ───────────────────────────────────────────

test("W1-T3360: every acknowledgement names a task and carries measured evidence, not just a promise", () => {
  assert.ok(ACKNOWLEDGED.size >= 11, `expected the measured contradiction set; got ${ACKNOWLEDGED.size}`);
  for (const [step, reason] of ACKNOWLEDGED) {
    assert.match(reason, /W1-T\d+/, `${step}: an acknowledgement must name the task that will fix it`);
    assert.match(reason, /union=|MB|rows/, `${step}: an acknowledgement must carry a measured figure`);
  }
  for (const [file, reason] of ACKNOWLEDGED_UNRESOLVED) {
    assert.match(reason, /runtime|RegExp/i, `${file}: say why the pattern cannot be read statically`);
  }
});

test("W1-T3360: this suite IS the CI wiring — it drives the census the same way a job would", () => {
  // No new ci.yml job: `.github/workflows/**` is on Standing rule 25's INSTRUMENT_SURFACE and this
  // PR changes src/, so a workflow edit would force an unsuppressible review failure. The npm test
  // run is the wiring instead, the same shape test/operator-macros-are-generated.test.ts uses.
  const result = execFileSync(
    process.execPath,
    ["--input-type=module", "-e", `const m = await import(${JSON.stringify(CENSUS_URL)}); process.exit(m.main([], { repoRoot: ${JSON.stringify(REPO_ROOT)} }));`],
    { encoding: "utf8" },
  );
  assert.match(result, /union-retention-census: OK/);
});
