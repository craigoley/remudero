/**
 * W1-T9631 — A BOOT THAT CANNOT ADVANCE ITS CHECKOUT RUNS THE TREE THAT LAST BOOTED, AND SAYS SO.
 *
 * 2026-10-15, 08:22-10:29Z: every core boot died at the entrypoint's checkout (`die "cannot check out
 * main"`), 25 revives in 2 h 7 m, while the tree that had just booted sat on disk. Two halves:
 *
 *  1. deploy/entrypoint.sh: a sync whose checkout refuses runs HEAD as a named STALE BOOT, ledgers
 *     `entrypoint.stale_boot`, spools an escalation the daemon's drain posts, and exports
 *     RMD_BOOT_CHECKOUT_BLOCKED=<target>. The clone path, with no tree that ever booted, still dies.
 *  2. src/lib/daemon.ts: a daemon told its checkout is blocked toward a target does not freshness-exit
 *     toward that same target (it would boot into the same refusal and loop), and does once main
 *     moves past it.
 *
 * The refusal here is a held `.git/index.lock`: a lock is a refusal W1-T9623's move-aside cannot
 * clear, which is the general case this backstop exists for.
 */
import { repoRoot } from "#test/helpers/repo-root.js";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { fixedClock } from "#src/lib/clock.js";
import { runDaemon, type DaemonFreshness } from "#src/lib/daemon.js";
import { DEPLOY_RESTART_RATE_CEILING_MS } from "#src/lib/deploy-judge.js";
import type { Escalation } from "#src/lib/escalate.js";
import { drainEscalationSpool, escalationSpoolDir } from "#src/lib/host-escalation-spool.js";
import { loadPlan } from "#src/lib/plan.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { gitRepo, type GitRepo } from "#test/helpers/git-repo.js";

const SCRIPT = join(repoRoot(), "deploy/entrypoint.sh");
const SPOOL_NAME = "escalate-entrypoint-stale-boot.json";

/** An origin carrying the two files a boot needs: package.json, and a bin/rmd the PATH step accepts. */
function seededOrigin(): GitRepo {
  const origin = gitRepo({ kind: "stale-boot-origin" });
  writeFileSync(join(origin.dir, "package.json"), '{"name":"fixture","version":"1.0.0"}\n');
  mkdirSync(join(origin.dir, "bin"));
  writeFileSync(join(origin.dir, "bin", "rmd"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
  chmodSync(join(origin.dir, "bin", "rmd"), 0o755);
  origin.git("add", "-A");
  origin.git("commit", "-qm", "fixture");
  return origin;
}

function advance(origin: GitRepo, file: string): string {
  writeFileSync(join(origin.dir, file), `${file}\n`);
  origin.git("add", "-A");
  origin.git("commit", "-qm", `add ${file}`);
  return origin.git("rev-parse", "HEAD");
}

/** Run the real entrypoint; its command records the RMD_BOOT_CHECKOUT_BLOCKED the daemon would inherit. */
function boot(home: string, origin: GitRepo, ref = "main", inheritedEnv: NodeJS.ProcessEnv = process.env) {
  const stubs = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}stale-boot-stub-`));
  writeFileSync(join(stubs, "npm"), '#!/usr/bin/env bash\nif [ "$1" = ci ]; then mkdir -p node_modules/.bin; printf "#!/bin/sh\\n" > node_modules/.bin/tsx; chmod 0755 node_modules/.bin/tsx; fi\n', { mode: 0o755 });
  chmodSync(join(stubs, "npm"), 0o755);
  const envFile = join(stubs, "blocked");
  const ambient = Object.fromEntries(Object.entries(inheritedEnv).filter(([k]) => !k.startsWith("RMD_") && !/^(GH_APP_|GH_TOKEN$|GITHUB_TOKEN$)/.test(k)));
  const r = spawnSync("bash", [SCRIPT, "bash", "-c", 'printf "%s" "${RMD_BOOT_CHECKOUT_BLOCKED-<unset>}" > "$0"', envFile], {
    encoding: "utf8",
    timeout: 60_000,
    // The entrypoint writes global config; inherited /dev/null or host paths must not receive it.
    env: { ...ambient, PATH: `${stubs}:${process.env.PATH ?? ""}`, HOME: home, RMD_REPO_URL: origin.dir, RMD_REF: ref, GIT_CONFIG_GLOBAL: join(home, ".gitconfig"), GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" },
  });
  const blocked = existsSync(envFile) ? readFileSync(envFile, "utf8") : undefined;
  rmSync(stubs, { recursive: true, force: true });
  return { status: r.status, stderr: r.stderr ?? "", blocked };
}

const treeOf = (home: string) => join(home, "Remudero", "remudero");
const stateOf = (home: string) => join(home, "Remudero", "state");
const headOf = (home: string) => spawnSync("git", ["-C", treeOf(home), "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
const rowsOf = (home: string) =>
  readFileSync(join(stateOf(home), "ledger.ndjson"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, string>);

function freshHome(t: { after: (fn: () => void) => void }): string {
  const home = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}stale-boot-home-`));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return home;
}

