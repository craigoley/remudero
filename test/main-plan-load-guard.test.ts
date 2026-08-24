import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { parse as parseYaml } from "yaml";

import { loadPlan, loadPlanAtRef, type FileIntegrityIO } from "../src/lib/plan.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const GUARD_PATH = join(REPO_ROOT, ".github", "workflows", "main-plan-guard.yml");

// ── W1-T491: the guard that asks whether `main`'s plan still loads ────────────────────────────
//
// Two same-base PRs can each be correctly green and still produce a `main` on which `loadPlan`
// refuses. Every other gate is `pull_request`-triggered, so nothing on `main` notices. These
// tests hold up the three properties that make the guard trustworthy rather than decorative:
// it FIRES on the two ways a plan actually goes unloadable, it stays GREEN on a healthy plan
// (asserted against the REAL tree, not only a fixture — a tripwire that is always red is a
// tripwire nobody reads), and it is wired to run on every push to `main` without a path filter
// or a test-suite run.

/** A minimal well-formed task entry — the smallest shape `loadPlanFromYaml` accepts. */
const task = (id: string, dependsOn: string[] = []): string =>
  [
    `- id: ${id}`,
    `  title: ${id.toLowerCase()}`,
    "  repo: remudero",
    "  type: implement",
    `  depends_on: [${dependsOn.join(", ")}]`,
    "  status: queued",
  ].join("\n");

/** Write a plan tree (monolith + optional shards) into a fresh temp dir; return the tasks.yaml. */
function planTree(monolith: string, shards: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "rmd-main-plan-guard-"));
  const monolithPath = join(dir, "tasks.yaml");
  writeFileSync(monolithPath, monolith + "\n");
  const shardNames = Object.keys(shards);
  if (shardNames.length > 0) {
    mkdirSync(join(dir, "tasks.d"), { recursive: true });
    for (const name of shardNames) {
      writeFileSync(join(dir, "tasks.d", name), shards[name] + "\n");
    }
  }
  return monolithPath;
}

/** The guard workflow, parsed. */
function guardWorkflow(): Record<string, unknown> {
  return parseYaml(readFileSync(GUARD_PATH, "utf8")) as Record<string, unknown>;
}

/** Every `run:` script in the guard, concatenated — what the job actually executes. */
function guardRunScripts(): string {
  const wf = guardWorkflow() as { jobs?: Record<string, { steps?: Array<{ run?: string }> }> };
  const steps = Object.values(wf.jobs ?? {}).flatMap((j) => j.steps ?? []);
  return steps.map((s) => s.run ?? "").join("\n");
}

// FAILURE MODE 1 — the class that broke main twice: two differently-NAMED files, one id.
test("main-plan-load-guard: a duplicate task id across a shard and the monolith makes loadPlan refuse", () => {
  const planPath = planTree(task("W1-T1"), { "collides.yaml": task("W1-T1") });
  assert.throws(
    () => loadPlan(planPath),
    /duplicate task id/,
    "a shard re-declaring a monolith id must refuse to load — this is the exact pairing that took main down",
  );
});

// FAILURE MODE 2 — same run catches it, per loadPlanFromYaml's dependency resolution.
test("main-plan-load-guard: a depends_on naming a task outside the blob makes loadPlan refuse", () => {
  const planPath = planTree([task("W1-T1"), task("W1-T2", ["W1-T404"])].join("\n"));
  assert.throws(
    () => loadPlan(planPath),
    /depends_on unknown task/,
    "a dependency naming a task no shard supplies must refuse to load",
  );
});

// THE HEALTHY CASE, DRIVEN AGAINST THE REAL TREE — without this the guard is a tripwire nobody
// can trust, and a permanently-red check on main teaches the operator to ignore it.
test("main-plan-load-guard: the live plan in this repo loads cleanly so the guard is a detector and not a permanent red", () => {
  const plan = loadPlan(join(REPO_ROOT, "plan", "tasks.yaml"));
  assert.ok(
    plan.tasks.length > 0,
    "the real plan must load and yield tasks — the guard's green state has to be reachable",
  );
});

// WIRING — a guard that does not run, or that a path filter can silence, is not a guard.
test("main-plan-load-guard: the guard runs on push to main and declares no path filter", () => {
  const wf = guardWorkflow() as {
    on?: { push?: { branches?: string[]; paths?: string[]; "paths-ignore"?: string[] } };
  };
  // `on:` is YAML 1.1-truthy in some parsers; assert against whichever key carries the triggers.
  const on = (wf.on ?? (wf as Record<string, unknown>)[true as unknown as string]) as {
    push?: { branches?: string[]; paths?: string[]; "paths-ignore"?: string[] };
  };
  assert.deepEqual(on.push?.branches, ["main"], "the guard must trigger on push to main");
  assert.equal(on.push?.paths, undefined, "no paths filter — a filtered check can go silently absent");
  assert.equal(on.push?.["paths-ignore"], undefined, "no paths-ignore filter, for the same reason");
});

