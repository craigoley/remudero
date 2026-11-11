// W1-T12199: machine-filed edits of a task file land through ONE pull request on one fixed branch.
// The branch is sealed while that pull request is open: the landing never pushes to it, so CI and
// review are not restarted by a later file. The refusal amendment in the sweep is the first user.
// Every test here drives the production path: `runSweep` with the effects of `buildSweepEffects`, real
// git against a bare origin, and fakes only for GitHub and for the plan preflight verdict.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { Config } from "#src/lib/config.js";
import { isLandingRef, landTaskFilesAsync, landingIdentity, stagedTaskFiles } from "#src/lib/feedback-landing.js";
import { appendLedger } from "#src/lib/ledger.js";
import { withLiveWritesAllowed } from "#src/lib/live-write-guard.js";
import type { PlanPrPreflightResult } from "#src/lib/plan-pr-emitter.js";
import type { Plan, Task } from "#src/lib/plan.js";
import { REFUSAL_AMENDMENT_STEP, planAmendmentReceipt } from "#src/lib/refusal-amendment.js";
import { gitRepo, type GitRepo } from "#test/helpers/git-repo.js";
import { buildSweepEffects, runSweep, type SweepDeps } from "#test/helpers/sweep-test.js";

const NOW = Date.parse("2026-11-10T12:00:00.000Z");
const VERDICT_TS = "2026-11-10T11:00:00.000Z"; // expiring-fixture: exempt -- compared only against this suite's INJECTED now (NOW), never the wall clock
const A = "W1-T90001";
const B = "W1-T90002";
const C = "W1-T90003";
const pathOf = (id: string): string => `plan/tasks.d/${id}-fixture.yaml`;
const shard = (id: string): string => [`- id: ${id}`, "  repo: remudero", "  status: queued", "  attempts: 0", ""].join("\n");
const REFUSAL = ["REFUSED:", "1. [premise-rotted] No headline at this checkout meets the task record's required condition"].join("\n");
const GREEN: PlanPrPreflightResult = { ok: true, failures: [], unreadable: [] };
const LINT_RED: PlanPrPreflightResult = { ok: false, failures: [{ check: "lint-plan", firstLine: "lint-plan-precheck: REFUSES the tree" }], unreadable: [] };
const PROOF_RED: PlanPrPreflightResult = { ok: false, failures: [{ check: "proof-discrimination", firstLine: "the proof does not discriminate" }], unreadable: [] };

type Row = Record<string, unknown>;

