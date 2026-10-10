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
 * on head; failing suites run again in a detached merge-base worktree borrowing node_modules.
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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix, resolve } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createScanner, SyntaxKind } from "typescript/unstable/ast";
import { isMainModule } from "./lib/argv.mjs";
import { git } from "./lib/git.mjs";
import { measureTree } from "./lib/instrument-surface-census.mjs";
import {
  DEFAULT_BASELINE_RELATIVE_PATH as CLOCK_BASELINE,
  readBaseline as readClockBaseline,
  scanClockSignaturesFromText,
} from "./clock-signature-ratchet.mjs";
import {
  CEILING_BUCKET_COMMENTS,
  MEASURED_ROOTS,
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
    ...scriptRatchetViolations(input),
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
 * Runs `files` (repo-relative suite paths) once, in ONE `node --test` child over `root`, and returns the ones
 * that fail. THROWS, naming why, on every way the run can fail to be a measurement (spawn error, time bound,
 * signal, no `# tests` summary, zero tests, a non-zero exit its TAP does not explain): never `[]` for those.
 */
export function runCensusSuitesViaChild({ root, files, run = spawnSync, priority = TEST_PRIORITY, snapshotPath }) {
  const args = ["--test", "--test-reporter=tap", "--import", import.meta.resolve("tsx"), "--import", TMP_HYGIENE_URL, ...files];
  if (priority.reason) console.error(`census-precheck: census suites run at default priority - ${priority.reason}`);
  const child = priority.wrap(process.execPath, args);
  const options = childOptions(root);
  if (snapshotPath) options.env[CENSUS_SNAPSHOT_ENV] = snapshotPath;
  const res = run(child.file, child.args, options);
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
const TEST_TS_SCOPE_RE = /^test\/.+\.ts$/;
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

/** W1-T5692: these slower censuses join the same child when changed source adds a literal. */
export const PRECHECK_TRIGGERED_SUITES = [
  { testFile: "test/ledger-rotation.test.ts", script: "census:ledger-rotation", trigger: stepTrigger,
    remedy: "register DECISION_RELEVANT_LEDGER_STEPS in src/lib/ledger.ts" },
  { testFile: "test/a-union-read-of-an-unretained-step-is-refused.test.ts", script: "census:unretained-step", trigger: stepTrigger,
    remedy: "register DECISION_RELEVANT_LEDGER_STEPS in src/lib/ledger.ts" },
  { testFile: "test/spend-is-counted-once-at-its-producer.test.ts", script: "census:spend", trigger: stepTrigger,
    remedy: "declare SPEND_STEP_ROLES in src/lib/spend-rows.ts" },
  { testFile: "test/env-var-registry.test.ts", script: "census:env-var-registry",
    trigger: (input) => input.changed.includes("src/lib/config-schema.ts") || addsLiteral(input, ENV_NAME_RE, 0),
    remedy: "register ENV_REGISTRY in src/lib/config-schema.ts" },
  { testFile: "test/error-subclass-census.test.ts", script: "census:error-subclass",
    trigger: (input) => input.changed.includes("scripts/error-subclass-baseline.json") || addsLiteral(input, ERROR_CLASS_RE, 1),
    remedy: "adopt RmdError in src/lib/errors.ts or record the reviewed ceiling in scripts/error-subclass-baseline.json" },
  // W1-T5693: whole-tree structural censuses, 4-13 s each alone; `structural` runs each in its OWN child.
  { testFile: "test/cycle-ratchet.test.ts", script: "census:cycle-ratchet", structural: true,
    trigger: (input) => input.changed.some((p) => [".dependency-cruiser.cjs", "scripts/cycle-baseline.json", "scripts/cycle-ratchet.mjs"].includes(p)) ||
      addsImport(input, IMPORT_SCOPE_RE),
    remedy: "break the import ring or record the reviewed ceiling in scripts/cycle-baseline.json" },
  { testFile: "test/source-size-baseline-is-enforced.test.ts", script: "census:source-size", structural: true,
    trigger: (input) => input.changed.some((p) => ["scripts/source-size-ratchet.mjs", "src/lib/ci-parity.ts", ".dependency-cruiser.cjs"].includes(p)) ||
      addsImport(input, LIB_SCOPE_RE, importsLayerAboveLib),
    remedy: "src/lib must not import src/cli, src/spike.ts or src/run-task.ts (.dependency-cruiser.cjs)" },
  { testFile: "test/citation-anchor-census.test.ts", script: "census:citation-anchor", structural: true,
    trigger: ({ changed }) => changed.some((p) => p.startsWith("plan/tasks.d/") || p === "MASTER-PLAN.md" || p === "scripts/citation-anchor-census.mjs"),
    remedy: "anchor each #NNNN citation the shard or MASTER-PLAN.md adds (scripts/citation-anchor-census.mjs)" },
  // W1-T5702: a new test importing src/run-task.ts is the reach ratchet's own refusal.
  { testFile: "test/the-affected-suite-reach-ratchet.test.ts", script: "census:affected-reach", structural: true,
    trigger: (input) =>
      input.changed.some((p) => ["src/lib/affected-suites.ts", "scripts/affected-reach-baseline.json"].includes(p)) ||
      addsImport(input, TEST_TS_SCOPE_RE, (spec) => /(?:^|\/)run-task\.[jt]s$/.test(spec)),
    remedy: "import the module the suite tests rather than src/run-task.ts, or record the tighter ceiling in scripts/affected-reach-baseline.json" },
  { testFile: "test/node-24-runtime-compatibility.test.ts", script: "census:node24-runtime", trigger: node24RuntimeTrigger,
    remedy: "name --test-reporter=tap on the spawn (or mark it `node-test-reporter: exempt`) and let the Worker inherit execArgv" },
  { testFile: "test/every-priced-ledger-step-is-in-the-config-garden-read.test.ts", script: "census:every-priced-ledger-step",
    trigger: (input) => input.changed.includes("src/lib/config-gardener.ts") || addsMatch(input, CLOCK_SCOPE_RE, pricedWrites),
    remedy: "register CONFIG_GARDEN_LEDGER_STEPS in src/lib/config-gardener.ts or a reasoned exemption in test/every-priced-ledger-step-is-in-the-config-garden-read.test.ts" },
  { testFile: "test/host-capability-fixtures.test.ts", script: "census:host-capability-fixtures",
    trigger: (input) => addsMatch(input, TEST_TS_SCOPE_RE, (text) => text.split("\n").filter((line) => HOST_CAPABILITY_RE.test(line))),
    remedy: "own the fixture's host condition or declare its reason in test/host-capability-fixtures.test.ts" },
  { testFile: "test/no-test-drives-a-real-preflight-against-the-repository-root.test.ts", script: "census:no-nested-preflight",
    trigger: (input) =>
      input.changed.includes("test/no-test-drives-a-real-preflight-against-the-repository-root.test.ts") ||
      addsMatch(input, TEST_TS_SCOPE_RE, (text) => text.split("\n").filter((line) => /\bpreflightCommand\(|["']preflight["']/.test(line))),
    remedy: "inject `spawn` into preflightCommand / `dispatch` into main, or prove the invariant through preflightSummaryTarget" },
  // W1-T6106: a host git spawn into a worker worktree must go through src/lib/worktree-git.ts.
  { testFile: "test/every-host-git-spawn-into-a-worktree-uses-the-hardened-leaf.test.ts", script: "census:host-worktree-git",
    trigger: (input) =>
      input.changed.includes("src/lib/worktree-git.ts") ||
      addsMatch(input, CLOCK_SCOPE_RE, (text) => text.split("\n").filter((line) => /"-C",\s*(?:wt|worktreePath|[\w$]+\.worktreePath|worktreeRoot|batchWorktree|ownerPath)\b/.test(line))),
    remedy: "route the spawn through hostWorktreeGit (src/lib/worktree-git.ts), or name it in that suite's RAW_SITE_EXCEPTIONS with its reason" },
];

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
    triggered = PRECHECK_TRIGGERED_SUITES.filter((m) => m.trigger({ changed, readHead, readBase }));
  } catch (e) {
    return { violations: [], unmeasured: String(e?.message ?? e) };
  }
  const admitted = members.filter((m) => changed.some((p) => m.walks.some((w) => p.startsWith(w))));
  const joined = [...new Map([...admitted, ...triggered].map((m) => [m.testFile, m])).values()];
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
      failing = new Set(runSuites([...new Set(group.map((m) => m.testFile))]));
    } catch (e) {
      unmeasured.push(String(e?.message ?? e));
      continue;
    }
    violations.push(
      ...group
        .filter((m) => failing.has(m.testFile))
        .map((m) => `census-suite: ${m.testFile} fails — run npm run ${m.script}${m.remedy ? `; ${m.remedy}` : ""}`),
    );
  }
  return { violations, unmeasured: unmeasured.length === 0 ? null : unmeasured.join("; ") };
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
  // W1-T5737: the script gates ci.yml runs, read out of ci.yml whenever a push edits it or the parity baseline.
  "test/every-ci-script-ratchet-has-a-pre-push-verdict.test.ts": { modeled: scriptRatchetViolations },
  "test/census-precheck-runs-the-admitted-census-suites.test.ts": { modeled: evaluateAdmittedCensusSuites },
  "test/a-census-suite-main-already-fails-does-not-refuse-a-joining-push.test.ts": { modeled: runCausedCensusSuites },
  // W1-T5692: the literal-triggered suites join the same evaluateAdmittedCensusSuites child.
  "test/census-precheck-runs-the-suites-a-new-literal-joins.test.ts": { modeled: evaluateAdmittedCensusSuites },
  // W1-T5693: the whole-tree structural suites join the same evaluateAdmittedCensusSuites, each in its own child.
  "test/census-precheck-runs-the-whole-tree-suites-a-diff-can-move.test.ts": { modeled: evaluateAdmittedCensusSuites },
  "test/the-precheck-asks-the-census-suites-a-test-or-priced-step-moves.test.ts": { modeled: evaluateAdmittedCensusSuites },
  // W1-T5617: CENSUS_ADMITTED_MEMBERS, run through each one's own npm script's suite.
  "test/bound-kind-declared.test.ts": { run: "census:bound-kind" },
  "test/ledger-literal-census.test.ts": { run: "census:ledger-literal" },
  "test/catch-erasure-ratchet.test.ts": { run: "census:catch-erasure" },
  "test/negative-reachability-ratchet.test.ts": { run: "census:negative-reachability" },
  "test/authority-ratchet.test.ts": { run: "census:authority" },
  "test/no-shallowing-of-the-canonical-checkout.test.ts": { run: "census:no-shallowing" },
  "test/no-draft-pull-request-ever-sits-on-the-board.test.ts": { run: "census:no-draft-pr" },
  ...Object.fromEntries(PRECHECK_TRIGGERED_SUITES.map((m) => [m.testFile, { run: m.script }])),
};

/** Census suites CI runs only in its ci/coverage shards, because no census name puts them in
 *  `listRuleSuites`; each with the incident that showed a push was blind to it. */
export const PRECHECK_EXTRA_CI_CENSUSES = {
  "test/spend-is-counted-once-at-its-producer.test.ts": "SPEND_STEP_ROLES — #8988 #9041",
  "test/ledger-rotation.test.ts": "DECISION_RELEVANT_LEDGER_STEPS — #8988 #9041",
  "test/a-union-read-of-an-unretained-step-is-refused.test.ts": "DECISION_RELEVANT_LEDGER_STEPS — #8988 #9041",
  "test/host-capability-fixtures.test.ts": "host-capability-fixtures — #8994",
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

function runCausedCensusSuites({ root, files, mergeBase, runSuites }) {
  const failing = [...new Set(runSuites({ root, files }))];
  if (failing.length === 0) return [];
  const temporary = mkdtempSync(join(tmpdir(), "rmd-census-base-"));
  const baseRoot = join(temporary, "tree");
  // Hook GIT_* variables must not redirect worktree administration to the pushing checkout.
  const options = { env: Object.fromEntries(Object.keys(process.env).filter((k) => k.startsWith("GIT_")).map((k) => [k, undefined])) };
  let added = false;
  try {
    gitOut(root, ["worktree", "add", "--detach", baseRoot, mergeBase], options);
    added = true;
    if (!existsSync(join(baseRoot, "node_modules"))) {
      symlinkSync(join(existsSync(join(root, "node_modules")) ? root : SCRIPT_REPO, "node_modules"), join(baseRoot, "node_modules"), "dir");
    }
    for (const file of failing) {
      if (!existsSync(join(baseRoot, file))) throw new Error(`merge-base suite ${file} is absent`);
    }
    const baseFailing = new Set(runSuites({ root: baseRoot, files: failing }));
    return failing.filter((file) => !baseFailing.has(file));
  } catch (e) {
    throw new Error(`merge-base census run could not be measured: ${String(e?.message ?? e)}`);
  } finally {
    try {
      if (added) gitOut(root, ["worktree", "remove", "--force", baseRoot], options);
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  }
}

function runSnapshotReach(snapshot, files) {
  const reach = "test/the-affected-suite-reach-ratchet.test.ts";
  if (files.some((file) => file !== reach)) throw new Error(`git-free snapshot reader unavailable for ${files.join(", ")}`);
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
      runSuites: (files) => {
        if (!snapshot) return runCausedCensusSuites({ root, files, mergeBase, runSuites });
        return runSnapshotReach(snapshot, files);
      },
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
