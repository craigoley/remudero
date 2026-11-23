/**
 * test/a-required-gate-can-be-demoted-in-silence.test.ts — W1-T3519.
 *
 * THE CENSUS CATCHES A DELETED GATE AND NOT A DEMOTED ONE, and the difference is one line.
 * `test/every-pr-check-is-required-or-advisory.test.ts` refuses a job in NEITHER list, and its own
 * falsifier covers exactly that — a name removed from REQUIRED and not added to ADVISORY. A name
 * MOVED between the two still satisfies "in exactly one list", so it passes.
 *
 * MEASURED 2026-09-13 on the real tree: moving `head-identity-gate` from REQUIRED to ADVISORY in
 * ci-gate.yml — which silently stops a required merge gate from blocking — passed that suite 9/9.
 * A PR can therefore weaken the gate set that governs its own merge. That is the second half of
 * the problem W1-T204 names; the `scripts/*-baseline.json` half is already closed by
 * baseline-monotonic-check.mjs, whose shape this check copies deliberately.
 *
 * THE REMEDY IS SELF-SERVICE, WHICH IS THE POINT. A demotion is legitimate often enough that
 * refusing it outright would stall the queue; what it must not be is SILENT. So a demotion passes
 * on a fresh `GATE_RATIONALE` naming the PR or task that reviewed it — the same escape hatch, with
 * the same staleness rule, the score-floor ratchet already uses. No operator is in the loop unless
 * they choose to be.
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import { parse as parseYaml } from "yaml";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(REPO_ROOT, "scripts", "gate-monotonic-check.mjs");

// `scripts/**` sits OUTSIDE tsconfig's `include`, so a static import is a TS7016 — the same reason
// test/acceptance-author-gate.test.ts reaches its script through a runtime import rather than a
// typed one. A dynamic specifier is not statically resolved, so this loads the REAL module.
type GateLists = { required: Set<string>; rationale: string | undefined };
type Verdict = { ok: boolean; demoted: string[]; status: string; detail: string };
/** What a reference may name: baseline-monotonic-check.mjs's planTasks/knownPrs shape. */
type Known = { has: (ref: string) => boolean; unreadable?: string };
const gate = (await import(pathToFileURL(join(REPO_ROOT, "scripts", "gate-monotonic-check.mjs")).href)) as {
  evaluateGateMonotonic: (base: GateLists, head: GateLists, plan?: Known, prs?: Known) => Verdict;
  readGateLists: (yamlText: string) => GateLists;
  gateRationaleNamesAPr: (r: unknown) => boolean;
  main: (argv: string[]) => number;
  CI_GATE_REL: string;
};

const lists = (required: string[], rationale?: string): GateLists => ({ required: new Set(required), rationale });
/** A fixed set of references that name something real, standing in for a plan or a merged-PR history. */
const known = (...refs: string[]): Known => ({ has: (ref) => refs.includes(ref) });
/** The plan and PRs every pure verdict below is judged against: one filed task and one merged PR. */
const PLAN = known("W1-T3519");
const PRS = known("#5379");

test("W1-T3519: a context that leaves REQUIRED with no rationale is REFUSED", () => {
  const v = gate.evaluateGateMonotonic(lists(["ci", "head-identity-gate"]), lists(["ci"]));
  assert.equal(v.ok, false);
  assert.equal(v.status, "unreviewed");
  assert.deepEqual(v.demoted, ["head-identity-gate"], "the refusal NAMES the gate, never just a count");
  assert.match(v.detail, /GATE_RATIONALE/, "and names the remedy, so the fix is self-service");
});

test("W1-T3519: the destination does not matter — ADVISORY, IGNORE or nowhere read the same", () => {
  // The consequence is identical however it left: it stops blocking the merge. The check compares
  // REQUIRED against REQUIRED for exactly this reason, rather than tracking where a name went.
  const v = gate.evaluateGateMonotonic(lists(["ci", "leak-grep"]), lists(["ci"]));
  assert.deepEqual(v.demoted, ["leak-grep"]);
  assert.equal(v.ok, false);
});

