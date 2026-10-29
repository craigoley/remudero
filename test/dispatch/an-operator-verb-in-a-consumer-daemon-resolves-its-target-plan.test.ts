import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import {
  readDaemonTargetRecord,
  resolveVerbPlanRoot,
  writeDaemonTargetRecord,
  type DaemonTargetRecord,
} from "#src/lib/repo-location.js";
import { LIVE_WRITE_OVERRIDE_ENV } from "#src/lib/live-write-guard.js";
import { SELF_SYNC_GUARD_ENV } from "#src/lib/self-sync.js";
import { readLedgerLines } from "#src/lib/status.js";
import { traceCommand } from "#src/lib/report-commands.js";
import { GIT_REPO_FIXTURE_IDENTITY, gitRepo, type GitRepo } from "#test/helpers/git-repo.js";
import { ghShim } from "#test/helpers/gh-shim.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

// W1-T10925: `rmd release PORTAL-T45`, docker-exec'd into a consumer daemon's container, loaded the
// ENGINE checkout's plan (cwd), exited 2 "unknown task" and wrote no `dispatch.breaker_released` row.
// The daemon now records its target at boot; a per-task verb whose cwd plan lacks the id reads the
// target checkout's plan instead. Each case runs the real CLI with cwd inside a fixture ENGINE
// checkout; the fixture config root holds the target checkout and the boot record naming it.

const TARGET_TASK = "PORTAL-T999";
const ENGINE_TASK = "ENGINE-T1";

const planYaml = (id: string, repo: string): string =>
  `- id: ${id}\n  title: "a task"\n  repo: ${repo}\n  depends_on: []\n  type: implement\n  verify: auto\n` +
  `  risk: low\n  status: queued\n  files: [src/x.ts]\n  acceptance:\n    - claim: "it holds"\n      proof: "unit test: it holds"\n`;

/** A git checkout whose committed plan holds `id`. */
function checkout(kind: string, id: string, repo: string): GitRepo {
  const r = gitRepo({ kind });
  mkdirSync(join(r.dir, "plan"), { recursive: true });
  writeFileSync(join(r.dir, "plan", "tasks.yaml"), planYaml(id, repo));
  r.git("add", "plan/tasks.yaml");
  r.git("commit", "--quiet", "-m", `plan ${id}`);
  return r;
}

interface Instance { home: string; root: string; stateDir: string; ledgerPath: string; target: string; engine: GitRepo; enginePlan: string }

/** A fixture HOME whose config root holds `repos/remudero-site` (only its plan names PORTAL-T999), and
 *  an engine checkout (origin craigoley/remudero) whose plan names only ENGINE-T1. */
