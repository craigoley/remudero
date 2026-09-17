import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { parse } from "yaml";
import { buildProjectInit } from "../src/lib/project-init.js";

// ── W1-T3725 — A PLAN-ONLY FILING PAID 3.8 MINUTES OF CodeQL ON A DIFF WITH NO CODE ──────────
//
// MEASURED on #5891, a PLAN_ONLY pull request touching one file under `plan/tasks.d/`:
//
//   WALL CLOCK 3.8 min
//     3.8  Analyze (javascript-typescript)   <- CodeQL, the critical path
//     2.9  ci-shard (3/4)
//     1.5  Scan
//
// Against 20.3 min for a code PR — so W1-T2428's classifier is doing real work and the coverage
// shards correctly skip. What remained was 3.8 minutes of static analysis of JavaScript and
// TypeScript on a diff containing neither. `codeql.yml` is a SEPARATE workflow that predates the
// classifier, has no paths filter, and is not even a required check — so it gates nothing while
// setting the wall clock for every filing this fleet makes, and it makes many.
//
// WHAT IS REAL HERE: the committed workflow file, parsed. No fixture stands in for it.

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIXED_NOW = () => new Date("2026-07-18T12:00:00.000Z");
const REAL_BASELINES = { coveragePct: 73.4, branchesPct: 68.9, mutationScorePct: 61.2, dupPct: 4.2 };
const codeql = parse(readFileSync(join(ROOT, ".github", "workflows", "codeql.yml"), "utf8")) as {
  on: { pull_request?: { "paths-ignore"?: string[] }; push?: Record<string, unknown>; schedule?: unknown };
};
const ignored: string[] = codeql.on.pull_request?.["paths-ignore"] ?? [];

/** GitHub skips a `pull_request` run when EVERY changed path matches `paths-ignore`. */
function wouldSkip(changed: readonly string[]): boolean {
  const matches = (path: string) =>
    ignored.some((glob) => {
      const re = new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*\/\*/g, "!!ANY!!").replace(/\*\*/g, "!!ANY!!").replace(/\*/g, "[^/]*").replace(/!!ANY!!/g, ".*")}$`);
      return re.test(path);
    });
  return changed.length > 0 && changed.every(matches);
}

test("a plan-only pull request does not trigger CodeQL", () => {
  assert.ok(wouldSkip(["plan/tasks.d/W1-T3725-codeql-has-no-fast-lane.yaml"]), "the #5891 shape");
  assert.ok(wouldSkip(["plan/tasks.yaml", "docs/operator-guide.md", "learnings/2026-09.yaml", "README.md"]));
});

test("a diff touching scripts or workflows still triggers CodeQL", () => {
  // THE MISTAKE THIS SHAPE INVITES, and the reason `scripts/**` and `.github/**` are absent from
  // the ignore list: both LOOK like configuration, and both are code CodeQL reads.
  assert.equal(wouldSkip(["scripts/diff-coverage.mjs"]), false, "a script is code");
  assert.equal(wouldSkip([".github/workflows/ci.yml"]), false, "a workflow is code");
  assert.equal(wouldSkip(["src/lib/review.ts"]), false);
  // A MIXED diff is analysed too — GitHub skips only when EVERY path matches.
  assert.equal(wouldSkip(["plan/tasks.yaml", "src/lib/review.ts"]), false, "one code path is enough");
});

test("the push and schedule triggers carry no paths filter", () => {
  // THE WHOLE SAFETY ARGUMENT. Skipping a PR analysis is sound ONLY because the same commit is
  // still analysed on push to main, and the weekly scan still sweeps the tree. Put a filter on
  // either and a commit could reach main having never been analysed at all.
  for (const trigger of ["push", "schedule"] as const) {
    const t = codeql.on[trigger] as Record<string, unknown> | undefined;
    assert.ok(t !== undefined, `${trigger} must still be a trigger`);
    if (t && !Array.isArray(t)) {
      assert.equal(t["paths-ignore"], undefined, `${trigger} must carry no paths-ignore`);
      assert.equal(t["paths"], undefined, `${trigger} must carry no paths filter`);
    }
  }
  assert.ok(ignored.length > 0, "and the pull_request trigger IS filtered — otherwise this proves nothing");
});

test("CodeQL is not in the required contexts a skip could strand", () => {
  // A skipped REQUIRED check leaves a PR permanently unmergeable. This one is not required — which
  // is what makes the whole change safe, and a future operator could add the context without ever
  // knowing that. Asserted against the repo's own recorded protection, not against prose.
  // BEHAVIOUR, NOT SOURCE TEXT (W1-T2905). Reading project-init.ts as text and regexing its
  // `contexts:` array passes when the prose is right and the payload is wrong, and breaks on an
  // innocent reformat. `buildProjectInit` returns the very payload that is PUT to GitHub, so ask it.
  const contexts = buildProjectInit({
    owner: "acme-corp",
    repo: "widget-service",
    profile: "ts-node",
    baselines: REAL_BASELINES,
    now: FIXED_NOW,
  }).branchProtection.required_status_checks.contexts;
  assert.ok(contexts.length > 0, "the required contexts must be readable — a vacuous pass proves nothing");
  assert.ok(!contexts.some((n) => /codeql/i.test(n)), `CodeQL must not be a required context, got ${JSON.stringify(contexts)}`);

  // THE CONTROL'S OTHER HALF. "CodeQL is not required" is also true of a tree where nothing skips
  // it — it was true before this change and would be true after a revert, which is exactly why
  // `check-proof --base` graded this proof `executed_stale` on its own. The claim it actually
  // supports is conditional: a skip cannot strand a pull request BECAUSE there is a skip and it is
  // not required. Both halves, or the assertion establishes nothing about this PR.
  assert.ok(ignored.length > 0, "there must BE a skip for the not-required fact to matter");
});
