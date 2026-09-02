/**
 * lib/worktree-sites.ts — W1-T2622: THE CENSUS OF EVERY WORKTREE-CREATION SITE IN `src/`.
 *
 * THE QUESTION THIS ANSWERS. W1-T2621 taught `worktreeAdd` (lib/worker.ts) to record the base it
 * cut from and assert the base is current against origin/main — but nothing enumerated the OTHER
 * paths that create worktrees, so "is a stale/silent base systemic across provisioning, or is
 * `worktreeAdd` the only path that matters" was unanswerable by inspection alone. This module makes
 * it answerable and KEEPS it answerable: {@link WORKTREE_SITE_REGISTRY} is the list, and
 * {@link assertWorktreeSiteCensusClean} is the guard that stops the list from silently going stale
 * in either direction.
 *
 * THE REGISTRY IS DATA, NEVER A CODE BRANCH. One row per worktree-creation site found in `src/`,
 * each naming the file, an identifying `site` (the enclosing function/property name), what it
 * creates, and its disposition:
 *   - `{ kind: "routes-through" }` — it calls the shared `worktreeAdd`, so it already gets a
 *     recorded base and an asserted currency for free (W1-T2621's own work covers it).
 *   - `{ kind: "exempt", because }` — it cuts a worktree with a RAW `git worktree add` invocation,
 *     never touching `worktreeAdd` at all, and `because` is the reason origin/main currency is not
 *     the applicable question for it. A blank reason is refused by the guard below: an exemption
 *     with no stated reason is how a hole becomes permanent.
 *
 * THE GUARD IS BIDIRECTIONAL, over the SHIPPED SOURCE — never a hand-maintained duplicate of it.
 * {@link assertWorktreeSiteCensusClean} re-scans `src/` on every call and fails on THREE distinct
 * drifts:
 *   1. a raw `git worktree add` invocation (outside `worktreeAdd`'s own body) with no matching
 *      `exempt` row — a new hole, appearing silently;
 *   2. a registry row whose named site no longer exists in `src/` at all — a rotted entry, checked
 *      for BOTH kinds (an `exempt` row's raw invocation gone, or a `routes-through` row's named
 *      function/method no longer declared) — the census stops being evidence the moment it
 *      outlives what it describes;
 *   3. an `exempt` row whose `because` is blank.
 * 1+2 together are what the task calls "bidirectional": a new raw site cannot appear silently (1),
 * and a rotted exemption cannot outlive the site it excused (2).
 *
 * WHY `routes-through` ROWS ARE CHECKED FOR EXISTENCE ONLY, NOT FOR STILL CALLING `worktreeAdd`.
 * An early revision of this guard also re-derived every `worktreeAdd(...)` CALL site by scanning
 * `src/` for the literal text `worktreeAdd(` and cross-checking it against the registry the same
 * way raw sites are — and that scan matched ITS OWN doc comments and error-message strings in this
 * very file (`"...route this through worktreeAdd (src/lib/worker.ts)..."` is prose, not a call),
 * plus mis-attributed a nested `deps` object literal's `log:` property as a call's "site" instead
 * of the enclosing function. A text scan cannot tell a call from a mention of one reliably enough
 * to gate a build on it. Checking only that the DECLARATION named by a `routes-through` row still
 * exists keeps the useful signal (the row rots if the function is renamed or deleted) without that
 * false-positive surface — the four claims this task must prove (see its acceptance criteria) are
 * all about raw sites and exemptions, never about re-deriving the routed call graph.
 *
 * SCOPE FENCE, hard, matching the task's own design note: this module CHANGES NO PROVISIONING
 * BEHAVIOUR. It only reads `src/` as text (see {@link walk}) — it never imports `node:child_process`,
 * never shells out to git, and never touches `run-task.ts`. The review-materialization site
 * (`realReviewWorktreeDeps.addWorktree`) and the fix rung's `createFixRungWorktree` are recorded
 * here EXACTLY as they behave today; converting either to route through `worktreeAdd`, or giving
 * either a recorded base, is real and separate work that belongs beside W1-T232/W1-T233, not here.
 *
 * VERIFIED FROM SOURCE, not inherited from a prose note (design note (v)): every row below was
 * derived by re-scanning `src/` for `"worktree", "add"` and `worktreeAdd(` at this task's own SHA,
 * not copied from W1-T2622's rationale — which is why this registry also carries five
 * `routes-through` rows (`runTask`, `addLaneWorktree`, `createDaemonLaneWorktree`, `approveCommand`,
 * `approveBatchCommand`, `dispatchAlertFixRun` in `src/run-task.ts`, plus `spike.ts`'s `main`) that
 * rationale text alone never named.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/** A worktree-creation site's disposition — see the module header for what each means. */
