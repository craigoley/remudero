/**
 * W1-T413: a MERGED **plan-only** PR carrying a `Remudero-Task:` trailer must not credit that task
 * as implemented.
 *
 * THE DEFECT, MEASURED RATHER THAN REASONED. `deriveStatus`'s rung (c) credits a merged PR once
 * the body carries the anchored trailer and `branchClaimsOtherTask` clears — and that predicate
 * returns false for ANY head not starting with `run-`, so a hand-named branch cannot veto. Nothing
 * in the chain looked at what the PR changed. Two live instances on the frontier when this was
 * written: W1-T395 credited by #1471 (three files, all under `plan/`) and W1-T401 credited by
 * #1468 (two shard YAMLs). Both read MERGED while their shards were queued and the tests their
 * acceptance criteria name did not exist, so the drain could never dispatch either — and a console
 * kick cannot recover them, because the kick path tests `isMerged` BEFORE `assertRunnable`.
 *
 * BOTH DIRECTIONS ARE ASSERTED IN EVERY BEHAVIOUR THAT HAS TWO. A suite that only proves the
 * refusal passes just as well on a change that credits NOTHING, which would strand every merged
 * task in the plan — so each refusal test is paired with the implementation PR that must still
 * credit, and the fixtures are proven to REACH the predicate rather than assumed to.
 */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Task } from "../src/lib/plan.js";
import { buildBatchedGithub, deriveStatus, ghGateway, isPlanOnlyChangeset, type GitHub, type PrRef } from "../src/lib/status.js";

function task(id: string): Task {
  return {
    id,
    title: "t",
    repo: "remudero",
    depends_on: [],
    type: "implement",
    risk: "medium",
    verify: "auto",
    status: "queued",
    attempts: 0,
  };
}

/** An EMPTY ledger — so nothing but rung (c) can decide, and a credit or refusal here is
 *  attributable to the trailer path rather than to a `pr.opened`/correction line. */
function emptyLedger(): string {
  const dir = mkdtempSync(join(tmpdir(), "trailer-plan-only-"));
  const p = join(dir, "ledger.ndjson");
  writeFileSync(p, "");
  return p;
}

interface GhOpts {
  /** Head ref of the trailered PR. */
  head: string;
  /** Paths the PR changed. `undefined` ⇒ the gateway cannot report them. */
  files?: string[];
  /** Omit `changedFiles` from the gateway entirely (the pre-W1-T413 implementer shape). */
  omitChangedFiles?: boolean;
  /** Records every `changedFiles` call, so a test can prove the read was — or was not — reached. */
  reads?: string[];
}

const PR_URL = "https://github.com/craigoley/remudero/pull/1471";

function github(taskId: string, opts: GhOpts): GitHub {
  const ref: PrRef = { number: 1471, url: PR_URL, state: "MERGED" };
  const gh: GitHub = {
    prByRef: () => null,
    findMergedByTrailer: (id) => (id === taskId ? ref : null),
    headRefName: () => opts.head,
    prBody: () => `body text\n\nRemudero-Task: ${taskId}\n`,
  };
  if (!opts.omitChangedFiles) {
    gh.changedFiles = (url) => {
      opts.reads?.push(url);
      return opts.files;
    };
  }
  return gh;
}

function derive(taskId: string, opts: GhOpts) {
  return deriveStatus(task(taskId), { ledgerPath: emptyLedger(), github: github(taskId, opts) });
}

// ── THE PREDICATE, ALONE ─────────────────────────────────────────────────────────────────────

test("isPlanOnlyChangeset is true only when every changed path is plan scope, and never for an empty list", () => {
  assert.equal(isPlanOnlyChangeset(["plan/tasks.d/W1-T413-x.yaml"]), true);
  assert.equal(isPlanOnlyChangeset(["plan/tasks.yaml", "MASTER-PLAN.md", "docs/ORIENTATION.md"]), true);
  // One path outside plan scope is enough to make it an implementation.
  assert.equal(isPlanOnlyChangeset(["plan/tasks.yaml", "src/lib/status.ts"]), false);
  // EMPTY IS FALSE — "every element of nothing is in plan scope" is the vacuous pass, and an
  // empty list is what a truncated read looks like.
  assert.equal(isPlanOnlyChangeset([]), false);
});

