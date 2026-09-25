/**
 * W1-T4420 — THE SHARED PRE-POST SEAM every automated PR opener (implement/retro/triage/plan in
 * `src/run-task.ts`) routes through, so a defective body is refused before the irreversible REST
 * create rather than patched afterward. Operator declined a `rmd pr open` CLI + `PrOpenDeps`
 * surface (PR #7165, 2026-09-25); this narrows the same inputs those four call sites already hold
 * into one checked function with positional callbacks — no command or dependency-object type.
 *
 * Refuses TWO defect classes before the POST:
 * 1. NON-DISCRIMINATING — `ghPrCreateFillCommand`'s generic open-time fallback Acceptance block
 *    greps a function (`acceptanceAuthorTimeCheck`) that predates every PR reaching it, proving
 *    nothing about THIS diff ({@link bodyOnlyCarriesOpenTimeFallback} re-detects it from its own
 *    proof text, never re-imported, to avoid a lib->root cycle). `rmd retro` already repairs this
 *    for itself, but only AFTER the PR exists (`repairRetroAcceptanceBlock`, a network PATCH).
 *    {@link diffDerivedAcceptanceProof} builds the same kind of proof from the worktree's OWN
 *    local diff, before any PR exists — substituting it, or refusing when none can be derived.
 * 2. PLAN-DIVERGENT — a filing PR's `bodyOverride` citing a task id its own diff does not file.
 */

import { breMetacharsIn } from "./task-linter.js";
import { parseAcceptanceBlock, parseWhitelistedProof } from "./review.js";

/** The exact argv shape {@link "../run-task.js".ghPrCreateFillCommand} returns — mirrored, not
 *  imported, so this lib module never depends on the root file that depends on it. */
export interface PrCreateArgv {
  command: "gh";
  args: string[];
  options: { cwd: string; encoding: "utf8" };
}

/** The verdict {@link openPullRequestChecked} reports: either the create argv is safe to POST, or a
 *  reason it must not be, stated for the caller's own `log`/`say`. */
export type OpenPullRequestCheckedResult =
  | { ok: true; create: PrCreateArgv }
  | { ok: false; refused: string };

/** The exact proof text `ghPrCreateFillCommand`'s open-time fallback carries — kept as a literal
 *  here (never re-imported from `run-task.ts`, which would cycle back into this lib module) because
 *  the two constants are asserted to agree by
 *  `test/a-pr-opens-with-a-judgeable-body.test.ts`. */
const OPEN_TIME_FALLBACK_PROOF = "grep: ^export function acceptanceAuthorTimeCheck in src/lib/review.ts";

/** TRUE when a body's ONLY judgeable Acceptance criterion is the generic open-time fallback — a
 *  block that parses (so `bodyNeedsAcceptanceRepair` calls it healthy) but whose one proof predates
 *  every PR that could ever carry it, and so discriminates nothing about THIS diff. */
export function bodyOnlyCarriesOpenTimeFallback(body: string): boolean {
  const criteria = parseAcceptanceBlock(body);
  return criteria.length === 1 && criteria[0].proof?.trim() === OPEN_TIME_FALLBACK_PROOF;
}

/** Escape one line of diff-added text into a literal (non-BRE-metachar) grep pattern — the same
 *  discipline `retroAcceptanceProofFromDiff` (`run-task.ts`) already applies to its own diff-derived
 *  proof, duplicated here in miniature rather than imported, since that function lives in the root
 *  file this lib module must not depend on. */
function escapeDiffLineForGrep(line: string): string {
  let escaped = "";
  for (const ch of line) {
    if (ch === "\\") escaped += "\\\\";
    else if (ch === "?") escaped += "[?]";
    else if (".[]*^$".includes(ch)) escaped += `\\${ch}`;
    else escaped += ch;
  }
  return escaped;
}

/**
 * A `grep:` proof on ONE line this diff itself just added — the strongest local discrimination a
 * proof can have, since the pattern could not have matched at the merge base (the line did not
 * exist there). Walks the unified diff for the first `+`-only line, in a file with an extension,
 * whose escaped text both parses as a whitelisted `grep:` proof and carries no blocking BRE
 * metacharacter (mirroring {@link "../run-task.js".retroAcceptanceProofFromDiff}'s own two guards).
 * `undefined` when no added line qualifies — every candidate line's own path or content is unsafe to
 * grep, or the diff is empty (a body-only PATCH, or nothing new the local check can see).
 */
