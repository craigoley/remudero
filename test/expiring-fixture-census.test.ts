import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join as joinPath } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// `scripts/**` sits OUTSIDE tsconfig's `include`, so a STATIC import of the .mjs is a TS7016 and
// fails typecheck — the same reason test/a-source-file-cannot-outgrow-its-baseline.test.ts reaches
// its script this way. A dynamic specifier is not statically resolved, so this loads the REAL
// module with no shadow copy that could drift from it.
const SCRIPT = joinPath(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "expiring-fixture-census.mjs");
const { AGED_FIELDS, EXEMPT_MARKER, MARGIN_DAYS, assertFieldsStillAged, censusExpiringFixtures, formatReport, main } =
  (await import(pathToFileURL(SCRIPT).href)) as {
    AGED_FIELDS: ReadonlyArray<{ field: string; threshold: string; source: string; evidence: string[] }>;
    EXEMPT_MARKER: string;
    MARGIN_DAYS: number;
    assertFieldsStillAged: (readFile?: (p: string) => string) => void;
    censusExpiringFixtures: (o: {
      files: string[];
      readFile: (p: string) => string;
      now: number;
      thresholdDays: number;
      marginDays?: number;
    }) => {
      population: number;
      reported: Array<{ file: string; line: number; daysLeft: number; expiresAt: number }>;
      exempt: unknown[];
      alreadyExpired: unknown[];
    };
    formatReport: (r: unknown, marginDays?: number) => string;
    main: (o?: {
      execFile?: (cmd: string, args: string[], opts: { encoding: "utf8" }) => string;
      readFile?: (p: string) => string;
      now?: () => number;
      log?: (message: string) => void;
      assertAged?: () => void;
    }) => number;
  };

// W1-T3272 — THE REFUSAL FOR A RULE THAT BOUND NOTHING TWICE.
//
// "A fixed date constant compared against rows stamped at REAL time is a time bomb" has been in
// CLAUDE.md since W1-T2250. On 2026-09-09 a fixture stamped 2026-08-26T18:15:00Z crossed the
// sweep's 14-day staleness rung at exactly 18:15:00Z and took `main` red, blocking every PR
// (W1-T3270). CLAUDE.md's own preamble says the answer to a rule that turns out to matter is to
// make something refuse it.

const DAY = 86_400_000;
const NOW = Date.parse("2026-09-09T12:00:00Z");
const THRESHOLD = 14;

/** A fixture tree in memory: the census takes its file list, reader and clock as inputs. */
function tree(files: Record<string, string>) {
  return {
    files: Object.keys(files),
    readFile: (p: string) => files[p],
    now: NOW,
    thresholdDays: THRESHOLD,
  };
}

const at = (msFromNow: number) => new Date(NOW + msFromNow).toISOString();

test("W1-T3272: a fixture about to cross its threshold is reported, and the report names the date it goes red", () => {
  // 13 days old against a 14-day rung: still fresh today, red tomorrow. This is the shape that took
  // main down — green on every check right up to the hour it was not.
  const r = censusExpiringFixtures(
    tree({ "test/a.test.ts": `  lastActivityAt: "${at(-13 * DAY)}",\n` }),
  );
  assert.equal(r.reported.length, 1, "a fixture inside the margin must be reported");
  assert.equal(r.reported[0].file, "test/a.test.ts");
  assert.equal(r.reported[0].line, 1, "and located, so it can be fixed without a search");

  const report = formatReport(r);
  assert.match(report, /BLOCKED/);
  assert.match(report, /goes red 2026-09-10/, "the DATE IT GOES RED is the output that makes this actionable");
  assert.match(report, /sweep\.staleDays/, "and the threshold that judges it is named");
});

test("W1-T3272: the margin fires BEFORE the boundary, not at it — a check that reddens the same hour as the suite has bought nothing", () => {
  const soon = censusExpiringFixtures(tree({ "test/a.test.ts": `lastActivityAt: "${at(-(THRESHOLD - 1) * DAY)}",` }));
  assert.equal(soon.reported.length, 1, `${MARGIN_DAYS}-day margin must catch a fixture one day out`);
  assert.ok(soon.reported[0].daysLeft > 0, "and catch it while it is still GREEN — that is the whole point");

  // Comfortably inside the threshold, well beyond the margin: not yet anyone's problem.
  const far = censusExpiringFixtures(tree({ "test/a.test.ts": `lastActivityAt: "${at(-1 * DAY)}",` }));
  assert.equal(far.reported.length, 0, "a fresh fixture must not be reported");

  // ALREADY past: the suite is green today WITH it expired, so it cannot newly break anything. It
  // is counted and totalled, never a line item — 67 of these exist in this tree, and naming them
  // would bury the two rows that matter.
  const past = censusExpiringFixtures(tree({ "test/a.test.ts": `lastActivityAt: "${at(-40 * DAY)}",` }));
  assert.equal(past.reported.length, 0, "an already-expired stamp is a state, not a transition");
  assert.equal(past.alreadyExpired.length, 1, "but it is still counted, never silently dropped");
});

