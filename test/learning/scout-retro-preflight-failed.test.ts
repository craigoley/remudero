// W1-T10144 — retro.preflight_failed recurred because the retro ran every plan-reading suite.
//
// ci.yml narrows its plan-reading lane to the suites that read the PR's changed paths
// (W1-T5698, `--list-plan-reading-suites --changed-files`). The retro preflight kept the broad
// listing, so a retro whose diff is MASTER-PLAN.md + docs/ORIENTATION.md ran ~696 suites against a
// 60-minute backstop where CI runs ~235 for the same PR, and every retro since 10-14 hit the bound
// or a suite CI never runs for it. These tests pin the CI-parity selection, its fail-closed
// fallbacks, the real changed-path reader, and the stand-down reason derived from its evidence.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  retroBranchChangedFiles,
  runRetroPrepublishPreflight,
  type RetroChangedFiles,
  type RetroPrepublishRunner,
} from "#src/lib/retro-preflight.js";
import { gitRepo } from "#test/helpers/git-repo.js";

const provenance = { provider: "claude" as const, model: "architect", servedModel: null, effort: "high", sessionId: "retro-10144" };
const ok = (stdout = "", stderr = "") => ({ status: 0, signal: null, stdout, stderr });

interface Row { step: string; extra: Record<string, unknown> }

/** A fake runner that answers like the worktree's own diff-class and records each call, the
 *  changed-path list as diff-class read it, and whether that list still existed afterwards. */
function recordingRunner(diffClass: string, testResult = ok("# tests 1\n# pass 1\n")) {
  const calls: string[][] = [];
  const listed: string[] = [];
  const run: RetroPrepublishRunner = (_command, args) => {
    calls.push(args);
    const at = args.indexOf("--changed-files");
    if (at >= 0) listed.push(readFileSync(args[at + 1]!, "utf8"));
    if (args.includes("--list-plan-reading-suites")) {
      return at >= 0
        ? ok("test/reads-master-plan.test.ts\n", "diff-class: plan-reading selected_count=1 previous_count=3\n")
        : ok("test/reads-master-plan.test.ts\ntest/b.test.ts\ntest/c.test.ts\n", "diff-class: plan-reading selected_count=3 previous_count=3\n");
    }
    if (args.includes("scripts/diff-class.mjs")) return ok(`${diffClass}\n`);
    return testResult;
  };
  return { run, calls, listed };
}

async function preflight(run: RetroPrepublishRunner, changed: RetroChangedFiles, extra: { tmpRoot?: string } = {}) {
  const rows: Row[] = [];
  const slotRoot = mkdtempSync(join(tmpdir(), "rmd-test-retro-10144-slot-"));
  const result = await runRetroPrepublishPreflight({
    worktreePath: "/tmp/retro-10144-worktree",
    provenance,
    remotePrExisted: false,
    repair: async () => {},
    regenerateHarnessArtifacts: () => {},
    log: (step, row) => rows.push({ step, extra: row }),
    deps: {
      run,
      changedFiles: async () => changed,
      ...extra,
      testSlot: { dir: join(slotRoot, "slots"), slots: 1, load: () => ({ cores: 8, load1: 0 }),
        memoryHeadroom: () => undefined, binaryExists: () => false, log: () => {} },
    },
  });
  return { result, rows };
}

test("W1-T10144: retro.preflight_failed no longer recurs", async () => {
  // The retro's real diff shape: every one of 37 retro merges since 09-20 changed exactly these.
  const { run, calls, listed } = recordingRunner("PLAN_ONLY");
  const { result, rows } = await preflight(run, { files: ["MASTER-PLAN.md", "docs/ORIENTATION.md"] });

  assert.deepEqual(result, { ok: true, attempts: 1, suiteCount: 1, repaired: false });
  const listing = calls.find((args) => args.includes("--list-plan-reading-suites"))!;
  assert.ok(listing.includes("--changed-files"), "the listing is narrowed by the branch's changed paths, as ci.yml narrows it");
  assert.deepEqual(listed, ["MASTER-PLAN.md\ndocs/ORIENTATION.md\n", "MASTER-PLAN.md\ndocs/ORIENTATION.md\n"],
    "the classifier and the listing both read exactly the branch's changed paths");
  const testRun = calls.at(-1)!;
  assert.ok(testRun.includes("test/reads-master-plan.test.ts"));
  assert.ok(!testRun.includes("test/b.test.ts") && !testRun.includes("test/c.test.ts"), "suites CI would not run for this PR are not run");
  const list = listing[listing.indexOf("--changed-files") + 1]!;
  assert.equal(existsSync(list), false, "the private changed-path list is removed after the listing");
  assert.equal(rows[0]!.step, "retro.preflight_passed");
  assert.equal(rows[0]!.extra.suite_selection, "changed-paths");
  assert.equal(rows[0]!.extra.suite_selection_reason, "diff class PLAN_ONLY");
  assert.equal(rows[0]!.extra.changed_path_count, 2);
  assert.equal(rows[0]!.extra.broad_suite_count, 3, "the row records the broad count, so each pass's saving is measurable");
  assert.equal(rows[0]!.extra.suite_count, 1);
});

