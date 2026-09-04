import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  decideReconArtifactReuse,
  filesDigest,
  PLAN_RECORD_ABSENT,
  planSha,
  taskRecordSha,
  type ReconArtifact,
} from "../src/run-task.js";

// ── W1-T2510: AN UNRELATED PLAN FILING THROWS AWAY A TASK'S RECON ──────────────────────────────
//
// THE DEFECT THIS PROVES FIXED: the `plan_sha` half of the recon artifact key used to be
// `planSha` — a hash of EVERY file under `plan/` — so filing any OTHER task's shard moved it and
// invalidated every cached artifact regardless of relevance (measured live at
// 2026-08-30T18:08:35Z: W1-T2467's artifact was invalidated with `reason: "plan_sha"` while its
// `files_digest` was byte-identical either side — nothing about W1-T2467 itself had changed).
// `plan_sha` is now `taskRecordSha` — a hash of ONLY the file holding the task's own record —
// scoped by `lib/plan.ts`'s `taskRecordPath`. These tests exercise the digest primitives and the
// pure `decideReconArtifactReuse` predicate directly: fast, filesystem-only, no git/worker
// mocking needed (the full dispatch-level lifecycle already lives in
// test/recon-artifact-reuse.test.ts).

function fakePrior(over: Partial<ReconArtifact> = {}): ReconArtifact {
  return {
    task_id: "TASK-A",
    plan_sha: "prior-plan-sha",
    files_digest: "prior-files-digest",
    observed: "o",
    inferred: "i",
    couldnt_verify: "c",
    written_at: "2026-08-25T00:00:00.000Z",
    run_id: "r1",
    ...over,
  };
}

/** A `plan/tasks.d/` tree with exactly one task's shard, for editing/adding shards around. */
function planFixture(root: string): { planPath: string; shardA: string } {
  const shardDir = join(root, "plan", "tasks.d");
  mkdirSync(shardDir, { recursive: true });
  const shardA = join(shardDir, "task-a.yaml");
  writeFileSync(
    shardA,
    ["- id: TASK-A", "  title: task A", "  repo: remudero", "  type: implement", "  files: [src/a.ts]", ""].join("\n"),
  );
  // planPath itself (the monolith) need not exist — taskRecordPath falls through to the shard
  // dir fail-soft, exactly as it does on a real shard-only repo.
  return { planPath: join(root, "plan", "tasks.yaml"), shardA };
}

// ── Claim 1 + 8: an unrelated filing doesn't move the NEW key, but WOULD move the OLD one ──────

