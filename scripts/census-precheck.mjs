/**
 * CENSUS COUNTS AND SUITES, ASKED BEFORE THE PUSH.
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
 * now RUNS those suites in a `node --test` child with every GIT_* variable stripped (the
 * W1-T3224 mechanism behind the damage W1-T3225 recorded), bounded, and read from its TAP. They run
 * on head; failing suites run again in a private merge-base checkout borrowing node_modules.
 * Only head-red/base-green refuses; an unrunnable base is not measured (W1-T5663).
 *
 * ONLY GROWTH THIS BRANCH CAUSES REFUSES. Each count is taken twice, on this tree and on the merge
 * base with `--base`, and a finding blocks only when the base did not already carry it (or this
 * branch grew it further). A census main already fails is main's to fix. Blocking every push on
 * it would be a bound that fires on a healthy condition, which is this repo's recurring defect.
 *
 * Exit 0 clean, 1 a caused violation, 2 could not measure (the hook does not block on 2).
 */
import { spawnSync } from "node:child_process";
import { isRuleSuitePath } from "../src/lib/rule-suites.ts";
import { createHash } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { loadavg, tmpdir } from "node:os";
import { delimiter, dirname, join, posix, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { parseArgs } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createScanner, SyntaxKind } from "typescript/unstable/ast";
import { isMainModule } from "./lib/argv.mjs";
import { git } from "./lib/git.mjs";
// A static import keeps the codemod an ES module: require()-ing it under tsx compiles it as
// CommonJS, which reports a synthetic scripts/<define:import.meta> coverage source.
import { analyzeSource } from "./test-repo-root-codemod.mjs";
import { scanSource as scanChildCoverage } from "./coverage-session-blanking-check.mjs";
import { captureStepSync } from "./lib/author-step-capture.mjs";
import { retainFixture } from "./lib/retained-fixtures.mjs";
import { measureTree } from "./lib/instrument-surface-census.mjs";
import {
  DEFAULT_BASELINE_RELATIVE_PATH as CLOCK_BASELINE,
  readBaseline as readClockBaseline,
  scanClockSignaturesFromText,
} from "./clock-signature-ratchet.mjs";
import {
  CEILING_BUCKET_COMMENTS,
  MEASURED_ROOTS,
  countCommentLines,
  listMeasuredFiles,
} from "./comment-load-ratchet.mjs";
import { DEPS_INTERFACE_BASELINE, DEPS_INTERFACE_CEILING_KEYS, depsInterfaceCounts } from "./deps-interface-census.mjs";
import { HOUSE_LITERALS, houseLiteralCounts, listHouseLayoutSrcFiles, qualifiedRunTaskLayoutSplit } from "./house-layout-census.mjs";
import {
  FIXTURE_COPY_CENSUS_FILENAME,
  FIXTURE_COPY_SIGNATURES,
  countFixtureCopiesInTexts,
  listFixtureCopyFiles,
} from "./fixture-copy-census.mjs";

export const FIXTURE_COPY_BASELINE = "scripts/fixture-copy-baseline.json";
export const CENSUS_SNAPSHOT_ENV = "RMD_CENSUS_SNAPSHOT";
export const CENSUS_SNAPSHOT_ROOTS = [...MEASURED_ROOTS, "test", "plan"];

export function readCensusSnapshot(path = process.env[CENSUS_SNAPSHOT_ENV]) {
  if (!path) return null;
  const snapshot = JSON.parse(readFileSync(path, "utf8"));
  if (snapshot.version !== 1 || typeof snapshot.root !== "string" || typeof snapshot.mergeBase !== "string" ||
      !Array.isArray(snapshot.headPaths) || !Array.isArray(snapshot.basePaths) ||
      !snapshot.baseBlobs || typeof snapshot.baseBlobs !== "object" || Array.isArray(snapshot.baseBlobs) ||
      !snapshot.mainBlobs || typeof snapshot.mainBlobs !== "object" || Array.isArray(snapshot.mainBlobs)) {
    throw new Error("invalid census snapshot");
  }
  for (const name of [...snapshot.headPaths, ...snapshot.basePaths, ...Object.keys(snapshot.baseBlobs), ...Object.keys(snapshot.mainBlobs)]) {
    if (typeof name !== "string" || posix.isAbsolute(name) || name.split("/").includes("..")) {
      throw new Error("invalid census snapshot path");
    }
  }
  if (snapshot.basePaths.some((p) => typeof snapshot.baseBlobs[p] !== "string") ||
      Object.values(snapshot.mainBlobs).some((text) => typeof text !== "string")) throw new Error("invalid census snapshot blobs");
  return snapshot;
}

// Include new census files before the harness stages them; deleted files disappear from the live population.
export function censusSnapshotPaths(snapshot) {
  const paths = new Set(snapshot.headPaths.filter((p) => existsSync(join(snapshot.root, p))));
  function walk(dir) {
    if (!existsSync(join(snapshot.root, dir))) return;
    for (const entry of readdirSync(join(snapshot.root, dir), { withFileTypes: true })) {
      const path = posix.join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && (/\.(?:ts|mts|mjs|js|cjs|json|ya?ml|sh|toml|txt)$/.test(path) || !posix.extname(path))) paths.add(path);
    }
  }
  for (const dir of CENSUS_SNAPSHOT_ROOTS) walk(dir);
  return [...paths].sort();
}

const CLOCK_FIELDS = ["legacy", "dateNow", "newDate"];
const CLOCK_SCOPE_RE = /^src\/.+\.ts$/;
/** A test file at any depth under test/, except test/fixtures/** (data, never a suite). */
const FIXTURE_SCOPE_RE = /^test\/(?!fixtures\/)(?:[^/]+\/)*[^/]+\.test\.ts$/;

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

function commentLoadViolations({ changed, readHead, measuredFiles, reportCommentSignal = () => {} }) {
  const measured = new Set(measuredFiles);
  for (const path of changed.filter(path => measured.has(path))) {
    const text = readHead(path);
    if (text === null) continue;
    const { comments } = countCommentLines(text, path);
    if (comments > CEILING_BUCKET_COMMENTS) reportCommentSignal({ path, comments, policy: "nonblocking-followup" });
  }
  return [];
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
  return { head: [...headTexts.values()], base: [...baseTexts.values()], headByPath: headTexts, baseByPath: baseTexts };
}

function houseLayoutViolations(input) {
  const scoped = input.changed.filter((p) => CLOCK_SCOPE_RE.test(p));
  if (scoped.length === 0) return [];
  const texts = srcTextsOnBothSides({ ...input, scoped });
  const head = houseLiteralCounts(texts.head);
  const base = houseLiteralCounts(texts.base);
  const split = qualifiedRunTaskLayoutSplit(texts.baseByPath, texts.headByPath);
  for (const [literal, count] of Object.entries(split)) {
    input.reportHouseLayoutSplit?.(`house-layout: W1-T9332 qualified structural split: ${literal} raw physical files ${head[literal]}, merge base ${base[literal]}; excluding ${count} conserved split duplicate`);
  }
  return HOUSE_LITERALS.filter((literal) => caused(head[literal] - (split[literal] ?? 0), base[literal], base[literal], base[literal])).map(
    (literal) =>
      `house-layout: ${literal} now in ${head[literal]} non-test src files, up from ${base[literal]} at the ` +
      "merge base — resolve it through resolveRepoLayout (src/lib/repo-layout.ts)" +
      (split[literal] ? " [W1-T9332 qualified structural split: one physical duplicate excluded]" : ""),
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

function testRepoRootViolations({ changed, readHead, readBase }) {
  const paths = changed.filter((p) => /^test\/(?!helpers\/|setup\/|lib\/|fixtures\/).*\.test\.ts$/.test(p));
  const out = [];
  let headCount = 0;
  let baseCount = 0;
  for (const path of paths) {
    const head = readHead(path);
    const base = readBase(path);
    const derivesRoot = (text) => {
      if (text === null || !/import\s*\.\s*meta|__dirname/.test(text)) return false;
      return analyzeSource(text, path).computations.length > 0;
    };
    const headOwnsRoot = derivesRoot(head);
    headCount += Number(headOwnsRoot);
    baseCount += Number(derivesRoot(base));
    if (base === null && headOwnsRoot) {
      out.push(`test-repo-root: new test ${path} derives its own root — import #test/helpers/repo-root.js`);
    }
  }
  // Unchanged files cancel: comparing changed-file counts asks the whole-tree ratchet's question.
  if (headCount > baseCount) {
    out.push(`test-repo-root: own-folder root files in the diff head=${headCount}, merge base=${baseCount} — ` +
      "import #test/helpers/repo-root.js; run test/every-test-finds-the-repo-root-through-one-helper.test.ts");
  }
  return out;
}

/**
 * Every census violation this branch causes. Pure over its readers, so every arm is testable
 * without git: `readHead` and `readBase` return a repo-relative file's text on this tree and at
 * the merge base, or null when it does not exist there.
 *
 * @param {{ changed: string[], readHead: (p: string) => string | null, readBase: (p: string) => string | null,
 *   measuredFiles: string[], testFiles: string[], reportHouseLayoutSplit?: (line: string) => void }} input
 */
export function evaluateCensusPrecheck(input) {
  return [
    ...clockViolations(input),
    ...commentLoadViolations(input),
    ...fixtureCopyViolations(input),
    ...houseLayoutViolations(input),
    ...depsInterfaceViolations(input),
    ...scriptRatchetViolations(input),
    ...testRepoRootViolations(input),
  ];
}

const CI_YAML_PATH = ".github/workflows/ci.yml";

/** W1-T5737: a push that edits ci.yml or the parity baseline must leave every script gate ci.yml runs with a
 *  verdict — asked in PRECHECK_SCRIPT_PARITY, or a reasoned `ciOnlyScripts` row. Reads only the two files. */
function scriptRatchetViolations({ changed, readHead }) {
  if (!changed.includes(CI_YAML_PATH) && !changed.includes(PRECHECK_PARITY_BASELINE)) return [];
  const ci = readHead(CI_YAML_PATH);
  const baselineText = readHead(PRECHECK_PARITY_BASELINE);
  if (ci === null || baselineText === null) return [];
  let rows;
  try {
    rows = JSON.parse(baselineText).ciOnlyScripts;
  } catch {
    return [];
  }
  if (typeof rows !== "object" || rows === null || Array.isArray(rows)) return [];
  const verdict = scriptRatchetParityVerdict({ population: ciScriptRatchetPopulation(ci), baseline: rows });
  return verdict.unasked.map(
    (key) =>
      `script-ratchet: ${key} runs in ${CI_YAML_PATH} but nothing asks it before the push — model it in ` +
      `PRECHECK_SCRIPT_PARITY (scripts/census-precheck.mjs) or record a reason under ciOnlyScripts in ${PRECHECK_PARITY_BASELINE}`,
  );
}

const INSTRUMENT_SCOPE_RE = /^(?:\.github\/workflows\/|scripts\/|package\.json$|src\/lib\/review\.ts$)/;
const INSTRUMENT_CHILD = fileURLToPath(new URL("./lib/instrument-surface-census.mjs", import.meta.url));
const INSTRUMENT_CHILD_CWD = resolve(dirname(INSTRUMENT_CHILD), "..", "..");
// BACKSTOP only: a healthy derivation takes well under a second; this ends a hung child as not measured.
const INSTRUMENT_CHILD_TIME_BOUND_MS = 60_000;

function isSide(side) {
  return Boolean(side) && Array.isArray(side.candidates) && Array.isArray(side.gaps);
}

/** A `[ "pattern", ... ];` array literal of plain strings, or [] for any other shape. */
function branchSurfacePatterns(scanner) {
  if (scanner.scan() !== SyntaxKind.OpenBracketToken) return [];
  const patterns = [];
  let token = scanner.scan();
  while (token !== SyntaxKind.CloseBracketToken) {
    if (token !== SyntaxKind.StringLiteral || scanner.isUnterminated()) return [];
    patterns.push(scanner.getTokenValue());
    token = scanner.scan();
    if (token === SyntaxKind.CommaToken) token = scanner.scan();
    else if (token !== SyntaxKind.CloseBracketToken) return [];
  }
  return [SyntaxKind.SemicolonToken, SyntaxKind.EndOfFile].includes(scanner.scan()) ? patterns : [];
}

// W1-T6237: read only literal entries and string concatenations; never import the branch reviewer.
// `name` is INSTRUMENT_SURFACE_EXCLUSIONS ({ path: reason } as a Map) or INSTRUMENT_SURFACE ([pattern] as an array).
function branchInstrumentDeclaration(text, name) {
  const scanner = createScanner(true, undefined, text ?? "");
  const empty = () => (name === "INSTRUMENT_SURFACE" ? [] : new Map());
  const scan = () => {
    const start = scanner.getTokenEnd();
    const next = scanner.scan();
    if (next !== SyntaxKind.EndOfFile && scanner.getTokenEnd() <= start) scanner.resetTokenState(start + 1);
    return next === SyntaxKind.SlashToken || next === SyntaxKind.SlashEqualsToken ? scanner.reScanSlashToken() : next;
  };
  function skipTemplate() {
    let depth = 0;
    for (let next = scan(); next !== SyntaxKind.EndOfFile; next = scan()) {
      if (next === SyntaxKind.TemplateHead) skipTemplate();
      else if (next === SyntaxKind.OpenBraceToken) depth++;
      else if (next === SyntaxKind.CloseBraceToken) {
        if (depth > 0) depth--;
        else if (scanner.reScanTemplateToken(false) === SyntaxKind.TemplateTail) return;
      }
    }
  }
  let token;
  while ((token = scan()) !== SyntaxKind.EndOfFile) {
    if (token === SyntaxKind.TemplateHead) {
      skipTemplate();
      continue;
    }
    if (token !== SyntaxKind.ExportKeyword || scanner.scan() !== SyntaxKind.ConstKeyword ||
        scanner.scan() !== SyntaxKind.Identifier || scanner.getTokenValue() !== name) continue;
    while ((token = scanner.scan()) !== SyntaxKind.EqualsToken) {
      if (token === SyntaxKind.EndOfFile || token === SyntaxKind.SemicolonToken) return empty();
    }
    if (name === "INSTRUMENT_SURFACE") return branchSurfacePatterns(scanner);
    if (scanner.scan() !== SyntaxKind.OpenBraceToken) return empty();
    const exclusions = new Map();
    token = scanner.scan();
    while (token !== SyntaxKind.CloseBraceToken) {
      if (token !== SyntaxKind.StringLiteral || scanner.isUnterminated()) return empty();
      const path = scanner.getTokenValue();
      if (scanner.scan() !== SyntaxKind.ColonToken) return empty();
      let reason = "";
      do {
        if (scanner.scan() !== SyntaxKind.StringLiteral || scanner.isUnterminated()) return empty();
        reason += scanner.getTokenValue();
        token = scanner.scan();
      } while (token === SyntaxKind.PlusToken);
      exclusions.set(path, reason);
      if (token === SyntaxKind.CommaToken) token = scanner.scan();
      else if (token !== SyntaxKind.CloseBraceToken) return empty();
    }
    return [SyntaxKind.SemicolonToken, SyntaxKind.EndOfFile].includes(scanner.scan()) ? exclusions : empty();
  }
  return empty();
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
 *   base: { candidates: string[], gaps: string[] } }, readHead?: (p: string) => string | null,
 *   reportExcused?: (line: string) => void }} input
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
  const review = input.readHead?.("src/lib/review.ts");
  const exclusions = branchInstrumentDeclaration(review, "INSTRUMENT_SURFACE_EXCLUSIONS");
  // A branch DECLARING its new script an instrument only widens what CI scrutinises, so it is honored too.
  const declared = branchInstrumentDeclaration(review, "INSTRUMENT_SURFACE").flatMap((p) => {
    try {
      return [new RegExp(p)];
    } catch {
      return [];
    }
  });
  const violations = measured.head.gaps
    .filter((path) => !carried.has(path))
    .sort()
    .filter((path) => {
      if (declared.some((re) => re.test(path))) {
        input.reportExcused?.(`instrument-surface: ${path} declared an instrument by this branch (CI and review judge it)`);
        return false;
      }
      if (!exclusions.get(path)?.trim()) return true;
      input.reportExcused?.(`instrument-surface: ${path} excused by this branch (CI and review judge the reason)`);
      return false;
    })
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
/** W1-T9919: the label of a census whose ONLY unmeasured cause is a suite child stopped on the backstop above.
 *  scripts/preflight-author.mjs reads this exact line and goes on (CI runs the suites); every other label refuses. */