function instance(t: TestContext): Instance {
  const home = mkdtempSync(join(tmpdir(), "rmd-t10925-"));
  const root = join(home, "Remudero");
  const stateDir = join(root, "state");
  const target = join(root, "repos", "remudero-site");
  mkdirSync(join(home, ".config", "remudero"), { recursive: true });
  mkdirSync(join(target, "plan"), { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(home, ".config", "remudero", "config.json"), JSON.stringify({ claudeBin: "/bin/true", root }));
  writeFileSync(join(target, "plan", "tasks.yaml"), planYaml(TARGET_TASK, "remudero-site"));
  const ledgerPath = join(stateDir, "ledger.ndjson");
  writeFileSync(ledgerPath, JSON.stringify({ step: "dispatch.circuit_broken", task: TARGET_TASK, freshCount: 5 }) + "\n");
  const engine = checkout("t10925-engine", ENGINE_TASK, "remudero");
  engine.addRemote("origin", "https://github.com/craigoley/remudero.git");
  t.after(() => {
    engine.cleanup();
    rmSync(home, { recursive: true, force: true });
  });
  return { home, root, stateDir, ledgerPath, target, engine, enginePlan: join(realpathSync(engine.dir), "plan", "tasks.yaml") };
}

const consumerRecord = (f: Instance): DaemonTargetRecord =>
  ({ owner: "craigoley", repo: "remudero-site", isSelf: false, checkoutRoot: f.target });

interface Run { code: number | null; out: string; err: string; released: Array<Record<string, unknown>> }

/** `rmd <argv>`, the real CLI in a child, cwd = the fixture engine checkout, HOME = the fixture's. */
function rmd(f: Instance, argv: string[]): Run {
  const shim = ghShim([{ when: "", stderr: "t10925 test: unexpected gh call", exit: 1 }], { kind: "t10925-gh" });
  const r = spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"), join(REPO_ROOT, "src", "run-task.ts"), ...argv], {
    cwd: f.engine.dir,
    encoding: "utf8",
    timeout: 180_000,
    env: {
      ...process.env,
      HOME: f.home,
      PATH: `${shim.dir}:${process.env.PATH}`,
      [SELF_SYNC_GUARD_ENV]: "1",
      // The ledger is this fixture's own and gh is the shim: the child's writes are contained.
      [LIVE_WRITE_OVERRIDE_ENV]: "1",
      GIT_AUTHOR_NAME: GIT_REPO_FIXTURE_IDENTITY.name,
      GIT_AUTHOR_EMAIL: GIT_REPO_FIXTURE_IDENTITY.email,
      GIT_COMMITTER_NAME: GIT_REPO_FIXTURE_IDENTITY.name,
      GIT_COMMITTER_EMAIL: GIT_REPO_FIXTURE_IDENTITY.email,
    },
  });
  rmSync(shim.dir, { recursive: true, force: true });
  const released = (readLedgerLines(f.ledgerPath) as Array<Record<string, unknown>>)
    .filter((row) => row.step === "dispatch.breaker_released");
  return { code: r.status, out: r.stdout, err: r.stderr, released };
}

test("W1-T10925: the default plan reader resolves cwd, target and explicit checkout plans", (t) => {
  const f = instance(t);
  const target = consumerRecord(f);
  assert.deepEqual(writeDaemonTargetRecord(f.stateDir, target), { written: true });
  const input = { argv: [], cwdRoot: f.engine.dir, stateDir: () => f.stateDir };

  assert.deepEqual(resolveVerbPlanRoot(ENGINE_TASK, input), { ok: true, root: f.engine.dir, via: "cwd" });
  assert.deepEqual(resolveVerbPlanRoot(TARGET_TASK, input), { ok: true, root: f.target, via: "target", target });
  assert.deepEqual(resolveVerbPlanRoot(TARGET_TASK, { ...input, argv: ["--repo-root", f.target] }),
    { ok: true, root: f.target, via: "repo-root" });

  const searched = [join(f.engine.dir, "plan", "tasks.yaml"), join(f.target, "plan", "tasks.yaml")];
  assert.deepEqual(resolveVerbPlanRoot("PORTAL-T000", input), {
    ok: false,
    searched,
    error: `not found in ${searched.join(", ")}; this instance targets craigoley/remudero-site — read its plan with --repo-root ${f.target}`,
  });
});

test("W1-T10925: a release in a consumer instance resolves the target plan", (t) => {
  const f = instance(t);
  assert.deepEqual(writeDaemonTargetRecord(f.stateDir, consumerRecord(f)), { written: true });

  const r = rmd(f, ["release", TARGET_TASK, "--reason", "site block fixed"]);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.released.length, 1, "exactly one dispatch.breaker_released row");
  assert.equal(r.released[0]!.task_id, TARGET_TASK);
  assert.equal(r.released[0]!.repo, "remudero-site", "the row carries the TARGET plan's repo");

  // `correct` and `trace` share the resolver: the target task is found, and correct asks the TARGET repo.
  const corrected = rmd(f, ["correct", TARGET_TASK, "--pr", "7"]);
  assert.equal(corrected.code, 1, corrected.err);
  assert.match(corrected.err, /could not resolve PR '7' in craigoley\/remudero-site/);
  const traced = rmd(f, ["trace", TARGET_TASK]);
  assert.equal(traced.code, 0, traced.err);
  assert.match(traced.out, new RegExp(`### rmd trace ${TARGET_TASK} \\(reverse`));
});