// ── BOTH DIRECTIONS THROUGH deriveStatus ─────────────────────────────────────────────────────

test("a merged plan-only PR no longer credits its trailered task, and names plan-only-changeset as the reason", () => {
  const proj = derive("W1-T395", {
    head: "claude/shard-corrections-t395-t391-t388",
    files: ["plan/tasks.d/W1-T395-x.yaml", "plan/tasks.d/W1-T391-y.yaml", "plan/tasks.d/W1-T388-z.yaml"],
  });
  assert.equal(proj.merged, false);
  assert.equal(proj.status, "queued");
  assert.equal(proj.source, "none");
  // The refusal is SURFACED, not silently dropped — the rung's own legibility contract.
  assert.deepEqual(proj.rejected_candidates, [{ pr: PR_URL, reason: "plan-only-changeset" }]);
});

test("a merged PR touching a path outside plan scope still credits, so the fix cannot strand real work", () => {
  const proj = derive("W1-T395", {
    head: "claude/some-hand-named-branch",
    files: ["plan/tasks.d/W1-T395-x.yaml", "src/lib/review.ts"],
  });
  assert.equal(proj.merged, true);
  assert.equal(proj.source, "trailer");
});

test("a DELETED source file makes a mostly-plan PR an implementation, since changedFiles reports deletions too", () => {
  // #1465's lesson, carried here: a diff that removes a `src/` file is not plan-only. The gateway
  // reports the path as changed either way, so the predicate needs no deletion-specific arm — this
  // test exists to lock that, because the opposite (deletions invisible) was a real defect.
  const proj = derive("W1-T400", { head: "chore/cleanup", files: ["plan/tasks.yaml", "src/lib/dead.ts"] });
  assert.equal(proj.merged, true);
});

// ── THE READ IS OFF THE HOT PATH ─────────────────────────────────────────────────────────────

test("a worker's own run- branch credits without ever reading the changed-file list", () => {
  const reads: string[] = [];
  const proj = derive("W1-T393", { head: "run-W1-T393-1784900000000", files: ["plan/tasks.yaml"], reads });
  assert.equal(proj.merged, true, "an own-run-branch PR must credit");
  // THE COST CONTROL, asserted rather than described: the file list is never fetched for the
  // ordinary implementation shape, which is what keeps this off the O(N) path.
  assert.deepEqual(reads, [], "changedFiles must not be consulted for a task's own run branch");
});

test("a hand-named branch DOES reach the changed-file read — otherwise the refusal tests prove nothing", () => {
  // The fixture-reaches-the-predicate control. Without it, a refusal test could pass because the
  // branch was never adjudicated at all rather than because the changeset was judged.
  const reads: string[] = [];
  derive("W1-T401", { head: "claude/file-t401-and-t402", files: ["plan/tasks.d/W1-T401-x.yaml"], reads });
  assert.deepEqual(reads, [PR_URL]);
});

// ── UNAVAILABLE KEEPS TODAY'S ANSWER ─────────────────────────────────────────────────────────

test("a gateway that cannot report changed files still credits, so a read failure never un-merges finished work", () => {
  const proj = derive("W1-T395", { head: "claude/hand-named", files: undefined });
  assert.equal(proj.merged, true, "undefined means UNAVAILABLE, never 'no files'");
});

test("a gateway that predates changedFiles behaves exactly as before, so no existing implementer breaks", () => {
  const proj = derive("W1-T395", { head: "claude/hand-named", omitChangedFiles: true });
  assert.equal(proj.merged, true);
  assert.equal(proj.source, "trailer");
});

// ── THE TWO LIVE INSTANCES ───────────────────────────────────────────────────────────────────

