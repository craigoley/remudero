import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(REPO_ROOT, "deploy", "host-update.sh");
// Every mkdtemp prefix below carries RMD_TMP_PREFIX so the boot sweep (`sweepStaleTempDirs`) can
// reap a fixture a killed run left behind — see test/host-update-reclaim.test.ts's own "no .git"
// fixture for the precedent this file follows for every NEW callsite (pre-existing ones on the
// sibling file are grandfathered on hooks/mkdtemp-allowlist.txt; this file has no such exemption).

/**
 * W1-T3626 — ~/.codex and ~/.claude filled the root disk and wedged the whole host.
 *
 * MEASURED 2026-09-16 (plan/tasks.d/W1-T3626-agent-history-fills-the-root-disk.yaml): 6.7 GiB of
 * agent conversation history under `~/.codex` (thread_history_1.sqlite, state_5.sqlite, sessions/)
 * and `~/.claude/projects`, growing ~580 MiB/day since 2026-09-07 with NO retention anywhere in
 * this repo. Section 4a (W1-T3612) already reclaims stranded git objects the same way — this adds
 * the sibling rung for agent history, landing between 4a and the `--reclaim-only` exit.
 *
 * NOT A FIXED CEILING. The rationale explicitly rules out a byte-size cap that fires near-full,
 * because that silently destroys the exact runs an incident review needs. The shape is AGE-TIERED:
 * remove files strictly older than RMD_AGENT_HISTORY_MAX_AGE_DAYS (default 14) under the configured
 * trees, oldest first, reporting bytes freed PER TREE — never one combined total, for the same
 * reason section 4a's own report never sums checkouts.
 *
 * SAME TECHNIQUE AS test/host-update-reclaim.test.ts: stub `docker` on PATH, run the REAL script,
 * assert on real filesystem fixtures built with `utimesSync`. No docker daemon required.
 */

/** Minimal `docker` stub — only what section 0/1/3/4 need under `--reclaim-only`. No pull is ever
 *  reached in this mode, so the stub does not need to answer it. */
function writeDockerStub(dir: string): void {
  const docker = [
    "#!/usr/bin/env bash",
    'case "$1 $2" in',
    '  "info --format")  echo "$STUB_REC"; exit 0 ;;',
    '  "system df")      echo "TYPE TOTAL ACTIVE SIZE"; exit 0 ;;',
    "esac",
    'case "$1" in',
    "  ps)",
    '    case "$STUB_MODE" in live) echo c0ffee ;; esac; exit 0 ;;',
    "  inspect)",
    '    case "$STUB_MODE" in',
    '      live) echo "/ad-hoc|rmd-local:latest|/home/node/Remudero " ;;',
    "    esac; exit 0 ;;",
    "  image)",
    '    if [ "$2" = "inspect" ]; then exit 0; fi',
    '    echo "Total reclaimed space: 0B"; exit 0 ;;',
    '  container|builder) echo "Total reclaimed space: 0B"; exit 0 ;;',
    "esac",
    "exit 0",
    "",
  ].join("\n");
  writeFileSync(join(dir, "docker"), docker, { mode: 0o755 });
  chmodSync(join(dir, "docker"), 0o755);
}

interface Run {
  status: number;
  stdout: string;
  stderr: string;
}

/** A day count expressed as milliseconds, for `utimesSync`. */
const DAYS = 24 * 60 * 60 * 1000;