test("W1-T3519: a FRESH rationale naming a PR or task lets a reviewed demotion through", () => {
  const v = gate.evaluateGateMonotonic(
    lists(["ci", "old-gate"], "#1200: earlier, unrelated demotion"),
    lists(["ci"], "#5379: old-gate is superseded by ci-shard"),
    PLAN,
    PRS,
  );
  assert.equal(v.ok, true, "a reviewed demotion is an ordinary outcome, not a defeat — the queue must not stall");
  assert.equal(v.status, "reviewed");
});

test("W1-T3519: a rationale carried over from an EARLIER demotion does not review this one", () => {
  const stale = "#1200: some demotion reviewed long ago";
  const v = gate.evaluateGateMonotonic(lists(["ci", "old-gate"], stale), lists(["ci"], stale), PLAN, known("#1200"));
  assert.equal(v.ok, false);
  assert.equal(v.status, "stale-rationale", "identical to the base's ⇒ it reviewed the base, not this change");
});

test("W1-T3519: a rationale naming no PR or task is not a review", () => {
  for (const bad of ["", "   ", "cleanup", "no longer needed"]) {
    assert.equal(gate.gateRationaleNamesAPr(bad), false, `"${bad}" names nothing to go read`);
  }
  assert.equal(gate.gateRationaleNamesAPr("#5379: superseded"), true);
  assert.equal(gate.gateRationaleNamesAPr("W1-T3519: superseded"), true);
});

test("W1-T3519: ADDING a gate is never a regression and needs no rationale", () => {
  const v = gate.evaluateGateMonotonic(lists(["ci"]), lists(["ci", "gate-monotonic"]));
  assert.equal(v.ok, true);
  assert.deepEqual(v.demoted, [], "this check is one-directional by design — it never taxes hardening");
});

test("W1-T3519: an unreadable ci-gate.yml THROWS rather than reporting a clean gate set", () => {
  // The caller turns this into exit 2. A run that cannot measure must never report OK — the same
  // contract baseline-monotonic-check.mjs states for its own unmeasurable case.
  for (const bad of [
    "",
    "jobs: {}",
    "jobs:\n  ci-gate:\n    env: {}",
    "jobs:\n  ci-gate:\n    env:\n      REQUIRED: 'not json'",
    // Valid JSON, but not an array of strings -- the OTHER half of readGateLists' guard: a
    // REQUIRED that parses cleanly yet is not the shape this check can compare.
    'jobs:\n  ci-gate:\n    env:\n      REQUIRED: \'{"not":"an array"}\'',
    "jobs:\n  ci-gate:\n    env:\n      REQUIRED: '[1, 2, 3]'",
  ]) {
    assert.throws(() => gate.readGateLists(bad), `"${bad.slice(0, 24)}" must not parse as a clean gate set`);
  }
});

test("W1-T3519: the REAL ci-gate.yml parses, and this check's own job is registered", () => {
  const yaml = readFileSync(join(REPO_ROOT, gate.CI_GATE_REL), "utf8");
  const real = gate.readGateLists(yaml);
  assert.ok(real.required.size >= 20, `sanity: expected a populated REQUIRED list, got ${real.required.size}`);
  const doc = parseYaml(yaml) as { jobs: Record<string, { env?: Record<string, string> }> };
  const advisory = new Set(JSON.parse(doc.jobs["ci-gate"]!.env!.ADVISORY!) as string[]);
  assert.ok(
    advisory.has("gate-monotonic") || real.required.has("gate-monotonic"),
    "the census refuses a pull_request job in neither list — this one starts ADVISORY per ci-gate.yml's own rule that a name joins REQUIRED once it is live on main",
  );
});

// ── wiring: the real CLI (`main`), driven as a subprocess against an isolated fixture remote ────
//
// Every pure branch above is exercised as a function call; NONE of that reaches `main()` itself —
// the argv parse, the two `git show`/`readFileSync` reads, and the exit-code translation are all
// process-boundary glue that only a real invocation of the script can drive. This mirrors
// test/baseline-monotonic-against-origin-main.test.ts's own convention for its sibling gate:
// every fixture lives under `mkdtemp`, never in the tracked tree (W1-T2291).

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/** `required`/`rationale` become `origin/main`'s `ci-gate.yml`; the working tree then gets a
 *  second commit (an unpushed local change, exactly like an open PR's branch) carrying
 *  `headRequired`/`headRationale` -- or, when `headRequired` is `undefined`, the file is removed
 *  from the working tree entirely, to drive `main()`'s own "cannot read the head file" arm.
 *  `baseSubject` is the base commit's subject, so a squash subject ending `(#<n>)` puts a merged PR
 *  in `origin/main`'s history; each of `tasks` gets a `plan/tasks.d/<id>-filed.yaml` shard. */