export type WorktreeSiteDisposition =
  | { kind: "routes-through" }
  | {
      kind: "exempt";
      /** Why origin/main currency is not the applicable question for this site. Required —
       *  {@link assertWorktreeSiteCensusClean} refuses a blank one. */
      because: string;
    };

/** One row: one worktree-creation site in `src/`. */
export interface WorktreeSiteRow {
  /** Repo-relative path, e.g. `"src/run-task.ts"`. */
  file: string;
  /** The enclosing function or object-literal-method name that identifies this site uniquely
   *  within `file` — the same identifier {@link enclosingSiteName} derives by scanning upward
   *  from the matched invocation for the nearest declaration line. */
  site: string;
  /** One line: what this site creates. */
  creates: string;
  disposition: WorktreeSiteDisposition;
}

/**
 * THE REGISTRY. Re-verify against source before editing this list — see the module header's
 * "VERIFIED FROM SOURCE" paragraph; a row here that the guard cannot find in `src/` fails loudly
 * (drift 2, above) rather than silently going stale.
 */
export const WORKTREE_SITE_REGISTRY: WorktreeSiteRow[] = [
  // ── ROUTES-THROUGH: base recorded, currency asserted, by worktreeAdd itself (lib/worker.ts) ──
  {
    file: "src/run-task.ts",
    site: "runTask",
    creates: "the run's own task worktree, off origin/main",
    disposition: { kind: "routes-through" },
  },
  {
    file: "src/run-task.ts",
    site: "addLaneWorktree",
    creates: "a shared retro/triage/plan lane worktree, off origin/main",
    disposition: { kind: "routes-through" },
  },
  {
    file: "src/run-task.ts",
    site: "createDaemonLaneWorktree",
    creates: "a daemon-lane worktree, off origin/main",
    disposition: { kind: "routes-through" },
  },
  {
    file: "src/run-task.ts",
    site: "approveCommand",
    creates: "an approval-flow worktree (off origin/main, or off a re-approved PR's own branch)",
    disposition: { kind: "routes-through" },
  },
  {
    file: "src/run-task.ts",
    site: "approveBatchCommand",
    creates: "a batch-approval worktree, off origin/main",
    disposition: { kind: "routes-through" },
  },
  {
    file: "src/run-task.ts",
    site: "dispatchAlertFixRun",
    creates: "an alert-lane ephemeral fix worktree, off origin/main (via its injected deps.worktreeAdd)",
    disposition: { kind: "routes-through" },
  },
  {
    file: "src/spike.ts",
    site: "main",
    creates: "the WS-0 spike's one-shot sandbox worktree, off origin/main",
    disposition: { kind: "routes-through" },
  },

  // ── EXEMPT: a raw `git worktree add`, deliberately not routed through worktreeAdd ──────────
  {
    file: "src/run-task.ts",
    site: "addWorktree",
    creates:
      "a throwaway worktree materialized AT A REVIEW'S PR HEAD, detached — `rmd review`'s proof-execution checkout",
    disposition: {
      kind: "exempt",
      because:
        "it materializes at a PR's own head branch, DETACHED, not a fresh branch cut off origin/main — " +
        "'is this behind origin/main' is not this site's question. The freshness check that DOES apply " +
        "(does the checkout match the PR's own head sha) is asserted directly by materializeReviewWorktree, " +
        "the caller in this same file, which throws loudly on a mismatch rather than posting a review " +
        "against the wrong tree. W1-T232 owns this path's detached-materialization and tip-mismatch guard; " +
        "giving this site a recorded origin/main base is real, separate work that belongs beside that task, " +
        "not folded into this census (see W1-T2622's design note (iv)).",
    },
  },
  {
    file: "src/run-task.ts",
    site: "createFixRungWorktree",
    creates: "a throwaway worktree materialized at a PR's OWN fix branch, for the fix rung to commit/push from",
    disposition: {
      kind: "exempt",
      because:
        "it materializes at `origin/<branch>` for a PR's own already-existing branch, not a fresh branch " +
        "cut off origin/main — the currency question that actually applies (has the LOCAL branch diverged " +
        "from that remote head) is checked immediately above this call via `merge-base --is-ancestor`, " +
        "refusing (FixRungCheckoutRefusedError) on a non-ancestor, never by comparing against origin/main. " +
        "worktreeAdd's origin/main currency assert is simply not the applicable check for a worktree that " +
        "isn't based on origin/main at all.",
    },
  },
];