/** A codex-shaped home: one file older than the default 14-day tier, one fresh (still growing). */
function codexFixture(): { dir: string; old: string; fresh: string } {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}host-update-codex-`));
  const old = join(dir, "thread_history_1.sqlite");
  const fresh = join(dir, "state_5.sqlite");
  writeFileSync(old, "x".repeat(4096));
  writeFileSync(fresh, "y".repeat(2048));
  const now = new Date();
  utimesSync(old, new Date(now.getTime() - 60 * DAYS), new Date(now.getTime() - 60 * DAYS));
  utimesSync(fresh, now, now);
  return { dir, old, fresh };
}

/** A claude-shaped home: `.credentials.json` beside `projects/`, one old session and one fresh. */
function claudeFixture(): { dir: string; oldSession: string; freshSession: string; credentials: string } {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}host-update-claude-`));
  mkdirSync(join(dir, "projects"), { recursive: true });
  const oldSession = join(dir, "projects", "old-session.jsonl");
  const freshSession = join(dir, "projects", "fresh-session.jsonl");
  const credentials = join(dir, ".credentials.json");
  writeFileSync(oldSession, "a".repeat(8192));
  writeFileSync(freshSession, "b".repeat(1024));
  writeFileSync(credentials, JSON.stringify({ claudeAiOauth: { accessToken: "sk-ant-oat01-x" } }));
  const now = new Date();
  // The credential self-refreshes every 8h in real operation, but this fixture pins it OLD on
  // purpose: `${CRED_DIR}/projects` is the configured tree, not `${CRED_DIR}` itself, so even a
  // stale credential file sitting beside `projects/` must survive untouched.
  utimesSync(credentials, new Date(now.getTime() - 60 * DAYS), new Date(now.getTime() - 60 * DAYS));
  utimesSync(oldSession, new Date(now.getTime() - 30 * DAYS), new Date(now.getTime() - 30 * DAYS));
  utimesSync(freshSession, now, now);
  return { dir, oldSession, freshSession, credentials };
}

