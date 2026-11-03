/**
 * test/a-moving-base-attributes-another-lanes-lines.test.ts — W1-T3060.
 *
 * SEVEN sites in `.github/workflows/ci.yml` diffed against `github.event.pull_request.base.sha` —
 * the base branch's tip AT THE MOMENT THE WEBHOOK FIRED — while `HEAD` in a `pull_request`
 * checkout is the MERGE COMMIT of the PR head into main's CURRENT tip. On a fleet that merges
 * several times an hour those are different points, and every commit that landed in between is
 * inside `HEAD` but outside `BASE_SHA`, so the diff reports it as this PR's own added lines.
 *
 * MEASURED 2026-09-07, four false reds in one afternoon. #4463's entire three-dot diff is two
 * `plan/*.yaml` files, and it was blocked by `diff-coverage` on `src/run-task.ts:18466-18469` —
 * lines byte-identical at its merge base, in a file it does not touch. A plan-only PR cannot add
 * source lines. #4455 was blocked the same way on the same file.
 *
 * THE FIX IS A DIFFERENT POINT, NOT A RETRY. On a `pull_request` event `HEAD` is a merge commit
 * whose FIRST PARENT is the base side, so `HEAD^1` is the exact point the merge was taken from and
 * is correct BY CONSTRUCTION however long the job waited in the queue. Nothing here detects drift
 * and re-runs; the diff is simply taken from the right place the first time.
 *
 * THE FALSIFIER IS A TWO-TREE COMPARISON, NOT AN ASSERTION ABOUT ONE. A test that only checked the
 * fixed form would pass against the unfixed workflow too, so every case below takes the diff BOTH
 * ways over the same fixture and asserts they DIFFER — the stale form seeing the intervening
 * commit is what makes the fixed form's silence meaningful.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse as parseYaml } from "yaml";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { produceCiDependencyEvidence, readCiDependencyEvidence, type CiDependencyProducerContext } from "#scripts/lib/ci-dependency-evidence.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CI_YAML = join(REPO_ROOT, ".github", "workflows", "ci.yml");

/** The REAL classifier the two fast-lane sites hand `changed-files.txt` to — imported, never
 *  restated, so criterion 2 is about the shipped predicate rather than a copy of it. */
const { classify, CLASSES } = (await import(pathToFileURL(join(REPO_ROOT, "scripts", "diff-class.mjs")).href)) as {
  classify: (files: unknown) => { class: string; reason: string };
  CLASSES: { PLAN_ONLY: string; DOCS_ONLY: string; SOURCE: string };
};

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
};

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", env: GIT_ENV });
}

/**
 * THE SHAPE GITHUB ACTUALLY BUILDS. A base commit `b0`; a PR branch off it carrying a PLAN-ONLY
 * change; a SECOND commit `b1` landing on main afterwards and touching `src/run-task.ts`; and the
 * merge commit GitHub checks out for a `pull_request` event, whose FIRST parent is `b1`.
 *
 * `b0` is what the webhook payload's `base.sha` would carry — main's tip when the PR opened.
 */