function ciGateFixture(
  required: string[],
  rationale: string | undefined,
  headRequired: string[] | undefined,
  headRationale?: string,
  { baseSubject = "base", tasks = [] }: { baseSubject?: string; tasks?: string[] } = {},
): string {
  const outer = mkdtempSync(join(tmpdir(), "rmd-gate-monotonic-"));
  const remote = join(outer, "origin.git");
  const repo = join(outer, "repo");
  git(outer, "init", "--bare", remote);
  git(outer, "init", "-b", "main", repo);
  git(repo, "config", "user.name", "RMD Gate Monotonic Test");
  git(repo, "config", "user.email", "gate-monotonic@example.invalid");
  mkdirSync(join(repo, ".github", "workflows"), { recursive: true });
  const ciGatePath = join(repo, ".github", "workflows", "ci-gate.yml");
  writeFileSync(ciGatePath, ciGateYaml(required, rationale));
  if (tasks.length > 0) mkdirSync(join(repo, "plan", "tasks.d"), { recursive: true });
  for (const id of tasks) writeFileSync(join(repo, "plan", "tasks.d", `${id}-filed.yaml`), `- id: ${id}\n`);
  git(repo, "add", ".");
  git(repo, "commit", "-m", baseSubject);
  git(repo, "remote", "add", "origin", remote);
  git(repo, "push", "-u", "origin", "main");

  if (headRequired === undefined) {
    rmSync(ciGatePath);
  } else {
    writeFileSync(ciGatePath, ciGateYaml(headRequired, headRationale));
  }
  git(repo, "add", "-A");
  git(repo, "commit", "-m", "open PR: touch ci-gate.yml");
  return repo;
}

function ciGateYaml(required: string[], rationale?: string): string {
  const lines = ["jobs:", "  ci-gate:", "    env:", `      REQUIRED: ${JSON.stringify(JSON.stringify(required))}`];
  if (rationale !== undefined) lines.push(`      GATE_RATIONALE: ${JSON.stringify(rationale)}`);
  return lines.join("\n") + "\n";
}

/** GITHUB_REF is emptied so the PR a CI run is checking never becomes a PR these fixtures' rationales name. */
function run(root: string, extraArgs: string[] = [], githubRef = "") {
  return spawnSync(process.execPath, [SCRIPT, "--repo-root", root, ...extraArgs], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, GITHUB_REF: githubRef },
  });
}

test("main(): a clean tree (no demotion) exits 0 and reports OK", () => {
  const repo = ciGateFixture(["ci"], undefined, ["ci", "gate-monotonic"]);
  const result = run(repo);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /gate-monotonic: OK/);
});

test("main(): a demotion with no rationale exits 1 and names the gate (THE FALSIFIER)", () => {
  const repo = ciGateFixture(["ci", "old-gate"], undefined, ["ci"]);
  const result = run(repo);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /gate-monotonic: REFUSED/);
  assert.match(result.stderr, /old-gate/);
});

test("main(): a reviewed demotion (fresh GATE_RATIONALE) exits 0", () => {
  const repo = ciGateFixture(["ci", "old-gate"], undefined, ["ci"], "#5379: old-gate is superseded by ci-shard");
  const result = run(repo, ["--pr", "5379"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /gate-monotonic: OK/);
});

test("main(): a rationale carried over unchanged from origin/main does not review a fresh demotion", () => {
  const stale = "#1200: some demotion reviewed long ago";
  const repo = ciGateFixture(["ci", "old-gate"], stale, ["ci"], stale);
  const result = run(repo);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /gate-monotonic: REFUSED/);
});

