import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import {
  landCiLearningShards,
  landingIdentity,
  landPlanReconcileShards,
  sweepFeedbackLanding,
  type CiLearningShardDraft,
  type LandingRepository,
} from "#src/lib/feedback-landing.js";
import { withLiveWritesAllowed } from "#src/lib/live-write-guard.js";
import { gitRepo, type GitRepo } from "#test/helpers/git-repo.js";

// W1-T9753: a landing branch is ONE commit built on the main of its day (`commit-tree -p <main>`),
// so everything it holds that its own commit did not change was inherited from that older main.
// The carry-forward used to restage every file the branch held, so main's later triage, shard
// edits and deletions were reverted by the next landing build. Each test cuts a landing from an
// older main, lets main move, and lands again against a real bare origin; only `gh` is faked.

const TARGET: LandingRepository = { owner: "o", repo: "r" };
const OWNER = "w1-t9753-fixture";
const preflightOk = () => ({ ok: true, failures: [], unreadable: [] });
const gh = (args: string[]): string => (args[0] === "pr" && args[1] === "list" ? "[]" : "https://github.com/o/r/pull/9753\n");

interface Fixture {
  origin: GitRepo;
  seed: GitRepo;
  /** Write (or, with `null`, delete) files in the seed checkout and commit them. */
  commit(files: Record<string, string | null>, message: string): void;
  push(ref: string): void;
  show(ref: string, path: string): string | undefined;
  changed(a: string, b: string): string[];
  clone(): string;
}

function fixture(kind: string): Fixture {
  const origin = gitRepo({ bare: true, kind: `${kind}-origin` });
  const seed = gitRepo({ kind: `${kind}-seed` });
  seed.addRemote("origin", origin.dir);
  return {
    origin,
    seed,
    commit(files, message) {
      for (const [path, content] of Object.entries(files)) {
        const abs = join(seed.dir, path);
        if (content === null) rmSync(abs);
        else {
          mkdirSync(dirname(abs), { recursive: true });
          writeFileSync(abs, content);
        }
      }
      seed.git("add", "-A");
      seed.git("commit", "--quiet", "-m", message);
    },
    push(ref) {
      seed.git("push", "--quiet", "--force", "origin", `HEAD:refs/heads/${ref}`);
    },
    show(ref, path) {
      try {
        return origin.git("show", `${ref}:${path}`);
      } catch {
        return undefined;
      }
    },
    changed(a, b) {
      return origin.git("diff", "--name-only", a, b).split("\n").filter(Boolean).sort();
    },
    clone() {
      return gitRepo({ cloneFrom: origin.dir, kind: `${kind}-root` }).dir;
    },
  };
}

const fb = (id: string, status: string): string => `id: ${id}\nstatus: ${status}\nraw: ${id} body\n`;
const shard = (id: string, status: string, note = ""): string => `- id: ${id}\n  title: ${id} fixture\n  status: ${status}\n${note}`;

test("W1-T9753: a feedback landing keeps main triage and deletions of inherited records", () => {
  const f = fixture("w9753-feedback");
  const branch = landingIdentity({ family: "feedback", targetRepository: TARGET, landingOwner: OWNER }).branch;
  const A = "plan/feedback/fb-a.yaml", D = "plan/feedback/fb-d.yaml", K = "plan/feedback/fb-k.yaml";
  const P = "plan/feedback/fb-p.yaml", NEW = "plan/feedback/fb-new.yaml";
  f.commit({ [A]: fb("fb-a", "new"), [D]: fb("fb-d", "new"), [K]: fb("fb-k", "new") }, "base");
  f.push("main");
  // The landing commit of its day: one parent, the main it was built on, plus its own record.
  f.seed.git("checkout", "--quiet", "-b", "landing");
  f.commit({ [P]: fb("fb-p", "new") }, "chore(feedback): land pending filings");
  f.push(branch);
  // Main moves on: fb-a is triaged and fb-d is deleted, after the landing was cut.
  f.seed.git("checkout", "--quiet", "main");
  f.commit({ [A]: fb("fb-a", "accepted"), [D]: null }, "triage on main");
  f.push("main");

  const root = f.clone();
  mkdirSync(join(root, "plan", "feedback"), { recursive: true });
  writeFileSync(join(root, NEW), fb("fb-new", "new"));
  const rows: Array<[string, Record<string, unknown> | undefined]> = [];
  const result = withLiveWritesAllowed(() =>
    sweepFeedbackLanding(root, {
      gh,
      targetRepository: TARGET,
      landingOwner: OWNER,
      planPrPreflight: preflightOk,
      log: (step, extra) => rows.push([step, extra]),
    }),
  );

  assert.equal(result.landed, true, result.error);
  assert.equal(result.refused, undefined, "an inherited record is never a conflict");
  assert.match(f.show(branch, A) ?? "", /status: accepted/, "main's triage of an inherited record stands");
  assert.equal(f.show(branch, D), undefined, "a record main deleted is not re-added");
  assert.deepEqual(f.changed("main", branch), [NEW, P], "the landing carries only its own records and the new capture");
  assert.deepEqual(result.carry, { carried: 1, inheritedSkipped: 2 });
  const row = rows.find(([step]) => step === "feedback.landing_sweep")?.[1];
  assert.equal(row?.carried, 1, "the landing row counts what it carried forward");
  assert.equal(row?.inherited_skipped, 2, "and the stale inherited copies it would once have restaged");

  // The next pass reads the landing it just built: both records are its own, nothing is inherited.
  const again = withLiveWritesAllowed(() =>
    sweepFeedbackLanding(root, {
      gh,
      targetRepository: TARGET,
      landingOwner: OWNER,
      planPrPreflight: preflightOk,
      log: (step, extra) => rows.push([step, extra]),
    }),
  );
  assert.equal(again.pushed, false, again.error);
  const quiet = rows.filter(([step]) => step === "feedback.landing_sweep").at(-1)?.[1];
  assert.deepEqual([quiet?.carried, quiet?.inherited_skipped], [2, 0], "the quiet row carries the same evidence");
});