interface Fixture {
  root: string;
  origin: GitRepo;
  checkout: GitRepo;
  ledger: string;
  /** GitHub as the landing sees it. */
  gh: { open: Array<{ url: string }>; listingBroken: boolean; creates: Array<{ url: string; body: string }>; states: Map<string, string> };
  /** The plan preflight: the ids whose file is red, and whether main itself is red. */
  preflight: { red: Set<string>; mainRed: boolean; calls: number };
  refuse: (taskId: string, runId: string) => void;
  sweep: () => Promise<void>;
  rows: (step?: string) => Row[];
  branch: () => string | undefined;
  branchSha: () => string | undefined;
  staged: () => string[];
  mergeLanding: () => void;
  commitOnMain: (relPath: string, content: string) => void;
  landingOpts: () => Parameters<typeof landTaskFilesAsync>[2];
}

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "rmd-w1-t12199-"));
  const origin = gitRepo({ bare: true, kind: "w1-t12199-origin" });
  const author = gitRepo({ cloneFrom: origin.dir, kind: "w1-t12199-author" });
  mkdirSync(join(author.dir, "plan", "tasks.d"), { recursive: true });
  for (const id of [A, B, C]) writeFileSync(join(author.dir, pathOf(id)), shard(id));
  author.git("add", "-A");
  author.git("commit", "--quiet", "-m", "seed the plan");
  author.git("push", "--quiet", "origin", "HEAD:refs/heads/main");
  const checkout = gitRepo({ cloneFrom: origin.dir, kind: "w1-t12199-checkout" });
  const ledger = join(root, "state", "ledger.ndjson");
  const tasks = [A, B, C].map((id) => ({ id, repo: "remudero", status: "queued", attempts: 0, title: "fixture" }) as unknown as Task);
  const gh: Fixture["gh"] = { open: [], listingBroken: false, creates: [], states: new Map() };
  const preflight: Fixture["preflight"] = { red: new Set(), mainRed: false, calls: 0 };
  const log = (step: string, extra?: Row): void => void appendLedger(ledger, { run_id: "SWEEP-W1-T12199", task_id: "SWEEP", step, ...extra });
  const ghJsonImpl = (args: string[]): unknown => {
    if (args[0] === "pr" && args[1] === "list") {
      if (gh.listingBroken) throw new Error("gh: the listing is unreachable");
      return gh.open;
    }
    if (args[0] === "pr" && args[1] === "create") {
      const url = `https://github.com/acme/remudero/pull/${9000 + gh.creates.length + 1}`;
      gh.creates.push({ url, body: args[args.indexOf("--body") + 1]! });
      gh.open = [{ url }];
      gh.states.set(url, "OPEN");
      return url;
    }
    if (args[0] === "pr" && args[1] === "view") return { state: gh.states.get(args[2]!) ?? "OPEN" };
    return [];
  };
  const planPrPreflightImpl = (_dir: string, _sha: string, pr: { body: string }): PlanPrPreflightResult => {
    preflight.calls++;
    if (preflight.mainRed) return LINT_RED;
    return [...preflight.red].some((id) => pr.body.includes(id)) ? PROOF_RED : GREEN;
  };
  const effects = buildSweepEffects({
    owner: "acme",
    repo: "remudero",
    repoRoot: checkout.dir,
    config: { root, claudeBin: "/bin/true" } as Config,
    ledgerPath: ledger,
    runId: "SWEEP-W1-T12199",
    plan: { tasks, byId: new Map(tasks.map((t) => [t.id, t])) } as unknown as Plan,
    log,
    nowMsImpl: () => NOW,
    ghJsonImpl,
    reloadPlanForFixImpl: () => undefined,
    planPrPreflightImpl,
  });
  const sweepDeps: SweepDeps = {
    arm: () => "armed",
    close: () => {},
    dispatchFix: () => {},
    escalate: () => {},
    ledgerPath: ledger,
    runId: "SWEEP-W1-T12199",
    now: () => NOW,
    readMainTip: () => origin.git("rev-parse", "refs/heads/main"),
    draftRefusalAmendments: effects.draftRefusalAmendments,
  };
  const branch = (): string | undefined =>
    origin.git("for-each-ref", "--format=%(refname:short)", "refs/heads").split("\n").find((ref) => ref.startsWith("task-files-landing"));
  const pending = join(root, "state", "task-files-landing-pending", "plan", "tasks.d");
  return {
    root, origin, checkout, ledger, gh, preflight, branch,
    refuse: (taskId, runId) => appendLedger(ledger, { run_id: runId, task_id: taskId, step: "verdict", verdict: "no_pr", report_excerpt: REFUSAL, ts: VERDICT_TS }),
    sweep: async () => void (await withLiveWritesAllowed(() => runSweep([], sweepDeps))),
    rows: (step) => (existsSync(ledger) ? readFileSync(ledger, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Row) : [])
      .filter((r) => step === undefined || r.step === step),
    branchSha: () => (branch() ? origin.git("rev-parse", `refs/heads/${branch()}`) : undefined),
    staged: () => (existsSync(pending) ? readdirSync(pending).filter((f) => f.endsWith(".yaml")).sort() : []),
    mergeLanding: () => {
      const name = branch()!;
      origin.git("update-ref", "refs/heads/main", origin.git("rev-parse", `refs/heads/${name}`));
      origin.git("update-ref", "-d", `refs/heads/${name}`);
      for (const pr of gh.open) gh.states.set(pr.url, "MERGED");
      gh.open = [];
    },
    commitOnMain: (relPath, content) => {
      author.git("pull", "--quiet", "origin", "main");
      mkdirSync(join(author.dir, relPath, ".."), { recursive: true });
      writeFileSync(join(author.dir, relPath), content);
      author.git("add", "-A");
      author.git("commit", "--quiet", "-m", `change ${relPath}`);
      author.git("push", "--quiet", "origin", "HEAD:refs/heads/main");
    },
    landingOpts: () => ({
      stateRoot: root,
      targetRepository: { owner: "acme", repo: "remudero" },
      log,
      gh: (args: string[]) => {
        const out = ghJsonImpl(args);
        return typeof out === "string" ? out : JSON.stringify(out);
      },
      planPrPreflight: (sha: string, pr: { title: string; body: string }) => planPrPreflightImpl(checkout.dir, sha, pr),
    }),
  };
}