test("main(): an unreadable base ref exits 2 (MEASUREMENT FAILED), never a silent OK", () => {
  const repo = ciGateFixture(["ci"], undefined, ["ci", "gate-monotonic"]);
  const result = run(repo, ["--base-ref", "origin/does-not-exist"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /MEASUREMENT FAILED -- base/);
});

test("main(): a head ci-gate.yml missing from the working tree exits 2, never a silent OK", () => {
  const repo = ciGateFixture(["ci"], undefined, undefined);
  const result = run(repo);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /MEASUREMENT FAILED -- head/);
});

test("main(): an unrecognised CLI argument exits 2, never a silent OK", () => {
  const repo = ciGateFixture(["ci"], undefined, ["ci", "gate-monotonic"]);
  const result = run(repo, ["--bogus"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /MEASUREMENT FAILED -- invalid arguments/);
});

// ── W1-T14304: a reference counts only when it names a real review ─────────────────────────────
//
// Until W1-T14304 a demotion was reviewed by any `#<n>` or `W1-T<n>` SUBSTRING, and stale only when
// its text equalled the base's. REPRODUCED at 8923f5635: `#999999999999999999999999`,
// `W1-T2906bogus` and `#0: nothing` each reviewed a demotion of `head-identity-gate`, and the base
// rationale plus one trailing space read fresh. The check now shares baseline-monotonic-check.mjs's
// reference rule (#20033): a whole word, compared as a number, naming a merged PR, this PR or a
// filed task that the base rationale did not.
//
// INVARIANT a-demotion-names-a-real-review: a REQUIRED context leaves the gate set only under a
// rationale naming a merged PR, this PR or a filed task that the base rationale did not name.

test("W1-T14304 criterion 1: a demotion whose rationale names only a number no PR held, a task with no shard, a zero, or a reference glued to a word is REFUSED", () => {
  const base = lists(["ci", "head-identity-gate"], "#1200: an earlier demotion");
  const refused = [
    "#999999999999999999999999: superseded", // a number no PR held
    "W1-T999999: superseded", // a task with no shard
    "#0: nothing", // a zero
    "W1-T0: nothing",
    "W1-T3519bogus: superseded", // glued to a word, though W1-T3519 is filed
    "x#5379: superseded", // glued to a word, though #5379 merged
    "#5379abc: superseded",
    "W1-T3519_x: superseded",
  ];
  for (const rationale of refused) {
    const v = gate.evaluateGateMonotonic(base, lists(["ci"], rationale), PLAN, PRS);
    assert.equal(v.ok, false, `${JSON.stringify(rationale)} must not review a demotion`);
    assert.deepEqual(v.demoted, ["head-identity-gate"], "the refusal names the gate");
  }
  for (const glued of ["#0: nothing", "W1-T0", "W1-T3519bogus", "x#5379", "#5379abc", "W1-T3519_x"]) {
    assert.equal(gate.gateRationaleNamesAPr(glued), false, `${JSON.stringify(glued)} names no reference at all`);
  }
  // The refusal says why a reference that parses still cannot count.
  assert.match(
    gate.evaluateGateMonotonic(base, lists(["ci"], refused[0]), PLAN, PRS).detail,
    /#999999999999999999999999 cannot count: neither a merged PR in the base's history nor this PR/,
  );
  assert.match(
    gate.evaluateGateMonotonic(base, lists(["ci"], refused[1]), PLAN, PRS).detail,
    /W1-T999999 cannot count: no plan\/tasks\.d shard declares it/,
  );
  // POSITIVE CONTROL: the same references standing as their own words do review it ...
  assert.equal(gate.evaluateGateMonotonic(base, lists(["ci"], "W1-T3519: superseded"), PLAN, PRS).status, "reviewed");
  assert.equal(gate.evaluateGateMonotonic(base, lists(["ci"], "(#5379) superseded"), PLAN, PRS).status, "reviewed");
  // ... and with no plan or PR record given, none does.
  assert.equal(gate.evaluateGateMonotonic(base, lists(["ci"], "#5379: superseded")).ok, false);

  // Through main() on a git fixture whose history holds no PR: exit 1, naming the reference.
  const unheld = ciGateFixture(["ci", "old-gate"], undefined, ["ci"], refused[0]);
  const result = run(unheld);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /gate-monotonic: REFUSED -- .*#999999999999999999999999 cannot count/);
  // A fixture with no plan/tasks.d counts no task, and says why rather than reporting OK.
  const noPlan = ciGateFixture(["ci", "old-gate"], undefined, ["ci"], "W1-T3519: superseded");
  const planless = run(noPlan);
  assert.equal(planless.status, 1, planless.stdout);
  assert.match(planless.stderr, /W1-T3519 cannot count: cannot list plan\/tasks\.d/);
});

test("W1-T14304 criterion 2: a demotion whose rationale names this PR's own number, or a filed task the base rationale did not, exits 0 through main() on a git fixture", () => {
  const ownPr = ciGateFixture(["ci", "old-gate"], "#1200: an earlier demotion", ["ci"], "#5379: old-gate is superseded by ci-shard");
  // This PR's own number, passed with --pr ...
  const viaFlag = run(ownPr, ["--pr", "5379"]);
  assert.equal(viaFlag.status, 0, viaFlag.stderr);
  assert.match(viaFlag.stdout, /gate-monotonic: OK -- .*naming #5379/);
  // ... or read from a pull_request run's GITHUB_REF.
  const viaRef = run(ownPr, [], "refs/pull/5379/merge");
  assert.equal(viaRef.status, 0, viaRef.stderr);
  // POSITIVE CONTROL: with neither, the fixture's history holds no PR, so the same rationale is refused.
  const neither = run(ownPr);
  assert.equal(neither.status, 1, neither.stdout);
  assert.match(neither.stderr, /#5379 cannot count/);

  // A filed task the base rationale did not name.
  const filed = ciGateFixture(["ci", "old-gate"], "W1-T204: the gate set", ["ci"], "W1-T3519: old-gate is superseded", {
    tasks: ["W1-T204", "W1-T3519"],
  });
  const taskRun = run(filed);
  assert.equal(taskRun.status, 0, taskRun.stderr);
  assert.match(taskRun.stdout, /naming W1-T3519/);
  // A PR the base's history records as merged.
  const merged = ciGateFixture(["ci", "old-gate"], undefined, ["ci"], "#4242: old-gate is superseded", {
    baseSubject: "feat(ci): supersede old-gate (#4242)",
  });
  const mergedRun = run(merged);
  assert.equal(mergedRun.status, 0, mergedRun.stderr);

  // In-process, so main()'s own lines are measured: --pr, GITHUB_REF, and a --pr that is no PR number.
  const saved = process.env.GITHUB_REF;
  try {
    process.env.GITHUB_REF = "refs/pull/5379/merge";
    assert.equal(gate.main(["--repo-root", ownPr]), 0);
    process.env.GITHUB_REF = "";
    assert.equal(gate.main(["--repo-root", ownPr, "--pr", "5379"]), 0);
    assert.equal(gate.main(["--repo-root", ownPr]), 1);
    assert.equal(gate.main(["--repo-root", filed]), 0);
    for (const bad of ["0", "-1", "abc", "05379"]) {
      assert.equal(gate.main(["--repo-root", ownPr, "--pr", bad]), 2, `--pr ${bad} cannot measure`);
    }
  } finally {
    if (saved === undefined) delete process.env.GITHUB_REF;
    else process.env.GITHUB_REF = saved;
  }
});

test("W1-T14304 criterion 3: a rationale that pads, re-spells or zero-pads the base rationale's references reads stale-rationale", () => {
  const prior = "#5379: old-gate is superseded by ci-shard (W1-T3519)";
  const base = lists(["ci", "old-gate"], prior);
  for (const rationale of [
    `${prior} `, // padded by one space
    `  ${prior}\n`,
    "W1-T3519 and #5379 superseded old-gate", // re-spelled: the same references, reworded
    "#05379: old-gate is superseded by ci-shard (W1-T03519)", // zero-padded
    "#5379 #5379",
  ]) {
    const v = gate.evaluateGateMonotonic(base, lists(["ci"], rationale), PLAN, PRS);
    assert.equal(v.ok, false, `${JSON.stringify(rationale)} reviews nothing new`);
    assert.equal(v.status, "stale-rationale", JSON.stringify(rationale));
  }
  // POSITIVE CONTROL: one new reference that names something real makes it fresh.
  const fresh = gate.evaluateGateMonotonic(base, lists(["ci"], `${prior}; reviewed again in #7000`), PLAN, known("#5379", "#7000"));
  assert.equal(fresh.status, "reviewed");

  // Through main(): a copy of origin/main's rationale padded by one space exits 1.
  const repo = ciGateFixture(["ci", "old-gate"], prior, ["ci"], `${prior} `, { tasks: ["W1-T3519"] });
  const result = run(repo, ["--pr", "5379"]);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /gate-monotonic: REFUSED -- .*names no PR or task origin\/main's did not/);
});

// Operator ruling 2026-11-22: an automated demotion cannot know its PR's number before the PR exists, so `#this-pr`
// names the PR under check. It is as strong as that PR's own `#<n>`, which already counts, and it is never silent: it
// reviews a demotion only when the rationale names each demoted context and is not origin/main's carried over.
test("W1-T14384 criterion 1: a rationale holding #this-pr reviews a demotion only when it names every demoted context exactly and is not origin/main's rationale carried over", () => {
  const prior = "W1-T4116 gate gardener: scan-pr / osv-scan refused 0 of 115 runs. Reviewed by its own merge: #this-pr.";
  const base = lists(["ci", "quiet-gate", "busy-gate"], prior);
  const reviewed = gate.evaluateGateMonotonic(base, lists(["ci", "busy-gate"], "W1-T4116 gate gardener: quiet-gate refused 0 of 12 runs. #this-pr"));
  assert.equal(reviewed.status, "reviewed", "no plan or PR record is needed: the token names the PR whose merge decides");
  assert.match(reviewed.detail, /#this-pr and each of them/);
  for (const [rationale, gap] of [
    ["W1-T4116 gate gardener: quiet-gate refused 0. #this-pr", /does not name busy-gate/], // one of two demoted unnamed
    ["quiet-gate and busy-gate go. #this-prx", undefined], // the token glued to a word is no token
    ["quiet-gate and busy-gate go. this-pr", undefined], // nor is it without its #
    ["W1-T4116 gate gardener: quiet-gate-old and busy-gate refused 0. #this-pr", /does not name quiet-gate/], // a longer name is not the name
  ] as const) {
    const v = gate.evaluateGateMonotonic(base, lists(["ci"], rationale));
    assert.equal(v.ok, false, JSON.stringify(rationale));
    if (gap) assert.match(v.detail, gap);
  }
  // origin/main's own rationale, carried over or padded with whitespace, reviews nothing new, even for a context it names.
  const carried = lists(["ci", "busy-gate"], prior.replace("scan-pr / osv-scan", "quiet-gate"));
  const named = { ...base, rationale: carried.rationale };
  for (const head of [carried, { ...carried, rationale: `  ${carried.rationale}\n` }]) {
    const v = gate.evaluateGateMonotonic(named, head);
    assert.equal(v.ok, false);
    assert.match(v.detail, /#this-pr cannot review it: the rationale is origin\/main's, carried over/);
  }
});

test("W1-T14384 criterion 2: a #this-pr demotion that names its context exits 0 through main() on a git fixture, and one that misses a part says which part", () => {
  const prior = "W1-T4116 gate gardener: scan-pr / osv-scan refused 0 of 115 runs. Reviewed by its own merge: #this-pr.";
  // The gardener's own shape exits 0 with no --pr and no GITHUB_REF: the token needs no PR record.
  const reviewed = run(ciGateFixture(["ci", "quiet-gate"], prior, ["ci"], "W1-T4116 gate gardener: quiet-gate refused 0 of 12 runs. #this-pr"));
  assert.equal(reviewed.status, 0, reviewed.stderr);
  assert.match(reviewed.stdout, /gate-monotonic: OK -- .*naming #this-pr/);
  // Two contexts leave, and the rationale names one: refused, naming the context it misses.
  const missing = run(ciGateFixture(["ci", "quiet-gate", "busy-gate"], prior, ["ci"], "W1-T4116 gate gardener: quiet-gate refused 0 of 12 runs. #this-pr"));
  assert.equal(missing.status, 1, missing.stdout);
  assert.match(missing.stderr, /gate-monotonic: REFUSED -- /);
  assert.match(missing.stderr, /#this-pr cannot review it: it does not name busy-gate/);
});