// COST — the whole argument for a dedicated workflow is that it does NOT buy a suite run per merge.
test("main-plan-load-guard: the guard loads the plan without running the PR test suite", () => {
  const scripts = guardRunScripts();
  assert.match(scripts, /loadPlan\(/, "the guard must actually load the plan");
  assert.doesNotMatch(scripts, /node --test|npm test|experimental-test-coverage/, "no suite run per merge");
  // `lint-plan` exits 1 on ordinary violations (main carries many), so gating on it would be
  // permanently red and would not discriminate an unloadable plan.
  assert.doesNotMatch(scripts, /lint-plan/, "the guard must not gate on lint-plan's exit code");
});

// ── W1-T2220: a torn read of a plan shard must not become a trusted, silently-defaulted record ─
//
// `loadPlan` reads the working tree, which a concurrent `git checkout --detach` truncates IN
// PLACE — a torn read raises no error at all, so it slips past the existing ENOENT-only guard
// and parses as a valid record with its late fields defaulted. Below: (1) a short/torn read is
// refused rather than parsed (remedy (a): stat/read/stat, the general fix every `loadPlan`
// caller gets for free); (2) that fix does not disturb the existing "vanished shard" skip or
// widen it into a catch-all; (3)+(5) `loadPlanAtRef` (remedy (c), the write gate's stronger
// "cannot be partial" guarantee) is immune to working-tree corruption entirely because it never
// reads the working tree, and its one real cost — an uncommitted edit is invisible — is stated
// and exercised, never silent; (4) a quiet tree loads byte-for-byte as it always did.

/** A fake {@link FileIntegrityIO} whose stat/read calls are scripted per-call, so a torn-read
 *  race (writer truncates mid-read) is reproducible without an 80-cycle live `git checkout` rig. */
function scriptedIntegrityIO(sizes: number[], text: string): FileIntegrityIO {
  let call = 0;
  return {
    statSize: () => {
      const size = sizes[Math.min(call, sizes.length - 1)];
      return size;
    },
    readFile: () => {
      call += 1;
      return text;
    },
  };
}

// (1) SHORT READ IS REFUSED, NOT PARSED — the fake reports a persistent stat/read/stat size
// disagreement (the file is still being truncate-written on every attempt), and the text handed
// back is itself a VALID, PARSEABLE single-task blob — proving the refusal comes from the
// integrity check, not a YAML syntax failure a torn cut happened to also cause.
test("main-plan-load-guard: a plan file read short is refused rather than parsed into a record with defaulted fields", () => {
  const planPath = planTree(task("W1-T1"));
  // sizes: stat-before=500 (the whole file), read=120 bytes (only a prefix), stat-after=120 —
  // the writer finished truncating between the two stats, so read and stat-after agree with each
  // other but NOT with stat-before: still a torn read, every attempt, by construction.
  const io = scriptedIntegrityIO([500, 120, 120], task("W1-T1"));
  assert.throws(
    () => loadPlan(planPath, io),
    /short\/torn read|cannot read plan file/,
    "a persistent size disagreement across every retry must refuse the file, never hand a partial read to the parser",
  );
});

// (2) THE ENOENT SKIP IS UNCHANGED, AND EVERY OTHER ERRNO STILL THROWS — regression-guards that
// wiring the new integrity check through readWholeFile did not touch this guard's own contract.
test("main-plan-load-guard: a shard that vanished between listing and reading is still skipped, and every other errno still throws", () => {
  const goodShard = "kept.yaml";
  const vanishedShard = "vanished.yaml";
  const brokenShard = "broken.yaml";
  const planPath = planTree(task("W1-T1"), {
    [goodShard]: task("W1-T2"),
    [vanishedShard]: task("W1-T3"),
    [brokenShard]: task("W1-T4"),
  });

  // Case A: ENOENT (the file listed by readdirSync but gone by the time it's read) is skipped —
  // the plan still loads, missing only the vanished shard's task.
  const enoentIO: FileIntegrityIO = {
    statSize: (p) => {
      if (p.endsWith(vanishedShard)) {
        const err = new Error("ENOENT: no such file or directory") as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      }
      return statSync(p).size;
    },
    readFile: (p) => readFileSync(p, "utf8"),
  };
  const plan = loadPlan(planPath, enoentIO);
  const ids = plan.tasks.map((t) => t.id).sort();
  assert.deepEqual(ids, ["W1-T1", "W1-T2", "W1-T4"], "the vanished shard is skipped silently, every other task still loads");

  // Case B: a non-ENOENT errno (EACCES: the shard is there and unreadable) still throws — this
  // is exactly the corruption the guard's own comment says it must never hide.
  const eaccesIO: FileIntegrityIO = {
    statSize: (p) => {
      if (p.endsWith(brokenShard)) {
        const err = new Error("EACCES: permission denied") as NodeJS.ErrnoException;
        err.code = "EACCES";
        throw err;
      }
      return statSync(p).size;
    },
    readFile: (p) => readFileSync(p, "utf8"),
  };
  assert.throws(
    () => loadPlan(planPath, eaccesIO),
    /cannot read plan shard/,
    "EACCES (or any non-ENOENT errno) must still throw, never be treated as a benign vanish",
  );
});

// (4) A QUIET TREE STILL LOADS BYTE-FOR-BYTE — the default IO path (real fs, no injection),
// same shape as the pre-existing FAILURE MODE tests above, proves the new stat/read/stat wiring
// is a no-op on the common case.
test("main-plan-load-guard: a complete plan on a quiet tree loads byte-for-byte as it does today", () => {
  const planPath = planTree(task("W1-T1"), { "shard.yaml": task("W1-T2") });
  const plan = loadPlan(planPath);
  assert.deepEqual(
    plan.tasks.map((t) => t.id).sort(),
    ["W1-T1", "W1-T2"],
    "an untouched plan tree loads exactly the tasks it declares, same as before this change",
  );
});

/** A real git repo with a committed plan/tasks.yaml (+ optional plan/tasks.d/ shards) — the
 *  fixture {@link loadPlanAtRef}'s tests need, since it reads git objects, never the working
 *  tree, and there is no `git show <ref>:<path>` without a real `.git`. */
function gitPlanRepo(monolith: string, shards: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "rmd-torn-read-git-"));
  const run = (args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  run(["init", "--quiet", "-b", "main"]);
  run(["config", "user.email", "test@example.invalid"]);
  run(["config", "user.name", "Test"]);
  mkdirSync(join(dir, "plan"), { recursive: true });
  writeFileSync(join(dir, "plan", "tasks.yaml"), monolith + "\n");
  const shardNames = Object.keys(shards);
  if (shardNames.length > 0) {
    mkdirSync(join(dir, "plan", "tasks.d"), { recursive: true });
    for (const name of shardNames) writeFileSync(join(dir, "plan", "tasks.d", name), shards[name] + "\n");
  }
  run(["add", "-A"]);
  run(["commit", "--quiet", "-m", "plan"]);
  return dir;
}