function runHostUpdate(mode: "good" | "live", extraEnv: NodeJS.ProcessEnv = {}, scriptPath = SCRIPT): Run {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}host-update-stub-`));
  const rec = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}host-update-rec-`));
  const state = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}host-update-state-`));
  writeDockerStub(dir);
  const r = spawnSync("bash", [scriptPath, "--reclaim-only"], {
    encoding: "utf8",
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PATH: `${dir}:${process.env.PATH ?? ""}`,
      STUB_REC: rec,
      STUB_MODE: mode,
      RMD_STATE_DIR: state,
      ...extraEnv,
    },
  });
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// ── ACCEPTANCE 1: bounded by age, oldest first, reported per tree ──────────────────────────────

test("agent history does not fill the root disk", () => {
  const codex = codexFixture();
  const claude = claudeFixture();
  const run = runHostUpdate("good", {
    RMD_CODEX_DIR: codex.dir,
    RMD_CLAUDE_DIR: claude.dir,
  });
  assert.equal(run.status, 0, run.stderr);

  // Bounded by age: the old files are gone, the still-growing ones survive untouched.
  assert.ok(!existsSync(codex.old), "a 60-day-old codex file must be reclaimed");
  assert.ok(existsSync(codex.fresh), "a file written today must survive — this is age-tiered, not a size cap");
  assert.ok(!existsSync(claude.oldSession), "a 30-day-old session must be reclaimed");
  assert.ok(existsSync(claude.freshSession), "today's session must survive");
  assert.ok(existsSync(claude.credentials), "the credential file, outside projects/, must never be touched");

  // Reported PER TREE, never one combined total — the same reason section 4a's own report never
  // sums checkouts: a single number cannot tell "nothing old here" from "nothing old here, and a
  // gigabyte on the other tree".
  assert.match(run.stdout, new RegExp(`agent history reclaim — ${esc(codex.dir)}: freed`));
  assert.match(run.stdout, new RegExp(`agent history reclaim — ${esc(join(claude.dir, "projects"))}: freed`));
  assert.doesNotMatch(run.stdout, /agent history reclaim — freed .* total/, "must never collapse into one sum");
});

test("oldest first: files are removed in ascending mtime order, not filesystem order", () => {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}host-update-order-`));
  const now = new Date();
  // Written to disk NEWEST-NAMED-FIRST so filesystem/readdir order would disagree with mtime order
  // if the script did not sort explicitly.
  const third = join(dir, "z-third.log");
  const first = join(dir, "a-first.log");
  const second = join(dir, "m-second.log");
  for (const [p, daysAgo] of [
    [third, 20],
    [first, 90],
    [second, 45],
  ] as const) {
    writeFileSync(p, "x".repeat(512));
    const t = new Date(now.getTime() - daysAgo * DAYS);
    utimesSync(p, t, t);
  }
  const run = runHostUpdate("good", { RMD_CODEX_DIR: dir, RMD_CLAUDE_DIR: mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}host-update-claude-empty-`)) });
  assert.equal(run.status, 0, run.stderr);
  const idx = (needle: string) => run.stdout.indexOf(needle);
  const iFirst = idx(first);
  const iSecond = idx(second);
  const iThird = idx(third);
  assert.ok(iFirst >= 0 && iSecond >= 0 && iThird >= 0, "every removed file must be traced in the output");
  assert.ok(iFirst < iSecond, "the 90-day file must be reported before the 45-day file");
  assert.ok(iSecond < iThird, "the 45-day file must be reported before the 20-day file");
});

test("--dry-run reports what would free without removing anything", () => {
  const codex = codexFixture();
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}host-update-stub-`));
  const rec = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}host-update-rec-`));
  const state = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}host-update-state-`));
  writeDockerStub(dir);
  const dryRun = spawnSync("bash", [SCRIPT, "--reclaim-only", "--dry-run"], {
    encoding: "utf8",
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PATH: `${dir}:${process.env.PATH ?? ""}`,
      STUB_REC: rec,
      STUB_MODE: "good",
      RMD_STATE_DIR: state,
      RMD_CODEX_DIR: codex.dir,
      RMD_CLAUDE_DIR: mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}host-update-claude-empty2-`)),
    },
  });
  assert.equal(dryRun.status, 0);
  assert.match(dryRun.stdout ?? "", /agent history reclaim \(DRY RUN\)/);
  assert.ok(existsSync(codex.old), "a dry run must remove nothing");
});

// ── ACCEPTANCE 2: refuses while a fleet container is live ──────────────────────────────────────

test("agent history reclaim refuses while a fleet container is live", () => {
  const codex = codexFixture();
  const claude = claudeFixture();
  const run = runHostUpdate("live", { RMD_CODEX_DIR: codex.dir, RMD_CLAUDE_DIR: claude.dir });
  assert.match(run.stderr, /REFUSING agent history reclaim — a fleet container is RUNNING/);
  assert.match(run.stderr, /rmd-local:latest/, "the refusal must name the live holder");
  assert.ok(existsSync(codex.old), "nothing may be removed while a fleet container is live");
  assert.ok(existsSync(claude.oldSession), "nothing may be removed while a fleet container is live");
  assert.doesNotMatch(run.stdout, /agent history reclaim —.*: freed/, "no tree may report a reclaim while live");
});

// ── ACCEPTANCE 3: never reads STATE_DIR state ───────────────────────────────────────────────────

test("grep: the agent history section never reads STATE_DIR state, in source", () => {
  const src = readFileSync(SCRIPT, "utf8");
  assert.match(src, /never reads STATE_DIR state/, "the literal invariant statement must be present");
});

test("the state volume's own files are untouched by a run that also reclaims agent history", () => {
  const codex = codexFixture();
  const claude = claudeFixture();
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}host-update-stub-`));
  const rec = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}host-update-rec-`));
  const state = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}host-update-state-`));
  mkdirSync(join(state, "state"), { recursive: true });
  const ledger = join(state, "state", "ledger.ndjson");
  writeFileSync(ledger, "old ledger row\n");
  const old = new Date(Date.now() - 90 * DAYS);
  utimesSync(ledger, old, old);
  writeDockerStub(dir);
  const r = spawnSync("bash", [SCRIPT, "--reclaim-only"], {
    encoding: "utf8",
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PATH: `${dir}:${process.env.PATH ?? ""}`,
      STUB_REC: rec,
      STUB_MODE: "good",
      RMD_STATE_DIR: state,
      RMD_CODEX_DIR: codex.dir,
      RMD_CLAUDE_DIR: claude.dir,
    },
  });
  assert.equal(r.status, 0);
  assert.ok(existsSync(ledger), "the ledger must survive even though it is far older than the age tier");
  assert.equal(readFileSync(ledger, "utf8"), "old ledger row\n", "and its content must be untouched");
});

// ── MUTANTS: a test that only passes on today's script proves nothing about tomorrow's ─────────