test("filing an UNRELATED task's shard leaves taskRecordSha unchanged, but moves planSha (the rejected whole-plan key)", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-unrelated-filing-"));
  try {
    const { planPath } = planFixture(root);
    const planShaBefore = planSha(root);
    const taskRecordShaBefore = taskRecordSha(planPath, "TASK-A");

    // A DIFFERENT task's shard is filed — the exact "unrelated filing" the task title names.
    writeFileSync(
      join(root, "plan", "tasks.d", "task-b.yaml"),
      ["- id: TASK-B", "  title: an unrelated task", "  repo: remudero", "  type: implement", "  files: [src/b.ts]", ""].join(
        "\n",
      ),
    );

    assert.equal(
      taskRecordSha(planPath, "TASK-A"),
      taskRecordShaBefore,
      "TASK-A's own record file never changed — its scoped digest must not move",
    );
    assert.notEqual(
      planSha(root),
      planShaBefore,
      "planSha (kept only as the rejected coarse alternative) DOES move — this is the bug being fixed, reproduced as a contrast",
    );

    // Wire both digests through the actual reuse predicate: the OLD key would have invalidated a
    // perfectly valid artifact; the NEW key correctly calls it a hit.
    const prior = fakePrior({ plan_sha: taskRecordShaBefore, files_digest: "same-files" });
    const withNewKey = decideReconArtifactReuse(prior, taskRecordSha(planPath, "TASK-A"), "same-files");
    assert.equal(withNewKey.valid, true, "acceptance #1: an unrelated task's shard filing does not invalidate this task's recon");

    const withOldKey = decideReconArtifactReuse({ ...prior, plan_sha: planShaBefore }, planSha(root), "same-files");
    assert.equal(
      withOldKey.valid,
      false,
      "acceptance #8: restoring the whole-plan key (planSha) makes the unrelated-filing case invalidate again",
    );
    assert.equal(withOldKey.invalidationReason, "plan_sha");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── Claim 2 + 5: editing THIS task's own record invalidates, named by component ────────────────

test("editing THIS task's own plan record moves taskRecordSha and invalidates, named plan_sha", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-own-record-edit-"));
  try {
    const { planPath, shardA } = planFixture(root);
    const before = taskRecordSha(planPath, "TASK-A");

    writeFileSync(
      shardA,
      ["- id: TASK-A", "  title: task A, RETITLED", "  repo: remudero", "  type: implement", "  files: [src/a.ts]", ""].join(
        "\n",
      ),
    );
    const after = taskRecordSha(planPath, "TASK-A");
    assert.notEqual(before, after, "editing the task's own shard content must move its taskRecordSha");

    const decision = decideReconArtifactReuse(fakePrior({ plan_sha: before, files_digest: "f" }), after, "f");
    assert.equal(decision.valid, false, "acceptance #2: editing this task's own plan record does invalidate its recon");
    assert.equal(decision.invalidationReason, "plan_sha", "acceptance #5: the invalidation row names WHICH component changed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── Claim 3 + 5: a declared-file change still invalidates, named by component ───────────────────

test("a change to the task's declared files still invalidates, named files_digest — the OTHER component", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-declared-file-edit-"));
  try {
    writeFileSync(join(root, "src.ts"), "export const x = 1;\n");
    const before = filesDigest(root, ["src.ts"]);
    writeFileSync(join(root, "src.ts"), "export const x = 2;\n");
    const after = filesDigest(root, ["src.ts"]);
    assert.notEqual(before, after, "editing a declared file must move filesDigest");

    const decision = decideReconArtifactReuse(fakePrior({ plan_sha: "p", files_digest: before }), "p", after);
    assert.equal(decision.valid, false, "acceptance #3: a change to the task's declared files still invalidates, as today");
    assert.equal(decision.invalidationReason, "files_digest", "acceptance #5: named as the OTHER component, not plan_sha");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── Claim 4: a missing or unreadable plan record always invalidates, never reuses ───────────────

test("a missing or unreadable plan record invalidates rather than reuses — even against a matching prior", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-missing-record-"));
  try {
    const { planPath } = planFixture(root);

    // The task's record does not exist anywhere (never filed, or since removed).
    const absentSha = taskRecordSha(planPath, "TASK-NEVER-FILED");
    assert.equal(absentSha, PLAN_RECORD_ABSENT, "taskRecordPath resolves to nothing — the ABSENT sentinel");

    const decisionVsRealPrior = decideReconArtifactReuse(fakePrior({ plan_sha: "some-real-digest", files_digest: "f" }), absentSha, "f");
    assert.equal(decisionVsRealPrior.valid, false, "acceptance #4: an unreadable/missing record must invalidate, never reuse");
    assert.equal(decisionVsRealPrior.invalidationReason, "plan_sha");

    // Pathological case: a PRIOR artifact was itself written while the record was already
    // absent (plan_sha stored as PLAN_RECORD_ABSENT). A naive string-equality check would call
    // this a "hit" since both sides say "absent" — it must not.
    const decisionVsAbsentPrior = decideReconArtifactReuse(
      fakePrior({ plan_sha: PLAN_RECORD_ABSENT, files_digest: "f" }),
      absentSha,
      "f",
    );
    assert.equal(
      decisionVsAbsentPrior.valid,
      false,
      "an ABSENT sentinel must never validate a reuse, even matching a prior that stored the same sentinel",
    );
    assert.equal(decisionVsAbsentPrior.invalidationReason, "plan_sha", "still correctly attributed to plan_sha, not misread as files_digest");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── Claim 6: no prior record at all is a miss, never a hit ──────────────────────────────────────

test("an artifact with no prior record is treated as a miss, never a hit", () => {
  const decision = decideReconArtifactReuse(undefined, "any-plan-sha", "any-files-digest");
  assert.equal(decision.valid, false, "acceptance #6: no prior artifact — always a miss");
  assert.equal(decision.invalidationReason, undefined, "nothing to attribute a reason to — there is no prior to compare against");
});

// ── Claim 7: filesDigest's own semantics are untouched by this task ─────────────────────────────

test("filesDigest's meaning is unchanged: unrelated files never move it, declared files do, absent is a stable sentinel", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-files-digest-unchanged-"));
  try {
    writeFileSync(join(root, "declared.ts"), "export const a = 1;\n");
    writeFileSync(join(root, "undeclared.ts"), "export const b = 1;\n");
    const before = filesDigest(root, ["declared.ts"]);

    writeFileSync(join(root, "undeclared.ts"), "export const b = 2;\n");
    assert.equal(filesDigest(root, ["declared.ts"]), before, "acceptance #7: an undeclared file's change never moves files_digest");

    writeFileSync(join(root, "declared.ts"), "export const a = 2;\n");
    assert.notEqual(filesDigest(root, ["declared.ts"]), before, "a declared file's own content change still moves files_digest, as before");

    const forwardRef = filesDigest(root, ["not-yet-created.ts"]);
    writeFileSync(join(root, "not-yet-created.ts"), "export const c = 1;\n");
    assert.notEqual(
      filesDigest(root, ["not-yet-created.ts"]),
      forwardRef,
      "a forward-referenced declared file's later creation still moves its digest, as before",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