test("W1-T10144: a docs-only diff narrows too, and a source diff keeps the broad set", async () => {
  const docs = recordingRunner("DOCS_ONLY");
  const narrowed = await preflight(docs.run, { files: ["docs/ORIENTATION.md"] });
  assert.equal(narrowed.rows[0]!.extra.suite_selection, "changed-paths");

  const source = recordingRunner("SOURCE");
  const broad = await preflight(source.run, { files: ["MASTER-PLAN.md", "learnings/ci.yaml"] });
  const listing = source.calls.find((args) => args.includes("--list-plan-reading-suites"))!;
  assert.ok(!listing.includes("--changed-files"), "a SOURCE diff is not a plan-reading-lane diff in ci.yml either");
  const classify = source.calls.find((args) => args.includes("--changed-files"))!;
  assert.equal(existsSync(classify[classify.indexOf("--changed-files") + 1]!), false, "the list is removed on the broad arm too");
  assert.equal(broad.result.suiteCount, 3);
  assert.equal(broad.rows[0]!.extra.suite_selection, "broad");
  assert.equal(broad.rows[0]!.extra.suite_selection_reason, "diff class SOURCE");
  assert.equal(broad.rows[0]!.extra.changed_path_count, 2);
});

test("W1-T10144: an unreadable diff, an empty diff, an unclassifiable diff and an unwritable list all fail closed to the broad set", async () => {
  const unreadable = recordingRunner("PLAN_ONLY");
  const a = await preflight(unreadable.run, { unreadable: "not a git worktree" });
  assert.equal(a.rows[0]!.extra.suite_selection_reason, "changed paths unreadable: not a git worktree");
  assert.equal(a.rows[0]!.extra.changed_path_count, null);

  const empty = recordingRunner("PLAN_ONLY");
  const b = await preflight(empty.run, { files: [] });
  assert.equal(b.rows[0]!.extra.suite_selection_reason, "no changed path");
  assert.equal(b.rows[0]!.extra.changed_path_count, 0);

  const failing: RetroPrepublishRunner = (command, args, options) =>
    args.includes("--list-plan-reading-suites") || !args.includes("scripts/diff-class.mjs")
      ? recordingRunner("PLAN_ONLY").run(command, args, options)
      : { status: 2, signal: null, stdout: "", stderr: "boom" };
  const c = await preflight(failing, { files: ["MASTER-PLAN.md"] });
  assert.equal(c.rows[0]!.extra.suite_selection_reason, "diff class unreadable (exit 2)");

  const unwritable = recordingRunner("PLAN_ONLY");
  const d = await preflight(unwritable.run, { files: ["MASTER-PLAN.md"] }, { tmpRoot: "/nonexistent-rmd-10144/tmp" });
  assert.match(String(d.rows[0]!.extra.suite_selection_reason), /^changed-path list unwritable: /);
  for (const run of [a, b, c, d]) {
    assert.equal(run.rows[0]!.extra.suite_selection, "broad");
    assert.equal(run.result.suiteCount, 3);
  }
});

test("W1-T10144: the real changed-path reader diffs a retro worktree against origin/main through the hardened leaf", async () => {
  const repo = gitRepo({ kind: "retro-10144" });
  repo.git("update-ref", "refs/remotes/origin/main", "HEAD");
  const worktree = repo.addWorktree(join(repo.dir, "..", `${repo.dir.split("/").at(-1)}-wt`), "run-RETRO-10144");
  writeFileSync(join(worktree.dir, "MASTER-PLAN.md"), "# plan\n");
  mkdirSync(join(worktree.dir, "docs"));
  writeFileSync(join(worktree.dir, "docs/ORIENTATION.md"), "# orientation\n");
  worktree.git("add", "-A");
  worktree.git("commit", "-m", "chore(plan): sync the retro");
  // origin/main moving on after the cut must not leak its own changes into the branch's diff.
  repo.git("commit", "--allow-empty", "-m", "main moves");
  repo.git("update-ref", "refs/remotes/origin/main", "HEAD");

  assert.deepEqual(await retroBranchChangedFiles(worktree.dir), { files: ["MASTER-PLAN.md", "docs/ORIENTATION.md"] });
  const notARepo = mkdtempSync(join(tmpdir(), "rmd-test-retro-10144-plain-"));
  const refused = await retroBranchChangedFiles(notARepo);
  assert.ok("unreadable" in refused && refused.unreadable.length > 0, "a directory git cannot pin is an unreadable answer, never an empty diff");
});

test("W1-T10144: a bound stand-down names the failing tests its run reported instead of claiming it had none", async () => {
  const timedOut: RetroPrepublishRunner = (command, args, options) => args.includes("scripts/test-with-retry.mjs")
    ? { status: null, signal: "SIGTERM", stdout: "not ok 1 - author deadline admission\n  ---\n  ...\n", stderr: "",
        error: Object.assign(new Error("backstop"), { code: "ETIMEDOUT" }) }
    : recordingRunner("PLAN_ONLY").run(command, args, options);
  const named = await preflight(timedOut, { files: ["MASTER-PLAN.md"] });
  const stoodDown = named.rows.find((row) => row.step === "retro.preflight_repair_stood_down")!;
  assert.equal(stoodDown.extra.failing_count, 1);
  assert.match(String(stoodDown.extra.reason), /^the process_timeout bound stopped the run after it named 1 failing test\(s\)/);
  assert.doesNotMatch(String(stoodDown.extra.reason), /carries no failing test/);

  const silent: RetroPrepublishRunner = (command, args, options) => args.includes("scripts/test-with-retry.mjs")
    ? { status: null, signal: "SIGTERM", stdout: "", stderr: "", error: Object.assign(new Error("stall"), { code: "ETIMEDOUT" }) }
    : recordingRunner("PLAN_ONLY").run(command, args, options);
  const empty = await preflight(silent, { files: ["MASTER-PLAN.md"] });
  const emptyRow = empty.rows.find((row) => row.step === "retro.preflight_repair_stood_down")!;
  assert.equal(emptyRow.extra.failing_count, 0);
  assert.match(String(emptyRow.extra.reason), /carries no failing test/);
});