test("W1-T9631: a boot that cannot advance runs the tree that last booted, names a STALE BOOT and ledgers entrypoint.stale_boot", (t) => {
  const home = freshHome(t);
  const origin = seededOrigin();
  t.after(() => origin.cleanup());
  const hostConfig = join(home, "host.gitconfig");
  const hostSentinel = "[fixture]\n\tmarker = untouched\n";
  writeFileSync(hostConfig, hostSentinel);
  const first = boot(home, origin, "main", { ...process.env, GIT_CONFIG_GLOBAL: hostConfig, GIT_CONFIG_SYSTEM: hostConfig });
  assert.equal(first.status, 0, first.stderr);
  assert.equal(readFileSync(hostConfig, "utf8"), hostSentinel, "the inherited config sentinel is untouched");
  assert.match(readFileSync(join(home, ".gitconfig"), "utf8"), /\[user\]/, "the entrypoint writes worker identity only to the fixture config");
  assert.equal(first.blocked, "<unset>", "a boot that reached its target tells the daemon nothing is blocked");
  const lastBooted = headOf(home);
  const target = advance(origin, "second.txt");
  writeFileSync(join(treeOf(home), ".git", "index.lock"), "");

  const stale = boot(home, origin);
  assert.equal(stale.status, 0, `a refused checkout must not kill the boot: ${stale.stderr}`);
  assert.match(stale.stderr, /CHECKOUT FAILED toward main/);
  assert.ok(
    stale.stderr.includes(`STALE BOOT: CHECKOUT FAILED toward main (${target}) — continuing on HEAD ${lastBooted}, the tree that last booted`),
    stale.stderr,
  );
  assert.equal(headOf(home), lastBooted, "the daemon runs the tree that last booted, unchanged");
  assert.equal(stale.blocked, target, "the daemon is told which target the checkout could not reach");

  const row = rowsOf(home).find((r) => r.step === "entrypoint.stale_boot");
  assert.ok(row, "the stale boot is ledgered");
  assert.equal(row.head, lastBooted);
  assert.equal(row.target, target);
  assert.equal(row.ref, "main");
  assert.match(row.error, /index\.lock/, "git's own refusal is carried on the row");

  const spoolFile = join(escalationSpoolDir(stateOf(home)), SPOOL_NAME);
  const entry = JSON.parse(readFileSync(spoolFile, "utf8")) as { kind: string; count: number; escalation: Escalation };
  assert.equal(entry.kind, "escalate");
  assert.equal(entry.count, 1);
  assert.equal(entry.escalation.taskId, "DAEMON");
  assert.ok(entry.escalation.detail.includes(target) && entry.escalation.detail.includes(lastBooted));
  assert.ok(entry.escalation.options.some((o) => o.label === entry.escalation.recommendation));

  const again = boot(home, origin);
  assert.equal(again.status, 0, again.stderr);
  assert.equal((JSON.parse(readFileSync(spoolFile, "utf8")) as { count: number }).count, 2, "a repeat is one spooled entry with a count");

  unlinkSync(join(treeOf(home), ".git", "index.lock"));
  const healed = boot(home, origin);
  assert.equal(healed.status, 0, healed.stderr);
  assert.equal(headOf(home), target, "once the refusal clears, the next boot advances");
  assert.equal(healed.blocked, "<unset>");
  assert.doesNotMatch(healed.stderr, /STALE BOOT/);
  assert.equal(existsSync(spoolFile), false, "an escalation nobody posted yet is withdrawn on recovery");
});

