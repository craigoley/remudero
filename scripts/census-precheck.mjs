/**
 * THREE CENSUSES, ASKED BEFORE THE PUSH, WITH NO TEST RUNNER.
 *
 * A census walks a whole population and names none of a caller's symbols, so the `git grep
 * <symbol>` sweep an author runs cannot find one this diff breaks. MEASURED in one session
 * (2026-09-23/24): #6955 (fixture-copy), #6962 (comment-load) and #6986 (clock signature) each
 * burned a CI round on exactly that, and #6967 and #7001 turned main red on a comment-load row.
 *
 * W1-T3225 took the census SUITES out of hooks/pre-push: spawning the runner caught none of nine
 * incidents and twice damaged the repository. This asks the same questions a different way: it
 * imports each census's own counter from scripts/, reads files, and spawns only `git merge-base`,
 * `git diff` and `git show`. It builds no fixture and starts no runner. The ONE exception is the
 * instrument-surface census (W1-T5101): its declarations live in src/lib/review.ts, which loads only
 * under tsx, so a diff that can matter spawns scripts/lib/instrument-surface-census.mjs as a child
 * (`node --import tsx`), and a diff that cannot never starts it.
 *
 * W1-T5617 PARTLY REVERSES W1-T3225 for the census-admitted suites: `CENSUS_ADMITTED_MEMBERS`
 * (src/lib/ci-parity.ts) names suites measured under the fast-gate census bound, and only `rmd
 * preflight` ran them, which no worker has run since W1-T464. A diff joining one's `walks` population
 * now RUNS those suites, once, in one `node --test` child with every GIT_* variable stripped (the
 * W1-T3224 mechanism behind the damage W1-T3225 recorded), bounded, and read from its TAP. They run
 * on this tree only, so unlike the counts below a suite main already fails refuses here too.
 *
 * ONLY GROWTH THIS BRANCH CAUSES REFUSES. Each count is taken twice, on this tree and on the merge
 * base with `--base`, and a finding blocks only when the base did not already carry it (or this
 * branch grew it further). A census main already fails is main's to fix. Blocking every push on
 * it would be a bound that fires on a healthy condition, which is this repo's recurring defect.
 *
 * Exit 0 clean, 1 a caused violation, 2 could not measure (the hook does not block on 2).
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isMainModule } from "./lib/argv.mjs";
import { git } from "./lib/git.mjs";
import {
  DEFAULT_BASELINE_RELATIVE_PATH as CLOCK_BASELINE,
  readBaseline as readClockBaseline,
  scanClockSignaturesFromText,
} from "./clock-signature-ratchet.mjs";
import {
  CEILING_BUCKET_COMMENTS,
  DEFAULT_BASELINE_RELATIVE_PATH as COMMENT_BASELINE,
  ceilingForComments,
  countCommentLines,
  isRedundantBaselineRow,
  listMeasuredFiles,
  readBaseline as readCommentBaseline,
} from "./comment-load-ratchet.mjs";
import { DEPS_INTERFACE_BASELINE, DEPS_INTERFACE_CEILING_KEYS, depsInterfaceCounts } from "./deps-interface-census.mjs";
import { HOUSE_LITERALS, houseLiteralCounts, listHouseLayoutSrcFiles } from "./house-layout-census.mjs";
import {
  FIXTURE_COPY_CENSUS_FILENAME,
  FIXTURE_COPY_SIGNATURES,
  countFixtureCopiesInTexts,
  listFixtureCopyFiles,
} from "./fixture-copy-census.mjs";

export const FIXTURE_COPY_BASELINE = "scripts/fixture-copy-baseline.json";

const CLOCK_FIELDS = ["legacy", "dateNow", "newDate"];
const CLOCK_SCOPE_RE = /^src\/.+\.ts$/;
const FIXTURE_SCOPE_RE = /^test\/[^/]+\.test\.ts$/;

/** A count is this branch's to answer for when it is over its ceiling here, and the base was
 *  either under its own ceiling or carried a smaller count. */
function caused(head, headCeiling, base, baseCeiling) {
  return head > headCeiling && (base <= baseCeiling || head > base);
}

function parseOr(text, parse, fallback) {
  return text === null ? fallback : parse(text);
}