// (3) THE WRITE-GATE READ CANNOT HAVE BEEN PARTIAL — corrupt the WORKING TREE copy of the
// monolith outright (simulating a checkout caught mid truncate-in-place) and assert
// `loadPlanAtRef` is completely unaffected: it never opens that file, so there is no torn window
// to hit at all, not merely a smaller one.
test("main-plan-load-guard: the write-scoped approve gate reads a plan that cannot have been partial", () => {
  const dir = gitPlanRepo(task("W1-T1"), { "shard.yaml": task("W1-T2") });
  // Corrupt the working-tree monolith AFTER the commit — a real torn read would leave something
  // exactly like this: a truncated prefix, still on disk, never re-committed.
  writeFileSync(join(dir, "plan", "tasks.yaml"), "- id: W1-T1\n  titl");

  const plan = loadPlanAtRef(dir, "plan/tasks.yaml");
  assert.deepEqual(
    plan.tasks.map((t) => t.id).sort(),
    ["W1-T1", "W1-T2"],
    "loadPlanAtRef reads the committed blob, so a corrupted/truncated working-tree file changes nothing",
  );
});

// (5) AN UNCOMMITTED EDIT'S INVISIBILITY IS STATED, NEVER SILENT — this test IS that statement:
// it pins the one real behavior difference loadPlanAtRef's own doc names as its cost.
test("main-plan-load-guard: an uncommitted working-tree edit is either still visible or its invisibility is stated, never silent", () => {
  const dir = gitPlanRepo(task("W1-T1"));
  // An uncommitted edit to the working tree — never `git add`ed, never committed.
  writeFileSync(join(dir, "plan", "tasks.yaml"), [task("W1-T1"), task("W1-T2")].join("\n") + "\n");

  const plan = loadPlanAtRef(dir, "plan/tasks.yaml");
  assert.deepEqual(
    plan.tasks.map((t) => t.id),
    ["W1-T1"],
    "an uncommitted addition must be invisible to loadPlanAtRef — it reads the last COMMIT, documented as this function's named cost",
  );
});