/** Write a mutated copy of the script and return its path. */
function mutate(find: string, replace: string): string {
  const src = readFileSync(SCRIPT, "utf8");
  assert.equal(src.split(find).length - 1, 1, `the mutation target must be unique: ${JSON.stringify(find)}`);
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}host-update-mutant-agent-history-`));
  const p = join(dir, "host-update.sh");
  writeFileSync(p, src.replace(find, replace), { mode: 0o755 });
  chmodSync(p, 0o755);
  return p;
}

test("MUTANT: dropping the live-worker refusal lets agent history reclaim run beside a live fleet container", () => {
  const mutant = mutate(
    '  if [ -n "${LIVE}" ]; then\n    echo "host-update: REFUSING agent history reclaim',
    '  if [ -n "${LIVE}" ] && false; then\n    echo "host-update: REFUSING agent history reclaim',
  );
  const codex = codexFixture();
  const claude = claudeFixture();
  const runMutant = runHostUpdate("live", { RMD_CODEX_DIR: codex.dir, RMD_CLAUDE_DIR: claude.dir }, mutant);
  assert.ok(!existsSync(codex.old), "the mutant must actually reach the reclaim, or this proves nothing about the guard");

  // …and the real script must not: the assertion the refusal test above makes, restated here so
  // the pair reads as one claim.
  const codexReal = codexFixture();
  const claudeReal = claudeFixture();
  const real = runHostUpdate("live", { RMD_CODEX_DIR: codexReal.dir, RMD_CLAUDE_DIR: claudeReal.dir });
  assert.ok(existsSync(codexReal.old));
});

test("MUTANT: collapsing the per-tree report into one combined total is caught by the per-tree test", () => {
  const src = readFileSync(SCRIPT, "utf8");
  const reportLine =
    '      echo "host-update: agent history reclaim — ${hdir}: freed $(human_kb "${freed_kb}") across ${removed} file(s) older than ${AGENT_HISTORY_MAX_AGE_DAYS}d, oldest first"\n';
  assert.equal(src.split(reportLine).length - 1, 1, "the report line must be locatable and unique, or this proves nothing");
  const mutated = src.replace(
    reportLine,
    '      TOTAL_AGENT_HISTORY_FREED_KB=$((TOTAL_AGENT_HISTORY_FREED_KB + freed_kb))\n',
  );
  assert.notEqual(mutated, src, "the mutation must actually change the script");
  const loopHeader = 'for hdir in "${AGENT_HISTORY_DIRS[@]}"; do';
  const withInit = mutated.replace(loopHeader, `TOTAL_AGENT_HISTORY_FREED_KB=0\n    ${loopHeader}`);
  const doneOnce = withInit.indexOf("    done\n  fi\nfi\n\n# ── 4c.");
  assert.ok(doneOnce >= 0, "the loop close before section 4c must be locatable, or this proves nothing");
  const withTotal =
    withInit.slice(0, doneOnce) +
    '    done\n    echo "host-update: agent history reclaim — freed $(human_kb "${TOTAL_AGENT_HISTORY_FREED_KB}") total"\n  fi\nfi\n\n# ── 4c.' +
    withInit.slice(doneOnce + "    done\n  fi\nfi\n\n# ── 4c.".length);

  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}host-update-mutant-agent-history-total-`));
  const mutant = join(dir, "host-update.sh");
  writeFileSync(mutant, withTotal, { mode: 0o755 });
  chmodSync(mutant, 0o755);

  const codex = codexFixture();
  const claude = claudeFixture();
  const runMutant = runHostUpdate("good", { RMD_CODEX_DIR: codex.dir, RMD_CLAUDE_DIR: claude.dir }, mutant);
  assert.equal(runMutant.status, 0, runMutant.stderr);
  assert.doesNotMatch(
    runMutant.stdout,
    new RegExp(`agent history reclaim — ${esc(codex.dir)}: freed`),
    "the mutant collapses the per-tree line away",
  );
  assert.match(runMutant.stdout, /agent history reclaim — freed .* total/, "the mutant reports one combined total instead");

  // …and the real script must still report per tree, or this proves nothing about the guard.
  const codexReal = codexFixture();
  const claudeReal = claudeFixture();
  const real = runHostUpdate("good", { RMD_CODEX_DIR: codexReal.dir, RMD_CLAUDE_DIR: claudeReal.dir });
  assert.match(real.stdout, new RegExp(`agent history reclaim — ${esc(codexReal.dir)}: freed`));
});