function clockViolations({ changed, readHead, readBase }) {
  const headBaseline = parseOr(readHead(CLOCK_BASELINE), (t) => readClockBaseline(t, CLOCK_BASELINE), {});
  const baseBaseline = parseOr(readBase(CLOCK_BASELINE), (t) => readClockBaseline(t, CLOCK_BASELINE), {});
  const paths = new Set(changed.filter((p) => CLOCK_SCOPE_RE.test(p)));
  if (changed.includes(CLOCK_BASELINE)) {
    for (const key of [...Object.keys(headBaseline), ...Object.keys(baseBaseline)]) if (key !== "_comment") paths.add(key);
  }
  const zero = { legacy: 0, dateNow: 0, newDate: 0 };
  const scan = (text) => (text === null ? zero : scanClockSignaturesFromText(text));
  const out = [];
  for (const path of [...paths].sort()) {
    const head = scan(readHead(path));
    const base = scan(readBase(path));
    for (const field of CLOCK_FIELDS) {
      const headCeiling = headBaseline[path]?.[field] ?? 0;
      if (caused(head[field], headCeiling, base[field], baseBaseline[path]?.[field] ?? 0)) {
        out.push(
          `clock-signature: ${path} ${field} ${head[field]} > baseline ${headCeiling} — move it onto ` +
            `src/lib/clock.ts's Clock port, or record the row in ${CLOCK_BASELINE}`,
        );
      }
    }
  }
  return out;
}

function commentLoadViolations({ changed, readHead, readBase, measuredFiles }) {
  const headBaseline = parseOr(readHead(COMMENT_BASELINE), (t) => readCommentBaseline(t, COMMENT_BASELINE), {});
  const baseBaseline = parseOr(readBase(COMMENT_BASELINE), (t) => readCommentBaseline(t, COMMENT_BASELINE), {});
  const measured = new Set(measuredFiles);
  const baselineChanged = changed.includes(COMMENT_BASELINE);
  const paths = new Set(changed.filter((p) => measured.has(p)));
  if (baselineChanged) for (const key of Object.keys(headBaseline)) if (measured.has(key)) paths.add(key);
  const count = (text, path) => (text === null ? 0 : countCommentLines(text, path).comments);
  const out = [];
  for (const path of [...paths].sort()) {
    const text = readHead(path);
    if (text === null) continue;
    const head = count(text, path);
    const headCeiling = headBaseline[path] ?? CEILING_BUCKET_COMMENTS;
    if (caused(head, headCeiling, count(readBase(path), path), baseBaseline[path] ?? CEILING_BUCKET_COMMENTS)) {
      out.push(
        `comment-load: ${path} has ${head} comment lines > ceiling ${headCeiling} — trim them, or record ` +
          `"${path}": ${ceilingForComments(head)} in ${COMMENT_BASELINE}`,
      );
    }
  }
  if (baselineChanged) {
    for (const [path, value] of Object.entries(headBaseline)) {
      if (path === "_comment" || !isRedundantBaselineRow(value) || baseBaseline[path] === value) continue;
      out.push(
        `comment-load: ${COMMENT_BASELINE} records "${path}" at ${value}, the default bucket — an absent ` +
          "row already means that, so drop the row",
      );
    }
  }
  return out;
}

function fixtureCopyViolations({ changed, readHead, readBase, testFiles }) {
  const scoped = changed.filter((p) => FIXTURE_SCOPE_RE.test(p) && !p.endsWith(`/${FIXTURE_COPY_CENSUS_FILENAME}`));
  if (scoped.length === 0 && !changed.includes(FIXTURE_COPY_BASELINE)) return [];
  const headBaseline = parseOr(readHead(FIXTURE_COPY_BASELINE), JSON.parse, {});
  const baseBaseline = parseOr(readBase(FIXTURE_COPY_BASELINE), JSON.parse, {});
  const headTexts = new Map();
  for (const name of testFiles) {
    const text = readHead(`test/${name}`);
    if (text !== null) headTexts.set(name, text);
  }
  // The base population is this tree with each changed test file read at the base instead — the
  // unchanged files are identical on both sides, so only the diff is fetched from git.
  const baseTexts = new Map(headTexts);
  for (const path of scoped) {
    const name = path.slice("test/".length);
    const text = readBase(path);
    if (text === null) baseTexts.delete(name);
    else baseTexts.set(name, text);
  }
  const head = countFixtureCopiesInTexts(headTexts);
  const base = countFixtureCopiesInTexts(baseTexts);
  return FIXTURE_COPY_SIGNATURES.filter((sig) =>
    caused(head[sig], headBaseline[sig] ?? 0, base[sig], baseBaseline[sig] ?? 0),
  ).map(
    (sig) =>
      `fixture-copy: ${sig} ${head[sig]} > baseline ${headBaseline[sig] ?? 0} — build the fixture with ` +
      "test/helpers/ (git-repo.ts, fake-github.ts, gh-shim.ts, ledger-fixture.ts) instead of by hand",
  );
}

