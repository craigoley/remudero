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
 * `git diff` and `git show`. It builds no fixture and starts no runner.
 *
 * ONLY GROWTH THIS BRANCH CAUSES REFUSES. Each count is taken twice, on this tree and on the merge
 * base with `--base`, and a finding blocks only when the base did not already carry it (or this
 * branch grew it further). A census main already fails is main's to fix. Blocking every push on
 * it would be a bound that fires on a healthy condition, which is this repo's recurring defect.
 *
 * Exit 0 clean, 1 a caused violation, 2 could not measure (the hook does not block on 2).
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
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

function gitOut(root, args) {
  const res = git(args, { cwd: root });
  if (res.status !== 0) throw new Error(`git ${args[0]}: ${(res.stderr || "no diagnostic").trim()}`);
  return res.stdout;
}

export function main(argv) {
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
  } catch (e) {
    console.error(`census-precheck: could not measure — ${String(e.message ?? e)}`);
    return 2;
  }
  if (violations.length > 0) {
    console.error(`census-precheck: this branch grows ${violations.length} census count(s) CI will refuse:`);
    for (const v of violations) console.error(`  ${v}`);
    return 1;
  }
  console.log(`census-precheck: OK — ${changed.length} changed file(s) checked against ${values.base}`);
  return 0;
}

if (isMainModule(import.meta.url)) process.exit(main(process.argv.slice(2)));