test("W1-T10925: a self-targeting instance and --repo-root are unchanged", (t) => {
  const f = instance(t);

  // A self-targeting record is never consulted: an id only some other checkout holds is unknown, as before.
  writeDaemonTargetRecord(f.stateDir, { ...consumerRecord(f), repo: "remudero", isSelf: true });
  const self = rmd(f, ["release", TARGET_TASK, "--reason", "x"]);
  assert.equal(self.code, 2);
  assert.ok(self.err.includes(`unknown task '${TARGET_TASK}' (not found in ${f.enginePlan})`), self.err);
  assert.equal(self.released.length, 0);

  // A consumer record never shadows the cwd plan: an id cwd holds resolves from cwd.
  writeDaemonTargetRecord(f.stateDir, consumerRecord(f));
  const cwd = rmd(f, ["release", ENGINE_TASK, "--reason", "engine release"]);
  assert.equal(cwd.code, 0, cwd.err);
  assert.equal(cwd.released.at(-1)!.task_id, ENGINE_TASK);
  assert.equal(cwd.released.at(-1)!.repo, "remudero");

  // An explicit --repo-root wins and is the ONLY plan searched — no fall-through to the target.
  const elsewhere = join(f.root, "elsewhere");
  mkdirSync(join(elsewhere, "plan"), { recursive: true });
  writeFileSync(join(elsewhere, "plan", "tasks.yaml"), planYaml("OTHER-T1", "other"));
  const missed = rmd(f, ["--repo-root", elsewhere, "release", TARGET_TASK, "--reason", "x"]);
  assert.equal(missed.code, 2);
  assert.ok(missed.err.includes(`not found in ${join(elsewhere, "plan", "tasks.yaml")};`), missed.err);
  assert.ok(!missed.err.includes(f.enginePlan), "the cwd plan is not searched under --repo-root");
  assert.equal(missed.released.length, 1, "nothing new was written");
  const explicit = rmd(f, ["--repo-root", f.target, "release", TARGET_TASK, "--reason", "explicit"]);
  assert.equal(explicit.code, 0, explicit.err);
  assert.equal(explicit.released.at(-1)!.task_id, TARGET_TASK);
});