test("W1-T3272: a fixture whose crossing does not matter opts out WITH ITS REASON, and the exempt set is printed rather than silently skipped", () => {
  const marked = `lastActivityAt: "${at(-13 * DAY)}", // ${EXEMPT_MARKER} -- aged past the rung, nothing failed`;
  const r = censusExpiringFixtures(tree({ "test/a.test.ts": marked }));
  assert.equal(r.reported.length, 0, "a marked fixture must not block");
  assert.equal(r.exempt.length, 1, "but it must still be counted as exempt");
  assert.match(formatReport(r), /exempted by marker/, "an invisible exemption is how a gate quietly stops covering anything");

  // The marker is also honoured on the line ABOVE, so a long line can carry its reason as a comment.
  const above = `// ${EXEMPT_MARKER} -- the case is testing staleness itself\nlastActivityAt: "${at(-13 * DAY)}",`;
  assert.equal(censusExpiringFixtures(tree({ "test/a.test.ts": above })).exempt.length, 1);
});

test("W1-T3272: the census proves it can see its corpus — a table that stops describing the source REFUSES rather than reporting all-clear", () => {
  // THE FAILURE MODE THIS EXISTS FOR: a census whose regex or field name silently stops matching
  // answers with a confident zero, which is worse than not existing. CLAUDE.md documents four
  // separate instruments in this repo that answer wrong rather than erroring.
  assert.doesNotThrow(() => assertFieldsStillAged(), "the table must describe the CURRENT source");

  const blinded = () => assertFieldsStillAged(() => "a source file that ages nothing at all");
  assert.throws(blinded, /STALE TABLE/, "and a table that no longer matches must refuse by name");

  // Population is asserted against the real tree, so a regex that stops matching fails HERE rather
  // than reporting OK over an empty set.
  const real = censusExpiringFixtures({
    files: AGED_FIELDS.length > 0 ? realTestFiles() : [],
    readFile: (p: string) => readFileSync(p, "utf8"),
    now: Date.now(),
    thresholdDays: THRESHOLD,
  });
  assert.ok(real.population > 50, `the census must still see its corpus — measured ${real.population} stamps, expected > 50`);
});

test("W1-T3272: a hardcoded date that NO threshold ages is not reported — the check does not ban dates as such", () => {
  // `createdAt` is a real field on the same fixtures and is not in AGED_FIELDS, because the sweep
  // takes the MINIMUM of the two ages: a fresh lastActivityAt keeps a PR out of the staleness rung
  // however old createdAt is. Flagging it would be noise, and noise is what gets a gate reverted.
  const r = censusExpiringFixtures(tree({ "test/a.test.ts": `createdAt: "${at(-13 * DAY)}",\nsomeOtherDate: "2020-01-01T00:00:00Z",` }));
  assert.equal(r.reported.length, 0, "only fields a live threshold ages are in scope");
  assert.equal(r.population, 0, "and they are not even counted, so the population figure stays meaningful");
});

test("W1-T3272: main reads the real test-file population and sweep staleDays policy through the CLI seams", () => {
  const calls: string[] = [];
  const output: string[] = [];
  const code = main({
    execFile: (cmd, args) => {
      calls.push(`${cmd} ${args.join(" ")}`);
      if (cmd === "git") return "test/a.test.ts\n";
      if (cmd === "node") return JSON.stringify({ staleDays: THRESHOLD });
      throw new Error(`unexpected command: ${cmd}`);
    },
    readFile: () => `lastActivityAt: "${at(-1 * DAY)}",`,
    now: () => NOW,
    log: (message) => output.push(message),
    assertAged: () => undefined,
  });

  assert.equal(code, 0, "fresh fixtures should let the CLI pass");
  assert.deepEqual(calls, [
    "git ls-files test/*.test.ts",
    "node --import tsx -e import {loadDefaultPolicy} from './src/lib/policy.ts'; console.log(JSON.stringify(loadDefaultPolicy().values.sweep));",
  ]);
  assert.match(output.join("\n"), /OK -- 1 fixture stamp/);
});

test("W1-T3272: main returns a blocking exit code when its census reports an expiring fixture", () => {
  const output: string[] = [];
  const code = main({
    execFile: (cmd) => (cmd === "git" ? "test/a.test.ts\n" : JSON.stringify({ staleDays: THRESHOLD })),
    readFile: () => `lastActivityAt: "${at(-13 * DAY)}",`,
    now: () => NOW,
    log: (message) => output.push(message),
    assertAged: () => undefined,
  });

  assert.equal(code, 1, "an expiring fixture must fail the CLI gate");
  assert.match(output.join("\n"), /BLOCKED -- 1 fixture/);
  assert.match(output.join("\n"), /goes red 2026-09-10/);
});

/** The real test corpus, read the way the CLI reads it. */
function realTestFiles(): string[] {
  return execFileSync("git", ["ls-files", "test/*.test.ts"], { encoding: "utf8" }).split("\n").filter(Boolean);
}

test("W1-T3272: a report NAMES the already-expired population, which is state rather than a transition", () => {
  // The distinction this line carries is the whole reason the census does not fail on them: a stamp
  // ALREADY past its threshold is green as it stands, and only a stamp about to CROSS is a bomb.
  // The live run reports 66 of these, so the branch is real; nothing formatted one until now.
  const report = formatReport({
    population: 3,
    reported: [],
    exempt: [],
    alreadyExpired: [{ file: "test/a.test.ts", line: 1 }, { file: "test/b.test.ts", line: 2 }],
  });
  assert.match(report, /none crossing within/, "no crossing stamp still reads as OK");
  assert.match(report, /2 stamp\(s\) are already past their threshold/, "and the settled ones are counted, never dropped");
  assert.match(report, /state, not a transition/, "with the reason a reader needs to not treat them as failures");
});