test("the two live instances flip to queued: W1-T395 via #1471 and W1-T401 via #1468", () => {
  // Re-derived from the real PRs at the time of writing: #1471 changed three files, all under
  // plan/; #1468 added exactly the two shard YAMLs it files. Both bodies carry the anchored
  // trailer on a hand-named branch, which is the whole shape of the defect.
  const t395 = derive("W1-T395", {
    head: "claude/shard-corrections-t395-t391-t388",
    files: [
      "plan/tasks.d/W1-T395-quoted-regions-misses-inline-spans.yaml",
      "plan/tasks.d/W1-T391-blocked-bucket-populations.yaml",
      "plan/tasks.d/W1-T388-ledger-grep-pattern-compile-unguarded.yaml",
    ],
  });
  const t401 = derive("W1-T401", {
    head: "claude/file-t401-t402-guard-reach",
    files: [
      "plan/tasks.d/W1-T401-declared-files-unenforced-on-the-live-path.yaml",
      "plan/tasks.d/W1-T402-instrument-surface-was-incomplete-at-filing.yaml",
    ],
  });
  assert.equal(t395.merged, false, "W1-T395 must read queued after this change");
  assert.equal(t395.status, "queued");
  assert.equal(t401.merged, false, "W1-T401 must read queued after this change");
  assert.equal(t401.status, "queued");
});

// ── THE OTHER REJECTION REASONS STILL REPORT THEMSELVES ──────────────────────────────────────
// `plan-only-changeset` was inserted ahead of three existing arms, so each is asserted here: a new
// first branch that silently swallowed the others would be invisible to every test above.

test("an unanchored trailer still reports trailer-not-anchored, not the new plan-only reason", () => {
  const gh: GitHub = {
    prByRef: () => null,
    findMergedByTrailer: () => ({ number: 1471, url: PR_URL, state: "MERGED" }),
    headRefName: () => "claude/hand-named",
    prBody: () => "a body that merely mentions W1-T395 in prose",
    changedFiles: () => ["plan/tasks.yaml"],
  };
  const proj = deriveStatus(task("W1-T395"), { ledgerPath: emptyLedger(), github: gh });
  assert.equal(proj.merged, false);
  assert.deepEqual(proj.rejected_candidates, [{ pr: PR_URL, reason: "trailer-not-anchored" }]);
});

test("a branch claiming another task still reports branch-claims-other-task", () => {
  const proj = derive("W1-T395", { head: "run-W1-T999-1784900000000", files: ["src/lib/review.ts"] });
  assert.equal(proj.merged, false);
  assert.deepEqual(proj.rejected_candidates, [{ pr: PR_URL, reason: "branch-claims-other-task" }]);
});

test("a non-merged trailer hit on a hand-named branch still reports trailer-pr-not-merged", () => {
  const gh: GitHub = {
    prByRef: () => null,
    findMergedByTrailer: () => ({ number: 1471, url: PR_URL, state: "OPEN" }),
    headRefName: () => "claude/hand-named",
    prBody: () => "Remudero-Task: W1-T395\n",
    changedFiles: () => ["src/lib/review.ts"],
  };
  const proj = deriveStatus(task("W1-T395"), { ledgerPath: emptyLedger(), github: gh });
  assert.equal(proj.merged, false);
  assert.deepEqual(proj.rejected_candidates, [{ pr: PR_URL, reason: "trailer-pr-not-merged" }]);
});

// ── THE GATEWAYS THEMSELVES, NOT A FAKE OF THEM ──────────────────────────────────────────────
// Every test above injects its own `changedFiles`, which means none of them executes either real
// implementation — the seam-default trap this repo has recorded before. These drive the REAL
// gateway bodies through an injected exec and assert the argv, the parse, and each failure arm.

test("ghGateway.changedFiles asks pr view for files and returns the paths", () => {
  const calls: string[][] = [];
  const gh = ghGateway("craigoley", "remudero", {
    exec: (args) => {
      calls.push(args);
      return JSON.stringify({ files: [{ path: "plan/tasks.yaml" }, { path: "src/lib/status.ts" }] });
    },
  });
  assert.deepEqual(gh.changedFiles?.(PR_URL), ["plan/tasks.yaml", "src/lib/status.ts"]);
  assert.deepEqual(calls, [["pr", "view", PR_URL, "--json", "files"]]);
});

test("ghGateway.changedFiles reports UNAVAILABLE on a gh failure and on a row set with no usable path", () => {
  const boom = ghGateway("craigoley", "remudero", {
    exec: () => {
      throw new Error("gh exploded");
    },
  });
  assert.equal(boom.changedFiles?.(PR_URL), undefined, "a failed read is unavailable, never 'no files'");
  const malformed = ghGateway("craigoley", "remudero", { exec: () => JSON.stringify({ files: [{}, {}] }) });
  assert.equal(malformed.changedFiles?.(PR_URL), undefined, "rows carrying no path are a malformed read");
});

