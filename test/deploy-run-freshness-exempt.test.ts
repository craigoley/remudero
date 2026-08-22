import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { main } from "../src/run-task.js";
import { treeFfSafe } from "../src/lib/deployer.js";
import { checkCliFreshness } from "../src/lib/self-sync.js";

// ── THE CIRCULAR REFUSAL ─────────────────────────────────────────────────────────────
// `deploy-run` is the deploy supervisor's cycle — the com.remudero.supervisor launchd unit
// invokes it every 120s — and its whole purpose is to fast-forward a stale checkout. But
// `checkCliFreshness` refuses when the tree is BEHIND *and* DIRTY (self-sync.ts:164-176),
// and `main()`'s entry gate (run-task.ts:10890) turned that into `process.exit(1)` BEFORE
// `deployRunCommand` (run-task.ts:6278) was ever entered. The verb that exists to fix
// staleness was refused for being stale. Reproduced live:
//
//   rmd is behind origin/main (e9fa9ac..97e6857) and the working tree has uncommitted
//   changes -- refusing to auto-sync
//
// The ledger carries ZERO deploy.* events across the live file and all 661 rotations.
//
// The outer gate is redundant here because the deployer owns a strictly better one:
// `treeFfSafe` (deployer.ts:102) refuses only when a locally-modified path is ALSO in the
// incoming diff, and it sits directly in front of `pullFf()` (deployer.ts:236-251). The
// blunt gate fired first, which is why the precise one had never run.

class ProcessExitCalled extends Error {
  constructor(public code: number | undefined) {
    super(`process.exit(${code})`);
  }
}

/** The exact shape `checkCliFreshness` returns for a behind-AND-dirty checkout. */
const REFUSED_BEHIND_AND_DIRTY = () =>
  ({
    status: "refused" as const,
    reason: "dirty" as const,
    message:
      "rmd is behind origin/main (e9fa9ac..97e6857) and the working tree has uncommitted " +
      "changes -- refusing to auto-sync (never mutating uncommitted local state).",
  });

// W1-T1134: the shape `checkCliFreshness` returns for the daemon's OWN boot state --
// `deploy/entrypoint.sh` runs `git checkout --detach <target>` on every restart, so `branch` is
// `undefined` (self-sync.ts:392-404) and the message names "a DETACHED HEAD", not a branch.
const REFUSED_DETACHED_AND_BEHIND = () =>
  ({
    status: "refused" as const,
    reason: "off-main" as const,
    message:
      "rmd is behind origin/main (c66b504..2e93251) but this checkout is on a DETACHED HEAD, " +
      "not `main` -- refusing to auto-sync (never moving a ref that is not main). Self-sync " +
      "exists to keep the operator's own `main` checkout fresh; fast-forwarding here would " +
      "move your work's base out from under it. Run `rmd sync` yourself if that is really " +
      "what you want.",
  });

/** Drives `main()` for one verb with the freshness check pinned to the refusal (default: the
 *  behind-and-dirty shape; W1-T1134's tests pass {@link REFUSED_DETACHED_AND_BEHIND} — the
 *  daemon's own boot-state shape), and reports whether the process exited (the gate fired) or
 *  execution continued into the verb. */
async function runVerbUnderRefusal(
  t: { mock: { method: typeof import("node:test").mock.method } },
  argv: string[],
  checkFreshness: typeof checkCliFreshness = REFUSED_BEHIND_AND_DIRTY,
): Promise<{ exited: boolean; code?: number; errs: string[]; reached: boolean }> {
  const errs: string[] = [];
  t.mock.method(
    process,
    "exit",
    ((code?: number): never => {
      throw new ProcessExitCalled(code);
    }) as typeof process.exit,
  );
  t.mock.method(console, "error", (...a: unknown[]) => {
    errs.push(a.map(String).join(" "));
  });
  const originalArgv = process.argv;
  process.argv = ["node", "run-task.js", ...argv];
  try {
    let caught: unknown;
    await main({ checkFreshness }).catch((e) => {
      caught = e;
    });
    const exited = caught instanceof ProcessExitCalled;
    const code = exited ? (caught as ProcessExitCalled).code : undefined;
    // The gate's refusal is identified by its own message. If execution got past the gate,
    // that message is absent — whatever happens later in the verb is a different failure.
    const gateRefused = errs.some((e) => e.includes("refusing to auto-sync"));
    return { exited, code, errs, reached: !gateRefused };
  } finally {
    process.argv = originalArgv;
  }
}