test("W1-T10925: a miss names every plan searched and the repo-root to use", (t) => {
  const f = instance(t);
  const targetPlan = join(f.target, "plan", "tasks.yaml");

  // With a consumer record: both plans, and the target's --repo-root.
  writeDaemonTargetRecord(f.stateDir, consumerRecord(f));
  const r = rmd(f, ["release", "PORTAL-T000", "--reason", "x"]);
  assert.equal(r.code, 2);
  assert.ok(r.err.includes(`not found in ${f.enginePlan}, ${targetPlan}`), r.err);
  assert.ok(r.err.includes(`targets craigoley/remudero-site — read its plan with --repo-root ${f.target}`), r.err);
  assert.equal(r.released.length, 0);

  // A PR-body preflight resolves the same trailer. It may use the body's criteria, but must
  // expose the resolver miss so the operator can point it at the intended checkout.
  const bodyPath = join(f.home, "unknown-task-body.md");
  writeFileSync(bodyPath,
    "## Acceptance\n\n- claim: body fallback\n  proof: unit test: body fallback\n\nRemudero-Task: PORTAL-T000\n");
  const checked = rmd(f, ["check-acceptance", bodyPath]);
  assert.equal(checked.code, 0, checked.err);
  assert.ok(checked.err.includes(`unknown task 'PORTAL-T000' (not found in ${f.enginePlan}, ${targetPlan}`), checked.err);
  assert.ok(checked.err.includes(`read its plan with --repo-root ${f.target}`), checked.err);
  assert.match(checked.out, /criteria source:\s+the body Acceptance: block/);

  const feedbackId = "operator-note";
  mkdirSync(join(f.engine.dir, "plan", "feedback"), { recursive: true });
  writeFileSync(join(f.engine.dir, "plan", "feedback", `${feedbackId}.yaml`),
    `id: ${feedbackId}\nstatus: new\nraw: operator note\nts: ${new Date().toISOString()}\n`);
  const feedback = rmd(f, ["trace", feedbackId]);
  assert.equal(feedback.code, 0, feedback.err);
  assert.ok(feedback.out.includes(`### rmd trace ${feedbackId} (forward`), feedback.out);

  // A resolver miss must survive the feedback fallback's cwd-plan read, including unreadable paths.
  rmSync(f.enginePlan);
  for (const condition of ["missing", "unreadable"]) {
    if (condition === "unreadable") mkdirSync(f.enginePlan);
    const traced = rmd(f, ["trace", "PORTAL-T000"]);
    assert.equal(traced.code, 2, traced.err);
    assert.ok(traced.err.includes(`rmd trace: 'PORTAL-T000' (not found in ${f.enginePlan} (unreadable:`), traced.err);
    assert.ok(traced.err.includes(`, ${targetPlan}; this instance targets craigoley/remudero-site`), traced.err);
    assert.ok(traced.err.includes(`read its plan with --repo-root ${f.target}`), traced.err);
    assert.equal(traced.released.length, 0);
  }
  rmSync(f.enginePlan, { recursive: true });
  writeFileSync(f.enginePlan, planYaml(ENGINE_TASK, "remudero"));

  // No record, two consumer checkouts that both hold the id: refuse — never guess from repos/.
  rmSync(join(f.stateDir, "daemon-target.json"));
  const other = join(f.root, "repos", "remudero-docs");
  mkdirSync(join(other, "plan"), { recursive: true });
  writeFileSync(join(other, "plan", "tasks.yaml"), planYaml(TARGET_TASK, "remudero-docs"));
  const guess = rmd(f, ["release", TARGET_TASK, "--reason", "x"]);
  assert.equal(guess.code, 2);
  assert.ok(guess.err.includes(`not found in ${f.enginePlan})`), guess.err);
  assert.ok(!guess.err.includes("--repo-root"), "no record names a target, so no --repo-root is offered");
  assert.equal(guess.released.length, 0);

  // A malformed record is "no target" with its reason; a record naming a missing checkout names it unreadable.
  const onlyTarget = (id: string) => resolveVerbPlanRoot(id, { argv: [], cwdRoot: f.engine.dir, stateDir: () => f.stateDir });
  writeFileSync(join(f.stateDir, "daemon-target.json"), "{not json");
  const bad = onlyTarget(TARGET_TASK);
  assert.match(bad.ok ? "" : bad.error, /; no instance target \(record unreadable: \S*daemon-target\.json: /);
  writeFileSync(join(f.stateDir, "daemon-target.json"), JSON.stringify({ owner: "craigoley", repo: "x" }));
  assert.match(String((readDaemonTargetRecord(f.stateDir) as { reason?: string }).reason), /not an \{owner, repo, isSelf, checkoutRoot\} record/);
  rmSync(join(f.stateDir, "daemon-target.json"));
  mkdirSync(join(f.stateDir, "daemon-target.json"));
  assert.equal(readDaemonTargetRecord(f.stateDir).kind, "unreadable", "a record path that cannot be read is unreadable");
  rmSync(join(f.stateDir, "daemon-target.json"), { recursive: true });
  writeDaemonTargetRecord(f.stateDir, { ...consumerRecord(f), checkoutRoot: join(f.root, "repos", "gone") });
  const gone = onlyTarget(TARGET_TASK);
  assert.ok(!gone.ok && gone.searched[1]!.startsWith(`${join(f.root, "repos", "gone", "plan", "tasks.yaml")} (unreadable: `), JSON.stringify(gone));

  // An instance config that cannot be read is named, never guessed past; a record that cannot be written says why.
  const noConfig = resolveVerbPlanRoot(TARGET_TASK, { argv: [], cwdRoot: f.target, stateDir: () => { throw new Error("bad config"); },
    holds: () => false });
  assert.equal(noConfig.ok ? undefined : noConfig.error.endsWith("(record unreadable: instance config: bad config)"), true);
  const blocked = writeDaemonTargetRecord(join(f.ledgerPath, "nested"), consumerRecord(f));
  assert.equal(blocked.written, false);
});

test("W1-T10925: trace refuses an unknown task and feedback id with the searched plans", async (t) => {
  const f = instance(t);
  writeDaemonTargetRecord(f.stateDir, consumerRecord(f));
  const id = "PORTAL-T000";
  const enginePlan = join(f.engine.dir, "plan", "tasks.yaml");
  const targetPlan = join(f.target, "plan", "tasks.yaml");
  const errors: string[] = [];
  const oldHome = process.env.HOME;
  const oldError = console.error;
  process.env.HOME = f.home;
  console.error = (message: string) => errors.push(message);
  try {
    const context = { repoRoot: f.engine.dir, resolveOwnerRepo: () => ({ owner: "craigoley", repo: "remudero" }) };
    const resolved = await traceCommand([id], {
      ...context,
      resolveTaskPlan: (taskId) => resolveVerbPlanRoot(taskId, {
        argv: [], cwdRoot: f.engine.dir, stateDir: () => f.stateDir,
      }),
    });
    assert.equal(resolved, 2);
    assert.deepEqual(errors, [
      `rmd trace: '${id}' is neither a known task id (not found in ${enginePlan}, ${targetPlan}; ` +
      `this instance targets craigoley/remudero-site — read its plan with --repo-root ${f.target}) ` +
      `nor a feedback entry (plan/feedback/${id}.yaml)`,
    ]);

    errors.length = 0;
    const direct = await traceCommand([id], context);
    assert.equal(direct, 2);
    assert.deepEqual(errors, [
      `rmd trace: '${id}' is neither a known task id (${enginePlan}) nor a feedback entry (plan/feedback/${id}.yaml)`,
    ]);

    rmSync(enginePlan);
    await assert.rejects(traceCommand([id], context), /ENOENT/);
    await assert.rejects(traceCommand([id], {
      ...context, resolveTaskPlan: () => ({ ok: true, root: f.engine.dir }),
    }), /ENOENT/);
  } finally {
    console.error = oldError;
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
  }
});

test("W1-T10925: a consumer claim reserves on the target repo", (t) => {
  const f = instance(t);
  // Both checkouts get a real local origin: the engine's main does not plan PORTAL-T999, the target's does.
  const engineOrigin = gitRepo({ bare: true, kind: "t10925-engine-origin" });
  const targetOrigin = gitRepo({ bare: true, kind: "t10925-target-origin" });
  const target = checkout("t10925-target", TARGET_TASK, "remudero-site");
  t.after(() => {
    engineOrigin.cleanup();
    targetOrigin.cleanup();
    target.cleanup();
  });
  f.engine.git("remote", "set-url", "origin", engineOrigin.dir);
  f.engine.git("push", "--quiet", "origin", "main");
  target.addRemote("origin", targetOrigin.dir);
  target.git("push", "--quiet", "origin", "main");
  writeDaemonTargetRecord(f.stateDir, { ...consumerRecord(f), checkoutRoot: target.dir });

  const r = rmd(f, ["claim", TARGET_TASK]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /claimed refs\/rmd-dispatch\/PORTAL-T999/);
  const held = (origin: GitRepo) =>
    execFileSync("git", ["-C", origin.dir, "for-each-ref", "--format=%(objectname)", "refs/rmd-dispatch/PORTAL-T999"], { encoding: "utf8" }).trim();
  assert.match(held(targetOrigin), /^[0-9a-f]{40}$/, "the claim ref exists on the TARGET repo's origin");
  assert.equal(held(engineOrigin), "", "and not on the engine's origin");
});
