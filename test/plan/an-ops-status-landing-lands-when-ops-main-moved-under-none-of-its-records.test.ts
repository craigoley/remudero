import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { promisify } from "node:util";
import { landPlanReconcileShardsAsync, type LandContentInput } from "#src/lib/feedback-landing.js";
import { withLiveWritesAllowed } from "#src/lib/live-write-guard.js";
import {
  assertCarriedRecordsUnmoved,
  preflightOnUnmovedRecords,
  type PlanReconcileSourceGit,
} from "#src/lib/plan-reconcile-batch.js";
import { GIT_REPO_FIXTURE_IDENTITY, gitRepo } from "#test/helpers/git-repo.js";

// W1-T14574: the ops status landing builds its candidate on the CURRENT ops main, while the bytes it
// carries for each record were derived from the run's pinned ops commit. A move of ops main matters
// only where it touched a carried record: there, pin-derived bytes would overwrite the newer copy.

const env: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: GIT_REPO_FIXTURE_IDENTITY.name,
  GIT_AUTHOR_EMAIL: GIT_REPO_FIXTURE_IDENTITY.email,
  GIT_COMMITTER_NAME: GIT_REPO_FIXTURE_IDENTITY.name,
  GIT_COMMITTER_EMAIL: GIT_REPO_FIXTURE_IDENTITY.email,
};
const git = (cwd: string, ...args: string[]): string => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env }).trim();
const execFileAsync = promisify(execFile);
const runnerAt = (cwd: string, calls: string[][] = []): PlanReconcileSourceGit => async (args) => {
  calls.push([...args]);
  return (await execFileAsync("git", ["-C", cwd, ...args], { encoding: "utf8", env })).stdout;
};

const CARRIED = "plan/tasks.d/W1-T900201.yaml";
const OTHER = "plan/tasks.d/W1-T900202.yaml";
const FILED = "plan/tasks.d/W1-T900203.yaml";
const record = (id: string, status: string, title = "Reconcile the fixture status"): string =>
  `- id: ${id}\n  title: ${title}\n  status: ${status}\n`;
const MOVED = /ops-status-source-moved/;

/** A pinned ops main (two queued records) on a bare origin, its checkout, and a second clone that advances main. */
function opsCatalog(t: TestContext) {
  const origin = gitRepo({ bare: true, scope: t, kind: "ops-origin" });
  const checkout = gitRepo({ scope: t, kind: "ops-checkout" }).dir;
  mkdirSync(join(checkout, "plan", "tasks.d"), { recursive: true });
  writeFileSync(join(checkout, CARRIED), record("W1-T900201", "queued"));
  writeFileSync(join(checkout, OTHER), record("W1-T900202", "queued"));
  git(checkout, "add", "plan"); git(checkout, "commit", "--quiet", "-m", "test: seed the pinned ops catalog");
  git(checkout, "remote", "add", "origin", origin.dir); git(checkout, "push", "--quiet", "origin", "main");
  const pin = git(checkout, "rev-parse", "HEAD");
  const updater = gitRepo({ cloneFrom: origin.dir, scope: t, kind: "ops-main-advance" }).dir;
  /** Commit `files` on ops main after the pin, the way a filing or an amendment merges there. */
  const advance = (files: Record<string, string>, message: string): string => {
    for (const [path, text] of Object.entries(files)) writeFileSync(join(updater, path), text);
    git(updater, "add", ...Object.keys(files)); git(updater, "commit", "--quiet", "-m", message);
    git(updater, "push", "--quiet", "origin", "main");
    return git(updater, "rev-parse", "HEAD");
  };
  return { origin: origin.dir, checkout, pin, advance };
}

/** The real plan-reconcile landing over `checkout`, carrying CARRIED's pin-derived flip. */
async function landCarried(f: ReturnType<typeof opsCatalog>, guarded: boolean) {
  const inner: string[] = [];
  const inputs: LandContentInput[] = [{ relPath: CARRIED, content: record("W1-T900201", "merged") }];
  const ghAsync = async (args: string[]): Promise<string> => {
    if (args[0] === "pr" && args[1] === "list") return "[]";
    if (args[0] === "pr" && args[1] === "create") return "https://github.com/fixture-private/ops/pull/900201\n";
    throw new Error(`unexpected gh call: ${JSON.stringify(args)}`);
  };
  const green = async (sha: string) => { inner.push(sha); return { ok: true, failures: [], unreadable: [] }; };
  const result = await withLiveWritesAllowed(() => landPlanReconcileShardsAsync(f.checkout, inputs, {
    targetRepository: { owner: "fixture-private", repo: "ops" },
    landingOwner: "measurement-cadence",
    ghAsync,
    planPrPreflight: guarded ? preflightOnUnmovedRecords(runnerAt(f.checkout), f.pin, new Set(inputs.map((input) => input.relPath)), green) : green,
  }));
  const branches = git(f.origin, "for-each-ref", "--format=%(refname:short)", "refs/heads/").split("\n").filter((ref) => ref !== "main" && ref !== "");
  return { result, inner, branches };
}