const outcomes = (f: Fixture): Array<[unknown, unknown, unknown]> => f.rows(REFUSAL_AMENDMENT_STEP).map((r) => [r.task_id, r.source_run_id, r.outcome]);
const criteria = (body: string): string[] => body.slice(body.indexOf("## Acceptance")).split("\n").filter((l) => l.startsWith("- "));

test("W1-T12199 criterion 1: the landing has a family for task files with one fixed branch, and isLandingRef knows it", () => {
  const identity = landingIdentity({ family: "task-files" });
  assert.equal(identity.branch, "task-files-landing");
  assert.equal(isLandingRef(identity.branch), true, "the branch reaper must keep the landing branch");
  const scoped = landingIdentity({ family: "task-files", targetRepository: { owner: "acme", repo: "other" }, landingOwner: "host-a" });
  assert.equal(isLandingRef(scoped.branch), true, "a scoped landing branch is a landing ref too");
});

// One story in four steps. Each step is its own subtest and builds on the step before it.
test("W1-T12199: one sealed landing pull request; a later amendment waits, dedupes, then lands", async (t) => {
  const f = fixture();
  let first: { url: string; body: string } = { url: "", body: "" };
  let sealedSha: string | undefined;

  await t.test("W1-T12199 criterion 2: the sweep lands the amendment through the family, in one pull request with one criterion", async () => {
    f.refuse(A, "RUN-A");
    await f.sweep();
    assert.equal(f.gh.creates.length, 1, "one landing pull request opens");
    first = f.gh.creates[0]!;
    assert.deepEqual(outcomes(f), [[A, "RUN-A", "drafted"]]);
    assert.equal(f.rows(REFUSAL_AMENDMENT_STEP)[0]!.pr_url, first.url);
    assert.match(f.origin.git("show", `refs/heads/${f.branch()}:${pathOf(A)}`), /refusal-amendment \(W1-T90001, run RUN-A,/);
    assert.equal(criteria(first.body).length, 1, "one criterion for the one file");
    assert.match(criteria(first.body)[0]!, /W1-T90001.*\| grep: refusal-amendment \(W1-T90001 in plan\/tasks\.d\/W1-T90001-fixture\.yaml/);
    assert.equal(f.origin.git("for-each-ref", "refs/heads/refusal-amendment").trim(), "", "no per-task branch is pushed");
  });

  await t.test("W1-T12199 criterion 3: the open pull request takes no push, and the later file waits in the state directory", async () => {
    sealedSha = f.branchSha();
    f.refuse(B, "RUN-B");
    await f.sweep();
    assert.equal(f.branchSha(), sealedSha, "the landing never pushes to a branch whose pull request is open");
    assert.equal(f.gh.creates.length, 1, "no second pull request while the first is open");
    assert.deepEqual(outcomes(f).at(-1), [B, "RUN-B", "waiting"]);
    assert.deepEqual(f.staged(), [`${A}-fixture.yaml`, `${B}-fixture.yaml`]);
  });

  await t.test("W1-T12199 criterion 9: a second amendment for a task whose amendment waits, or is in the open pull request, dedupes", async () => {
    f.refuse(B, "RUN-B2");
    f.refuse(A, "RUN-A2");
    await f.sweep();
    const deduped = f.rows(REFUSAL_AMENDMENT_STEP).filter((r) => r.outcome === "deduped");
    assert.deepEqual(deduped.map((r) => [r.task_id, r.source_run_id, r.pr_url]).sort(), [[A, "RUN-A2", first.url], [B, "RUN-B2", undefined]]);
    assert.deepEqual(f.staged(), [`${A}-fixture.yaml`, `${B}-fixture.yaml`], "no second file is staged");
    assert.equal(f.branchSha(), sealedSha);
    assert.deepEqual(stagedTaskFiles(f.root), [{ relPath: pathOf(A), prUrl: first.url }, { relPath: pathOf(B) }]);
  });

  await t.test("W1-T12199 criterion 5: after the merge, the next pass lands the waiting file with no new refusal from a worker", async () => {
    f.mergeLanding();
    await f.sweep();
    assert.equal(f.gh.creates.length, 2, "the next landing pull request opens");
    const second = f.gh.creates[1]!;
    assert.equal(criteria(second.body).length, 1);
    assert.match(criteria(second.body)[0]!, /W1-T90002/);
    assert.match(f.origin.git("show", `refs/heads/${f.branch()}:${pathOf(B)}`), /refusal-amendment \(W1-T90002, run RUN-B,/);
    assert.deepEqual(f.staged(), [`${B}-fixture.yaml`], "the merged file leaves the queue");
    const opened = f.rows("task_files_landing.opened");
    assert.deepEqual(opened.map((r) => [r.pr_url, r.files]), [[first.url, [pathOf(A)]], [second.url, [pathOf(B)]]]);
  });
});

test("W1-T12199 criterion 4: an unreadable list of open pull requests means wait, and nothing is pushed", async () => {
  const f = fixture();
  f.gh.listingBroken = true;
  f.refuse(A, "RUN-A");
  await f.sweep();
  assert.equal(f.branch(), undefined, "no push: an open pull request may be behind the failed listing");
  assert.equal(f.gh.creates.length, 0);
  assert.deepEqual(outcomes(f), [[A, "RUN-A", "waiting"]]);
  assert.deepEqual(f.staged(), [`${A}-fixture.yaml`]);
  assert.match(String(f.rows("task_files_landing.waiting")[0]!.reason), /cannot be read, so the landing waits/);

  f.gh.listingBroken = false;
  await f.sweep();
  assert.equal(f.gh.creates.length, 1, "the file lands once the listing is readable");
});

test("W1-T12199 criterion 6: a staged edit whose base moved is set aside, not written over main, and the others land", async () => {
  const f = fixture();
  f.gh.listingBroken = true;
  f.refuse(A, "RUN-A");
  f.refuse(B, "RUN-B");
  await f.sweep();
  assert.deepEqual(f.staged(), [`${A}-fixture.yaml`, `${B}-fixture.yaml`]);

  const moved = `${shard(A)}  note: main changed this file while the edit waited\n`;
  f.commitOnMain(pathOf(A), moved);
  f.gh.listingBroken = false;
  await f.sweep();

  const [aside] = f.rows("task_files_landing.set_aside");
  assert.equal(aside!.path, pathOf(A));
  assert.match(String(aside!.reason), /origin\/main changed plan\/tasks\.d\/W1-T90001-fixture\.yaml after this edit was staged/);
  assert.equal(f.rows("task_files_landing.set_aside").length, 1, "one ledger row for the file");
  assert.equal(f.origin.git("show", `refs/heads/${f.branch()}:${pathOf(A)}`), moved.trim(), "the copy on main stands in the landing");
  assert.match(f.origin.git("show", `refs/heads/${f.branch()}:${pathOf(B)}`), /refusal-amendment \(W1-T90002/, "the other file lands");
  assert.equal(criteria(f.gh.creates[0]!.body).length, 1);
  assert.deepEqual(f.staged(), [`${B}-fixture.yaml`]);
  assert.ok(existsSync(join(f.root, "state", "task-files-landing-refused", pathOf(A))), "the file is kept, with its cause, for a person");
});

test("W1-T12199 criterion 7: a file the preflight refuses is set aside once with its cause, and the others land", async () => {
  const f = fixture();

  // Refused when it is staged: nothing waits, and the source run is settled by its own row.
  f.preflight.red.add(C);
  f.refuse(C, "RUN-C");
  await f.sweep();
  assert.deepEqual(f.staged(), []);
  const [refused] = f.rows(REFUSAL_AMENDMENT_STEP);
  assert.deepEqual([refused!.task_id, refused!.outcome, refused!.main_red], [C, "preflight_refused", false]);
  assert.equal(f.gh.creates.length, 0);

  // Refused when the batch is built: main moved, so each file is tested again on the new main.
  f.gh.listingBroken = true;
  f.refuse(A, "RUN-A");
  f.refuse(B, "RUN-B");
  await f.sweep();
  assert.deepEqual(f.staged(), [`${A}-fixture.yaml`, `${B}-fixture.yaml`]);
  const stagedB = readFileSync(join(f.root, "state", "task-files-landing-pending", pathOf(B)), "utf8");
  f.commitOnMain("README.md", "main moved\n");
  f.preflight.red.add(B);
  f.gh.listingBroken = false;
  await f.sweep();

  const aside = f.rows("task_files_landing.set_aside");
  assert.deepEqual(aside.map((r) => r.path), [pathOf(B)], "one ledger row, for the refused file only");
  assert.match(String(aside[0]!.reason), /the plan preflight refused it: \[proof-discrimination\]/);
  assert.equal(f.gh.creates.length, 1, "the other file lands");
  assert.match(criteria(f.gh.creates[0]!.body).join("\n"), /W1-T90001/);
  assert.doesNotMatch(f.gh.creates[0]!.body, /W1-T90002/);
  assert.equal(f.origin.git("show", `refs/heads/${f.branch()}:${pathOf(B)}`), shard(B).trim(), "the refused file is left out of the batch");

  // The same bytes are never staged again.
  f.preflight.red.clear();
  const calls = f.preflight.calls;
  const again = await landTaskFilesAsync(f.checkout.dir, [{ relPath: pathOf(B), content: stagedB, claim: `${B} again`, proof: "grep: . in x" }], { ...f.landingOpts(), stageOnly: true });
  assert.match(again.refused[0]!.reason, /the same bytes were set aside before: the plan preflight refused it/);
  assert.equal(f.preflight.calls, calls, "the refused bytes are not preflighted again");
  assert.deepEqual(f.staged(), [`${A}-fixture.yaml`]);
});

test("W1-T12199 criterion 8: a red that main itself causes sets no file aside; the files wait until main moves", async () => {
  const f = fixture();
  f.gh.listingBroken = true;
  f.refuse(A, "RUN-A");
  await f.sweep();
  f.commitOnMain("README.md", "main moved, and it is red\n");
  f.preflight.mainRed = true;
  f.gh.listingBroken = false;
  await f.sweep();
  assert.deepEqual(f.rows("task_files_landing.set_aside"), [], "main caused the red: no file is set aside");
  assert.deepEqual(f.staged(), [`${A}-fixture.yaml`]);
  assert.equal(f.branch(), undefined);
  assert.match(String(f.rows("task_files_landing.waiting").at(-1)!.reason), /origin\/main is red at [0-9a-f]{40}/);

  f.preflight.mainRed = false;
  f.commitOnMain("README.md", "main moved again, and it is green\n");
  await f.sweep();
  assert.equal(f.gh.creates.length, 1, "the file lands once main is green");
});

test("W1-T12199 criterion 10: the landing refuses a path outside plan/tasks.d and a path origin/main does not hold", async () => {
  const f = fixture();
  const result = await withLiveWritesAllowed(() => landTaskFilesAsync(f.checkout.dir, [
    { relPath: "docs/a-garden-log.md", content: "x\n", claim: "a docs path", proof: "grep: x in docs/a-garden-log.md" },
    { relPath: "plan/tasks.d/W1-T99999-new.yaml", content: shard("W1-T99999"), claim: "a new task", proof: "grep: W1-T99999 in plan/tasks.d/W1-T99999-new.yaml" },
  ], f.landingOpts()));
  assert.match(result.refused[0]!.reason, /is not a task file under plan\/tasks\.d/);
  assert.match(result.refused[1]!.reason, /origin\/main does not hold .* only an edit of a task file that exists/);
  assert.deepEqual([f.staged(), f.branch(), f.gh.creates.length, f.preflight.calls], [[], undefined, 0, 0], "nothing is staged, tested or pushed");
});

test("W1-T12199 criterion 12: the escalation triage accepts an amendment that waits and names the wait in its receipt", () => {
  assert.match(planAmendmentReceipt(A, { outcome: "waiting" }), /W1-T90001 waits for the next landing pull request of task files/);
  assert.match(planAmendmentReceipt(A, { outcome: "drafted", prUrl: "https://github.com/acme/remudero/pull/1" }), /pull\/1 proposes the proof amendment/);
  assert.throws(() => planAmendmentReceipt(A, { outcome: "text_drift" }), /amendment not opened: text_drift/);
  assert.throws(() => planAmendmentReceipt(A, undefined), /amendment not opened: unavailable/);
});