/** Files under `dir`, recursively, `.ts` only. Read with `readFileSync`, never grepped: two files
 *  in this tree (`lib/flight-signals.ts`, `lib/task-linter.ts`) carry raw NUL bytes that are
 *  invisible to a line-oriented grep without `-a` — the same trap `spawn-guard.ts`'s
 *  `findRuntimeSdkImporters` already documents and avoids the same way. */
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (name.endsWith(".ts")) out.push(p);
  }
  return out;
}

/** The literal raw `git worktree add` invocation shape — any quoting, any following args, e.g.
 *  `["-C", repoDir, "worktree", "add", worktreePath, ...]`. */
const RAW_WORKTREE_ADD_RE = /["']worktree["']\s*,\s*["']add["']/;

/** One matched site: where it was found and what it is called. */
export interface ScannedSite {
  /** Repo-relative path. */
  file: string;
  /** The enclosing function/property name — see {@link enclosingSiteName}. Empty string if none
   *  was found above the match (e.g. top-level module code). */
  site: string;
  /** 1-based line number, for a human-readable pointer in a failure message. */
  line: number;
}

/**
 * The nearest enclosing declaration ABOVE `lineIdx` (0-based), scanning upward — the same identity
 * a {@link WorktreeSiteRow}'s `site` names. Two shapes only, deliberately:
 *   - a named function: `function foo(`, `export function foo(`, `async function foo(`, or
 *     `export async function foo(`;
 *   - an object-literal method: `foo: (`.
 * The method pattern requires the colon to follow the name with only whitespace between — an
 * OPTIONAL inline parameter type like `warn?: (message: string) => void` (worktreeAdd's own `deps`
 * type, right above its raw invocation) has a `?` between the name and the colon and so never
 * matches, which is exactly what keeps that scan landing on `worktreeAdd` itself rather than on
 * one of its options' property names.
 */
export function enclosingSiteName(lines: readonly string[], lineIdx: number): string {
  for (let i = lineIdx; i >= 0; i--) {
    const line = lines[i] ?? "";
    const fn = /^\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(/.exec(line);
    if (fn?.[1]) return fn[1];
    const method = /^\s*(\w+)\s*:\s*\(/.exec(line);
    if (method?.[1]) return method[1];
  }
  return "";
}

/** Scan every `.ts` file under `srcDir` for `re`, skipping whole-line comments (`//…`, `*…` JSDoc
 *  continuations) — a doc line that merely QUOTES the shape (e.g. `addLaneWorktree`'s own comment
 *  citing "the FIRST `worktreeAdd(...` match") is prose about the pattern, not an invocation of it. */
function scanFor(re: RegExp, srcDir: string, root: string): ScannedSite[] {
  const out: ScannedSite[] = [];
  for (const file of walk(srcDir).sort()) {
    const text = readFileSync(file, "utf8");
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      const trimmed = line.trim();
      if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) continue;
      if (!re.test(line)) continue;
      out.push({ file: relative(root, file), site: enclosingSiteName(lines, i), line: i + 1 });
    }
  }
  return out;
}

/** Every raw `git worktree add` invocation found in `srcDir`, INCLUDING the one inside
 *  `worktreeAdd`'s own body — callers that want "every raw site that is NOT the canonical
 *  implementation" filter that one out themselves (see {@link censusWorktreeSites}). */
export function findRawWorktreeAddSites(srcDir: string, root: string): ScannedSite[] {
  return scanFor(RAW_WORKTREE_ADD_RE, srcDir, root);
}

/** Does `file` (repo-relative) still declare a function or object-literal method named `site`? A
 *  plain existence check over the file's own text — see the module header for why a
 *  `routes-through` row is verified this way (existence) rather than by re-deriving whether that
 *  declaration still calls `worktreeAdd` (a text scan for that call proved too easy to fool with a
 *  doc comment or an error-message string quoting the same shape). */
function siteDeclaredIn(root: string, file: string, site: string): boolean {
  const text = readFileSync(join(root, file), "utf8");
  const declRe = new RegExp(
    `(?:^|\\n)\\s*(?:export\\s+)?(?:async\\s+)?function\\s+${site}\\s*\\(|(?:^|\\n)\\s*${site}\\s*:\\s*\\(`,
  );
  return declRe.test(text);
}

/** `worktreeAdd`'s own file and site name — the raw invocation inside its body is the routing
 *  TARGET, not a site that itself needs a registry row. */
const CANONICAL_FILE = "src/lib/worker.ts";
const CANONICAL_SITE = "worktreeAdd";

/** The full bidirectional diff between what `src/` actually contains and what the registry
 *  declares. Pure — takes `srcDir`/`root` so a test can point it at a fixture tree instead of the
 *  real repo. */
export interface WorktreeCensusResult {
  /** Raw invocations outside `worktreeAdd`'s own body with no matching `exempt` row — drift 1, a
   *  new hole appearing silently. */
  undeclaredRawSites: ScannedSite[];
  /** Registry rows (either kind) whose named site no longer exists in `src/` — drift 2, a rotted
   *  entry that has outlived the site it described. */
  rottedRows: WorktreeSiteRow[];
  /** `exempt` rows whose `because` is blank or whitespace-only — drift 3. */
  blankReasonRows: WorktreeSiteRow[];
}

const rowKey = (file: string, site: string): string => `${file}::${site}`;

export function censusWorktreeSites(
  srcDir: string,
  root: string,
  registry: readonly WorktreeSiteRow[] = WORKTREE_SITE_REGISTRY,
): WorktreeCensusResult {
  const rawSites = findRawWorktreeAddSites(srcDir, root).filter(
    (s) => !(s.file === CANONICAL_FILE && s.site === CANONICAL_SITE),
  );

  const exemptRows = registry.filter((r) => r.disposition.kind === "exempt");
  const exemptKeys = new Set(exemptRows.map((r) => rowKey(r.file, r.site)));

  const undeclaredRawSites = rawSites.filter((s) => !exemptKeys.has(rowKey(s.file, s.site)));

  const rawFound = new Set(rawSites.map((s) => rowKey(s.file, s.site)));
  const rottedRows = registry.filter((r) =>
    r.disposition.kind === "exempt"
      ? !rawFound.has(rowKey(r.file, r.site))
      : !siteDeclaredIn(root, r.file, r.site),
  );

  const blankReasonRows = exemptRows.filter(
    (r) => r.disposition.kind === "exempt" && r.disposition.because.trim() === "",
  );

  return { undeclaredRawSites, rottedRows, blankReasonRows };
}

/** Human-readable rendering of a non-empty {@link WorktreeCensusResult} — thrown, never returned
 *  silently, so a broken census fails loudly with a pointer to the fix (mirrors
 *  `spawn-guard.ts`/`live-write-guard.ts`'s own error shape). */
export function renderWorktreeCensusFailure(result: WorktreeCensusResult): string {
  const problems: string[] = [];
  if (result.undeclaredRawSites.length) {
    problems.push(
      "raw `git worktree add` invocation(s) with no registry row: " +
        result.undeclaredRawSites.map((s) => `${s.file}:${s.line} (site "${s.site || "?"}")`).join(", ") +
        ". Either route this through worktreeAdd (src/lib/worker.ts) or add a NAMED exempt row to " +
        "WORKTREE_SITE_REGISTRY (src/lib/worktree-sites.ts) carrying the reason.",
    );
  }
  if (result.rottedRows.length) {
    problems.push(
      "registry row(s) whose site no longer exists in src/: " +
        result.rottedRows.map((r) => `${r.file}::${r.site}`).join(", ") +
        ". Remove the row — a rotted exemption cannot outlive the site it excused.",
    );
  }
  if (result.blankReasonRows.length) {
    problems.push(
      "exempt row(s) with a blank reason: " +
        result.blankReasonRows.map((r) => `${r.file}::${r.site}`).join(", ") +
        ". State what makes origin/main currency the wrong question for this site.",
    );
  }
  return `worktree-sites census FAILED:\n  - ${problems.join("\n  - ")}`;
}

/** Throws iff `censusWorktreeSites` finds any of the three drifts, over the REAL `srcDir`/`root`
 *  by default. This is the guard `test/worktree-creation-census.test.ts` runs against the actual
 *  repo; it takes no dependencies beyond `node:fs`, so it can never itself perform a git operation
 *  or otherwise change provisioning behaviour. */
export function assertWorktreeSiteCensusClean(
  srcDir: string,
  root: string,
  registry: readonly WorktreeSiteRow[] = WORKTREE_SITE_REGISTRY,
): void {
  const result = censusWorktreeSites(srcDir, root, registry);
  const dirty =
    result.undeclaredRawSites.length > 0 || result.rottedRows.length > 0 || result.blankReasonRows.length > 0;
  if (dirty) throw new Error(renderWorktreeCensusFailure(result));
}