// ── VALIDATION 4: deploy-run ENTERS its own logic ────────────────────────────────────
test("deploy-run on a behind-and-dirty checkout is NOT refused by the entry gate — it reaches its own logic", async (t) => {
  const r = await runVerbUnderRefusal(t, ["deploy-run", "--dry-run"]);

  // THE ASSERTION THAT MATTERS: the gate's refusal message never appears, so execution
  // continued past run-task.ts:10890 into deployRunCommand rather than exiting there.
  assert.ok(
    r.reached,
    `the freshness refusal must NOT fire for deploy-run; stderr was ${JSON.stringify(r.errs)}`,
  );
  assert.ok(
    !r.errs.some((e) => e.includes("refusing to auto-sync")),
    "the circular refusal is gone",
  );
});

// ── VALIDATION 7: REGRESSION LOCK — every other verb still refuses ───────────────────
test("REGRESSION LOCK: a plan-reading verb still refuses on a behind-and-dirty checkout — the gate was narrowed, not removed", async (t) => {
  const r = await runVerbUnderRefusal(t, ["lint-plan"]);

  assert.ok(r.exited, "lint-plan still exits at the gate");
  assert.equal(r.code, 1, "and exits 1, exactly as before");
  assert.ok(
    r.errs.some((e) => e.includes("refusing to auto-sync")),
    "the operator still gets the remedy message — a stale plan gives a wrong answer",
  );
});

test("REGRESSION LOCK: `deploy` (the marker-writing operator trigger) is NOT exempted — only deploy-run is", async (t) => {
  const r = await runVerbUnderRefusal(t, ["deploy"]);

  assert.ok(r.exited, "`rmd deploy` still exits at the gate");
  assert.equal(r.code, 1);
  assert.ok(
    r.errs.some((e) => e.includes("refusing to auto-sync")),
    "deploy is an interactive operator trigger with a human present to act on the remedy",
  );
});

// ── VALIDATIONS 5 & 6: the guard that REPLACES the outer gate ───────────────────────
// After this change `treeFfSafe` is the only thing between a dirty tree and a bad
// fast-forward, so both directions of its predicate are pinned here.

test("deployer guard: a dirty path that IS in the incoming diff conflicts — this is what replaces the outer gate", () => {
  const r = treeFfSafe({
    dirtyFiles: ["src/lib/deployer.ts", "DECISIONS.md"],
    incomingFiles: ["src/lib/deployer.ts", "README.md"],
  });

  assert.equal(r.ok, false, "a locally-modified file that the fast-forward would overwrite must abort");
  assert.deepEqual(r.conflicting, ["src/lib/deployer.ts"], "and it names exactly the conflicting path");
});

test("deployer guard: a dirty path NOT in the incoming diff proceeds — the case blocked for five days", () => {
  // This is the live shape: the canonical checkout is dirty with the daemon's own writes
  // (DECISIONS.md, plan/feedback/*.yaml, state/) while the incoming diff touches src/.
  const r = treeFfSafe({
    dirtyFiles: ["DECISIONS.md", "plan/feedback/fb-1784770185732-e025c1.yaml"],
    incomingFiles: ["src/lib/sweep.ts", "test/sweep.test.ts"],
  });

  assert.equal(r.ok, true, "dirt that the fast-forward does not touch must NOT block the deploy");
  assert.deepEqual(r.conflicting, [], "nothing conflicts");
});

