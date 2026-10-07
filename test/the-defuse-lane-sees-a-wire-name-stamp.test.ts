/**
 * W1-T6036: the defuse lane sees a wire-name stamp and files only what a shifted run confirms.
 *
 * main went red at 2026-10-06T12:00Z on test/a-freshness-drain-keeps-reviewing.test.ts:228, the
 * GitHub REST fixture line `updated_at: "2026-09-22T12:00:00Z"`. mapRestPr renames it updatedAt,
 * buildOpenPrViews renames that lastActivityAt, and deriveDisposition ages it against
 * sweep.staleDays (14). The census keyed on `lastActivityAt` alone, so it and the gate gardener's
 * 21-day DEFUSE lead both read OK while it crossed. Widening the field list alone would file about
 * 20 defuse tasks for non-bombs, so the gardener now confirms each finding by running its file
 * with the clock shifted past the crossing, and files only when the shift alone turns it red.
 */
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { fixedClock } from "../src/lib/clock.js";
import * as gardener from "../src/lib/gate-gardener.js";
import { gitRepo } from "./helpers/git-repo.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
// scripts/** sits outside tsconfig's include, so the .mjs is loaded by URL, as its own suite does.
const census = (await import(pathToFileURL(join(ROOT, "scripts/expiring-fixture-census.mjs")).href)) as {
  AGED_FIELDS: ReadonlyArray<{ field: string; source: string; evidence: string[] }>;
  assertFieldsStillAged: (readFile?: (path: string) => string) => void;
  censusExpiringFixtures: (opts: {
    files: string[]; readFile: (path: string) => string; now: number; thresholdDays: number; marginDays?: number;
    readBaseFile?: (path: string) => string | undefined;
  }) => {
    population: number;
    reported: Array<{ file: string; line: number; field: string; stamp: string; expiresAt: number; daysLeft: number; inherited?: boolean }>;
    alreadyExpired: unknown[];
  };
};

const DAY = 86_400_000;
const NOW = Date.parse("2026-10-06T00:00:00Z");
const STALE_DAYS = 14;
/** The verbatim pre-#9561 fixture line from test/a-freshness-drain-keeps-reviewing.test.ts:228. */
const PRE_9561_LINE = `        updated_at: "2026-09-22T12:00:00Z",`;
const CROSSING = Date.parse("2026-10-06T12:00:00Z");
const FILE = "test/fixture.test.ts";

function scan(files: Record<string, string>, opts: { marginDays?: number; base?: Record<string, string> } = {}) {
  return census.censusExpiringFixtures({
    files: Object.keys(files),
    readFile: (path) => files[path]!,
    now: NOW,
    thresholdDays: STALE_DAYS,
    marginDays: opts.marginDays ?? 7,
    ...(opts.base ? { readBaseFile: (path: string) => opts.base![path] } : {}),
  });
}

test("W1-T6036: the pre-#9561 REST fixture line is reported crossing at 2026-10-06T12:00Z", () => {
  const r = scan({ [FILE]: `const row = {\n${PRE_9561_LINE}\n};\n` });
  assert.equal(r.reported.length, 1, "the wire name the sweep ages through two renames is a census row");
  const [row] = r.reported;
  assert.equal(row!.file, FILE);
  assert.equal(row!.line, 2);
  assert.equal(row!.field, "updated_at");
  assert.equal(row!.stamp, "2026-09-22T12:00:00Z");
  assert.equal(new Date(row!.expiresAt).toISOString(), "2026-10-06T12:00:00.000Z");
  assert.equal(row!.daysLeft, 0.5);
});

test("W1-T6036: a quoted or JSON-escaped key reports the same stamp, and a left word boundary keeps a longer name out", () => {
  const forms = [
    `{"number":1,"updated_at":"2026-09-22T12:00:00Z"}`,
    `const body = '{\\"number\\":1,\\"updated_at\\":\\"2026-09-22T12:00:00Z\\"}';`,
    `  'updated_at': '2026-09-22T12:00:00Z',`,
    `  updatedAt: "2026-09-22T12:00:00Z",`,
  ];
  for (const form of forms) {
    const r = scan({ [FILE]: form });
    assert.deepEqual(r.reported.map((x) => [x.stamp, x.expiresAt]), [["2026-09-22T12:00:00Z", CROSSING]], form);
  }
  const longer = scan({ [FILE]: `last_updated_at: "2026-09-22T12:00:00Z",\nprevupdatedAt: "2026-09-22T12:00:00Z",` });
  assert.equal(longer.population, 0, "a key that merely ends in the field name is a different field");
  const inherited = scan({ [FILE]: forms[0]! }, { base: { [FILE]: forms[1]! } });
  assert.equal(inherited.reported[0]?.inherited, true, "base attribution reads the same key forms the population scan does");
});