test("W1-T9631: the daemon's spool drain posts the stale-boot escalation, and a recovered boot closes it", async (t) => {
  const home = freshHome(t);
  const origin = seededOrigin();
  t.after(() => origin.cleanup());
  assert.equal(boot(home, origin).status, 0);
  advance(origin, "second.txt");
  writeFileSync(join(treeOf(home), ".git", "index.lock"), "");
  assert.equal(boot(home, origin).status, 0);

  const posted: Escalation[] = [];
  const closed: string[] = [];
  const poster = {
    clock: fixedClock(Date.UTC(2026, 9, 15)),
    escalate: async (e: Escalation) => { posted.push(e); return "https://github.com/o/r/issues/1"; },
    close: async (url: string) => { closed.push(url); },
    comment: async () => {},
  };
  const first = await drainEscalationSpool(stateOf(home), poster);
  assert.deepEqual(first, { delivered: 1, failed: 0 }, "the hand-written entry must parse as a real spool entry");
  assert.equal(posted[0]!.class, "BLOCKED");
  assert.match(posted[0]!.summary, /STALE BOOT/);

  unlinkSync(join(treeOf(home), ".git", "index.lock"));
  assert.equal(boot(home, origin).status, 0);
  const second = await drainEscalationSpool(stateOf(home), poster);
  assert.deepEqual(second, { delivered: 1, failed: 0 });
  assert.deepEqual(closed, ["https://github.com/o/r/issues/1"], "the posted issue is closed once the boot advances");
});

test("W1-T9631: the clone path still dies on a refusal, since no tree has ever booted there", (t) => {
  const home = freshHome(t);
  const origin = seededOrigin();
  t.after(() => origin.cleanup());
  const r = boot(home, origin, "no-such-ref");
  assert.notEqual(r.status, 0, "with nothing that last booted there is nothing to fall back to");
  assert.match(r.stderr, /ref not found: no-such-ref/);
  assert.doesNotMatch(r.stderr, /STALE BOOT/);
});

// ── the daemon half ───────────────────────────────────────────────────────────────────────────

const STEP_MS = DEPLOY_RESTART_RATE_CEILING_MS;
const OLD = "a".repeat(40);
const BLOCKED = "b".repeat(40);
const NEXT = "c".repeat(40);
const staleToward = (newSha: string): DaemonFreshness => ({
  stale: true, oldSha: OLD, newSha, changes: [{ sha: newSha, files: ["src/lib/daemon.ts"] }],
});

async function daemonRun(read: (step: number) => DaemonFreshness, steps: number, bootCheckoutBlocked?: string) {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}stale-boot-daemon-`));
  const file = join(root, "tasks.yaml");
  writeFileSync(file, "- id: A\n  title: a\n  repo: remudero\n  type: implement\n  depends_on: []\n  status: queued\n");
  const start = Date.now();
  let now = start;
  const rows: { step: string; extra: Record<string, unknown> }[] = [];
  try {
    const summary = await runDaemon(loadPlan(file), {
      refreshMerged: () => () => true,
      runOne: async (taskId) => ({ taskId, runId: "unused", merged: true, costUsd: 0, verdict: "merged" }),
      now: () => new Date(now),
      sleep: async () => { now += STEP_MS; },
      checkStop: () => (now >= start + steps * STEP_MS ? "fixture complete" : undefined),
      checkFreshness: () => read(Math.floor((now - start) / STEP_MS)),
      log: (step, extra = {}) => rows.push({ step, extra }),
      readLedgerLines: () => [],
      ...(bootCheckoutBlocked ? { bootCheckoutBlocked } : {}),
    });
    return { summary, rows };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("W1-T9631: a blocked checkout does not freshness-restart into the same target, and does once main moves past it", async () => {
  const control = await daemonRun(() => staleToward(BLOCKED), 6);
  assert.equal(control.summary.stopReason, "stale", "control: an unblocked daemon restarts toward the advance");

  const held = await daemonRun(() => staleToward(BLOCKED), 6, BLOCKED);
  assert.notEqual(held.summary.stopReason, "stale", "a restart toward the blocked target would boot into the same refusal");
  const blockedRows = held.rows.filter((r) => r.step === "daemon.freshness_blocked");
  assert.ok(blockedRows.length >= 2, `one row per tick while blocked, got ${blockedRows.length}`);
  assert.equal(blockedRows[0]!.extra.new_sha, BLOCKED);
  assert.equal(blockedRows[0]!.extra.old_sha, OLD);
  assert.equal(held.rows.some((r) => r.step === "daemon_selfrestart_for_freshness"), false);

  const moved = await daemonRun((step) => staleToward(step < 3 ? BLOCKED : NEXT), 10, BLOCKED);
  assert.equal(moved.summary.stopReason, "stale", "once main moves past the blocked target, one restart is tried again");
  const decision = moved.rows.filter((r) => r.step === "daemon.freshness_decision").at(-1);
  assert.equal(decision?.extra.new_sha, NEXT, "and it restarts toward the new target, never the blocked one");
  assert.ok(moved.rows.some((r) => r.step === "daemon.freshness_blocked"), "the blocked stretch was ledgered first");
});