// ── W1-T1134: THE GATE REFUSES READ-ONLY VERBS ON THE ONE HOST THAT HOLDS THEIR DATA ─────
//
// `deploy/entrypoint.sh` runs `git checkout --detach <target>` on every daemon boot, so the
// daemon's own checkout is detached by design. `checkCliFreshness`'s off-main arm refuses a
// detached-and-behind checkout — correctly, for a verb that DECIDES from the plan and then
// ACTS — but `main()`'s blanket `else` escalated that into `process.exit(1)` for `doctor` and
// `status` too, which only read the ledger/state/plan and print. That left the daemon host
// without its own diagnostic instrument in exactly the window (a restart, before the next
// merge to `main`) an operator reaches for one.
//
// This does not touch `checkCliFreshness` itself (self-sync.ts, W1-T446's territory) — only
// where `main()` applies its result. `doctor`/`status` are exempted by a DECLARED list
// (`READ_ONLY_FRESHNESS_EXEMPT_VERBS` in run-task.ts), the same shape as the existing
// `deploy-run`/`sync` carve-outs just above, not a heuristic over the verb name or a
// `--dry-run` flag sniff.

test("W1-T1134: a read-only verb runs from a detached checkout that is behind", async (t) => {
  // `doctor`'s own unknown-argument guard exits 64 (DOCTOR_USAGE_EXIT — doctor.ts:68, chosen so
  // "any exit code but 0/1/2/64 always means a check failed and never a typo"); `status` shares
  // the ordinary `unknownArgError` exit 2. Different codes, same point: each is the VERB'S own
  // arg guard answering, not the gate.
  for (const [verb, expectCode] of [
    ["doctor", 64],
    ["status", 2],
  ] as const) {
    // A deliberately invalid flag (same trick test/sync-freshness-exempt.test.ts uses): past
    // the gate, doctorCommand/statusCommand's own unknown-argument guard answers immediately,
    // before either reads real ledger/state files or (for `status`) writes its cache — so this
    // proves the gate was cleared without touching any real state on disk.
    const r = await runVerbUnderRefusal(t, [verb, "--not-a-real-flag"], REFUSED_DETACHED_AND_BEHIND);

    assert.ok(
      r.reached,
      `${verb} on a detached-and-behind checkout must NOT be refused by the entry gate; ` +
        `stderr was ${JSON.stringify(r.errs)}`,
    );
    assert.ok(
      !r.errs.some((e) => e.includes("DETACHED HEAD")),
      `${verb} must never see the gate's off-main refusal message`,
    );
    // Execution really reached the verb's own dispatch: its unknown-argument guard fired.
    assert.ok(r.exited, `${verb} still exits — through the verb's own arg guard, not the gate`);
    assert.equal(r.code, expectCode, `${verb} exits with its own unknown-argument code`);
  }
});

test("W1-T1134: a dispatching verb still refuses on the same checkout", async (t) => {
  // Reuses the detached-and-behind refusal, not the dirty one — this is the shape the task
  // record measured live: "rmd is behind origin/main (...) but this checkout is on a
  // DETACHED HEAD". A dispatching verb (one that reads the plan and then ACTS on it) must
  // still be refused before it ever reaches its own logic.
  for (const argv of [["lint-plan"], ["run-task", "T1"], ["triage"], ["fix", "1"], ["drain"]]) {
    const r = await runVerbUnderRefusal(t, argv, REFUSED_DETACHED_AND_BEHIND);

    assert.ok(r.exited, `\`rmd ${argv.join(" ")}\` still exits at the gate`);
    assert.equal(r.code, 1, "and exits 1, exactly as before");
    assert.ok(
      r.errs.some((e) => e.includes("DETACHED HEAD")),
      `\`rmd ${argv.join(" ")}\` still gets the remedy message — a stale plan gives a wrong answer`,
    );
  }
});

test("W1-T1134: the exempt set is declared, not inferred from the verb name", async (t) => {
  // `sweep`/`inbox` both have a genuinely read-only `--dry-run` form, and the task record's
  // design (ii) explicitly refuses to exempt them: a flag can be absent and the verb still
  // dispatch, so exempting the VERB would also exempt its non-dry-run (real) dispatch. Passing
  // `--dry-run` here must NOT be enough to pass the gate — proving the exemption is keyed on the
  // declared verb list, never on "does this invocation look read-only".
  for (const argv of [["sweep", "--dry-run"], ["inbox", "--dry-run"]]) {
    const r = await runVerbUnderRefusal(t, argv, REFUSED_DETACHED_AND_BEHIND);

    assert.ok(r.exited, `\`rmd ${argv.join(" ")}\` still exits at the gate despite --dry-run`);
    assert.equal(r.code, 1);
    assert.ok(
      r.errs.some((e) => e.includes("DETACHED HEAD")),
      `--dry-run alone must not exempt \`rmd ${argv.join(" ")}\` — only the declared list does`,
    );
  }
});