export const CENSUS_TIME_BOUND_LABEL = "census suites NOT MEASURED (time bound)";
const TIME_BOUND_CODES = new Set(["ETIMEDOUT", "ERR_AUTHOR_STEP_TIMEOUT"]);
// A hook's GIT_DIR family (W1-T3224), a parent runner's context (it turns the child's TAP into v8 frames), and
// the lanes' read-only escape, which only flips checkCliFreshness — no census reads it — and makes the setup refuse.
const CHILD_ENV_DROPPED = /^(?:GIT_|NODE_TEST_CONTEXT$|RMD_SELF_SYNC_DONE$)/;

function childEnv() {
  return Object.fromEntries(Object.entries(process.env).filter(([k]) => !CHILD_ENV_DROPPED.test(k)));
}

function childOptions(root, timeoutMs = CENSUS_SUITE_CHILD_TIME_BOUND_MS) {
  return { cwd: root, encoding: "utf8", env: childEnv(), timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 };
}

/** Throws, naming why, when a child did not run to a status: a spawn error (the time bound included) or a signal. */
function assertChildFinished(res, what) {
  if (res.error) throw new Error(`the ${what} child could not run to completion: ${res.error.message}`);
  if (res.signal) throw new Error(`the ${what} child was ended by ${res.signal}`);
  if (res.outputComplete === false) throw new Error(`the ${what} child has incomplete captured output`);
}

function isMember(m) {
  return typeof m?.testFile === "string" && typeof m.script === "string" && Array.isArray(m.walks) && m.walks.length > 0;
}

/**
 * The tree's admission table and census-shaped source-text readers, read under tsx. Readers run
 * separately, calibrated on that reader, never on unrelated historical census durations.
 * A missing table admits nothing; a failed read or empty table is never a clean set.
 */
export function listAdmittedCensusMembers(root, run = spawnSync) {
  const table = join(root, ADMISSION_TABLE);
  if (!existsSync(table)) return [];
  const readers = join(root, "src/lib/source-text-readers.ts");
  const code =
    `const m = await import(${JSON.stringify(pathToFileURL(table).href)});` +
    "const members = m.CENSUS_ADMITTED_MEMBERS.map((x) => ({ testFile: x.testFile, script: x.script, walks: [...(x.walks ?? [])] }));" +
    (existsSync(readers) ?
      'if (members.length === 0) throw new Error("the admission table lists no admitted member");' +
      `const r = await import(${JSON.stringify(pathToFileURL(readers).href)});` +
      "const readerRuntimePolicy = { floorMs: m.FAST_GATE_CENSUS_REFERENCE_FLOOR_MS, multiple: m.FAST_GATE_CENSUS_RUNAWAY_MULTIPLE," +
      " remeasureMargin: m.FAST_GATE_CENSUS_REMEASURE_MARGIN };" +
      'if (![readerRuntimePolicy.floorMs, readerRuntimePolicy.multiple].every((x) => Number.isFinite(x) && x > 0) ||' +
      ' !(readerRuntimePolicy.remeasureMargin >= 1 && Number.isFinite(readerRuntimePolicy.remeasureMargin))) throw new Error("no measured census runtime policy");' +
      `members.push(...r.discoverSourceTextReaders(${JSON.stringify(root)}).filter((x) => x.censusShaped && x.walks.length > 0)` +
      '.map((x) => ({ testFile: x.testFile, script: "", walks: [...x.walks], structural: true, readerRuntimePolicy })));' : "") +
    "console.log(JSON.stringify(members));";
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
 * How a census suite child starts: niced, with an explicit `--test-concurrency` (src/lib/test-slot.ts, loaded through
 * tsx's own API because this script runs under plain node). No host-wide slot: a pre-push census is seconds of work
 * and must not wait behind a coverage run. A tree whose tsx or test-slot.ts cannot load gets `priority: "none"` and
 * a reason, so the run says it went unwrapped instead of reading as niced.
 */
export async function loadTestPriority(importSlot = defaultImportTestSlot) {
  try {
    const slot = await importSlot();
    return {
      priority: "nice",
      wrap: (file, args) => {
        const load = slot.readHostLoad();
        return slot.lowPriorityCommand(file, slot.testRunArgv(args, slot.testRunConcurrency(load, slot.defaultTestSlots(load.cores))));
      },
    };
  } catch (e) {
    // A named third value, not a silent unwrapped run: the caller prints `reason` beside its result.
    return { priority: "none", reason: `test-slot.ts did not load (${String(e?.message ?? e)})`, wrap: (file, args) => ({ file, args: [...args] }) };
  }
}

async function defaultImportTestSlot() {
  const url = pathToFileURL(join(SCRIPT_REPO, "src", "lib", "test-slot.ts")).href;
  // An active tsx resolver remaps the graph's .js imports to .ts, including API-registered loaders.
  if (import.meta.resolve(url.replace(/\.ts$/, ".js")) === url) return import(url);
  const { tsImport } = await import("tsx/esm/api");
  return tsImport(url, import.meta.url);
}

const TEST_PRIORITY = await loadTestPriority();

/**
 * The reader's qualification budget: `multiple` times its calibration (floored), capped at the backstop. `margin`
 * (> 1 only for the one re-measure) is the fast gate's FAST_GATE_CENSUS_REMEASURE_MARGIN, applied as ci-parity does.
 */
export function censusReaderBudget(measurement, context, policy, nowMs, margin = 1) {
  if (!policy || ![policy.floorMs, policy.multiple].every((n) => Number.isFinite(n) && n > 0) ||
      !(margin >= 1 && Number.isFinite(margin)) ||
      !measurement || measurement.context !== context || measurement.complete !== true || measurement.passed !== true ||
      !Number.isFinite(measurement.elapsedMs) || measurement.elapsedMs <= 0 ||
      !Number.isSafeInteger(measurement.tests) || measurement.tests <= 0 ||
      !Number.isFinite(nowMs) || !Number.isFinite(measurement.finishedMs) || nowMs < measurement.finishedMs ||
      nowMs - measurement.finishedMs > CENSUS_SUITE_CHILD_TIME_BOUND_MS) {
    throw new Error("source-reader runtime is UNKNOWN: missing, stale, mismatched or incomplete calibration");
  }
  if (measurement.elapsedMs > CENSUS_SUITE_CHILD_TIME_BOUND_MS) throw new Error("source-reader calibration exceeded the existing backstop");
  const budgetMs = Math.ceil(Math.max(policy.floorMs, measurement.elapsedMs) * policy.multiple * margin);
  if (!Number.isSafeInteger(budgetMs)) throw new Error("source-reader runtime is UNKNOWN: invalid derived budget");
  return Math.min(budgetMs, CENSUS_SUITE_CHILD_TIME_BOUND_MS);
}

const CENSUS_CAPTURE_DISPOSITION = Symbol("census capture disposition");

function completeCensusCapture(dir, owner, result) {
  const names = ["stdout", "stderr", "native.json"];
  let pins, pinError;
  try { pins = names.map((name) => lstatSync(join(dir, name))); }
  catch (error) { pinError = error; }
  return (accepted, reason) => {
    try {
      if (pinError) throw pinError;
      const current = lstatSync(dir);
      if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== owner.dev ||
          current.ino !== owner.ino || current.uid !== owner.uid) throw new Error("capture directory ownership changed");
      const bytes = names.map((name, index) => {
        const path = join(dir, name), pin = pins[index];
        const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
          const opened = fstatSync(fd), linked = lstatSync(path);
          if (!opened.isFile() || !pin.isFile() || linked.isSymbolicLink() ||
              [opened, linked].some((stat) => ["dev", "ino", "uid", "size", "mtimeMs", "ctimeMs"].some((key) => stat[key] !== pin[key]))) {
            throw new Error(`capture ${name} was replaced or changed`);
          }
          return readFileSync(fd, "utf8");
        } finally { closeSync(fd); }
      });
      const native = JSON.parse(bytes[2]);
      if (bytes[0] !== result.stdout || bytes[1] !== result.stderr || native.version !== 1 ||
          native.outputComplete !== true || native.status !== result.status || native.signal !== result.signal ||
          !native.finishedAt || native.finishedAt !== result.finishedAt || native.startedAt !== result.startedAt ||
          native.durationMs !== result.durationMs || native.error?.code !== result.error?.code) {
        throw new Error("native receipt does not bind this closed complete capture");
      }
      if (accepted) rmSync(dir, { recursive: true, force: true });
      else retainFixture(dir, `rejected complete census measurement: ${reason}`);
    } catch (error) {
      const reason = `capture custody UNKNOWN (${error.message})`;
      retainFixture(dir, reason);
      throw new Error(reason);
    }
  };
}