export function diffDerivedAcceptanceProof(diff: string): string | undefined {
  let file: string | undefined;
  for (const raw of diff.split("\n")) {
    if (raw.startsWith("+++ ")) {
      const path = raw.slice(4).replace(/^b\//, "").replace(/\r$/, "").trim();
      file = path === "/dev/null" ? undefined : path;
      continue;
    }
    if (!file || !raw.startsWith("+") || raw.startsWith("+++ ")) continue;
    const line = raw.slice(1).replace(/\r$/, "").trim();
    if (!line || !/\.[^/]+$/.test(file)) continue;
    const pattern = escapeDiffLineForGrep(line);
    const proof = `grep: ${pattern} in ${file}`;
    if (parseWhitelistedProof(proof) !== null && breMetacharsIn(pattern).blocking.length === 0) return proof;
  }
  return undefined;
}

/** `W1-T####`-shaped ids named literally anywhere in a body's text — used only to compare a filing
 *  PR's claimed ids against the ids its own diff actually files (see {@link idsFiledInDiff}), never
 *  as a general id extractor for other callers. */
function idsReferencedInBody(body: string): Set<string> {
  const ids = new Set<string>();
  for (const m of body.matchAll(/\bW1-T\d+\b/g)) ids.add(m[0]);
  return ids;
}

/** `id:` keys a diff ADDS under the plan's monolith or a task shard — the ids this
 *  diff actually files, read from the `+` lines alone so a REMOVED id (a renumber, a retirement)
 *  never counts as filed. */
function idsFiledInDiff(diff: string): Set<string> {
  const ids = new Set<string>();
  let inPlanFile = false;
  for (const raw of diff.split("\n")) {
    if (raw.startsWith("+++ ")) {
      const path = raw.slice(4).replace(/^b\//, "").replace(/\r$/, "").trim();
      inPlanFile = /^plan\/(tasks\.yaml|tasks\.d\/.+\.ya?ml)$/.test(path);
      continue;
    }
    if (!inPlanFile || !raw.startsWith("+") || raw.startsWith("+++ ")) continue;
    const m = raw.match(/^\+\s*-?\s*id:\s*"?(W1-T\d+)"?/);
    if (m) ids.add(m[1]);
  }
  return ids;
}

/**
 * The shared checked opener. Every existing automated call site (implement, retro, triage, plan)
 * routes its `ghPrCreateFillCommand` + `runGhPrCreate` pair through this instead — same REST
 * transport, same argv shape, the checks run BEFORE the caller ever executes `create`.
 *
 * `taskId` given ⇒ a BUILD PR (implement/retro/triage): the branch's tip is stamped with the
 * `Remudero-Task: <id>` trailer before the create argv is read (folding implement/retro's existing
 * inline stamp-then-repush into one call, and adding it for triage, which previously stamped only
 * AFTER the create via a PATCH — `ensureTaskTrailer`, still called defensively afterward, is now a
 * no-op on the common path). If the resulting body's only Acceptance criterion is the
 * non-discriminating open-time fallback, a diff-derived proof is substituted; if none can be
 * derived, this REFUSES rather than opening a PR that would need the exact post-hoc PATCH
 * `repairRetroAcceptanceBlock` already exists to repair for retro alone.
 *
 * `taskId` omitted ⇒ a FILING PR (plan): no trailer step runs (a filing PR carries none, by
 * design). When `opts.bodyOverride` is given, its claimed ids are checked against the ids this
 * diff's own `plan/` additions actually declare, and a plan-divergent body — one citing an id its
 * own diff does not file — is refused rather than opened.
 */
export function openPullRequestChecked(
  taskId: string | undefined,
  buildCreate: (title?: string, bodyOverride?: string) => PrCreateArgv,
  pushRunBranch: (opts?: { force?: boolean }) => void,
  localDiff: () => string,
  opts: { title?: string; bodyOverride?: string } = {},
  ensureTrailerOnCommit?: (taskId: string) => boolean,
): OpenPullRequestCheckedResult {
  if (taskId !== undefined && ensureTrailerOnCommit?.(taskId)) {
    pushRunBranch({ force: true });
  }
  const create = buildCreate(opts.title, opts.bodyOverride);
  const bodyIdx = create.args.findIndex((a) => a.startsWith("body="));
  const body = bodyIdx === -1 ? "" : create.args[bodyIdx].slice("body=".length);
  if (body.trim().length === 0) {
    return { ok: false, refused: "the create argv carries an empty body — refusing before the REST create" };
  }
  if (opts.bodyOverride !== undefined) {
    const claimed = idsReferencedInBody(body);
    if (claimed.size > 0) {
      const filed = idsFiledInDiff(localDiff());
      const divergent = [...claimed].filter((id) => !filed.has(id));
      if (divergent.length > 0) {
        return {
          ok: false,
          refused:
            `the body cites ${divergent.join(", ")}, which this diff's own plan/ additions do not file — ` +
            "a plan-divergent Acceptance block, refused before the REST create",
        };
      }
    }
  }
  if (bodyOnlyCarriesOpenTimeFallback(body)) {
    const derived = diffDerivedAcceptanceProof(localDiff());
    if (derived === undefined) {
      return {
        ok: false,
        refused:
          "the only Acceptance criterion this body carries is the generic open-time fallback, whose proof " +
          "predates every PR that could carry it and so discriminates nothing about this diff, and no safe " +
          "diff-derived proof could be built either — refusing a stale Acceptance block before the REST create",
      };
    }
    const patchedBody = body.replace(OPEN_TIME_FALLBACK_PROOF, derived);
    create.args[bodyIdx] = `body=${patchedBody}`;
  }
  return { ok: true, create };
}