test("W1-T6036: a deadline row is dated at its own instant, not a staleness threshold later", () => {
  // Census INPUT, scanned at the pinned NOW: no suite outcome here reads the real clock.
  const r = scan({ [FILE]: [
    `deadline: "2026-10-08T00:00:00.000Z",`, // expiring-fixture: exempt -- census input read at the pinned NOW
    `snoozedUntil: "2026-10-09T00:00:00.000Z",`, // expiring-fixture: exempt -- census input read at the pinned NOW
    `freshUntil: "2026-10-10T00:00:00.000Z",`, // expiring-fixture: exempt -- census input read at the pinned NOW
    `deadline: "2026-10-01T18:00:00.000Z",`, // expiring-fixture: exempt -- census input read at the pinned NOW
    `lastActivityAt: "2026-09-23T00:00:00.000Z",`, // expiring-fixture: exempt -- census input read at the pinned NOW
    `retroAttemptAt: "2026-10-05T20:00:00.000Z",`, // expiring-fixture: exempt -- census input read at the pinned NOW
  ].join("\n") });
  const at = (field: string) => r.reported.filter((x) => x.field === field).map((x) => new Date(x.expiresAt).toISOString());
  assert.deepEqual(at("deadline"), ["2026-10-08T00:00:00.000Z"]);
  assert.deepEqual(at("snoozedUntil"), ["2026-10-09T00:00:00.000Z"]);
  assert.deepEqual(at("freshUntil"), ["2026-10-10T00:00:00.000Z"]);
  assert.deepEqual(at("lastActivityAt"), ["2026-10-07T00:00:00.000Z"]);
  assert.deepEqual(at("retroAttemptAt"), ["2026-10-06T02:00:00.000Z"], "retro backoff's own 6h base delay");
  assert.equal(r.alreadyExpired.length, 1, "a deadline that passed on 10-01 is already past, not reported 14 days late");
});

test("W1-T6036: the census pins both renames against their mapping sources", () => {
  const pins = Object.fromEntries(census.AGED_FIELDS.map((row) => [row.field, [row.source, ...row.evidence]]));
  assert.deepEqual(pins.updated_at, ["src/lib/open-prs-rest.ts", "updatedAt: row.updated_at"]);
  assert.deepEqual(pins.updatedAt, ["src/run-task.ts", "lastActivityAt: pr.updatedAt"]);
  const real = (path: string) => readFileSync(join(ROOT, path), "utf8");
  assert.doesNotThrow(() => census.assertFieldsStillAged(real));
  for (const [source, needle] of [["src/lib/open-prs-rest.ts", "updatedAt: row.updated_at"], ["src/run-task.ts", "lastActivityAt: pr.updatedAt"]]) {
    const dropped = (path: string) => (path === source ? real(path).replaceAll(needle!, "") : real(path));
    assert.throws(() => census.assertFieldsStillAged(dropped), new RegExp(`STALE TABLE.*${source}`), `${source} without the rename`);
  }
});

// ── The gardener confirms before it files ────────────────────────────────────────────────────

type Row = { step: string; extra?: Record<string, unknown> };