function runCensusChild(file, args, options) {
  const dir = mkdtempSync(join(tmpdir(), "rmd-census-capture-"));
  const owner = lstatSync(dir);
  let result;
  try {
    result = captureStepSync(file, args, { cwd: options.cwd, env: options.env, runtimeMs: options.timeout,
      maxBytes: options.maxBuffer, trackParent: true,
      stdoutPath: join(dir, "stdout"), stderrPath: join(dir, "stderr"), resultPath: join(dir, "native.json") });
  } catch (error) {
    const reason = `capture custody UNKNOWN (${error.message})`;
    retainFixture(dir, reason);
    throw new Error(reason);
  }
  if (result.outputComplete) result[CENSUS_CAPTURE_DISPOSITION] = completeCensusCapture(dir, owner, result);
  else {
    let custody = "capture retained at";
    try {
      const fd = openSync(join(dir, "native.json"), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      let native;
      try {
        if (!fstatSync(fd).isFile()) throw new Error("native receipt is not a regular file");
        native = JSON.parse(readFileSync(fd, "utf8"));
      } finally {
        closeSync(fd);
      }
      if (native.version !== 1 || native.outputComplete !== false || native.status !== result.status ||
          native.signal !== result.signal || !native.finishedAt || native.finishedAt !== result.finishedAt ||
          native.startedAt !== result.startedAt || native.error?.code !== result.error?.code) {
        throw new Error("native receipt does not bind this closed incomplete capture");
      }
    } catch (error) {
      // Keeping partial bytes is not evidence that the native receipt remains readable or valid.
      custody = `capture custody UNKNOWN (${error.message}); partial diagnostics retained at`;
    }
    retainFixture(dir, `${custody} ${dir}`);
    // Custody changes neither the original native outcome nor W1-T9919's timeout disposition.
    result.error = Object.assign(new Error(`${result.error?.message ?? "incomplete census capture"}; ${custody} ${dir}`), { code: result.error?.code });
  }
  return result;
}

function censusReaderContext(root, child, options) {
  const env = { ...Object.fromEntries(Object.keys(process.env).filter((k) => k.startsWith("GIT_")).map((k) => [k, undefined])), ...options.env };
  const readGit = (args) => gitOut(root, args, { env, timeout: CENSUS_SUITE_CHILD_TIME_BOUND_MS });
  const untracked = readGit(["ls-files", "--others", "--exclude-standard", "-z"]).split("\0").filter(Boolean);
  const dependencies = join(root, "node_modules");
  const dependency = lstatSync(dependencies, { throwIfNoEntry: false }) ? statSync(dependencies) : null;
  if (dependency && !dependency.isDirectory()) throw new Error("source-reader runtime is UNKNOWN: node_modules is not a directory donor");
  const input = { root: resolve(root), head: readGit(["rev-parse", "HEAD"]).trim(),
    tracked: readGit(["ls-files", "--stage", "-z"]), diff: readGit(["diff", "--binary", "HEAD"]),
    untracked: untracked.filter((p) => p !== "node_modules" && p !== "node_modules/")
      .map((p) => [p, readFileSync(join(root, p)).toString("base64")]),
    dependency: dependency ? [realpathSync(dependencies), dependency.dev, dependency.ino,
      ...["package-lock.json", "node_modules/tsx/package.json"].map((p) => existsSync(join(root, p)) ? readFileSync(join(root, p)).toString("base64") : null)] : null,
    loader: readFileSync(fileURLToPath(import.meta.resolve("tsx"))).toString("base64"),
    runtime: [process.execPath, process.version, process.versions.v8, process.platform, process.arch],
    command: child, environment: Object.entries(options.env).sort(([a], [b]) => a.localeCompare(b)),
    snapshot: options.env[CENSUS_SNAPSHOT_ENV] ? readFileSync(options.env[CENSUS_SNAPSHOT_ENV]).toString("base64") : null };
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

/**
 * Runs `files` (repo-relative suite paths) once, in ONE `node --test` child over `root`, and returns the ones
 * that fail. THROWS, naming why, on every way the run can fail to be a measurement (spawn error, time bound,
 * signal, no `# tests` summary, zero tests, a non-zero exit its TAP does not explain): never `[]` for those.
 */
export function runCensusSuitesViaChild({ root, files, run = runCensusChild, priority = TEST_PRIORITY, snapshotPath, pathOverride, timeoutMs,
  readerRuntimePolicy, now = () => performance.now(), readContext = censusReaderContext, load1 = () => loadavg()[0] }) {
  const args = ["--test", "--test-reporter=tap", "--import", import.meta.resolve("tsx"), "--import", TMP_HYGIENE_URL, ...files];
  if (priority.reason) console.error(`census-precheck: census suites run at default priority - ${priority.reason}`);
  const child = priority.wrap(process.execPath, args);
  const options = childOptions(root, timeoutMs);
  if (snapshotPath) options.env[CENSUS_SNAPSHOT_ENV] = snapshotPath;
  if (pathOverride !== undefined) options.env.PATH = pathOverride;
  const pending = new Set();
  const dispose = (sample, accepted, reason) => {
    if (!pending.delete(sample)) return;
    sample[CENSUS_CAPTURE_DISPOSITION]?.(accepted, reason);
  };
  try {
    const once = () => {
      const startLoad = load1();
      const startedMs = now();
      const res = run(child.file, child.args, options);
      pending.add(res);
      const finishedMs = now();
      if (TIME_BOUND_CODES.has(res.error?.code) && options.timeout === CENSUS_SUITE_CHILD_TIME_BOUND_MS) {
        // W1-T9919: the backstop fired; name what sizes it, so a loaded host reads differently from a hung child.
        const loads = [startLoad, load1()].map((n) => (Number.isFinite(n) ? n.toFixed(2) : "unknown"));
        throw Object.assign(new Error(`the census suite child could not run to completion: ${res.error.message} - time bound: ` +
          `${Math.round(finishedMs - startedMs)} ms elapsed of the ${CENSUS_SUITE_CHILD_TIME_BOUND_MS} ms bound, ${files.length} suite(s), ` +
          `1-minute load ${loads[0]} at start and ${loads[1]} at end`), { censusTimeBound: true });
      }
      if (TIME_BOUND_CODES.has(res.error?.code)) {
        // Below the backstop the bound is a reader's measured budget: an overrun its qualification re-measures once.
        throw Object.assign(new Error(`the census suite child could not run to completion: ${res.error.message}`), { readerBudgetOverrun: true });
      }
      assertChildFinished(res, "census suite");
      const stdout = String(res.stdout ?? "");
      const totals = [...stdout.matchAll(/^# tests (\d+)$/gm)];
      const total = totals.length === 1 ? totals[0] : null;
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
      const summary = Object.fromEntries(["pass", "fail", "cancelled", "skipped", "todo"].map((key) => {
        const matches = [...stdout.matchAll(new RegExp(`^# ${key} (\\d+)$`, "gm"))];
        return [key, matches.length === 1 ? Number(matches[0][1]) : null];
      }));
      const passed = summary.pass === Number(total[1]) && ["fail", "cancelled", "skipped", "todo"].every((key) => summary[key] === 0);
      const identities = [...stdout.matchAll(/^( *)(?:not )?ok [0-9]+ - (.+)$/gm)]
        .map((match) => `${match[1].length}:${match[2]}`);
      return { failing, tests: Number(total[1]), identities, passed, elapsedMs: finishedMs - startedMs, finishedMs,
        [CENSUS_CAPTURE_DISPOSITION]: (accepted, reason) => dispose(res, accepted, reason) };
    };
    const finish = (sample, accepted, reason) => sample[CENSUS_CAPTURE_DISPOSITION](accepted, reason);
    if (readerRuntimePolicy === undefined) {
      const sample = once();
      finish(sample, sample.passed && sample.failing.length === 0, "unsuccessful census result");
      return sample.failing;
    }
    if (files.length !== 1 || timeoutMs !== undefined) throw new Error("source-reader calibration requires one reader and no timeout override");
    if (!lstatSync(join(root, files[0])).isFile()) throw new Error("source-reader calibration requires a physical test file");
    if (!readerRuntimePolicy || ![readerRuntimePolicy.floorMs, readerRuntimePolicy.multiple].every((n) => Number.isFinite(n) && n > 0) ||
        !(readerRuntimePolicy.remeasureMargin >= 1 && Number.isFinite(readerRuntimePolicy.remeasureMargin))) {
      throw new Error("source-reader runtime is UNKNOWN: invalid calibration policy");
    }
    const context = readContext(root, child, options);
    const calibration = once();
    if (readContext(root, child, options) !== context) throw new Error("source-reader inputs changed during calibration");
    if (calibration.failing.length > 0) {
      finish(calibration, false, "failed calibration assertions");
      return calibration.failing;
    }
    if (!calibration.passed) throw new Error("source-reader runtime is UNKNOWN: calibration has no complete unskipped pass");
    console.log(`census-reader-calibration: ${JSON.stringify({ file: files[0], context, tests: calibration.tests,
      cases: calibration.identities, measuredMs: Math.ceil(calibration.elapsedMs), assurance: "observation-not-qualification" })}`);
    const measurement = { ...calibration, context, complete: true, passed: true };
    // As the fast gate judges a RUNAWAY (ci-parity.ts): a first overrun is re-measured once, against the budget
    // times FAST_GATE_CENSUS_REMEASURE_MARGIN; only a second overrun refuses. Both budgets share one calibration age.
    const budgetAtMs = now();
    const budgets = [1, readerRuntimePolicy.remeasureMargin].map((margin) =>
      censusReaderBudget(measurement, context, readerRuntimePolicy, budgetAtMs, margin));
    finish(calibration, true, "accepted calibration");
    const overruns = [];
    let measured;
    for (const budgetMs of budgets) {
      options.timeout = budgetMs;
      let sample;
      try {
        sample = once();
      } catch (e) {
        if (e?.readerBudgetOverrun !== true) throw e;
        overruns.push(`stopped at its ${budgetMs}ms bound (${e.message})`);
        continue;
      }
      if (readContext(root, child, options) !== context) throw new Error("source-reader inputs changed during qualification");
      if (sample.tests !== calibration.tests || JSON.stringify(sample.identities) !== JSON.stringify(calibration.identities)) {
        throw new Error("source-reader runtime is UNKNOWN: qualification case inventory differs from calibration");
      }
      if (!(sample.elapsedMs > 0 && Number.isFinite(sample.elapsedMs))) throw new Error("source-reader runtime is UNKNOWN: invalid native duration");
      if (sample.elapsedMs <= budgetMs) {
        measured = sample;
        break;
      }
      overruns.push(`took ${Math.ceil(sample.elapsedMs)}ms against ${budgetMs}ms`);
      finish(sample, false, overruns.at(-1));
    }
    if (measured === undefined) {
      throw new Error(`source-reader runtime exceeded its ${budgets[0]}ms measured budget, then its one re-measure exceeded ` +
        `${budgets[1]}ms (x${readerRuntimePolicy.remeasureMargin} margin): ${overruns.join("; then ")}`);
    }
    if (!measured.passed && measured.failing.length === 0) throw new Error("source-reader runtime is UNKNOWN: qualification has no complete unskipped result");
    finish(measured, measured.passed && measured.failing.length === 0, "failed qualification assertions");
    console.log(`census-reader-runtime: ${JSON.stringify({ file: files[0], context, tests: measured.tests,
      cases: measured.identities, calibrationMs: Math.ceil(calibration.elapsedMs), budgetMs: options.timeout,
      measuredMs: Math.ceil(measured.elapsedMs), ...(overruns.length > 0 ? { remeasuredAfter: overruns[0] } : {}),
      assurance: "fresh-timing-only-no-cached-verdict" })}`);
    return measured.failing;
  } catch (error) {
    for (const sample of pending) {
      try { dispose(sample, false, error.message); }
      catch (custody) { error.message += `; ${custody.message}`; }
    }
    throw error;
  }
}

const STEP_LITERAL_RE = /(?:\bstep\s*===|\bcase|\blog\w*\s*\(|\bstep\s*:)\s*(["'`])([^"'`\r\n$]+)\1/g;
const ENV_NAME_RE = /\b(?:RMD|REMUDERO)_[A-Z0-9_]+\b/g;
const ERROR_CLASS_RE = /\bclass\s+([\w$]+)\s+extends\s+Error\b/g;

function addsLiteral({ changed, readHead, readBase }, pattern, group) {
  if (typeof readHead !== "function" || typeof readBase !== "function") return false;
  const literals = (text) => new Set([...String(text ?? "").matchAll(pattern)].map((m) => m[group]));
  return changed.filter((path) => CLOCK_SCOPE_RE.test(path)).some((path) => {
    const base = literals(readBase(path));
    return [...literals(readHead(path))].some((literal) => !base.has(literal));
  });
}

const IMPORT_SPECIFIER_RE = /(?:\bfrom|\bimport|\brequire)\s*\(?\s*(["'])([^"'\r\n]+)\1/g;
const BAKED_CATALOG_PATHS = ["deploy/install-host-units.sh", "src/lib/baked-runtime-inputs.ts", ".github/workflows/acr-build.yml"];

/** Both sides matter: removing an import or detaching a module also moves the catalogued closure. */
function closureImportTrigger(seed) {
  return ({ changed, readHead, readBase }) => {
    if (changed.some((p) => p === seed || BAKED_CATALOG_PATHS.includes(p))) return true;
    if (typeof readHead !== "function" || typeof readBase !== "function") return false;
    const specifiers = (text) => new Set([...String(text ?? "").matchAll(IMPORT_SPECIFIER_RE)].map((m) => m[2]));
    const importChanges = changed.filter((path) => {
      const head = specifiers(readHead(path));
      const base = specifiers(readBase(path));
      return head.size !== base.size || [...head].some((spec) => !base.has(spec));
    });
    if (importChanges.length === 0) return false;
    const closure = (read) => {
      const seen = new Set();
      const queue = [seed];
      while (queue.length > 0) {
        const path = queue.pop();
        if (seen.has(path)) continue;
        seen.add(path);
        for (const spec of specifiers(read(path))) {
          if (spec.startsWith(".")) queue.push(posix.normalize(posix.join(posix.dirname(path), spec)).replace(/\.js$/, ".ts"));
        }
      }
      return seen;
    };
    const reachable = new Set([...closure(readHead), ...closure(readBase)]);
    return importChanges.some((path) => reachable.has(path));
  };
}
const IMPORT_SCOPE_RE = /^(?:src|scripts)\/.+\.(?:[cm]?[jt]sx?)$/;
const LIB_SCOPE_RE = /^src\/lib\/.+\.[cm]?[jt]sx?$/;
/** What `src/lib` may never import (.dependency-cruiser.cjs): the CLI layer, the spike and the task runner. */
const LAYER_ABOVE_LIB_RE = /^src\/(?:cli(?:\/|\.|$)|spike\.|run-task\.)/;

/** W1-T5693: a changed file in `inScope` whose head imports a specifier (kept by `keep(specifier, path)`) its
 *  merge-base text did not. A new file's every import is new. */
function addsImport({ changed, readHead, readBase }, inScope, keep = () => true) {
  if (typeof readHead !== "function" || typeof readBase !== "function") return false;
  const specifiers = (text, path) =>
    new Set([...String(text ?? "").matchAll(IMPORT_SPECIFIER_RE)].map((m) => m[2]).filter((spec) => keep(spec, path)));
  return changed.filter((path) => inScope.test(path)).some((path) => {
    const base = specifiers(readBase(path), path);
    return [...specifiers(readHead(path), path)].some((spec) => !base.has(spec));
  });
}

const importsLayerAboveLib = (spec, path) =>
  spec.startsWith(".") && LAYER_ABOVE_LIB_RE.test(posix.normalize(posix.join(posix.dirname(path), spec)));

function stepTrigger(input) {
  return input.changed.some((path) => path === "src/lib/ledger.ts" || path === "src/lib/spend-rows.ts") ||
    addsLiteral(input, STEP_LITERAL_RE, 2);
}

/** W1-T5882: a changed src/, scripts/ or bin/ file that adds a nested `node --test` argv or hands a Worker
 *  process.execArgv — the two Node 24 behaviours test/node-24-runtime-compatibility.test.ts guards. */
const NODE24_RUNTIME_RE = /(["'])--test\1|execArgv:\s*process\.execArgv/g;
const NODE24_SCOPE_RE = /^(?:src|scripts|bin)\/.+\.[cm]?[jt]s$/;
function node24RuntimeTrigger({ changed, readHead, readBase }) {
  if (changed.includes("test/node-24-runtime-compatibility.test.ts")) return true;
  if (typeof readHead !== "function" || typeof readBase !== "function") return false;
  const count = (text) => [...String(text ?? "").matchAll(NODE24_RUNTIME_RE)].length;
  return changed.filter((path) => NODE24_SCOPE_RE.test(path)).some((path) => count(readHead(path)) > count(readBase(path)));
}

const HOST_CAPABILITY_RE = /chmod|process\.platform|getuid|hostname|\/usr\/bin\//;
const NESTED_PREFLIGHT_RE = /\bpreflightCommand\(|["']preflight["']/;
const TEST_TS_SCOPE_RE = /^test\/.+\.ts$/;
function changesTestText({ changed, readHead, readBase }, pattern) {
  if (typeof readHead !== "function" || typeof readBase !== "function") return false;
  return changed.filter((path) => TEST_TS_SCOPE_RE.test(path)).some((path) =>
    pattern.test(readHead(path) ?? "") || pattern.test(readBase(path) ?? ""));
}
const PRICE_RE = /\b(?:pr_url|cost_usd)\b/;
const PRICED_WRITE_RE = /\blog\w*\(\s*(?:(["'])[A-Za-z0-9_.:-]+\1|[A-Z][A-Z0-9_]*)\s*,|\bstep:\s*(?:(["'])[A-Za-z0-9_.:-]+\2|[A-Z][A-Z0-9_]*\b)/g;

// Match the census's call/object boundaries, including nested and multiline payloads.
function pricedWrites(text) {
  return [...text.matchAll(PRICED_WRITE_RE)].flatMap((match) => {
    const call = match[0].startsWith("log");
    let open = call ? text.indexOf("(", match.index) : match.index;
    let depth = 0;
    if (!call) {
      for (; open >= 0; open--) {
        if (text[open] === "}") depth++;
        else if (text[open] === "{" && depth-- === 0) break;
      }
      if (open < 0) return [];
    }
    const up = call ? "(" : "{";
    const down = call ? ")" : "}";
    depth = 0;
    let end = open;
    for (; end < text.length; end++) {
      if (text[end] === up) depth++;
      else if (text[end] === down && --depth === 0) break;
    }
    const payload = text.slice(open, end + 1);
    return PRICE_RE.test(payload) ? [payload] : [];
  });
}

function addsMatch({ changed, readHead, readBase }, scope, scan) {
  if (typeof readHead !== "function" || typeof readBase !== "function") return false;
  return changed.filter((path) => scope.test(path)).some((path) => {
    const remaining = new Map();
    for (const match of scan(String(readBase(path) ?? ""))) remaining.set(match, (remaining.get(match) ?? 0) + 1);
    return scan(String(readHead(path) ?? "")).some((match) => {
      const count = remaining.get(match) ?? 0;
      remaining.set(match, count - 1);
      return count === 0;
    });
  });
}

/**
 * W1-T6137: the host-worktree-git trigger reads the census's own git-spawn shapes from
 * scripts/lib/git-spawn-shapes.mjs (one definition, no copied regex). The module is loaded once, and a load
 * failure is kept rather than thrown here so one broken module cannot take the whole precheck down: the trigger
 * rethrows it, and evaluateAdmittedCensusSuites reports that as `unmeasured` with its reason.
 */
let gitSpawnShapesModule = null;
let gitSpawnShapesError = null;
try {
  gitSpawnShapesModule = await import("./lib/git-spawn-shapes.mjs");
} catch (e) {
  gitSpawnShapesError = e;
}

function loadGitSpawnShapes() {
  if (gitSpawnShapesModule === null) {
    throw new Error(`git-spawn shapes (scripts/lib/git-spawn-shapes.mjs) could not be loaded: ${gitSpawnShapesError?.message ?? gitSpawnShapesError}`);
  }
  return gitSpawnShapesModule;
}

/** True when the diff touches the leaf, the census, or the shared shapes, or adds a src/ git spawn of any shape the census counts. */
export function gitSpawnTrigger(input, load = loadGitSpawnShapes) {
  const shapes = load();
  if (input.changed.some((p) => GIT_LEAF_CENSUS_PATHS.includes(p))) return true;
  return addsMatch(input, CLOCK_SCOPE_RE, shapes.gitSpawnShapeMatches);
}

const GIT_LEAF_CENSUS_PATHS = [
  "src/lib/worktree-git.ts",
  "scripts/lib/git-spawn-shapes.mjs",
  "test/every-host-git-spawn-into-a-worktree-uses-the-hardened-leaf.test.ts",
];

/**
 * #11677 (2026-10-14): a build adding a raw `git worktree add` site (src/lib/engine-tree.ts::buildEngine) was
 * refused by test/worktree-creation-census.test.ts only in CI's rule-checks, costing a fix round. The census
 * keys each raw site by its enclosing declaration, so the trigger reads the same key: the shape is
 * src/lib/worktree-sites.ts's RAW_WORKTREE_ADD_RE and the two declaration patterns its enclosingSiteName scans
 * upward for (test/the-precheck-asks-the-worktree-creation-census.test.ts holds both copies equal on the real tree).
 */
export const RAW_WORKTREE_ADD_SHAPE = /["']worktree["']\s*,\s*["']add["']/;
const SITE_FUNCTION_RE = /^\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(/;
const SITE_METHOD_RE = /^\s*(\w+)\s*:\s*\(/;
const WORKTREE_CENSUS_PATHS = ["src/lib/worktree-sites.ts", "src/lib/worker.ts", "test/worktree-creation-census.test.ts"];

/** The census key of each raw site in `text`: its enclosing declaration's name, sorted, comment lines skipped. */
export function rawWorktreeAddSiteKeys(text) {
  const lines = String(text ?? "").split("\n");
  const keys = [];
  lines.forEach((line, i) => {
    const trimmed = line.trim();
    if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) return;
    if (!RAW_WORKTREE_ADD_SHAPE.test(line)) return;
    let site = "";
    for (let j = i; j >= 0 && site === ""; j--) {
      site = SITE_FUNCTION_RE.exec(lines[j])?.[1] ?? SITE_METHOD_RE.exec(lines[j])?.[1] ?? "";
    }
    keys.push(site);
  });
  return keys.sort();
}

/** True when the diff touches the registry, the canonical sites or the census, or moves a src/ raw site's key. */
export function worktreeCreationTrigger({ changed, readHead, readBase }) {
  if (changed.some((p) => WORKTREE_CENSUS_PATHS.includes(p))) return true;
  if (typeof readHead !== "function" || typeof readBase !== "function") return false;
  return changed.filter((p) => CLOCK_SCOPE_RE.test(p)).some((p) =>
    rawWorktreeAddSiteKeys(readHead(p)).join("\n") !== rawWorktreeAddSiteKeys(readBase(p)).join("\n"));
}

function childCoverageFindings(text) {
  const { defects, suspects } = scanChildCoverage(text, "test/changed.ts");
  return [...defects.map((finding) => `delete:${finding.expr}`), ...suspects.map((finding) => `strip:${finding.ident}`)];
}

/** W1-T5692: these slower censuses join the same child when changed source adds a literal. */
export const PRECHECK_TRIGGERED_SUITES = [
  { testFile: "test/ledger-rotation.test.ts",
    gateRegex: STEP_LITERAL_RE,
    recognizer: "src/lib/ledger.ts", ownFiles: ["src/lib/ledger.ts"], script: "census:ledger-rotation", trigger: stepTrigger,
    remedy: "register DECISION_RELEVANT_LEDGER_STEPS in src/lib/ledger.ts" },
  { testFile: "test/a-union-read-of-an-unretained-step-is-refused.test.ts",
    gateRegex: STEP_LITERAL_RE,
    recognizer: "src/lib/ledger.ts", ownFiles: ["src/lib/ledger.ts"], script: "census:unretained-step", trigger: stepTrigger,
    remedy: "register DECISION_RELEVANT_LEDGER_STEPS in src/lib/ledger.ts" },
  { testFile: "test/spend-is-counted-once-at-its-producer.test.ts",
    gateRegex: STEP_LITERAL_RE,
    recognizer: "src/lib/spend-rows.ts", ownFiles: ["src/lib/spend-rows.ts"], script: "census:spend", trigger: stepTrigger,
    remedy: "declare SPEND_STEP_ROLES in src/lib/spend-rows.ts" },
  { testFile: "test/env-var-registry.test.ts",
    recognizer: "test/env-var-registry.test.ts", symbol: "harnessEnvNamesInSource", gateRegex: ENV_NAME_RE,
    ownFiles: ["src/lib/config-schema.ts"], script: "census:env-var-registry",
    trigger: (input) => input.changed.includes("src/lib/config-schema.ts") || addsLiteral(input, ENV_NAME_RE, 0),
    remedy: "register ENV_REGISTRY in src/lib/config-schema.ts" },
  { testFile: "test/error-subclass-census.test.ts",
    gateRegex: ERROR_CLASS_RE,
    recognizer: "test/error-subclass-census.test.ts", ownFiles: ["scripts/error-subclass-baseline.json"], script: "census:error-subclass",
    trigger: (input) => input.changed.includes("scripts/error-subclass-baseline.json") || addsLiteral(input, ERROR_CLASS_RE, 1),
    remedy: "adopt RmdError in src/lib/errors.ts or record the reviewed ceiling in scripts/error-subclass-baseline.json" },
  // W1-T5693: whole-tree structural censuses, 4-13 s each alone; `structural` runs each in its OWN child.
  { testFile: "test/cycle-ratchet.test.ts",
    gateRegex: IMPORT_SPECIFIER_RE,
    recognizer: "scripts/cycle-ratchet.mjs", ownFiles: ["scripts/cycle-baseline.json", ".dependency-cruiser.cjs"], gitFree: true, script: "census:cycle-ratchet", structural: true,
    trigger: (input) => input.changed.some((p) => [".dependency-cruiser.cjs", "scripts/cycle-baseline.json", "scripts/cycle-ratchet.mjs"].includes(p)) ||
      addsImport(input, IMPORT_SCOPE_RE),
    remedy: "break the import ring or record the reviewed ceiling in scripts/cycle-baseline.json" },
  { testFile: "test/source-size-baseline-is-enforced.test.ts",
    gateRegex: IMPORT_SPECIFIER_RE,
    recognizer: ".dependency-cruiser.cjs", ownFiles: [".dependency-cruiser.cjs"], script: "census:source-size", structural: true,
    trigger: (input) => input.changed.some((p) => ["scripts/source-size-ratchet.mjs", "src/lib/ci-parity.ts", ".dependency-cruiser.cjs"].includes(p)) ||
      addsImport(input, LIB_SCOPE_RE, importsLayerAboveLib),
    remedy: "src/lib must not import src/cli, src/spike.ts or src/run-task.ts (.dependency-cruiser.cjs)" },
  { testFile: "test/citation-anchor-census.test.ts",
    gateRegex: null, // Path-triggered; no source-token predicate.
    recognizer: "scripts/citation-anchor-census.mjs", ownFiles: ["scripts/citation-anchor-census.mjs"], gitFree: true, script: "census:citation-anchor", structural: true,
    trigger: ({ changed }) => changed.some((p) => p.startsWith("plan/tasks.d/") || p === "MASTER-PLAN.md" || p === "scripts/citation-anchor-census.mjs"),
    remedy: "anchor each #NNNN citation the shard or MASTER-PLAN.md adds (scripts/citation-anchor-census.mjs)" },
  // W1-T5702: a new test importing src/run-task.ts is the reach ratchet's own refusal.
  { testFile: "test/the-affected-suite-reach-ratchet.test.ts",
    gateRegex: IMPORT_SPECIFIER_RE,
    recognizer: "src/lib/affected-suites.ts", ownFiles: ["scripts/affected-reach-baseline.json"], script: "census:affected-reach", structural: true,
    trigger: (input) =>
      input.changed.some((p) => ["src/lib/affected-suites.ts", "scripts/affected-reach-baseline.json"].includes(p)) ||
      addsImport(input, TEST_TS_SCOPE_RE, (spec) => /(?:^|\/)run-task\.[jt]s$/.test(spec)),
    remedy: "import the module the suite tests rather than src/run-task.ts, or record the tighter ceiling in scripts/affected-reach-baseline.json" },
  { testFile: "test/node-24-runtime-compatibility.test.ts",
    gateRegex: NODE24_RUNTIME_RE,
    recognizer: "scripts/census-precheck.mjs", ownFiles: ["test/node-24-runtime-compatibility.test.ts"], script: "census:node24-runtime", trigger: node24RuntimeTrigger,
    remedy: "name --test-reporter=tap on the spawn (or mark it `node-test-reporter: exempt`) and let the Worker inherit execArgv" },
  { testFile: "test/every-priced-ledger-step-is-in-the-config-garden-read.test.ts",
    gateRegex: PRICED_WRITE_RE,
    recognizer: "src/lib/config-gardener.ts", gitFree: true, script: "census:every-priced-ledger-step",
    ownFiles: ["src/lib/config-gardener.ts", "test/every-priced-ledger-step-is-in-the-config-garden-read.test.ts"],
    trigger: (input) => input.changed.includes("src/lib/config-gardener.ts") || addsMatch(input, CLOCK_SCOPE_RE, pricedWrites),
    remedy: "register CONFIG_GARDEN_LEDGER_STEPS in src/lib/config-gardener.ts or a reasoned exemption in test/every-priced-ledger-step-is-in-the-config-garden-read.test.ts" },
  { testFile: "test/host-capability-fixtures.test.ts",
    gateRegex: HOST_CAPABILITY_RE,
    recognizer: "test/host-capability-fixtures.test.ts", ownFiles: ["test/host-capability-fixtures.test.ts"], script: "census:host-capability-fixtures",
    trigger: (input) => addsMatch(input, TEST_TS_SCOPE_RE, (text) => text.split("\n").filter((line) => HOST_CAPABILITY_RE.test(line))),
    remedy: "own the fixture's host condition or declare its reason in test/host-capability-fixtures.test.ts" },
  { testFile: "test/no-test-drives-a-real-preflight-against-the-repository-root.test.ts",
    gateRegex: NESTED_PREFLIGHT_RE,
    recognizer: "test/no-test-drives-a-real-preflight-against-the-repository-root.test.ts", ownFiles: ["test/no-test-drives-a-real-preflight-against-the-repository-root.test.ts"], script: "census:no-nested-preflight",
    trigger: (input) =>
      input.changed.includes("test/no-test-drives-a-real-preflight-against-the-repository-root.test.ts") ||
      addsMatch(input, TEST_TS_SCOPE_RE, (text) => text.split("\n").filter((line) => NESTED_PREFLIGHT_RE.test(line))),
    remedy: "inject `spawn` into preflightCommand / `dispatch` into main, or prove the invariant through preflightSummaryTarget" },
  // W1-T7812: changes to the measured fixture-crossing runner or its proof rerun that proof before push.
  { testFile: "test/a-near-fixture-crossing-blocks-only-once-a-shifted-run-proves-it-red.test.ts",
    gateRegex: null, // Path-triggered; the gate measures shifted executions.
    recognizer: "scripts/expiring-fixture-census.mjs", ownFiles: ["scripts/expiring-fixture-census.mjs"], gitFree: true, script: "census:near-fixture-crossing",
    trigger: ({ changed }) => changed.some((p) => [
      "scripts/expiring-fixture-census.mjs", "src/lib/gate-gardener.ts", "scripts/clock-shift.mjs",
      "src/lib/ci-parity.ts", "scripts/census-precheck.mjs",
      "test/a-near-fixture-crossing-blocks-only-once-a-shifted-run-proves-it-red.test.ts",
    ].includes(p)),
    remedy: "preserve the 24 h control/shifted verdict and the private TMPDIR proof" },
  // W1-T6106: a host git spawn into a worker worktree must go through src/lib/worktree-git.ts.
  { testFile: "test/every-host-git-spawn-into-a-worktree-uses-the-hardened-leaf.test.ts",
    gateRegex: /["'`](?:git|-C)["'`]/,
    recognizer: "test/every-host-git-spawn-into-a-worktree-uses-the-hardened-leaf.test.ts", ownFiles: ["test/every-host-git-spawn-into-a-worktree-uses-the-hardened-leaf.test.ts"], gitFree: true, script: "census:host-worktree-git",
    trigger: (input) => gitSpawnTrigger(input),
    remedy: "route the spawn through hostWorktreeGit (src/lib/worktree-git.ts), or name it in that suite's RAW_SITE_EXCEPTIONS with its reason" },
  { testFile: "test/worktree-creation-census.test.ts",
    gateRegex: RAW_WORKTREE_ADD_SHAPE,
    recognizer: "src/lib/worktree-sites.ts", ownFiles: ["src/lib/worktree-sites.ts"], gitFree: true, script: "census:worktree-creation", trigger: worktreeCreationTrigger,
    remedy: "route the site through worktreeAdd (src/lib/worker.ts), or add a NAMED exempt row with its reason to WORKTREE_SITE_REGISTRY (src/lib/worktree-sites.ts)" },
];

/** Suites a diff joins by path with no npm script of their own (W1-T9565): evaluateAdmittedCensusSuites runs each by
 *  testFile and models it in PRECHECK_PARITY as `modeled`. A row is `{ testFile, trigger, remedy }`. */
export const PRECHECK_PATH_TRIGGERED_SUITES = [
  { testFile: "test/a-gate-that-fired-wrongly-is-filed-against-the-gate.test.ts", gitFree: true,
    trigger: ({ changed }) => changed.some((p) => [
      "src/lib/gate-gardener.ts", "scripts/census-precheck.mjs",
      "test/a-gate-that-fired-wrongly-is-filed-against-the-gate.test.ts",
    ].includes(p)),
    remedy: "classify suspect repairs through production gate metadata and file against the gate recognizer" },
  { testFile: "test/coverage-session-blanking.test.ts",
    trigger: (input) => input.changed.some((path) => ["scripts/coverage-session-blanking-check.mjs",
      "test/coverage-session-blanking.test.ts"].includes(path)) || addsMatch(input, TEST_TS_SCOPE_RE, childCoverageFindings),
    remedy: "explicitly blank NODE_V8_COVERAGE on the child environment when stripping NODE_TEST_CONTEXT; deleting the coverage variable is ineffective" },
  { testFile: "test/rules/the-root-scratch-ignore-stays-root-only.test.ts",
    trigger: ({ changed }) => changed.some((p) => [".gitignore", "scripts/census-precheck.mjs",
      "test/rules/the-root-scratch-ignore-stays-root-only.test.ts"].includes(p)),
    remedy: "preserve the operator-approved root-only scratch ignore and existing or tracked contents" },
  { testFile: "test/every-ci-census-is-asked-before-the-push.test.ts",
    recognizer: "src/lib/ci-parity.ts", symbol: "censusCandidateWalks", gateRegex: /ls-files|readdirSync|globSync/,
    ownFiles: ["scripts/census-precheck-parity-baseline.json", "src/lib/rule-suites.ts", "scripts/census-precheck.mjs"],
    trigger: ({ changed, readHead, readBase }) => changed.some((p) => [
      "scripts/census-precheck.mjs", "scripts/census-precheck-parity-baseline.json",
      "scripts/list-rule-suites.mjs", "src/lib/ci-parity.ts", "src/lib/rule-suites.ts",
    ].includes(p) || isRuleSuitePath(p, readHead?.(p) ?? readBase?.(p) ?? "")),
    remedy: "register each new CI census in an actual pre-push execution path; the CI-only baseline may only shrink" },
  { testFile: "test/rules/the-janitor-preserves-tracked-artifacts.test.ts",
    trigger: ({ changed }) => changed.some((p) => [
      "deploy/mac/remudero-janitor.sh", "deploy/workspace-retirement-guard.sh", "scripts/census-precheck.mjs",
      "test/rules/the-janitor-preserves-tracked-artifacts.test.ts",
    ].includes(p)),
    remedy: "preserve tracked source and unreadable Git indexes before generated-artifact deletion" },
  { testFile: "test/rules/scout-config-gardener-failed.test.ts", gitFree: true,
    trigger: ({ changed }) => changed.some((p) => [
      "src/run-task.ts", "src/lib/config-gardener.ts", "scripts/build-child-entries.mjs",
      "test/rules/scout-config-gardener-failed.test.ts",
    ].includes(p)),
    remedy: "load the config garden and bundled measurement worker with the TypeScript loader" },
  { testFile: "test/ci/a-rejected-census-measurement-retains-its-complete-capture.test.ts",
    trigger: ({ changed }) => changed.some((p) => [
      "scripts/census-precheck.mjs", "scripts/lib/author-step-capture.mjs", "scripts/lib/retained-fixtures.mjs",
      "test/setup/retained-fixtures.ts", "test/setup/tmp-hygiene.ts",
      "test/ci/a-rejected-census-measurement-retains-its-complete-capture.test.ts",
    ].includes(p)),
    remedy: "retain rejected complete census evidence through qualification and the actual producer exit" },
  { testFile: "test/ci/gates/an-incomplete-census-capture-survives-its-producer-exit.test.ts",
    trigger: ({ changed }) => changed.some((p) => [
      "scripts/census-precheck.mjs", "scripts/lib/retained-fixtures.mjs", "scripts/lib/retained-fixtures.d.mts",
      "test/setup/retained-fixtures.ts", "test/setup/tmp-hygiene.ts",
      "test/ci/gates/an-incomplete-census-capture-survives-its-producer-exit.test.ts",
    ].includes(p)),
    remedy: "retain the actual incomplete census capture through the shared fixture registry until its producer exits" },
  ...[
    { testFile: "test/baked-supervisor-inputs.test.ts", seed: "src/lib/serve-supervisor-main.ts",
      remedy: "catalog each module the closure gains or loses in BAKED_RUNTIME_SOURCE_PATHS (src/lib/baked-runtime-inputs.ts) and in .github/workflows/acr-build.yml's on.push.paths and drift loop" },
    { testFile: "test/a-busy-primary-reaches-its-image-recycle.test.ts", seed: "src/lib/deployer.ts",
      remedy: "catalog each module the closure gains or loses in DEPLOY_LOGIC_PATHS (deploy/install-host-units.sh)" },
    { testFile: "test/acr-build-trigger.test.ts", seed: "src/lib/serve-supervisor-main.ts",
      remedy: "update .github/workflows/acr-build.yml's on.push.paths and drift loop against BAKED_RUNTIME_SOURCE_PATHS (src/lib/baked-runtime-inputs.ts)" },
  ].map(({ seed, ...row }) => ({ ...row, trigger: (input) =>
    input.changed.includes(row.testFile) || closureImportTrigger(seed)(input) })),
  // W1-T9872: these test/ censuses now join listRuleSuites through their recursive Git enumeration.
  // Read both sides: removing a package scope or sweep lock can break a census without adding a token.
  { testFile: "test/architecture-fitness.test.ts", structural: true,
    trigger: (input) => input.changed.some((p) => ["test/architecture-fitness.test.ts", ".dependency-cruiser.cjs"].includes(p)) ||
      changesTestText(input, /return\s+(?:await\s+)?page\.|\b(?:tmpdir|writeFileSync|writeFile|put)\s*\(|await\s+import\s*\(/),
    remedy: "keep test module copies in an ESM scope under the project root and await page calls before teardown" },
  { testFile: "test/orphan-sweep-names-the-third-party.test.ts",
    trigger: (input) => input.changed.some((p) => ["test/orphan-sweep-names-the-third-party.test.ts", "src/lib/worker-containment.ts"].includes(p)) ||
      changesTestText(input, /withRealSweepLock|\[RUN_ID_ENV\]/),
    remedy: "hold withRealSweepLock in every fixture that sends an ended-run stray into a real sweep" },
  { testFile: "test/the-mutant-loader-resolves-every-relative-import.test.ts",
    trigger: (input) => input.changed.some((p) => ["test/the-mutant-loader-resolves-every-relative-import.test.ts", "test/helpers/mutant-module.ts", "scripts/satisfied-task-census.mjs"].includes(p)) ||
      changesTestText(input, /\.replace\s*\(/),
    remedy: "rewrite copied module imports through rewriteRelativeSpecifiers / writeMutantModule" },
  { testFile: "test/a-near-crossing-check-loads-the-gate-gardener-as-esm.test.ts", gitFree: true,
    trigger: ({ changed }) => changed.some((p) => [
      "scripts/expiring-fixture-census.mjs", "src/lib/gate-gardener.ts", "scripts/census-precheck.mjs",
      "test/a-near-crossing-check-loads-the-gate-gardener-as-esm.test.ts",
    ].includes(p)),
    remedy: "load src/lib/gate-gardener.ts through tsImport (ESM), never tsx/cjs/api" },
  // W1-T9860: the basename-uniqueness check, asked when its rule (the resolver) or the check itself changes. A new
  // test that takes a held basename is refused by the same suite in CI's rule-checks.
  { testFile: "test/every-test-basename-is-unique.test.ts",
    trigger: ({ changed }) => changed.some((p) =>
      ["src/lib/test-path-resolver.ts", "test/every-test-basename-is-unique.test.ts"].includes(p)),
    remedy: "rename one test of each pair: resolveTestPath (src/lib/test-path-resolver.ts) finds a moved test by its unique basename" },
  { testFile: "test/gardeners/the-memory-tuner-fixture-shares-a-clock-with-its-shell.test.ts",
    trigger: ({ changed }) => changed.some((p) => [
      "test/a-squeezed-page-cache-grows-its-memory-high.test.ts", "test/the-beat-publishes-each-daemons-memory-high.test.ts",
      "test/the-sweep-reads-the-reviewers-own-summary.test.ts", "test/gardeners/the-memory-tuner-fixture-shares-a-clock-with-its-shell.test.ts",
    ].includes(p)),
    remedy: "run the measured clock-control regressions when their physical fixture inputs change" },
  { testFile: "test/sandbox-subject-generator.test.ts",
    trigger: ({ changed }) => changed.some((p) => (p.startsWith("learnings/") && /\.ya?ml$/.test(p)) || [
      "learnings/index.json", "src/lib/learnings.ts", "src/lib/wipe-test.ts",
      "test/sandbox-subject-generator.test.ts",
    ].includes(p)),
    remedy: "preserve isolating sandbox subjects when learning bindings change" },
];

export const GATE_REPAIR_RULES = [...PRECHECK_TRIGGERED_SUITES, ...PRECHECK_PATH_TRIGGERED_SUITES]
  .filter((entry) => entry.recognizer && entry.ownFiles)
  .map((entry) => ({ gate: entry.testFile, recognizer: entry.recognizer,
    symbol: entry.symbol ?? entry.script ?? entry.testFile, ownFiles: entry.ownFiles,
    gateRegex: entry.gateRegex, trigger: entry.trigger }));


/**
 * Admitted suites join by `walks` prefixes; triggered suites join by new literals or registry changes.
 * They run through `runSuites` (the structural ones each in their own call); each failure is one row in the shape censusPushRefusal reads.
 * A diff joining none starts no child. Every failure
 * to read the table or run the suites is `unmeasured` with its reason, never an empty violation list.
 *
 * @param {{ changed: string[], loadMembers: () => { testFile: string, script: string, walks: string[] }[],
 *   runSuites: (files: string[]) => string[], readHead?: (p: string) => string | null,
 *   readBase?: (p: string) => string | null }} input
 * @returns {{ violations: string[], unmeasured: string | null }}
 */
export function evaluateAdmittedCensusSuites({ changed, loadMembers, runSuites, readHead, readBase }) {
  if (changed.length === 0) return { violations: [], unmeasured: null };
  let members;
  let triggered;
  try {
    members = loadMembers();
    triggered = [...PRECHECK_TRIGGERED_SUITES, ...PRECHECK_PATH_TRIGGERED_SUITES]
      .filter((m) => m.trigger({ changed, readHead, readBase }));
  } catch (e) {
    return { violations: [], unmeasured: String(e?.message ?? e) };
  }
  const admitted = members.filter((m) => changed.some((p) => m.walks.some((w) => p.startsWith(w))));
  const byFile = new Map();
  for (const member of [...admitted, ...triggered]) {
    const prior = byFile.get(member.testFile);
    byFile.set(member.testFile, {
      ...prior, ...member,
      script: member.script || prior?.script || "",
      structural: member.structural || prior?.structural,
      timeoutMs: member.timeoutMs ?? prior?.timeoutMs,
      readerRuntimePolicy: member.readerRuntimePolicy ?? prior?.readerRuntimePolicy,
    });
  }
  const joined = [...byFile.values()];
  if (joined.length === 0) return { violations: [], unmeasured: null };
  // W1-T5693: the slow whole-tree suites each run in their OWN child, so one that exceeds its time bound reads
  // NOT MEASURED alone and cannot turn the others' verdicts into a silent pass.
  const groups = [joined.filter((m) => !m.structural), ...joined.filter((m) => m.structural).map((m) => [m])]
    .filter((group) => group.length > 0);
  const violations = [];
  const unmeasured = [];
  for (const group of groups) {
    let failing;
    try {
      const files = [...new Set(group.map((m) => m.testFile))];
      failing = new Set(group[0].readerRuntimePolicy !== undefined ? runSuites(files, { readerRuntimePolicy: group[0].readerRuntimePolicy }) :
        group[0].timeoutMs === undefined ? runSuites(files) : runSuites(files, { timeoutMs: group[0].timeoutMs }));
    } catch (e) {
      const reason = String(e?.message ?? e);
      unmeasured.push(!group[0].structural ? reason : `${group[0].testFile}: ${reason}`);
      continue;
    }
    violations.push(
      ...group
        .filter((m) => failing.has(m.testFile))
        .map((m) => `census-suite: ${m.testFile} fails — run ${m.script ? `npm run ${m.script}` : `node --test --import tsx ${m.testFile}`}${m.remedy ? `; ${m.remedy}` : ""}`),
    );
  }
  return { violations, unmeasured: unmeasured.length === 0 ? null : unmeasured.join("; ") };
}

export const PRECHECK_PARITY_BASELINE = "scripts/census-precheck-parity-baseline.json";

/** Explicit pre-push proof runs that are rostered but are not admitted census populations. */
export const PRECHECK_ADDITIONAL_RUNS = [
  // W1-T7719: listRuleSuites includes this rostered proof, so pre-push asks it directly as well.
  { testFile: "test/a-stale-dirty-fix-owner-is-preserved-and-reclaimed.test.ts", script: "test:fix-owner-recovery" },
  // W1-T7853: the same for the two suites its disclosed census-shaped rows put in listRuleSuites.
  { testFile: "test/ci-filed-fold-debt-reaches-the-daemon.test.ts", script: "test:fold-debt-pull" },
  { testFile: "test/the-merge-queue-runs-the-recorded-literal-gates.test.ts", script: "test:merge-queue-gates" },
];

/** Every census suite this script asks before the push, and how: `modeled` names the check that asks its
 *  question here, `run` an npm script that runs it. test/every-ci-census-is-asked-before-the-push.test.ts
 *  fails on a CI census on neither this nor the shrink-only baseline above (W1-T5616). */
export const PRECHECK_PARITY = {
  "test/clock-signature-census.test.ts": { modeled: clockViolations },
  "test/comment-load-ratchet.test.ts": { modeled: commentLoadViolations },
  "test/fixture-copy-census.test.ts": { modeled: fixtureCopyViolations },
  "test/deps-interface-census.test.ts": { modeled: depsInterfaceViolations },
  "test/repo-layout.test.ts": { modeled: houseLayoutViolations },
  "test/every-test-finds-the-repo-root-through-one-helper.test.ts": { modeled: testRepoRootViolations },
  "test/instrument-surface-completeness.test.ts": { modeled: evaluateInstrumentSurface },
  // W1-T5737: the script gates ci.yml runs, read out of ci.yml whenever a push edits it or the parity baseline.
  "test/every-ci-script-ratchet-has-a-pre-push-verdict.test.ts": { modeled: scriptRatchetViolations },
  "test/census-precheck-runs-the-admitted-census-suites.test.ts": { modeled: evaluateAdmittedCensusSuites },
  "test/the-census-precheck-runs-the-source-text-censuses-a-diff-joins.test.ts": { modeled: evaluateAdmittedCensusSuites },
  "test/a-suite-that-walks-an-import-closure-joins-its-diffs.test.ts": { modeled: evaluateAdmittedCensusSuites },
  "test/census-reader-runtime-calibration.test.ts": { modeled: runCensusSuitesViaChild },
  "test/a-census-suite-main-already-fails-does-not-refuse-a-joining-push.test.ts": { modeled: runCausedCensusSuites },
  // W1-T5692: the literal-triggered suites join the same evaluateAdmittedCensusSuites child.
  "test/census-precheck-runs-the-suites-a-new-literal-joins.test.ts": { modeled: evaluateAdmittedCensusSuites },
  // W1-T5693: the whole-tree structural suites join the same evaluateAdmittedCensusSuites, each in its own child.
  "test/census-precheck-runs-the-whole-tree-suites-a-diff-can-move.test.ts": { modeled: evaluateAdmittedCensusSuites },
  "test/the-precheck-asks-the-census-suites-a-test-or-priced-step-moves.test.ts": { modeled: evaluateAdmittedCensusSuites },
  "test/the-precheck-asks-the-worktree-creation-census.test.ts": { modeled: evaluateAdmittedCensusSuites },
  // W1-T5617: CENSUS_ADMITTED_MEMBERS, run through each one's own npm script's suite.
  "test/bound-kind-declared.test.ts": { run: "census:bound-kind" },
  "test/ledger-literal-census.test.ts": { run: "census:ledger-literal" },
  "test/catch-erasure-ratchet.test.ts": { run: "census:catch-erasure" },
  "test/negative-reachability-ratchet.test.ts": { run: "census:negative-reachability" },
  "test/authority-ratchet.test.ts": { run: "census:authority" },
  "test/no-shallowing-of-the-canonical-checkout.test.ts": { run: "census:no-shallowing" },
  "test/no-draft-pull-request-ever-sits-on-the-board.test.ts": { run: "census:no-draft-pr" },
  ...Object.fromEntries(PRECHECK_ADDITIONAL_RUNS.map((m) => [m.testFile, { run: m.script }])),
  ...Object.fromEntries(PRECHECK_TRIGGERED_SUITES.map((m) => [m.testFile, { run: m.script }])),
  ...Object.fromEntries(PRECHECK_PATH_TRIGGERED_SUITES.map((m) => [m.testFile, { modeled: evaluateAdmittedCensusSuites }])),
};

/** Census suites CI runs only in its ci/coverage shards, because no census name puts them in
 *  `listRuleSuites`; each with the incident that showed a push was blind to it. */
export const PRECHECK_EXTRA_CI_CENSUSES = {
  "test/spend-is-counted-once-at-its-producer.test.ts": "SPEND_STEP_ROLES — #8988 #9041",
  "test/ledger-rotation.test.ts": "DECISION_RELEVANT_LEDGER_STEPS — #8988 #9041",
  "test/a-union-read-of-an-unretained-step-is-refused.test.ts": "DECISION_RELEVANT_LEDGER_STEPS — #8988 #9041",
  "test/every-priced-ledger-step-is-in-the-config-garden-read.test.ts": "CONFIG_GARDEN_LEDGER_STEPS — #9179 #9181",
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

/** The script-level gates CI runs as their own steps (W1-T5737). The question W1-T5616 asked of every census
 *  SUITE, asked of every ci.yml script: `npm run --silent <script>` or `node scripts/<name>.mjs`, counted when the
 *  enclosing step's id or the script's own name says ratchet, census, budget, monotonic, parity or signal. Each is
 *  keyed `script:<name>` and counted once however many places ci.yml invokes it. Only .github/workflows/ci.yml. */
const SCRIPT_GATE_NAME = /ratchet|census|budget|monotonic|parity|signal/;

export function ciScriptRatchetPopulation(ciYamlText) {
  const keys = new Set();
  let stepId = "";
  for (const line of String(ciYamlText).split("\n")) {
    if (/^\s*-\s+\S/.test(line)) stepId = "";
    const id = line.match(/^\s*(?:-\s+)?id:\s*([\w-]+)/);
    if (id) stepId = id[1];
    for (const m of line.matchAll(/npm run --silent\s+([\w:-]+)|\bnode\s+(?:\S+\s+)*?scripts\/([\w-]+)\.mjs/g)) {
      const name = m[1] ?? m[2];
      if (SCRIPT_GATE_NAME.test(`${stepId} ${name}`)) keys.add(`script:${name}`);
    }
  }
  return [...keys].sort();
}

/** Every ci.yml script gate this script asks before the push: `modeled` names the check, `run` an npm script
 *  that runs the gate's own census suite. A script gate on neither this nor `ciOnlyScripts` in
 *  scripts/census-precheck-parity-baseline.json is named by test/every-ci-script-ratchet-has-a-pre-push-verdict.test.ts. */
export const PRECHECK_SCRIPT_PARITY = {
  "script:comment-load-signal": { modeled: commentLoadViolations },
  "script:cycle-ratchet": { run: "census:cycle-ratchet" },
};

/** The verdict for the script gates: `precheckParityVerdict` over `script:<name>` keys. `baseline` and
 *  `baseBaseline` are the `ciOnlyScripts` objects (the merge base's, or null when it had none). */
export function scriptRatchetParityVerdict({ population, baseline, baseBaseline = null, parity = PRECHECK_SCRIPT_PARITY }) {
  return precheckParityVerdict({
    population,
    baseline: Object.keys(baseline),
    baseBaseline: baseBaseline === null ? null : Object.keys(baseBaseline),
    parity,
  });
}

function gitOut(root, args, options = {}) {
  const res = git(args, { cwd: root, ...options });
  if (res.status !== 0) throw new Error(`git ${args[0]}: ${(res.stderr || "no diagnostic").trim()}`);
  return res.stdout;
}

function runCausedCensusSuites({ root, files, mergeBase, runSuites, ...optionsForSuites }) {
  const failing = [...new Set(runSuites({ root, files, ...optionsForSuites }))];
  if (failing.length === 0) return [];
  const temporary = mkdtempSync(join(tmpdir(), "rmd-census-base-"));
  const baseRoot = join(temporary, "tree");
  // Hook GIT_* variables must not redirect the private checkout into the pushing checkout.
  const options = { env: Object.fromEntries(Object.keys(process.env).filter((k) => k.startsWith("GIT_")).map((k) => [k, undefined])) };
  try {
    mkdirSync(baseRoot);
    gitOut(baseRoot, ["init", "--quiet"], options);
    const objects = gitOut(root, ["rev-parse", "--path-format=absolute", "--git-path", "objects"], options).trim();
    writeFileSync(join(baseRoot, ".git", "objects", "info", "alternates"), `${objects}\n`);
    writeFileSync(join(baseRoot, ".git", "packed-refs"), gitOut(root, ["for-each-ref", "--format=%(objectname) %(refname)"], options));
    writeFileSync(join(baseRoot, ".git", "HEAD"), `${mergeBase}\n`);
    // Census children need the base index, HEAD and refs for baseline comparisons. checkout-index
    // uses the source repo's checkout settings and keeps export-ignore/export-subst files intact.
    options.env.GIT_INDEX_FILE = join(baseRoot, ".git", "index");
    gitOut(root, ["-c", "core.sparseCheckout=false", "-c", "core.splitIndex=false", "read-tree", mergeBase], options);
    gitOut(root, ["--work-tree", baseRoot, "checkout-index", "--all"], options);
    if (!existsSync(join(baseRoot, "node_modules"))) {
      symlinkSync(join(existsSync(join(root, "node_modules")) ? root : SCRIPT_REPO, "node_modules"), join(baseRoot, "node_modules"), "dir");
    }
    for (const file of failing) {
      if (!existsSync(join(baseRoot, file))) throw new Error(`merge-base suite ${file} is absent`);
    }
    const baseFailing = new Set(runSuites({ root: baseRoot, files: failing, ...optionsForSuites }));
    return failing.filter((file) => !baseFailing.has(file));
  } catch (e) {
    throw new Error(`merge-base census run could not be measured: ${String(e?.message ?? e)}`);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

const SNAPSHOT_REACH = "test/the-affected-suite-reach-ratchet.test.ts";
const GIT_NAME_RE = /^git(?:[-.]|$)/;

/** W1-T9484: the suites a snapshot-mode round can run with no git, declared `gitFree: true` on their census row. */
export function gitFreeCensusSuites() {
  return [...PRECHECK_TRIGGERED_SUITES, ...PRECHECK_PATH_TRIGGERED_SUITES].filter((m) => m.gitFree === true).map((m) => m.testFile);
}

/**
 * W1-T9484: a directory of symlinks to every executable on `pathValue` except git (and its `git-*` helpers), so a
 * child run with it as PATH finds every tool but git and a git spawn dies ENOENT. Returns `{ bin, cleanup }`.
 */
export function makeGitAbsentBin(pathValue = process.env.PATH ?? "") {
  const parent = mkdtempSync(join(tmpdir(), "rmd-census-nogit-"));
  const bin = join(parent, "bin");
  mkdirSync(bin);
  const linked = new Set();
  for (const dir of pathValue.split(delimiter).filter(Boolean)) {
    let names;
    try {
      names = readdirSync(dir);
    } catch {
      continue; // a PATH entry that is not a readable directory contributes no tool
    }
    for (const name of names) {
      if (GIT_NAME_RE.test(name) || linked.has(name)) continue;
      linked.add(name);
      try {
        symlinkSync(join(dir, name), join(bin, name));
      } catch {
        linked.delete(name); // a later PATH entry may still supply this tool
      }
    }
  }
  return { bin, cleanup: () => rmSync(parent, { recursive: true, force: true }) };
}

function runSnapshotReach(snapshot, files) {
  const run = (snapshotPath) => runCensusSuitesViaChild({ root: SCRIPT_REPO, files, snapshotPath,
    priority: { wrap: (file, args) => ({ file, args }) } });
  const failing = run();
  if (failing.length === 0) return [];
  const temporary = mkdtempSync(join(tmpdir(), "rmd-census-snapshot-base-"));
  try {
    for (const path of snapshot.basePaths) {
      if (typeof snapshot.baseBlobs[path] !== "string") throw new Error(`snapshot lacks base blob ${path}`);
      mkdirSync(dirname(join(temporary, path)), { recursive: true });
      writeFileSync(join(temporary, path), snapshot.baseBlobs[path]);
    }
    const path = join(temporary, "snapshot.json");
    writeFileSync(path, JSON.stringify({ ...snapshot, root: temporary, headPaths: snapshot.basePaths }), { mode: 0o444 });
    const baseFailing = new Set(run(path));
    return failing.filter((file) => !baseFailing.has(file));
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

/**
 * W1-T9484: the `gitFree` suites run in ONE child over the round's own tree (`root`, not the harness's), with git
 * absent from PATH. A red one re-runs over a base tree rebuilt from the snapshot's frozen base blobs, with every other
 * top-level entry (node_modules, docs, .github) linked from `root`; only head-red/base-green is returned.
 */
function runSnapshotGitFree(snapshot, files, root) {
  if (!existsSync(join(root, "node_modules"))) throw new Error(`${root} has no node_modules, so ${files.join(", ")} cannot run from it`);
  const noGit = makeGitAbsentBin();
  const identity = { wrap: (file, args) => ({ file, args }) };
  try {
    const run = (cwd) => runCensusSuitesViaChild({ root: cwd, files, priority: identity, pathOverride: noGit.bin });
    const failing = run(root);
    if (failing.length === 0) return [];
    const temporary = mkdtempSync(join(tmpdir(), "rmd-census-snapshot-base-"));
    try {
      for (const path of snapshot.basePaths) {
        if (typeof snapshot.baseBlobs[path] !== "string") throw new Error(`snapshot lacks base blob ${path}`);
        mkdirSync(dirname(join(temporary, path)), { recursive: true });
        writeFileSync(join(temporary, path), snapshot.baseBlobs[path]);
      }
      const owned = new Set([...snapshot.basePaths.map((path) => path.split("/")[0]), ".git", "state"]);
      for (const entry of readdirSync(root)) {
        if (!owned.has(entry)) symlinkSync(join(root, entry), join(temporary, entry));
      }
      for (const file of failing) {
        if (!existsSync(join(temporary, file))) throw new Error(`merge-base suite ${file} is absent`);
      }
      const baseFailing = new Set(run(temporary));
      return failing.filter((file) => !baseFailing.has(file));
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  } finally {
    noGit.cleanup();
  }
}

/**
 * W1-T9484: what a snapshot-mode round measures of `files`. The reach ratchet reads the snapshot itself; a
 * `gitFree` suite runs over `root` with git absent; any other suite needs git, so it is returned in `notMeasured`
 * (a reason string naming it) and never as a pass. A gitFree run that cannot be measured is a reason too, so one
 * unrunnable kind cannot drop the verdict of the other.
 */
function runSnapshotSuites(snapshot, files, root) {
  const gitFree = new Set(gitFreeCensusSuites());
  const free = files.filter((file) => file !== SNAPSHOT_REACH && gitFree.has(file));
  const needGit = files.filter((file) => file !== SNAPSHOT_REACH && !gitFree.has(file));
  const failing = files.includes(SNAPSHOT_REACH) ? runSnapshotReach(snapshot, [SNAPSHOT_REACH]) : [];
  const notMeasured = needGit.length === 0 ? [] : [`git-free snapshot reader unavailable for ${needGit.join(", ")}`];
  if (free.length > 0) {
    try {
      failing.push(...runSnapshotGitFree(snapshot, free, root));
    } catch (e) {
      notMeasured.push(String(e?.message ?? e));
    }
  }
  return { failing, notMeasured };
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
  const snapshotUnmeasured = [];
  const suiteErrors = [];
  try {
    const snapshot = readCensusSnapshot();
    if (snapshot && resolve(snapshot.root) !== root) throw new Error("census snapshot belongs to another worktree");
    const mergeBase = snapshot?.mergeBase ?? gitOut(root, ["merge-base", "HEAD", values.base]).trim();
    changed = snapshot
      ? [...new Set([...snapshot.basePaths, ...censusSnapshotPaths(snapshot)])]
        .filter((p) => (existsSync(join(root, p)) ? readFileSync(join(root, p), "utf8") : null) !== (snapshot.baseBlobs[p] ?? null))
      : gitOut(root, ["diff", "--name-only", "--no-renames", mergeBase]).split("\n").filter(Boolean);
    const readers = {
      readHead: (p) => (existsSync(join(root, p)) ? readFileSync(join(root, p), "utf8") : null),
      readBase: (p) => {
        if (snapshot) return snapshot.baseBlobs[p] ?? null;
        const res = git(["show", `${mergeBase}:${p}`], { cwd: root });
        return res.status === 0 ? res.stdout : null;
      },
    };
    violations = evaluateCensusPrecheck({
      changed,
      reportHouseLayoutSplit: (line) => console.log(line),
      reportCommentSignal: (finding) => console.log(`comment-load-signal-json: ${JSON.stringify(finding)}`),
      ...readers,
      measuredFiles: snapshot ? censusSnapshotPaths(snapshot).filter((p) => MEASURED_ROOTS.some((dir) => p.startsWith(`${dir}/`))) : listMeasuredFiles(root),
      testFiles: listFixtureCopyFiles(root),
      srcFiles: listHouseLayoutSrcFiles(root),
    });
    const instrument = evaluateInstrumentSurface({
      changed,
      readHead: readers.readHead,
      reportExcused: (line) => console.log(line),
      measureInstrumentSurface: () => {
        if (snapshot) {
          if (!Array.isArray(snapshot.instrumentSurface) || !snapshot.instrumentExclusions) {
            throw new Error("snapshot lacks instrument-surface declarations");
          }
          return {
            head: measureTree({ tracked: new Set(censusSnapshotPaths(snapshot)), readText: readers.readHead },
              snapshot.instrumentSurface, snapshot.instrumentExclusions),
            base: measureTree({ tracked: new Set(snapshot.basePaths), readText: readers.readBase },
              snapshot.instrumentSurface, snapshot.instrumentExclusions),
          };
        }
        return measure({ root, mergeBase });
      },
    });
    violations.push(...instrument.violations);
    if (instrument.unmeasured !== null) unmeasured.push(`instrument-surface NOT MEASURED - ${instrument.unmeasured}`);
    const suites = evaluateAdmittedCensusSuites({
      changed,
      ...readers,
      loadMembers: () => admitted(root),
      runSuites: (files, options = {}) => {
        if (!snapshot) {
          try {
            return runCausedCensusSuites({ root, files, mergeBase, runSuites, ...options });
          } catch (e) {
            suiteErrors.push(e);
            throw e;
          }
        }
        if (options.readerRuntimePolicy !== undefined) throw new Error("source-reader runtime calibration is unavailable in git-free snapshot mode");
        const measured = runSnapshotSuites(snapshot, files, root);
        snapshotUnmeasured.push(...measured.notMeasured);
        return measured.failing;
      },
    });
    violations.push(...suites.violations);
    const suiteReasons = [...(suites.unmeasured === null ? [] : [suites.unmeasured]), ...snapshotUnmeasured];
    // W1-T9919: time-bound only when every unmeasured cause is a head child stopped on the backstop. A merge-base
    // run's stop is rewrapped without the mark: its head already failed a suite, so that stays a refusal.
    const timeBoundOnly = instrument.unmeasured === null && snapshotUnmeasured.length === 0 && suiteErrors.length > 0 &&
      suiteErrors.every((e) => e?.censusTimeBound === true);
    if (suiteReasons.length > 0) {
      unmeasured.push(`${timeBoundOnly ? CENSUS_TIME_BOUND_LABEL : "census suites NOT MEASURED"} - ${suiteReasons.join("; ")}`);
    }
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