test("buildBatchedGithub.changedFiles pages the files endpoint, then MEMOISES it — including a failure", () => {
  const calls: string[][] = [];
  let fail = false;
  const gh = buildBatchedGithub("craigoley", "remudero", {
    fetchAll: () => [],
    exec: (args) => {
      calls.push(args);
      if (fail) throw new Error("unreachable");
      return "plan/tasks.d/W1-T401-x.yaml\nplan/tasks.d/W1-T402-y.yaml\n";
    },
  });
  assert.deepEqual(gh.changedFiles?.(PR_URL), ["plan/tasks.d/W1-T401-x.yaml", "plan/tasks.d/W1-T402-y.yaml"]);
  assert.deepEqual(calls, [
    ["api", "--paginate", "repos/craigoley/remudero/pulls/1471/files", "--jq", ".[].filename"],
  ]);
  // The memo is the O(N) control: a second ask for the same PR must not re-read.
  gh.changedFiles?.(PR_URL);
  assert.equal(calls.length, 1, "a repeated ask must be served from the memo");

  // A FAILED read is cached too, so one unreachable PR is read once per gateway, not once per task.
  fail = true;
  const other = "https://github.com/craigoley/remudero/pull/1468";
  assert.equal(gh.changedFiles?.(other), undefined);
  assert.equal(calls.length, 2);
  assert.equal(gh.changedFiles?.(other), undefined);
  assert.equal(calls.length, 2, "a cached failure must not be re-read");
});

test("buildBatchedGithub.changedFiles reports UNAVAILABLE for a url carrying no pull number", () => {
  const gh = buildBatchedGithub("craigoley", "remudero", {
    fetchAll: () => [],
    exec: () => {
      throw new Error("must not be reached for an unparseable url");
    },
  });
  assert.equal(gh.changedFiles?.("https://github.com/craigoley/remudero/issues/12"), undefined);
});

// ── FALSIFIER ────────────────────────────────────────────────────────────────────────────────

test("MUTANT: crediting without the plan-only test restores the false credit for both live instances", async () => {
  // Mutating the SOURCE proves the refusal is carried by the line under test rather than by some
  // neighbouring accident. The substitution target is asserted UNIQUE first: a mutation applied to
  // two sites, or to none, would make the result unattributable.
  const { readFileSync, writeFileSync: write, mkdtempSync: mkd } = await import("node:fs");
  const src = readFileSync(new URL("../src/lib/status.ts", import.meta.url), "utf8");
  const target = "const files = deps.github.changedFiles?.(trailerPr.url);";
  const occurrences = src.split(target).length - 1;
  assert.equal(occurrences, 1, "the substitution target must be UNIQUE or the mutant proves nothing");

  const dir = mkd(join(tmpdir(), "trailer-plan-only-mutant-"));
  const mutantPath = join(dir, "status.ts");
  // The copy lives outside src/, so its SIBLING imports (`./drain-lock.js`, …) would not resolve —
  // absolutise them against the real directory rather than writing a scratch module into src/.
  const libDir = new URL("../src/lib/", import.meta.url).pathname;
  const mutated = src
    .replace(target, "const files = undefined as string[] | undefined;")
    .replace(/from "\.\/([A-Za-z0-9._-]+)\.js"/g, (_m, name) => `from "${libDir}${name}.js"`);
  write(mutantPath, mutated);
  // The mutant reads the file list as permanently UNAVAILABLE, which is exactly the pre-fix
  // behaviour: every anchored trailer credits regardless of what the PR changed.
  const mutant = (await import(mutantPath)) as typeof import("../src/lib/status.js");
  const gh = github("W1-T395", {
    head: "claude/shard-corrections-t395-t391-t388",
    files: ["plan/tasks.d/W1-T395-x.yaml"],
  });
  const proj = mutant.deriveStatus(task("W1-T395"), { ledgerPath: emptyLedger(), github: gh });
  assert.equal(proj.merged, true, "the mutant must reach the bad state — otherwise this proves nothing");
  // And the real module must not.
  const real = derive("W1-T395", {
    head: "claude/shard-corrections-t395-t391-t388",
    files: ["plan/tasks.d/W1-T395-x.yaml"],
  });
  assert.equal(real.merged, false);
});