function fixture(completePlan = false): { dir: string; b0: string; merge: string; root: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1t3060-`)));
  const dir = completePlan ? join(root, "checkout") : root;
  if (completePlan) mkdirSync(dir);
  git(dir, "init", "-q", "-b", "main", ".");
  mkdirSync(join(dir, "src"), { recursive: true });
  mkdirSync(join(dir, "plan", "tasks.d"), { recursive: true });
  writeFileSync(join(dir, "src", "run-task.ts"), "export const a = 1;\n");
  const planRecord = (id: string): string => JSON.stringify([{ id, title: `Producer identity fixture ${id}`,
    repo: "remudero", depends_on: [], type: "implement", verify: "auto", risk: "low", status: "queued", attempts: 0,
    files: ["src/run-task.ts"], acceptance: [{ claim: "The fixture has committed source",
      proof: "grep: export const a in src/run-task.ts" }] }]) + "\n";
  if (completePlan) writeFileSync(join(dir, "plan", "tasks.yaml"), "[]\n");
  writeFileSync(join(dir, "plan", "tasks.d", "W1-T1.yaml"), completePlan ? planRecord("W1-T1") : "- id: W1-T1\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "b0: the base when the PR opened");
  const b0 = git(dir, "rev-parse", "HEAD").trim();

  // The PR: plan-only, branched from b0.
  git(dir, "checkout", "-q", "-b", "pr");
  writeFileSync(join(dir, "plan", "tasks.d", "W1-T2.yaml"), completePlan ? planRecord("W1-T2") : "- id: W1-T2\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "pr: file one shard");

  // ANOTHER LANE lands on main while the PR sits open.
  git(dir, "checkout", "-q", "main");
  writeFileSync(join(dir, "src", "run-task.ts"), "export const a = 1;\nexport const b = 2;\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "b1: another lane's source change");

  // The merge commit a pull_request checkout receives: first parent is the CURRENT base.
  git(dir, "merge", "-q", "--no-ff", "-m", "merge pr into main", "pr");
  return { dir, b0, merge: git(dir, "rev-parse", "HEAD").trim(), root };
}

/** `git diff --name-only <base>...HEAD`, the exact three-dot form every rewritten site uses. */
function changedFiles(dir: string, base: string): string[] {
  return git(dir, "diff", "--name-only", `${base}...HEAD`).trim().split("\n").filter(Boolean);
}

// ── criterion 1: the two points disagree, and only one of them is this PR ──────────────────────

test("W1-T3060 criterion 1: the stale base attributes another lane's commit to this PR; HEAD^1 does not", () => {
  const { dir, b0, merge } = fixture();
  try {
    const stale = changedFiles(dir, b0);
    const fixed = changedFiles(dir, `${merge}^1`);

    // THE DEFECT, REPRODUCED. Without this half the assertion below proves nothing: a test that
    // only checked the fixed form would pass against the unfixed workflow too.
    assert.deepEqual(stale.sort(), ["plan/tasks.d/W1-T2.yaml", "src/run-task.ts"], "the webhook's base sees the intervening commit");
    assert.deepEqual(fixed, ["plan/tasks.d/W1-T2.yaml"], "the merge commit's first parent sees only this PR");
    assert.notDeepEqual(stale.sort(), fixed, "and the two points genuinely disagree on this fixture");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W1-T3060 criterion 1: HEAD^1 is the point the merge was taken from, whatever the queue delay", () => {
  // `HEAD^1` is an ancestor of `HEAD`, so `HEAD^1...HEAD` and `HEAD^1..HEAD` name the same set —
  // the three-dot form is correct by construction here rather than by coincidence, and no later
  // merge onto main can move it.
  const { dir, merge } = fixture();
  try {
    const threeDot = git(dir, "diff", "--name-only", `${merge}^1...HEAD`).trim();
    const twoDot = git(dir, "diff", "--name-only", `${merge}^1..HEAD`).trim();
    assert.equal(threeDot, twoDot, "the first parent is an ancestor, so both forms agree");
    assert.equal(git(dir, "merge-base", `${merge}^1`, "HEAD").trim(), git(dir, "rev-parse", `${merge}^1`).trim());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── criterion 2: the fast lane classifies a plan-only diff as PLAN_ONLY again ──────────────────

test("W1-T3060 criterion 2: a plan-only diff still classifies PLAN_ONLY once unrelated commits land on the base", () => {
  // MISCLASSIFICATION AND MISATTRIBUTION COMPOUND, which is why the block landed at all: with
  // another lane's `src/` file in `changed-files.txt` a genuinely plan-only diff classified as
  // SOURCE, the `CLASS != SOURCE` early exit never fired, and diff-coverage ran on a PR it was
  // designed to skip — then failed it on lines that PR never touched.
  const { dir, b0, merge } = fixture();
  try {
    assert.equal(classify(changedFiles(dir, b0)).class, CLASSES.SOURCE, "the stale list misclassifies — the defect");
    assert.equal(classify(changedFiles(dir, `${merge}^1`)).class, CLASSES.PLAN_ONLY, "the correct list classifies correctly");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── criterion 3: the push path is unchanged ────────────────────────────────────────────────────

test("W1-T3060 criterion 3: every rewritten site is still unreachable on a push", () => {
  // `HEAD^1` does not name a base side on a push, exactly as `base.sha` was empty there, so the
  // push path must keep skipping rather than run wrong. Each job establishes that ONE of two ways
  // and this asserts the disjunction per job rather than assuming which — a job that lost both
  // would slip through a check that only looked for one.
  const raw = readFileSync(CI_YAML, "utf8");
  const doc = parseYaml(raw) as { jobs: Record<string, { if?: string; steps?: Array<{ run?: string; env?: Record<string, string> }> }> };
  const readsParent = (s: { run?: string; env?: Record<string, string> }) => (s.run ?? "").includes("HEAD^1") || (s.env ?? {}).BASE_SHA === "HEAD^1";
  const rewritten = Object.entries(doc.jobs).filter(([, job]) => (job.steps ?? []).some(readsParent));
  // The sanity floor counts STEPS, not jobs: W1-T4399 folded several light gates into one job, so
  // the job count fell while every rewritten site is still here and still checked below.
  const sites = rewritten.reduce((n, [, job]) => n + (job.steps ?? []).filter(readsParent).length, 0);
  assert.ok(sites >= 5, `sanity: the rewritten sites must be findable, got ${sites}`);
  for (const [id, job] of rewritten) {
    const prOnly = job.if === "github.event_name == 'pull_request'";
    const shellGuarded = (job.steps ?? []).some(
      (s) => (s.run ?? "").includes("HEAD^1") && /GITHUB_EVENT_NAME.*pull_request/s.test(s.run ?? ""),
    );
    assert.ok(prOnly || shellGuarded, `job '${id}' must be PR-only or shell-guarded, or a push runs it against a parent that is not a base`);
  }
});

test("W1-T3060 criterion 3: on a non-merge HEAD, HEAD^1 is an ordinary parent — which is why the guards matter", () => {
  // The reason the guards are load-bearing rather than ceremonial, shown rather than asserted
  // about: on a push HEAD^1 resolves to something, and that something is not a base side.
  const { dir } = fixture();
  try {
    git(dir, "checkout", "-q", "main");
    writeFileSync(join(dir, "src", "run-task.ts"), "export const a = 1;\nexport const b = 2;\nexport const c = 3;\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "an ordinary push commit");
    assert.deepEqual(changedFiles(dir, "HEAD^1"), ["src/run-task.ts"], "HEAD^1 names the previous commit, not a PR base");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});


type BaseStep = { id?: string; name?: string; run?: string; env?: Record<string, string> };
const PRODUCER_IDENTITY_WITNESSES = [
  "[[ \"$DEPENDENCY_BASE_SHA\" =~ ^[0-9a-f]{40}$ ]] || exit 1",
  "case \"$GITHUB_EVENT_NAME\" in pull_request|merge_group) ;; *) exit 1 ;; esac",
  "event_dependency_base=\"$(git rev-parse --verify \"${DEPENDENCY_BASE_SHA}^{commit}\")\" || exit 1",
  "dependency_base=\"$event_dependency_base\"",
  "[[ \"$DEPENDENCY_HEAD_SHA\" =~ ^[0-9a-f]{40}$ ]] || exit 1",
  "[[ \"$GITHUB_SHA\" =~ ^[0-9a-f]{40}$ ]] || exit 1",
  "[ \"$GITHUB_BASE_REF\" = \"main\" ] || exit 1",
  "[[ \"$GITHUB_REF\" =~ ^refs/pull/[1-9][0-9]*/merge$ ]] || exit 1",
  "[ \"$(git rev-parse --verify 'HEAD^{commit}')\" = \"$GITHUB_SHA\" ] || exit 1",
  "read -r -a dependency_parents <<< \"$(git rev-list --parents -n 1 HEAD)\"",
  "[ \"${#dependency_parents[@]}\" -eq 3 ] || exit 1",
  "[ \"${dependency_parents[2]}\" = \"$DEPENDENCY_HEAD_SHA\" ] || exit 1",
  "dependency_base=\"$(git rev-parse --verify 'HEAD^1^{commit}')\" || exit 1",
  "git merge-base --is-ancestor \"$event_dependency_base\" \"$dependency_base\" || exit 1",
  "git merge-base --is-ancestor \"$dependency_base\" refs/remotes/origin/main || exit 1",
  "[ \"$(git rev-parse --verify 'HEAD^1^{commit}')\" = \"$dependency_base\" ] || exit 1"
];

function movingBaseWorkflow(): { raw: string; doc: { jobs: Record<string, { steps?: BaseStep[] }> } } {
  const raw = readFileSync(CI_YAML, "utf8");
  return { raw, doc: parseYaml(raw) as { jobs: Record<string, { steps?: BaseStep[] }> } };
}

/** The producer may read exact parent-verified identity metadata, never use it for a diff.
 * Every other step/env still rejects the event payload's moving base. */
function assertNoStaleEventDiffSteps(jobs: Record<string, { steps?: BaseStep[] }>): void {
  for (const [jobId, job] of Object.entries(jobs)) {
    for (const step of job.steps ?? []) {
      const env = { ...step.env };
      if (Object.values(env).some(value => String(value).includes("pull_request.base.sha"))) {
        assert.equal(jobId, "commitlint", "only the protected-base producer reads identity metadata");
        assert.equal(step.id, "dependency-evidence");
        assert.equal(step.name, "Observe merged dependencies with protected-base producer code");
        assert.deepEqual(Object.keys(env).sort(), ["DEPENDENCY_BASE_SHA", "DEPENDENCY_HEAD_SHA", "GH_TOKEN"]);
        assert.equal(env.GH_TOKEN, "${{ github.token }}");
        assert.equal(env.DEPENDENCY_BASE_SHA, "${{ github.event.pull_request.base.sha || github.event.merge_group.base_sha }}");
        assert.equal(env.DEPENDENCY_HEAD_SHA, "${{ github.event.pull_request.head.sha }}");
        const run = step.run ?? "";
        for (const witness of PRODUCER_IDENTITY_WITNESSES) assert.ok(run.includes(witness), `missing producer identity witness: ${witness}`);
        assert.ok(run.includes('[[ "$DEPENDENCY_BASE_SHA" =~ ^[0-9a-f]{40}$ ]]'), "metadata must be a full immutable SHA");
        assert.ok(run.includes('if [ "$GITHUB_EVENT_NAME" = "pull_request" ]; then'), "the parent check must apply to PRs");
        assert.ok(run.includes('[ "$(git rev-parse --verify \'HEAD^1^{commit}\')" = "$dependency_base" ]'), "metadata must equal the checked-out merge's first parent");
        assert.ok(run.includes('git archive "$dependency_base" | tar -x -C "$dependency_runtime"'), "only protected-base code may produce evidence");
        assert.doesNotMatch(run, /\bgit\s+diff\b/, "identity metadata never authorizes a diff from the event base");
        delete env.DEPENDENCY_BASE_SHA;
      }
      assert.ok(!Object.values(env).some(value => String(value).includes("pull_request.base.sha")), "all attribution envs reject the event payload's base");
      assert.ok(!(step.run ?? "").includes("pull_request.base.sha"), "an inline event base cannot bypass the env guard");
    }
  }
}

// ── criterion 4: all seven, not just the two loud ones ─────────────────────────────────────────

test("W1-T3060 criterion 4: no ci.yml step computes a diff from the event payload's base.sha", () => {
  // FIX ALL SEVEN OR THE DEFECT SURVIVES WHERE IT IS HARDEST TO SEE. The two diff-coverage sites
  // produce a loud red; lint-plan, mutation-ratchet, containment-probe and the §8A net-byte arm
  // produce a WIDER measurement that usually still passes, so they degrade silently.
  const { raw, doc } = movingBaseWorkflow();
  const steps = Object.values(doc.jobs).flatMap((j) => j.steps ?? []);
  assertNoStaleEventDiffSteps(doc.jobs);
  assert.doesNotMatch(raw, /git diff[^\n]*BASE_SHA[^\n]*\.\.\.HEAD/, "and none may diff from it");
  // The count is asserted so a site added later cannot quietly reintroduce the stale point while
  // the two assertions above still pass on the six that were fixed.
  const usingFirstParent = steps.filter((s) => (s as BaseStep).id !== "dependency-evidence" && ((s.run ?? "").includes("HEAD^1") || (s.env ?? {}).BASE_SHA === "HEAD^1"));
  assert.ok(usingFirstParent.length >= 6, `every rewritten site must read HEAD^1, found ${usingFirstParent.length}`);
});

test("moving-base fixture admits only parent-verified producer metadata", () => {
  const { doc: { jobs } } = movingBaseWorkflow();
  assertNoStaleEventDiffSteps(jobs);
  const producer = jobs.commitlint!.steps!.find(step => step.id === "dependency-evidence")!;
  assert.ok(producer, "the positive control must see the real producer");
  const changed = (mutate: (step: BaseStep) => void) => {
    const copy = structuredClone(jobs);
    mutate(copy.commitlint!.steps!.find(step => step.id === "dependency-evidence")!);
    return copy;
  };
  for (const invalid of [
    changed(step => { step.id = "other-step"; }),
    changed(step => { step.env!.DEPENDENCY_BASE_SHA = "${{ github.event.pull_request.base.sha }}"; }),
    changed(step => { step.env!.BASE_SHA = step.env!.DEPENDENCY_BASE_SHA!; }),
    changed(step => { step.run = step.run!.replace('[[ "$DEPENDENCY_BASE_SHA" =~ ^[0-9a-f]{40}$ ]]', ':'); }),
    changed(step => { step.run = step.run!.replace('HEAD^1^{commit}', 'HEAD^{commit}'); }),
    changed(step => { step.run = step.run!.replace('git archive "$dependency_base"', 'git archive HEAD'); }),
    changed(step => { step.run += '\ngit diff "$dependency_base"...HEAD\n'; }),
  ]) assert.throws(() => assertNoStaleEventDiffSteps(invalid));
  const elsewhere = structuredClone(jobs);
  elsewhere.ci!.steps!.push(structuredClone(producer));
  assert.throws(() => assertNoStaleEventDiffSteps(elsewhere));
  const inline = structuredClone(jobs);
  inline.ci!.steps!.push({ run: "git diff ${{ github.event.pull_request.base.sha }}...HEAD" });
  assert.throws(() => assertNoStaleEventDiffSteps(inline));
});


/** Execute only the real workflow's identity stage: no npm install, network or credit write. */
function producerIdentityScript(run: string): string {
  const marker = "if bash -euo pipefail <<'PRODUCER'\n";
  const start = run.indexOf(marker) + marker.length;
  const end = run.indexOf("dependency_runtime=", start);
  assert.ok(start >= marker.length && end > start, "the real producer identity stage resolves");
  return run.slice(start, end) + 'printf "%s\\n" "$dependency_base"\n';
}
function producerBase(dir: string, eventBase: string, overrides: Record<string, string> = {}): string {
  const { doc: { jobs } } = movingBaseWorkflow();
  const run = jobs.commitlint!.steps!.find(step => step.id === "dependency-evidence")!.run!;
  return execFileSync("bash", ["-euo", "pipefail", "-c", producerIdentityScript(run)], {
    cwd: dir, encoding: "utf8", env: { ...GIT_ENV,
      GITHUB_EVENT_NAME: "pull_request", GITHUB_BASE_REF: "main", GITHUB_REF: "refs/pull/13008/merge",
      GITHUB_SHA: git(dir, "rev-parse", "HEAD").trim(),
      DEPENDENCY_BASE_SHA: eventBase, DEPENDENCY_HEAD_SHA: git(dir, "rev-parse", "pr").trim(), ...overrides },
    stdio: "pipe",
  }).trim();
}

test("W1-T10390: dependency producer follows a verified advanced merge parent", async () => {
  const { dir, b0, merge, root } = fixture(true);
  try {
    const parent = git(dir, "rev-parse", "HEAD^1").trim();
    assert.notEqual(b0, parent, "the healthy observed population really advanced");
    git(dir, "update-ref", "refs/remotes/origin/main", parent);
    const selected = producerBase(dir, b0);
    assert.equal(selected, parent, "event metadata is ancestry evidence, never the current base");
    // The selected identity reaches the real producer and consumer, beyond a printed shell SHA.
    // These valid operator filings have no dependency closure, so defaults make no network calls.
    const context: CiDependencyProducerContext = { actions: true, repository: "fixture-owner/remudero",
      head: merge, base: selected, producerSha: selected, producerJob: "commitlint", runId: "10390",
      attempt: "1", nowMs: Date.now(), checkout: dir };
    const produced = await produceCiDependencyEvidence(context);
    const sealed = JSON.parse(produced.bytes) as { head: string; base: string; producerSha: string };
    assert.equal(sealed.head, merge);
    assert.equal(sealed.base, parent);
    assert.equal(sealed.producerSha, parent);
    const artifact = join(root, "producer-evidence.json");
    writeFileSync(artifact, produced.bytes, { flag: "wx", mode: 0o400 });
    assert.equal(readCiDependencyEvidence(artifact, { ...context, digest: produced.digest,
      maxAgeMs: 60000, runnerTemp: root }).state, "ready", "the real consumer accepts the sealed actual-parent identity");
    assert.equal(producerBase(dir, parent), parent, "an unchanged protected base remains accepted");
    assert.equal(producerBase(dir, parent, { GITHUB_EVENT_NAME: "merge_group", DEPENDENCY_HEAD_SHA: "", GITHUB_SHA: "" }), parent,
      "the existing merge-group base path is preserved");
    assert.equal(git(dir, "rev-parse", "HEAD").trim(), merge, "identity observation never changes the checkout");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("W1-T10390: dependency producer rejects foreign heads parents and event contexts", () => {
  const { dir, b0, merge } = fixture();
  try {
    const parent = git(dir, "rev-parse", "HEAD^1").trim();
    const pr = git(dir, "rev-parse", "pr").trim();
    git(dir, "update-ref", "refs/remotes/origin/main", parent);
    assert.equal(producerBase(dir, b0), parent, "negative cases start from an accepted real Git corpus");
    for (const overrides of [
      { DEPENDENCY_BASE_SHA: pr }, { DEPENDENCY_BASE_SHA: "0".repeat(40) },
      { DEPENDENCY_BASE_SHA: "" }, { DEPENDENCY_BASE_SHA: b0.slice(1) },
      { DEPENDENCY_HEAD_SHA: b0 }, { DEPENDENCY_HEAD_SHA: "" }, { GITHUB_SHA: pr }, { GITHUB_SHA: "" },
      { GITHUB_REF: "refs/heads/main" }, { GITHUB_REF: "refs/pull/0/merge" },
      { GITHUB_REF: "refs/pull/13008/head" }, { GITHUB_REF: "" },
      { GITHUB_BASE_REF: "develop" }, { GITHUB_BASE_REF: "" },
      { GITHUB_EVENT_NAME: "push" }, { GITHUB_EVENT_NAME: "" },
    ] as Array<Record<string, string>>) assert.throws(() => producerBase(dir, b0, overrides), JSON.stringify(overrides));
    git(dir, "update-ref", "refs/remotes/origin/main", b0);
    assert.throws(() => producerBase(dir, b0), "an unprotected advanced parent cannot supply code");
    git(dir, "update-ref", "-d", "refs/remotes/origin/main");
    assert.throws(() => producerBase(dir, b0), "missing protected-ref evidence is not acceptance");
    git(dir, "update-ref", "refs/remotes/origin/main", parent);
    git(dir, "checkout", "-q", "--detach", pr);
    assert.throws(() => producerBase(dir, b0), "a direct head checkout is not the Actions merge");
    git(dir, "checkout", "-q", "--detach", merge);
    const octopus = git(dir, "commit-tree", "HEAD^{tree}", "-p", parent, "-p", pr, "-p", b0, "-m", "extra parent").trim();
    git(dir, "checkout", "-q", "--detach", octopus);
    assert.throws(() => producerBase(dir, b0), "an extra parent cannot masquerade as the two-parent PR merge");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("W1-T10390: moving-base qualification retains every producer identity witness", () => {
  const { doc: { jobs } } = movingBaseWorkflow();
  assertNoStaleEventDiffSteps(jobs);
  for (const witness of PRODUCER_IDENTITY_WITNESSES) {
    const copy = structuredClone(jobs);
    const step = copy.commitlint!.steps!.find(step => step.id === "dependency-evidence")!;
    assert.ok(step.run!.includes(witness));
    step.run = step.run!.replace(witness, ":");
    assert.throws(() => assertNoStaleEventDiffSteps(copy), `removing ${witness} must be refused`);
  }
  const copy = structuredClone(jobs);
  copy.commitlint!.steps!.find(step => step.id === "dependency-evidence")!.env!.DEPENDENCY_HEAD_SHA = "untrusted";
  assert.throws(() => assertNoStaleEventDiffSteps(copy));
});