function garden(opts: { at?: number; files?: Record<string, string>; realRun?: boolean } = {}) {
  const repo = gitRepo({ kind: "w1t6036-defuse-confirm" });
  const put = (path: string, text: string) => {
    mkdirSync(join(repo.dir, path, ".."), { recursive: true });
    writeFileSync(join(repo.dir, path), text);
  };
  for (const [path, text] of Object.entries(opts.files ?? { [FILE]: `const row = {\n${PRE_9561_LINE}\n};\n` })) put(path, text);
  put("scripts/source-size-baseline.json", "{}\n");
  put("scripts/comment-load-baseline.json", "{}\n");
  put("scripts/learnings-budget-baseline.json", '{"measuredChars":0,"measuredActiveEntries":0}\n');
  put(".github/workflows/ci-gate.yml", 'jobs:\n  ci-gate:\n    env:\n      REQUIRED: >-\n        [\n        "ci"\n        ]\n      ADVISORY: >-\n        [\n        "dashboard"\n        ]\n');
  put("plan/tasks.yaml", "[]\n");
  if (opts.realRun) {
    copyFileSync(join(ROOT, "scripts/clock-shift.mjs"), join(repo.dir, "scripts/clock-shift.mjs"));
    put("test/setup/tmp-hygiene.ts", [
      `if (process.env.RMD_SELF_SYNC_DONE !== undefined) throw new Error("setup refused: RMD_SELF_SYNC_DONE");`,
      `process.env.FIXTURE_SETUP_LOADED = "1";`, "",
    ].join("\n"));
    symlinkSync(join(ROOT, "node_modules"), join(repo.dir, "node_modules"), "dir");
  }
  repo.git("add", ".");
  repo.git("commit", "-qm", "seed defuse confirmation fixture");
  mkdirSync(join(repo.dir, "state"));
  for (const c of ["tighten", "refresh", "demote"]) put(`state/GATE_OFF-${c}`, "");
  const rows: Row[] = [];
  const deps = {
    repoRoot: repo.dir, stateDir: join(repo.dir, "state"), clock: fixedClock(opts.at ?? NOW), seed: 1,
    log: (step: string, extra?: Record<string, unknown>) => rows.push({ step, extra }),
    openWorkspace: () => { throw new Error("no filing in an inventory test"); },
  };
  return { repo, put, deps, rows, unconfirmed: () => rows.filter((r) => r.step === "gate_garden.defuse_unconfirmed").map((r) => r.extra) };
}

/** A runner that answers from a table keyed by shift, recording every call it is asked to make. */
function scripted(answer: (shiftDays: number) => boolean | Error) {
  const calls: Array<[string, number]> = [];
  const runSuite = (file: string, shiftDays: number) => {
    calls.push([file, shiftDays]);
    const a = answer(shiftDays);
    if (a instanceof Error) throw a;
    return a;
  };
  return { calls, runSuite };
}

async function defuses(g: ReturnType<typeof garden>, sources: Record<string, unknown>) {
  const probes = await gardener.loadGateProbes(ROOT);
  const spec = gardener.gateGardenSpec(g.deps, probes, { thresholdDays: STALE_DAYS, openOrigins: () => [], ...sources });
  return spec.inventory().candidates.filter((a) => a.class === "defuse");
}

test("W1-T6036: a finding whose suite fails shifted past the crossing and passes at the control is filed", async () => {
  const g = garden();
  const run = scripted((days) => days < 1);
  const actions = await defuses(g, { runSuite: run.runSuite });
  assert.deepEqual(actions.map((a) => a.target), [`expiring-fixture:${FILE}`]);
  assert.deepEqual(run.calls, [[FILE, 0.001], [FILE, 2]], "control first, then ceil(0.5 days left) + 1");
  assert.deepEqual(g.unconfirmed(), []);
});

test("W1-T6036: a stamp the suite does not depend on is ledgered unconfirmed and never filed", async () => {
  const g = garden();
  const run = scripted(() => true);
  assert.deepEqual(await defuses(g, { runSuite: run.runSuite }), []);
  assert.deepEqual(g.unconfirmed(), [{ file: FILE, line: 2, crossingDate: "2026-10-06T12:00:00.000Z", outcome: "shifted_passed" }]);
});

test("W1-T6036: a suite already red at the control is ledgered control_failed and the shifted run is skipped", async () => {
  const g = garden();
  const run = scripted(() => false);
  assert.deepEqual(await defuses(g, { runSuite: run.runSuite }), []);
  assert.deepEqual(run.calls, [[FILE, 0.001]]);
  assert.deepEqual(g.unconfirmed(), [{ file: FILE, line: 2, crossingDate: "2026-10-06T12:00:00.000Z", outcome: "control_failed" }]);
});

