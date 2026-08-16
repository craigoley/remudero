import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { reconcileChangesetClaim, CHANGESET_HEADER } from "../src/lib/plan-pr-emitter.js";
import { bodyContradictsDiff } from "../src/lib/review.js";

/**
 * W1-T533. The retro's body claims a changeset the harness itself widens afterwards, so the
 * claim is false by the time `bodyContradictsDiff` reads it. These drive the reconciler against
 * a REAL git repository — the changed-path list comes from `git diff --name-only`, never from a
 * hand-written array — because a fixture list would prove the formatter and not the mechanism.
 */

/** A real repo with a real commit, returning the paths git itself reports as changed. */
function realRunChanging(paths: string[]): { changed: string[]; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "rmd-retro-changeset-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.invalid");
  git("config", "user.name", "t");
  writeFileSync(join(dir, "seed.txt"), "seed\n");
  git("add", "-A");
  git("commit", "-q", "-m", "seed");
  const base = git("rev-parse", "HEAD").trim();
  for (const p of paths) {
    const full = join(dir, p);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, `content for ${p}\n`);
  }
  git("add", "-A");
  git("commit", "-q", "-m", "the retro run");
  const changed = git("diff", "--name-only", `${base}...HEAD`).split("\n").map((s) => s.trim()).filter(Boolean);
  return { changed, dir };
}

/** The shape #1943 and #1944 both shipped, verbatim in structure. */
const STALE_BODY = [
  "Plan-only sync for RETRO-1786867677764 (R20). Edits `MASTER-PLAN.md` and nothing else.",
  "",
  "## Acceptance",
  "",
  "- the log records this cycle | grep: RETRO in MASTER-PLAN.md",
  "",
  "- Plan-only, harness files untouched | `git diff --stat` shows exactly one file changed:",
  "  `MASTER-PLAN.md`. No `src/`, no `test/`, no `docs/ORIENTATION.md`.",
].join("\n");

const RETRO_THREE = ["MASTER-PLAN.md", "docs/ORIENTATION.md", "plan/plan-index.json"];

test("W1-T533: the reconciled body names every path the run wrote and no others", () => {
  const { changed } = realRunChanging(RETRO_THREE);
  assert.deepEqual([...changed].sort(), [...RETRO_THREE].sort(), "the real run wrote all three");

  const out = reconcileChangesetClaim(STALE_BODY, changed);
  assert.ok(out, "a contradicted body must be reconciled");

  for (const p of changed) {
    assert.ok(out.includes(p), `the reconciled body must name ${p}, which the run actually wrote`);
  }
  // AND NO OTHERS: the only paths listed in the harness section are the ones git reported.
  const listed = out
    .slice(out.indexOf(CHANGESET_HEADER))
    .split("\n")
    .filter((l) => l.startsWith("- `"))
    .map((l) => l.replace(/^- `/, "").replace(/`$/, ""));
  assert.deepEqual(listed.sort(), [...changed].sort(), "no path beyond what the run wrote");
});

test("W1-T533: the pre-change body is contradicted by the real diff and the reconciled one is not", () => {
  const { changed } = realRunChanging(RETRO_THREE);

  // THE FALSIFIER. Without this the test above would pass on a reconciler that changed nothing
  // material: it proves the ORIGINAL body really does trip the gate over this same real diff.
  const before = bodyContradictsDiff(STALE_BODY, changed);
  assert.ok(before.length > 0, "the pre-change template must be contradicted — else there is no defect to fix");

  const out = reconcileChangesetClaim(STALE_BODY, changed);
  assert.ok(out);
  assert.deepEqual(bodyContradictsDiff(out, changed), [], "the reconciled body must clear the gate");
});

test("W1-T533: a run writing a different number of files is reconciled just as well", () => {
  // A hardcoded three would be the same defect wearing a new number, so both a SMALLER and a
  // LARGER real run must come out clean.
  for (const paths of [
    ["MASTER-PLAN.md", "plan/plan-index.json"],
    ["MASTER-PLAN.md", "docs/ORIENTATION.md", "plan/plan-index.json", "plan/tasks.d/W1-T999-x.yaml"],
  ]) {
    const { changed } = realRunChanging(paths);
    assert.equal(changed.length, paths.length, "the real run wrote what was asked");

    const out = reconcileChangesetClaim(STALE_BODY, changed);
    assert.ok(out, `a ${paths.length}-file run must still reconcile`);
    assert.deepEqual(bodyContradictsDiff(out, changed), [], `a ${paths.length}-file run must clear the gate`);
    for (const p of changed) assert.ok(out.includes(p), `${p} must be named`);
  }
});

test("W1-T533: a body that already agrees is left alone rather than rewritten", () => {
  // The false-positive containment: returning a new body every pass would edit the PR on every
  // retro whether or not anything was wrong, and would make the ledger line meaningless.
  const { changed } = realRunChanging(RETRO_THREE);
  const agreed = reconcileChangesetClaim(STALE_BODY, changed);
  assert.ok(agreed);
  assert.equal(reconcileChangesetClaim(agreed, changed), undefined, "an agreeing body yields no edit");
});

test("W1-T533: a truthful no-path denial survives, so the plan-side assurance is not destroyed", () => {
  // `no src/` is TRUE for a retro and is the reader's assurance it carried no code. Only a denial
  // naming a path the diff DOES carry may be dropped.
  const { changed } = realRunChanging(RETRO_THREE);
  const out = reconcileChangesetClaim(STALE_BODY, changed);
  assert.ok(out);
  assert.match(out, /No `src\/`/, "a denial about a path genuinely absent must survive");
  assert.match(out, /no `test\/`/, "and so must the second one, whatever its capitalisation");
  assert.equal(/no `?docs\/ORIENTATION\.md`?/i.test(out), false, "a denial the diff refutes must go");
});