test("W1-T14574 criterion 1: a parent descended from the pin whose range names none of the carried records is accepted", async (t) => {
  const f = opsCatalog(t);
  await assertCarriedRecordsUnmoved(runnerAt(f.checkout), f.pin, f.pin, [CARRIED]);
  f.advance({ [FILED]: record("W1-T900203", "queued") }, "test: a filing merges on ops main after the pin");
  const parent = f.advance({ [OTHER]: record("W1-T900202", "queued", "An amended title") }, "test: an unrelated record is amended");
  git(f.checkout, "fetch", "--quiet", "origin");
  assert.notEqual(parent, f.pin, "positive control: ops main moved past the pin");
  assert.notEqual(git(f.checkout, "diff", "--name-only", f.pin, parent), "", "positive control: the range changes records");
  const calls: string[][] = [];
  await assertCarriedRecordsUnmoved(runnerAt(f.checkout, calls), f.pin, parent, [CARRIED]);
  assert.ok(calls.some((args) => args[0] === "merge-base"), "the ancestry was actually asked");
  assert.ok(calls.some((args) => args[0] === "diff"), "the range was actually read");

  // End to end through the real landing: it pushes, and the unrelated moves on main stand in its tree.
  const { result, inner, branches } = await landCarried(f, true);
  assert.equal(result.error, undefined, String(result.error));
  assert.equal(result.landed, true);
  assert.equal(inner.length, 1, "the plan PR preflight ran after the source judgement");
  assert.equal(branches.length, 1, "the landing branch was pushed");
  const tip = git(f.origin, "rev-parse", `refs/heads/${branches[0]}`);
  assert.equal(git(f.origin, "rev-parse", `${tip}^`), parent, "the candidate sits on the moved main");
  assert.equal(git(f.origin, "show", `${tip}:${CARRIED}`) + "\n", record("W1-T900201", "merged"));
  assert.equal(git(f.origin, "show", `${tip}:${OTHER}`) + "\n", record("W1-T900202", "queued", "An amended title"), "main's amendment is kept");
  assert.equal(git(f.origin, "show", `${tip}:${FILED}`) + "\n", record("W1-T900203", "queued"), "main's filing is kept");
});

test("W1-T14574 criterion 2: a parent the pin is not an ancestor of, or a range that changes a carried record, still throws ops-status-source-moved", async (t) => {
  const f = opsCatalog(t);
  const sameTreeOrphan = git(f.checkout, "commit-tree", `${f.pin}^{tree}`, "-m", "test: an unrelated history with the pin's own tree");
  assert.equal(git(f.checkout, "diff", "--name-only", f.pin, sameTreeOrphan), "", "positive control: only the ancestry differs");
  await assert.rejects(assertCarriedRecordsUnmoved(runnerAt(f.checkout), f.pin, sameTreeOrphan, [CARRIED]), MOVED);

  const parent = f.advance({ [CARRIED]: record("W1-T900201", "queued", "Amended after the pin") }, "test: the carried record is amended");
  git(f.checkout, "fetch", "--quiet", "origin");
  await assertCarriedRecordsUnmoved(runnerAt(f.checkout), f.pin, parent, [OTHER]);
  await assert.rejects(assertCarriedRecordsUnmoved(runnerAt(f.checkout), f.pin, parent, [OTHER, CARRIED]), MOVED);

  // Fail closed: an unreadable commit, a value that is not a commit id, a failing runner, no named record.
  await assert.rejects(assertCarriedRecordsUnmoved(runnerAt(f.checkout), f.pin, "f".repeat(40), [CARRIED]), MOVED);
  await assert.rejects(assertCarriedRecordsUnmoved(runnerAt(f.checkout), f.pin, "--all", [CARRIED]), MOVED);
  await assert.rejects(assertCarriedRecordsUnmoved(async () => { throw new Error("git is unavailable"); }, f.pin, f.pin, [CARRIED]), MOVED);
  await assert.rejects(assertCarriedRecordsUnmoved(runnerAt(f.checkout), f.pin, f.pin, []), MOVED);

  // The preflight wrapper refuses before its inner check on an unresolvable candidate parent.
  const inner: string[] = [];
  const preflight = preflightOnUnmovedRecords(runnerAt(f.checkout), f.pin, [CARRIED], async (sha: string) => { inner.push(sha); return sha; });
  await assert.rejects(preflight(sameTreeOrphan, undefined), (error: Error) => MOVED.test(error.message)
    && /rev-parse/.test(String((error.cause as Error | undefined)?.message)), "a root-commit candidate has no parent to judge");
  assert.deepEqual(inner, []);
});

test("W1-T14574 criterion 3: a record changed on ops main after the pin is never overwritten with bytes derived from the pin", async (t) => {
  const amended = record("W1-T900201", "queued", "Amended after the pin");
  // Positive control: without the judgement the real landing pushes the pin-derived flip over main's amendment.
  const control = opsCatalog(t);
  control.advance({ [CARRIED]: amended }, "test: the carried record is amended on ops main");
  const unguarded = await landCarried(control, false);
  assert.equal(unguarded.result.landed, true, String(unguarded.result.error));
  assert.equal(unguarded.branches.length, 1);
  assert.equal(git(control.origin, "show", `refs/heads/${unguarded.branches[0]}:${CARRIED}`) + "\n", record("W1-T900201", "merged"),
    "positive control: the landing's candidate carries pin-derived bytes over main's newer copy");

  const f = opsCatalog(t);
  f.advance({ [CARRIED]: amended }, "test: the carried record is amended on ops main");
  const { result, inner, branches } = await landCarried(f, true);
  assert.equal(result.landed, false);
  assert.match(String(result.error), MOVED);
  assert.deepEqual(inner, [], "the candidate was refused before its plan PR preflight");
  assert.deepEqual(branches, [], "nothing was pushed");
  assert.equal(git(f.origin, "show", `main:${CARRIED}`) + "\n", amended, "main's newer copy stands");
});