test("W1-T6036: a run that yields no verdict is ledgered run_error, files nothing, and is retried next pass", async () => {
  const g = garden();
  const run = scripted(() => new Error("spawn node ENOENT"));
  assert.deepEqual(await defuses(g, { runSuite: run.runSuite }), []);
  assert.deepEqual(await defuses(g, { runSuite: run.runSuite }), []);
  assert.equal(run.calls.length, 2, "an error is not a verdict, so it is not remembered");
  assert.deepEqual(g.unconfirmed().map((x) => [x!.outcome, x!.error]), [
    ["run_error", "Error: spawn node ENOENT"], ["run_error", "Error: spawn node ENOENT"],
  ]);
});

test("W1-T6036: a verdict is remembered per blob and crossing day, and re-run when either changes", async () => {
  const g = garden();
  const run = scripted(() => true);
  await defuses(g, { runSuite: run.runSuite });
  await defuses(g, { runSuite: run.runSuite });
  assert.equal(run.calls.length, 2, "the second pass reads the remembered verdict instead of re-running");
  assert.equal(g.unconfirmed().length, 1, "and ledgers a verdict only when it is reached");
  await defuses(g, { runSuite: run.runSuite, thresholdDays: STALE_DAYS + 1 });
  assert.equal(run.calls.length, 4, "a new crossing day is a new question");
  g.put(FILE, `const row = {\n${PRE_9561_LINE}\n  other: 1,\n};\n`);
  await defuses(g, { runSuite: run.runSuite });
  assert.equal(run.calls.length, 6, "so is new file content");
  const confirmed = scripted((days) => days < 1);
  assert.equal((await defuses(garden(), { runSuite: confirmed.runSuite })).length, 1);
});

test("W1-T6036: a finding an open filing already covers is deferred without running its suite", async () => {
  const g = garden();
  const run = scripted(() => false);
  assert.deepEqual(await defuses(g, { runSuite: run.runSuite, openOrigins: () => [`expiring-fixture:${FILE}`] }), []);
  assert.deepEqual(run.calls, []);
  assert.equal(g.rows.filter((r) => r.step === "gate_garden.defuse_deferred").length, 1);
});

test("W1-T6036: the default runner really spawns the file under the shifted clock and the repo's test setup", async () => {
  // Stamps are placed against the REAL clock, because the spawned suite reads it: the gardener's
  // census clock is pinned to the same instant so its shift lands just past each crossing.
  const at = Date.now();
  const stamp = new Date(at - (STALE_DAYS - 3) * DAY).toISOString();
  const head = `import assert from "node:assert/strict";\nimport { test } from "node:test";\n`;
  const g = garden({
    at, realRun: true, files: {
      "test/bomb.test.ts": `${head}const row = {\n  updated_at: "${stamp}",\n};\ntest("ages", () => assert.ok(Date.now() - Date.parse(row.updated_at) < ${STALE_DAYS} * ${DAY}));\n`,
      "test/inert.test.ts": `${head}const row = {\n  updated_at: "${stamp}",\n};\ntest("ignores it", () => assert.equal(process.env.FIXTURE_SETUP_LOADED, "1", row.updated_at));\n`,
    },
  });
  const prior = process.env.RMD_SELF_SYNC_DONE;
  process.env.RMD_SELF_SYNC_DONE = "1";
  try {
    const actions = await defuses(g, {});
    assert.deepEqual(actions.map((a) => a.target), ["expiring-fixture:test/bomb.test.ts"]);
  } finally {
    if (prior === undefined) delete process.env.RMD_SELF_SYNC_DONE;
    else process.env.RMD_SELF_SYNC_DONE = prior;
  }
  assert.deepEqual(g.unconfirmed().map((x) => [x!.file, x!.outcome]), [["test/inert.test.ts", "shifted_passed"]]);
});

test("W1-T6036: the default runner throws, rather than reading red, when the run cannot start", () => {
  const runSuiteShifted = (gardener as unknown as { runSuiteShifted: (root: string, file: string, days: number) => boolean }).runSuiteShifted;
  assert.equal(typeof runSuiteShifted, "function");
  assert.throws(() => runSuiteShifted(join(ROOT, "no-such-checkout"), FILE, 2), /ENOENT/);
});