function ciDraft(): CiLearningShardDraft {
  return {
    findingId: "ci-learning:9753:ci-gate",
    title: "the landing keeps main's shards",
    gate: "ci-gate",
    pr: 9753,
    prs: [9753],
    repairFiles: ["src/lib/x.ts"],
    dominantRepairFiles: [{ file: "src/lib/x.ts", prs: 1 }],
    action: "gate",
    author_class: "machine",
    verify: "human",
    remedySurface: "test",
  };
}

test("W1-T9753: a content landing never restages an inherited shard", () => {
  // ...including a landing tip that merged main in, which is diffed against its merge base.
  const f = fixture("w9753-ci-learning");
  const branch = landingIdentity({ family: "ci-learning", targetRepository: TARGET, landingOwner: OWNER }).branch;
  const A = "plan/tasks.d/W1-T101-alpha.yaml", B = "plan/tasks.d/W1-T102-beta.yaml", OWN = "plan/tasks.d/W1-T900-own.yaml";
  f.commit({ "plan/tasks.yaml": "[]\n", [A]: shard("W1-T101", "queued"), [B]: shard("W1-T102", "queued") }, "base");
  f.push("main");
  f.seed.git("checkout", "--quiet", "-b", "landing");
  f.commit({ [OWN]: shard("W1-T900", "queued", "  origin: ci-learning:900:ci-gate\n") }, "chore(ci-learning): land pending lessons");
  f.push(branch);
  // Main moves, then someone merges main into the landing branch (a GitHub "update branch").
  f.seed.git("checkout", "--quiet", "main");
  f.commit({ [A]: shard("W1-T101", "merged") }, "main moves once");
  f.push("main");
  f.seed.git("checkout", "--quiet", "landing");
  f.seed.git("merge", "--quiet", "--no-ff", "--no-edit", "main");
  f.push(branch);
  // Main moves again after that merge.
  f.seed.git("checkout", "--quiet", "main");
  f.commit({ [A]: shard("W1-T101", "merged", "  note: edited after the merge\n"), [B]: shard("W1-T102", "merged") }, "main moves twice");
  f.push("main");

  const root = f.clone();
  const stateRoot = mkdtempSync(join(tmpdir(), "rmd-w9753-state-"));
  const result = withLiveWritesAllowed(() =>
    landCiLearningShards([ciDraft()], root, {
      stateRoot,
      mintTaskId: () => "W1-T9001",
      planOrigins: [],
      renderShard: (draft, taskId) => shard(taskId, "queued", `  origin: ${draft.findingId}\n`),
      recordVerdict: () => ({ ok: true, reason: "" }),
      gh,
      targetRepository: TARGET,
      landingOwner: OWNER,
      planPrPreflight: preflightOk,
    }),
  );

  const NEW = "plan/tasks.d/W1-T9001-the-landing-keeps-main-s-shards.yaml";
  assert.equal(result.carryRefused, undefined, "an inherited shard is never a conflict, merged-in or not");
  assert.equal(f.show(branch, A), f.show("main", A), "main's later edit of an inherited shard stands");
  assert.equal(f.show(branch, B), f.show("main", B), "main's edit of a shard the landing never touched stands");
  assert.deepEqual(f.changed("main", branch), [OWN, NEW], "the landing carries its own shard forward across the merge");
});