/** A real origin + a real clone, the clone one commit BEHIND — mirrors
 *  test/self-sync-branch-guard.test.ts's own fixture (that file sits outside this task's
 *  `files:` scope; this is a fresh, minimal copy of the same shape, not an import from it). */
function behindFixture(): { originDir: string; localDir: string } {
  const git = (dir: string, args: string[]): string => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  const root = mkdtempSync(join(tmpdir(), "rmd-w1-t1134-"));
  const originDir = join(root, "origin");
  const localDir = join(root, "local");
  mkdirSync(join(originDir, "plan"), { recursive: true });
  git(originDir, ["init", "--quiet", "-b", "main"]);
  git(originDir, ["config", "user.email", "test@example.com"]);
  git(originDir, ["config", "user.name", "Test"]);
  writeFileSync(join(originDir, "plan", "tasks.yaml"), "- id: T1\n  title: \"origin\"\n  repo: remudero\n  type: implement\n", "utf8");
  git(originDir, ["add", "."]);
  git(originDir, ["commit", "--quiet", "-m", "init"]);
  execFileSync("git", ["clone", "--quiet", originDir, localDir], { encoding: "utf8" });
  git(localDir, ["config", "user.email", "test@example.com"]);
  git(localDir, ["config", "user.name", "Test"]);
  writeFileSync(join(originDir, "plan", "tasks.yaml"), "- id: T1\n  title: \"newer\"\n  repo: remudero\n  type: implement\n", "utf8");
  git(originDir, ["add", "."]);
  git(originDir, ["commit", "--quiet", "-m", "newer"]);
  return { originDir, localDir };
}

test("W1-T1134: the freshness predicate is unchanged by this task", () => {
  // This task changes only WHERE main()'s gate applies (the verb dispatch), never WHAT
  // `checkCliFreshness` decides — design (i) of the task record, and self-sync.ts is not in
  // this task's `files:` at all. Drives the real predicate directly, on a real detached-and-
  // behind repo, and pins it to the exact contract W1-T445 established: still `refused`, still
  // reason `off-main`, still names "a DETACHED HEAD" and the `git pull --ff-only` remedy.
  const { localDir } = behindFixture();
  execFileSync("git", ["checkout", "--quiet", "--detach", "HEAD"], { cwd: localDir, encoding: "utf8" });

  const result = checkCliFreshness(localDir, {}, { say: () => {}, warn: () => {} });

  assert.equal(result.status, "refused");
  assert.equal(result.status === "refused" ? result.reason : undefined, "off-main");
  assert.match(result.status === "refused" ? result.message : "", /DETACHED HEAD/);
  assert.match(result.status === "refused" ? result.message : "", /git pull --ff-only/);
});

test("W1-T1134: the existing deploy-run and sync carve-outs are unchanged", async (t) => {
  // Same detached-and-behind refusal the new doctor/status exemption is proven against above —
  // `deploy-run` and `sync` must keep bypassing the gate exactly as they did before this task
  // (design iv/v of the task record touches neither carve-out). Invalid flags, same trick as
  // the doctor/status case above and as test/sync-freshness-exempt.test.ts, so neither verb's
  // real logic (a real fast-forward / a real sync classification) ever runs.
  for (const argv of [["deploy-run", "--not-a-real-flag"], ["sync", "--not-a-real-flag"]]) {
    const r = await runVerbUnderRefusal(t, argv, REFUSED_DETACHED_AND_BEHIND);

    assert.ok(
      r.reached,
      `\`rmd ${argv.join(" ")}\` must still NOT be refused by the entry gate; stderr was ${JSON.stringify(r.errs)}`,
    );
    assert.ok(
      !r.errs.some((e) => e.includes("DETACHED HEAD")),
      `\`rmd ${argv.join(" ")}\` must never see the gate's refusal message`,
    );
    assert.ok(r.exited, `\`rmd ${argv.join(" ")}\` still exits — through the verb, not the gate`);
    assert.equal(r.code, 2, "with the verb's own unknown-argument code, proving dispatch was reached");
  }
});