/** Every src file's text on this tree, and the same population with each changed src file read at the merge
 *  base instead — the unchanged files are identical on both sides, so only the diff is fetched from git. */
function srcTextsOnBothSides({ scoped, readHead, readBase, srcFiles = [] }) {
  const headTexts = new Map();
  for (const path of srcFiles) {
    const text = readHead(path);
    if (text !== null) headTexts.set(path, text);
  }
  const baseTexts = new Map(headTexts);
  for (const path of scoped) {
    const text = readBase(path);
    if (text === null) baseTexts.delete(path);
    else baseTexts.set(path, text);
  }
  return { head: [...headTexts.values()], base: [...baseTexts.values()] };
}

function houseLayoutViolations(input) {
  const scoped = input.changed.filter((p) => CLOCK_SCOPE_RE.test(p));
  if (scoped.length === 0) return [];
  const texts = srcTextsOnBothSides({ ...input, scoped });
  const head = houseLiteralCounts(texts.head);
  const base = houseLiteralCounts(texts.base);
  return HOUSE_LITERALS.filter((literal) => caused(head[literal], base[literal], base[literal], base[literal])).map(
    (literal) =>
      `house-layout: ${literal} now in ${head[literal]} non-test src files, up from ${base[literal]} at the ` +
      "merge base — resolve it through resolveRepoLayout (src/lib/repo-layout.ts)",
  );
}

function depsInterfaceViolations(input) {
  const scoped = input.changed.filter((p) => CLOCK_SCOPE_RE.test(p));
  if (scoped.length === 0 && !input.changed.includes(DEPS_INTERFACE_BASELINE)) return [];
  const headBaseline = parseOr(input.readHead(DEPS_INTERFACE_BASELINE), JSON.parse, {});
  const baseBaseline = parseOr(input.readBase(DEPS_INTERFACE_BASELINE), JSON.parse, {});
  const texts = srcTextsOnBothSides({ ...input, scoped });
  const head = depsInterfaceCounts(texts.head);
  const base = depsInterfaceCounts(texts.base);
  const out = [];
  for (const [count, key] of Object.entries(DEPS_INTERFACE_CEILING_KEYS)) {
    // The lower of the two ceilings, so raising one in this diff never excuses the growth it rides in on.
    const ceiling = Math.min(headBaseline[key] ?? Infinity, baseBaseline[key] ?? Infinity);
    if (caused(head[count], ceiling, base[count], baseBaseline[key] ?? Infinity)) {
      out.push(
        `deps-interface: ${count} ${head[count]} > baseline ${ceiling} — reuse an existing seam ` +
          '(Pick<PreflightFastDeps, "spawn"> is the counted-sibling remedy) instead of adding another *Deps shape',
      );
    }
  }
  return out;
}

/**
 * Every census violation this branch causes. Pure over its readers, so every arm is testable
 * without git: `readHead` and `readBase` return a repo-relative file's text on this tree and at
 * the merge base, or null when it does not exist there.
 *
 * @param {{ changed: string[], readHead: (p: string) => string | null, readBase: (p: string) => string | null,
 *   measuredFiles: string[], testFiles: string[] }} input
 */
export function evaluateCensusPrecheck(input) {
  return [
    ...clockViolations(input),
    ...commentLoadViolations(input),
    ...fixtureCopyViolations(input),
    ...houseLayoutViolations(input),
    ...depsInterfaceViolations(input),
  ];
}

const INSTRUMENT_SCOPE_RE = /^(?:\.github\/workflows\/|scripts\/|package\.json$|src\/lib\/review\.ts$)/;
const INSTRUMENT_CHILD = fileURLToPath(new URL("./lib/instrument-surface-census.mjs", import.meta.url));
const INSTRUMENT_CHILD_CWD = resolve(dirname(INSTRUMENT_CHILD), "..", "..");
// BACKSTOP only: a healthy derivation takes well under a second; this ends a hung child as not measured.
const INSTRUMENT_CHILD_TIME_BOUND_MS = 60_000;