test("W1-T9753: the plan-reconcile landing never restages an inherited shard", () => {
  const f = fixture("w9753-plan-reconcile");
  const branch = landingIdentity({ family: "plan-reconcile", targetRepository: TARGET, landingOwner: OWNER }).branch;
  const X = "plan/tasks.d/W1-T201-x.yaml", Y = "plan/tasks.d/W1-T202-y.yaml", OWN = "plan/tasks.d/W1-T203-own.yaml";
  const Z = "plan/tasks.d/W1-T204-z.yaml";
  f.commit({ [X]: shard("W1-T201", "queued"), [Y]: shard("W1-T202", "queued"), [OWN]: shard("W1-T203", "queued"), [Z]: shard("W1-T204", "queued") }, "base");
  f.push("main");
  f.seed.git("checkout", "--quiet", "-b", "landing");
  f.commit({ [OWN]: shard("W1-T203", "merged") }, "chore(plan): reconcile credited task statuses");
  f.push(branch);
  f.seed.git("checkout", "--quiet", "main");
  f.commit({ [X]: shard("W1-T201", "running"), [Y]: null }, "main edits one shard and deletes another");
  f.push("main");

  const root = f.clone();
  const result = withLiveWritesAllowed(() =>
    landPlanReconcileShards(root, [{ relPath: Z, content: shard("W1-T204", "merged") }], {
      gh,
      targetRepository: TARGET,
      landingOwner: OWNER,
      planPrPreflight: preflightOk,
    }),
  );

  assert.equal(result.landed, true, result.error);
  assert.equal(result.refused, undefined);
  assert.match(f.show(branch, X) ?? "", /status: running/, "main's edit of an inherited shard stands");
  assert.equal(f.show(branch, Y), undefined, "a shard main deleted is not re-added");
  assert.deepEqual(f.changed("main", branch), [OWN, Z], "only the landing's own reconciliation and the new one ride");
  assert.deepEqual(result.carry, { carried: 1, inheritedSkipped: 2 });
});

test("W1-T9753: a path both sides changed is decided by lineage or refused by name", () => {
  const f = fixture("w9753-both-sides");
  const fbBranch = landingIdentity({ family: "feedback", targetRepository: TARGET, landingOwner: OWNER }).branch;
  const prBranch = landingIdentity({ family: "plan-reconcile", targetRepository: TARGET, landingOwner: OWNER }).branch;
  const ADV = "plan/feedback/fb-adv.yaml", BACK = "plan/feedback/fb-back.yaml", GONE = "plan/feedback/fb-gone.yaml";
  const S = "plan/tasks.d/W1-T301-s.yaml";
  f.commit({ [ADV]: fb("fb-adv", "new"), [BACK]: fb("fb-back", "new"), [GONE]: fb("fb-gone", "new"), [S]: shard("W1-T301", "queued") }, "base");
  f.push("main");
  f.seed.git("checkout", "--quiet", "-b", "fb-landing");
  f.commit({ [ADV]: fb("fb-adv", "accepted"), [BACK]: fb("fb-back", "proposed"), [GONE]: fb("fb-gone", "grilling") }, "feedback landing");
  f.push(fbBranch);
  f.seed.git("checkout", "--quiet", "-b", "pr-landing", "main");
  f.commit({ [S]: shard("W1-T301", "merged") }, "reconcile landing");
  f.push(prBranch);
  // Main changes every one of those paths too.
  f.seed.git("checkout", "--quiet", "main");
  f.commit({ [ADV]: fb("fb-adv", "grilling"), [BACK]: fb("fb-back", "accepted"), [GONE]: null, [S]: shard("W1-T301", "queued", "  note: main's edit\n") }, "main");
  f.push("main");

  const root = f.clone();
  mkdirSync(join(root, "plan", "feedback"), { recursive: true });
  writeFileSync(join(root, "plan/feedback/fb-fresh.yaml"), fb("fb-fresh", "new"));
  const fed = withLiveWritesAllowed(() =>
    sweepFeedbackLanding(root, { gh, targetRepository: TARGET, landingOwner: OWNER, planPrPreflight: preflightOk }),
  );
  assert.equal(fed.landed, true, fed.error);
  assert.match(f.show(fbBranch, ADV) ?? "", /status: accepted/, "the landing's lifecycle advance wins by lineage");
  assert.match(f.show(fbBranch, BACK) ?? "", /status: accepted/, "a backward move keeps main's copy");
  assert.equal(f.show(fbBranch, GONE), undefined, "main's deletion stands");
  assert.deepEqual(fed.refused?.map((r) => r.path).sort(), [BACK, GONE]);
  assert.match(fed.refused?.find((r) => r.path === GONE)?.reason ?? "", /plan\/feedback\/fb-gone\.yaml.*deletion/);

  const rec = withLiveWritesAllowed(() =>
    landPlanReconcileShards(root, [{ relPath: "plan/tasks.d/W1-T302-t.yaml", content: shard("W1-T302", "merged") }], {
      gh,
      targetRepository: TARGET,
      landingOwner: OWNER,
      planPrPreflight: preflightOk,
    }),
  );
  assert.equal(rec.landed, true, rec.error);
  assert.equal(f.show(prBranch, S), f.show("main", S), "a non-feedback conflict keeps main's copy");
  assert.deepEqual(rec.refused?.map((r) => r.path), [S]);
  assert.match(rec.refused?.[0]?.reason ?? "", /both main and .* changed plan\/tasks\.d\/W1-T301-s\.yaml/, "refused by name");
});
