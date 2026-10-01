/**
 * THE INSTRUMENT-SURFACE COMPLETENESS DERIVATION, SHARED BY CI'S CENSUS AND THE PRE-PUSH PRECHECK.
 *
 * W1-T402's alarm derives candidate gate-rule paths from a tree and fails when one is neither on
 * INSTRUMENT_SURFACE nor excused (with a reason) in INSTRUMENT_SURFACE_EXCLUSIONS (src/lib/review.ts).
 * W1-T5101 moved the derivation here, verbatim, out of test/instrument-surface-completeness.test.ts:
 * it was file-local, and importing a node:test file runs its tests, so scripts/census-precheck.mjs
 * could not ask the same question before a push (#8235 passed the hook and went red in CI).
 *
 * The derivation takes `{ tracked, readText }` instead of reading the live tree, so one function runs
 * over this tree and over the merge base. The declarations are TypeScript (review.ts), so the CLI
 * entry below imports them dynamically and is run as a child under tsx; this module itself imports
 * no TypeScript at load.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { isMainModule } from "./argv.mjs";
import { git } from "./git.mjs";

// Extension alternation ordered LONGEST-FIRST and anchored at the token's end (`\b`). W1-T402's
// design recorded the trap directly: an alternation ordered `js` before `json` truncates
// `.jscpd.json` to `.jscpd.js` — untracked, and silently dropped by the tracked-file filter below
// — so the first hand-derivation reported the clearest instrument in the repo as underivable.
const EXT_RE = "(?:cjs|mjs|json|yaml|yml|ts|sh|js)";
const TOKEN_RE = new RegExp(`[A-Za-z0-9_./-]+\\.${EXT_RE}\\b`, "g");

/** Path-like tokens ending in a rule/config extension, in declaration order, longest-ext-first. */
export function harvestTokens(text) {
  return [...text.matchAll(TOKEN_RE)].map((m) => m[0].replace(/^\.\//, ""));
}

/** Under `src/`, `apps/`, `packages/`, or `test/` — the product/test halves, never a candidate. */
export function isProductOrTestPath(path) {
  return /^(src|apps|packages|test)\//.test(path);
}

/**
 * Derives candidate gate-rule paths from a tree (W1-T402 design clause (i), "declared-plus-derived"):
 * harvest path-like tokens out of every workflow file plus package.json's `scripts` values, restrict
 * to tracked, non-product/non-test paths, then follow ONE level into any harvested script's own
 * source for the sibling config files it reads (this is how `scripts/mutation-nightly-scope.json` —
 * never itself named in a `run:` line, only reached via `scripts/mutation-ratchet.mjs`'s own
 * `join(__dirname, ...)` default) is recovered without an unbounded, over-eager recursive harvest
 * (the design's own rejected alternative — it pulled in `src/run-task.ts` and `src/lib/review.ts`,
 * which would fire this alarm on nearly every PR).
 *
 * `readText` returns a tracked path's text, or null when the tree does not hold it. A missing
 * package.json is no scripts; a malformed one throws, and a caller reports that as not measured.
 *
 * @param {{ tracked: Set<string>, readText: (path: string) => string | null }} tree
 * @returns {string[]}
 */
export function deriveInstrumentCandidates({ tracked, readText }) {
  const workflowFiles = [...tracked].filter((f) => f.startsWith(".github/workflows/") && /\.ya?ml$/.test(f));

  const stageA = new Set();
  for (const f of workflowFiles) {
    for (const t of harvestTokens(readText(f) ?? "")) stageA.add(t);
  }
  const pkgText = readText("package.json");
  const pkg = pkgText === null ? {} : JSON.parse(pkgText);
  for (const t of harvestTokens(Object.values(pkg.scripts ?? {}).join("\n"))) stageA.add(t);

  const candidates = new Set([...stageA].filter((f) => tracked.has(f) && !isProductOrTestPath(f)));

  const STRING_LIT_RE = /["']([A-Za-z0-9_./-]+\.(?:json|ya?ml))["']/g;
  const scriptCandidates = [...candidates].filter((f) => /\.(mjs|cjs|ts|sh)$/.test(f));
  for (const s of scriptCandidates) {
    const src = readText(s);
    if (src === null) continue;
    const dir = s.split("/").slice(0, -1).join("/");
    for (const m of src.matchAll(STRING_LIT_RE)) {
      const rel = m[1].replace(/^\.\//, "");
      for (const c of [rel, dir ? `${dir}/${rel}` : rel]) {
        if (tracked.has(c) && !isProductOrTestPath(c)) candidates.add(c);
      }
    }
  }
  return [...candidates].sort();
}

/**
 * THE ALARM ITSELF, pure: a derived candidate is unexplained when it matches neither
 * `declaredRe` (the BLOCKING authority) nor carries a non-blank reason in `exclusions`. Never
 * consults anything but its three arguments, so it is exercised directly against fabricated
 * fixtures (proving the mechanism in isolation) and against a real tree's own derivation
 * without duplicating the check's logic between the two.
 *
 * @param {string[]} candidates
 * @param {RegExp} declaredRe
 * @param {Readonly<Record<string, string>>} exclusions
 * @returns {string[]}
 */
export function findUnexplainedGaps(candidates, declaredRe, exclusions) {
  return candidates.filter((c) => {
    if (declaredRe.test(c)) return false;
    const reason = exclusions[c];
    return typeof reason !== "string" || reason.trim().length === 0;
  });
}

/** The declared-path regex built from INSTRUMENT_SURFACE's pattern list. */
export function declaredInstrumentRe(surface) {
  return new RegExp(surface.join("|"));
}

/** This tree as `{ tracked, readText }`: `git ls-files` plus the file system. */
export function liveTree(root) {
  const res = git(["ls-files"], { cwd: root });
  if (res.status !== 0) throw new Error(`git ls-files: ${(res.stderr || "no diagnostic").trim()}`);
  return {
    tracked: new Set(res.stdout.split("\n").filter(Boolean)),
    readText: (p) => (existsSync(join(root, p)) ? readFileSync(join(root, p), "utf8") : null),
  };
}

/** The tree at `sha` as `{ tracked, readText }`: `git ls-tree -r --name-only` plus `git show`. */
export function treeAt(root, sha) {
  const res = git(["ls-tree", "-r", "--name-only", sha], { cwd: root });
  if (res.status !== 0) throw new Error(`git ls-tree ${sha}: ${(res.stderr || "no diagnostic").trim()}`);
  return {
    tracked: new Set(res.stdout.split("\n").filter(Boolean)),
    readText: (p) => {
      const shown = git(["show", `${sha}:${p}`], { cwd: root });
      return shown.status === 0 ? shown.stdout : null;
    },
  };
}

/** One side of the measurement: the derived candidates and the gaps among them. */
export function measureTree(tree, surface, exclusions) {
  const candidates = deriveInstrumentCandidates(tree);
  return { candidates, gaps: findUnexplainedGaps(candidates, declaredInstrumentRe(surface), exclusions) };
}

/** CLI: prints ONE JSON line `{ head, base }`; any failure is a stderr diagnostic and a non-zero exit. */
export async function main(argv) {
  const { values } = parseArgs({
    args: argv,
    options: { root: { type: "string", default: "." }, "merge-base": { type: "string" } },
  });
  const root = resolve(values.root);
  const mergeBase = values["merge-base"];
  if (!mergeBase) throw new Error("--merge-base <sha> is required");
  const { INSTRUMENT_SURFACE, INSTRUMENT_SURFACE_EXCLUSIONS } = await import("../../src/lib/review.ts");
  const head = measureTree(liveTree(root), INSTRUMENT_SURFACE, INSTRUMENT_SURFACE_EXCLUSIONS);
  const base = measureTree(treeAt(root, mergeBase), INSTRUMENT_SURFACE, INSTRUMENT_SURFACE_EXCLUSIONS);
  console.log(JSON.stringify({ head, base }));
}

if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(`instrument-surface-census: ${String(e?.message ?? e)}`);
    process.exit(1);
  });
}