function isSide(side) {
  return Boolean(side) && Array.isArray(side.candidates) && Array.isArray(side.gaps);
}

/**
 * Runs the shared derivation as a child under tsx over `root` and its merge base. THROWS, naming why, on
 * every way the measurement can fail (spawn error, time bound, signal, non-zero exit, output that is not
 * the `{ head, base }` shape): the caller reports each as NOT MEASURED, never as a clean tree.
 */
export function measureViaChild({ root, mergeBase, run = spawnSync }) {
  const res = run(
    process.execPath,
    ["--import", "tsx", INSTRUMENT_CHILD, "--root", root, "--merge-base", mergeBase],
    { cwd: INSTRUMENT_CHILD_CWD, encoding: "utf8", timeout: INSTRUMENT_CHILD_TIME_BOUND_MS, maxBuffer: 64 * 1024 * 1024 },
  );
  if (res.error) throw new Error(`the derivation child could not run to completion: ${res.error.message}`);
  if (res.signal) throw new Error(`the derivation child was ended by ${res.signal}`);
  if (res.status !== 0) {
    throw new Error(`the derivation child exited ${res.status}: ${String(res.stderr || "no diagnostic").trim().slice(0, 300)}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(String(res.stdout).trim());
  } catch (e) {
    throw new Error(`the derivation child printed output that is not JSON: ${String(e.message ?? e)}`);
  }
  if (!isSide(parsed?.head) || !isSide(parsed?.base)) {
    throw new Error("the derivation child printed JSON that is not { head, base } of { candidates, gaps }");
  }
  return parsed;
}

/**
 * The instrument-surface census, as a pure check over an injected measurement. A gap at head the merge base
 * did not carry is this branch's doing: one row each, on ONE physical line, because src/run-task.ts
 * censusPushRefusal reads a row as `^\s+[a-z][\w-]*: ` and the remedy file from a tail `... in <file>`.
 * Every failure to measure is `unmeasured` with its reason, never an empty violation list.
 *
 * @param {{ changed: string[], measureInstrumentSurface?: () => { head: { candidates: string[], gaps: string[] },
 *   base: { candidates: string[], gaps: string[] } } }} input
 * @returns {{ violations: string[], unmeasured: string | null }}
 */
export function evaluateInstrumentSurface(input) {
  if (!input.changed.some((p) => INSTRUMENT_SCOPE_RE.test(p))) return { violations: [], unmeasured: null };
  if (typeof input.measureInstrumentSurface !== "function") return { violations: [], unmeasured: "no measurement supplied" };
  let measured;
  try {
    measured = input.measureInstrumentSurface();
  } catch (e) {
    return { violations: [], unmeasured: String(e?.message ?? e) };
  }
  if (!isSide(measured?.head) || !isSide(measured?.base)) {
    return { violations: [], unmeasured: "the measurement is not { head, base } of { candidates, gaps }" };
  }
  if (measured.head.candidates.length === 0) {
    return { violations: [], unmeasured: "the derivation found no candidates at all, which is a failed read, not a clean tree" };
  }
  const carried = new Set(measured.base.gaps);
  const violations = measured.head.gaps
    .filter((path) => !carried.has(path))
    .sort()
    .map(
      (path) =>
        `instrument-surface: ${path} is neither on INSTRUMENT_SURFACE nor excused in INSTRUMENT_SURFACE_EXCLUSIONS - ` +
        `TO FIX: add a "^${path.replace(/[\\.]/g, "\\$&")}$" pattern to INSTRUMENT_SURFACE if it is gate-rule logic, ` +
        "or record a reasoned exclusion in INSTRUMENT_SURFACE_EXCLUSIONS if it is not, both in src/lib/review.ts",
    );
  return { violations, unmeasured: null };
}

const SCRIPT_REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TMP_HYGIENE_URL = pathToFileURL(join(SCRIPT_REPO, "test", "setup", "tmp-hygiene.ts")).href;
const ADMISSION_TABLE = "src/lib/ci-parity.ts";
// BACKSTOP only: the seven admitted suites take 6-10 s together on an 8-core host; this ends a hung child as not measured.
const CENSUS_SUITE_CHILD_TIME_BOUND_MS = 60_000;
// A hook's GIT_DIR family (W1-T3224), a parent runner's context (it turns the child's TAP into v8 frames), and
// the lanes' read-only escape, which only flips checkCliFreshness — no census reads it — and makes the setup refuse.
const CHILD_ENV_DROPPED = /^(?:GIT_|NODE_TEST_CONTEXT$|RMD_SELF_SYNC_DONE$)/;

function childEnv() {
  return Object.fromEntries(Object.entries(process.env).filter(([k]) => !CHILD_ENV_DROPPED.test(k)));
}

function childOptions(root) {
  return { cwd: root, encoding: "utf8", env: childEnv(), timeout: CENSUS_SUITE_CHILD_TIME_BOUND_MS, maxBuffer: 64 * 1024 * 1024 };
}

/** Throws, naming why, when a child did not run to a status: a spawn error (the time bound included) or a signal. */
function assertChildFinished(res, what) {
  if (res.error) throw new Error(`the ${what} child could not run to completion: ${res.error.message}`);
  if (res.signal) throw new Error(`the ${what} child was ended by ${res.signal}`);
}

function isMember(m) {
  return typeof m?.testFile === "string" && typeof m.script === "string" && Array.isArray(m.walks) && m.walks.length > 0;
}

/**
 * The tree's own `CENSUS_ADMITTED_MEMBERS` as `{ testFile, script, walks }`, read by a child under tsx because
 * the table is TypeScript. A tree that carries no table has no admitted suites; every failure to read one that
 * exists THROWS, and an empty list is a failed read, never a clean set.
 */
export function listAdmittedCensusMembers(root, run = spawnSync) {
  const table = join(root, ADMISSION_TABLE);
  if (!existsSync(table)) return [];
  const code =
    `const m = await import(${JSON.stringify(pathToFileURL(table).href)});` +
    "console.log(JSON.stringify(m.CENSUS_ADMITTED_MEMBERS.map((x) => ({ testFile: x.testFile, script: x.script, walks: [...(x.walks ?? [])] }))));";
  const res = run(process.execPath, ["--import", import.meta.resolve("tsx"), "--input-type=module", "-e", code], childOptions(root));
  assertChildFinished(res, "admission table");
  if (res.status !== 0) {
    throw new Error(`the admission table child exited ${res.status}: ${String(res.stderr || "no diagnostic").trim().slice(0, 300)}`);
  }
  let members;
  try {
    members = JSON.parse(String(res.stdout).trim());
  } catch (e) {
    throw new Error(`the admission table child printed output that is not JSON: ${String(e.message ?? e)}`);
  }
  if (!Array.isArray(members) || !members.every(isMember)) {
    throw new Error("the admission table child printed JSON that is not a list of { testFile, script, walks }");
  }
  if (members.length === 0) throw new Error(`${ADMISSION_TABLE} lists no admitted member, which is a failed read, not a clean set`);
  return members;
}

/** The given suites a TAP stream fails, read from each TOP-LEVEL `not ok` and its `location:`. Throws on a
 *  failure it cannot attribute to one of `files`, so an unread failure is never dropped. */
function failingSuitesFromTap(stdout, files) {
  const lines = stdout.split("\n");
  const failing = new Set();
  lines.forEach((line, i) => {
    if (!/^not ok \d+ - /.test(line)) return;
    let location = null;
    for (let j = i + 1; j < lines.length && /^\s/.test(lines[j]); j++) {
      location ??= lines[j].match(/^ {2}location: '(.*):\d+:\d+'$/)?.[1] ?? null;
    }
    const file = files.find((f) => location === f || location?.endsWith(`/${f}`));
    if (file === undefined) throw new Error(`the census suite child failed a test its TAP attributes to no suite it was given: ${line}`);
    failing.add(file);
  });
  return [...failing];
}

/**
 * Runs `files` (repo-relative suite paths) once, in ONE `node --test` child over `root`, and returns the ones
 * that fail. THROWS, naming why, on every way the run can fail to be a measurement (spawn error, time bound,
 * signal, no `# tests` summary, zero tests, a non-zero exit its TAP does not explain): never `[]` for those.
 */
export function runCensusSuitesViaChild({ root, files, run = spawnSync }) {
  const args = ["--test", "--test-reporter=tap", "--import", import.meta.resolve("tsx"), "--import", TMP_HYGIENE_URL, ...files];
  const res = run(process.execPath, args, childOptions(root));
  assertChildFinished(res, "census suite");
  const stdout = String(res.stdout ?? "");
  const total = stdout.match(/^# tests (\d+)$/m);
  if (total === null) {
    throw new Error(
      `the census suite child printed no \`# tests\` summary (exit ${res.status}): ${String(res.stderr || "no diagnostic").trim().slice(0, 300)}`,
    );
  }
  if (Number(total[1]) === 0) throw new Error("the census suite child ran 0 tests, which is a failed run, not a clean one");
  const failing = failingSuitesFromTap(stdout, files);
  if (res.status !== 0 && failing.length === 0) {
    throw new Error(`the census suite child exited ${res.status} but its TAP names no failing suite`);
  }
  return failing;
}

/**
 * The admitted census suites this diff joins, run. A member joins when a changed path starts with one of its
 * `walks` prefixes; the joined suites run once through `runSuites`, and each failing one is a row on ONE physical
 * line in the shape src/run-task.ts censusPushRefusal reads. A diff joining none starts no child. Every failure
 * to read the table or run the suites is `unmeasured` with its reason, never an empty violation list.
 *
 * @param {{ changed: string[], loadMembers: () => { testFile: string, script: string, walks: string[] }[],
 *   runSuites: (files: string[]) => string[] }} input
 * @returns {{ violations: string[], unmeasured: string | null }}
 */
export function evaluateAdmittedCensusSuites({ changed, loadMembers, runSuites }) {
  if (changed.length === 0) return { violations: [], unmeasured: null };
  let members;
  try {
    members = loadMembers();
  } catch (e) {
    return { violations: [], unmeasured: String(e?.message ?? e) };
  }
  const joined = members.filter((m) => changed.some((p) => m.walks.some((w) => p.startsWith(w))));
  if (joined.length === 0) return { violations: [], unmeasured: null };
  let failing;
  try {
    failing = new Set(runSuites([...new Set(joined.map((m) => m.testFile))]));
  } catch (e) {
    return { violations: [], unmeasured: String(e?.message ?? e) };
  }
  const violations = joined
    .filter((m) => failing.has(m.testFile))
    .map((m) => `census-suite: ${m.testFile} fails — run npm run ${m.script}`);
  return { violations, unmeasured: null };
}

export const PRECHECK_PARITY_BASELINE = "scripts/census-precheck-parity-baseline.json";

/** Every census suite this script asks before the push, and how: `modeled` names the check that asks its
 *  question here, `run` an npm script that runs it. test/every-ci-census-is-asked-before-the-push.test.ts
 *  fails on a CI census on neither this nor the shrink-only baseline above (W1-T5616). */
export const PRECHECK_PARITY = {
  "test/clock-signature-census.test.ts": { modeled: clockViolations },
  "test/comment-load-ratchet.test.ts": { modeled: commentLoadViolations },
  "test/fixture-copy-census.test.ts": { modeled: fixtureCopyViolations },
  "test/deps-interface-census.test.ts": { modeled: depsInterfaceViolations },
  "test/repo-layout.test.ts": { modeled: houseLayoutViolations },
  "test/instrument-surface-completeness.test.ts": { modeled: evaluateInstrumentSurface },
  "test/census-precheck-runs-the-admitted-census-suites.test.ts": { modeled: evaluateAdmittedCensusSuites },
  // W1-T5617: CENSUS_ADMITTED_MEMBERS, run through each one's own npm script's suite.
  "test/bound-kind-declared.test.ts": { run: "census:bound-kind" },
  "test/ledger-literal-census.test.ts": { run: "census:ledger-literal" },
  "test/catch-erasure-ratchet.test.ts": { run: "census:catch-erasure" },
  "test/negative-reachability-ratchet.test.ts": { run: "census:negative-reachability" },
  "test/authority-ratchet.test.ts": { run: "census:authority" },
  "test/no-shallowing-of-the-canonical-checkout.test.ts": { run: "census:no-shallowing" },
  "test/no-draft-pull-request-ever-sits-on-the-board.test.ts": { run: "census:no-draft-pr" },
};

/** Census suites CI runs only in its ci/coverage shards, because no census name puts them in
 *  `listRuleSuites`; each with the incident that showed a push was blind to it. */
export const PRECHECK_EXTRA_CI_CENSUSES = {
  "test/spend-is-counted-once-at-its-producer.test.ts": "SPEND_STEP_ROLES — #8988 #9041",
  "test/ledger-rotation.test.ts": "DECISION_RELEVANT_LEDGER_STEPS — #8988 #9041",
  "test/a-union-read-of-an-unretained-step-is-refused.test.ts": "DECISION_RELEVANT_LEDGER_STEPS — #8988 #9041",
  "test/host-capability-fixtures.test.ts": "host-capability-fixtures — #8994",
};

/** CI's census population: the rule-check suites plus the extras, once each, sorted. */
export function ciCensusPopulation(ruleSuites, extras = PRECHECK_EXTRA_CI_CENSUSES) {
  return [...new Set([...ruleSuites, ...Object.keys(extras)])].sort();
}

/**
 * The parity verdict. `unasked`: a population member neither on `parity` nor baselined. `stale`: a
 * baseline row `parity` now asks or the population no longer holds, which must leave the baseline.
 * `grown`: a row `baseBaseline` (the merge base's rows, null when it had no baseline) did not carry.
 */
export function precheckParityVerdict({ population, baseline, baseBaseline = null, parity = PRECHECK_PARITY }) {
  const members = new Set(population);
  const baselined = new Set(baseline);
  const carried = new Set(baseBaseline ?? baseline);
  return {
    unasked: population.filter((p) => !Object.hasOwn(parity, p) && !baselined.has(p)).sort(),
    stale: baseline.filter((p) => Object.hasOwn(parity, p) || !members.has(p)).sort(),
    grown: baseline.filter((p) => !carried.has(p)).sort(),
  };
}

function gitOut(root, args) {
  const res = git(args, { cwd: root });
  if (res.status !== 0) throw new Error(`git ${args[0]}: ${(res.stderr || "no diagnostic").trim()}`);
  return res.stdout;
}

export function main(argv, { measure = measureViaChild, admitted = listAdmittedCensusMembers, runSuites = runCensusSuitesViaChild } = {}) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: { root: { type: "string", default: "." }, base: { type: "string", default: "origin/main" } },
    }));
  } catch (e) {
    console.error(`census-precheck: could not measure — ${String(e.message ?? e)}`);
    return 2;
  }
  const root = resolve(values.root);
  let violations;
  let changed;
  const unmeasured = [];
  try {
    const mergeBase = gitOut(root, ["merge-base", "HEAD", values.base]).trim();
    changed = gitOut(root, ["diff", "--name-only", "--no-renames", mergeBase]).split("\n").filter(Boolean);
    violations = evaluateCensusPrecheck({
      changed,
      readHead: (p) => (existsSync(join(root, p)) ? readFileSync(join(root, p), "utf8") : null),
      readBase: (p) => {
        const res = git(["show", `${mergeBase}:${p}`], { cwd: root });
        return res.status === 0 ? res.stdout : null;
      },
      measuredFiles: listMeasuredFiles(root),
      testFiles: listFixtureCopyFiles(root),
      srcFiles: listHouseLayoutSrcFiles(root),
    });
    const instrument = evaluateInstrumentSurface({
      changed,
      measureInstrumentSurface: () => measure({ root, mergeBase }),
    });
    violations.push(...instrument.violations);
    if (instrument.unmeasured !== null) unmeasured.push(`instrument-surface NOT MEASURED - ${instrument.unmeasured}`);
    const suites = evaluateAdmittedCensusSuites({
      changed,
      loadMembers: () => admitted(root),
      runSuites: (files) => runSuites({ root, files }),
    });
    violations.push(...suites.violations);
    if (suites.unmeasured !== null) unmeasured.push(`census suites NOT MEASURED - ${suites.unmeasured}`);
  } catch (e) {
    console.error(`census-precheck: could not measure — ${String(e.message ?? e)}`);
    return 2;
  }
  if (violations.length > 0) {
    console.error(`census-precheck: this branch grows ${violations.length} census count(s) CI will refuse:`);
    for (const v of violations) console.error(`  ${v}`);
    // AFTER the rows: censusPushRefusal stops at the first line that is not a row, so this cannot drop one.
    for (const u of unmeasured) console.error(`census-precheck: ${u}`);
    return 1;
  }
  if (unmeasured.length > 0) {
    for (const u of unmeasured) console.error(`census-precheck: ${u}`);
    return 2;
  }
  console.log(`census-precheck: OK — ${changed.length} changed file(s) checked against ${values.base}`);
  return 0;
}

if (isMainModule(import.meta.url)) process.exit(main(process.argv.slice(2)));
