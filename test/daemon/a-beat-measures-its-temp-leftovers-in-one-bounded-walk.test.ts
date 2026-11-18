// W1-T13190: the temp-leftover consumer is measured per temp ROOT, not per entry. The REAL committed
// beat runs against a fixture whose `du`, `df` and `findmnt` record every call, so the count of
// measuring commands is read off what actually started.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { parseHeartbeatPayload } from "#src/lib/host-resource-gardener.js";
import { makeTempDir } from "#src/lib/tmp.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const LEFTOVER = /\/(account|system|scratch)-tmp\/(rmd|remudero)-(?!c-)[^/]+$/;

function nativeKb(path: string): number {
  const result = spawnSync("sh", ["-c", 'command -p du -sk "$1"', "du", path], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return Number(result.stdout.trim().split(/\s+/)[0]);
}

interface Measured {
  beat: Record<string, string>;
  leftoverKb: number;
  duLeftover: string[][];
  dfLeftover: string[];
  findmntLeftover: string[];
  other: Record<string, number>;
}

function measure(opts: { accountEntries: number; systemEntries: number; slowSystem?: boolean }): Measured {
  const dir = makeTempDir("heartbeat-one-walk");
  try {
    for (const path of ["bin", "scripts", "home/rmd-work", "root/state", "account-tmp", "system-tmp", "scratch-tmp"])
      mkdirSync(join(dir, path), { recursive: true });
    const seed = (path: string, bytes: number) => {
      mkdirSync(join(dir, path), { recursive: true });
      writeFileSync(join(dir, path, "data"), Buffer.alloc(bytes, 1));
      return join(dir, path);
    };
    let leftoverKb = 0;
    const entries: string[] = [];
    for (let i = 0; i < opts.accountEntries; i++)
      entries.push(seed(`account-tmp/${i % 2 ? "rmd" : "remudero"}-leak-${i}`, 4096 * ((i % 5) + 1)));
    for (let i = 0; i < opts.systemEntries; i++) entries.push(seed(`system-tmp/rmd-leak-${i}`, 4096 * ((i % 3) + 1)));
    for (const entry of entries) leftoverKb += nativeKb(entry);
    // Consumers the change must leave alone, each with a size the real du reads.
    const other = {
      tsx_cache: nativeKb(seed("account-tmp/tsx-1000", 8192)),
      coverage: nativeKb(seed("account-tmp/rmd-c-one", 12288)),
      scratch: nativeKb(seed("account-tmp/claude-one", 16384)),
      hand_worktrees: nativeKb(seed("home/rmd-work", 20480)),
    };

    const source = readFileSync(join(REPO_ROOT, "scripts/fleet-heartbeat.sh"), "utf8")
      .replaceAll("/mnt/scratch/tmp", "$FIXTURE/scratch-tmp")
      .replace(/(?<![\w/])\/tmp(?=\/|["\s}])/g, "$FIXTURE/system-tmp");
    const script = join(dir, "scripts/fleet-heartbeat.sh");
    writeFileSync(script, source);
    const stub = (name: string, body: string) =>
      writeFileSync(join(dir, "bin", name), `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
    stub("git", "printf 'fixture-sha\\n'");
    stub("docker", "exit 1");
    stub("systemctl", "exit 1");
    stub("ionice", 'shift 2; exec "$@"');
    stub("findmnt", 'printf "%s\\n" "$*" >> "$FIXTURE/findmnt-calls"; exit 1');
    stub("df", `
printf '%s\\n' "\${@: -1}" >> "$FIXTURE/df-calls"
p="\${@: -1}"
case "$p" in
  "$FIXTURE"/account-tmp/*) device=/dev/account ;;
  "$FIXTURE"/system-tmp/*) device=/dev/system ;;
  *) device=/dev/root ;;
esac
printf 'Filesystem 1024-blocks Used Available Capacity Mounted\\n%s 100000 1000 99000 1%% /\\n' "$device"`);
    stub("du", `
for a in "$@"; do printf '%s\\t' "$a" >> "$FIXTURE/du-calls"; done; printf '\\n' >> "$FIXTURE/du-calls"
case "\${@: -1}" in
  "$FIXTURE"/system-tmp/rmd-leak-*) [ "\${SLOW:-}" = 1 ] && exec sleep 120 ;;
esac
case "\${@: -1}" in
  "$FIXTURE"/root/*) printf '1\\t%s\\n' "\${@: -1}" ;;
  "$FIXTURE"/*) command -p du "$@" ;;
  *) exit 1 ;;
esac`);
    const result = spawnSync("bash", [script], {
      encoding: "utf8", timeout: 60_000,
      env: {
        ...process.env, PATH: `${join(dir, "bin")}:${process.env.PATH ?? ""}`,
        FIXTURE: dir, HOME: join(dir, "home"), RMD_ROOT: join(dir, "root"), TMPDIR: join(dir, "account-tmp"),
        RMD_HEARTBEAT_LOCK_HELD: "1", RMD_HEARTBEAT_DRY_RUN: "1",
        RMD_HEARTBEAT_DOCKER: join(dir, "bin/docker"), RMD_HEARTBEAT_SYSTEMCTL: join(dir, "bin/systemctl"),
        RMD_CONSUMER_WALK_BUDGET_S: opts.slowSystem ? "6" : "120", SLOW: opts.slowSystem ? "1" : "",
      },
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    const lines = (file: string) => {
      try { return readFileSync(join(dir, file), "utf8").split("\n").filter(Boolean); } catch { return []; }
    };
    return {
      beat: parseHeartbeatPayload(result.stdout), leftoverKb, other,
      duLeftover: lines("du-calls").map(l => l.split("\t").filter(Boolean)).filter(a => a.some(x => LEFTOVER.test(x))),
      dfLeftover: lines("df-calls").filter(p => LEFTOVER.test(p)),
      findmntLeftover: lines("findmnt-calls").filter(p => LEFTOVER.test(p)),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("W1-T13190 criterion 1: the measuring commands for temp leftovers do not grow with the entry count", () => {
  const few = measure({ accountEntries: 2, systemEntries: 1 });
  const many = measure({ accountEntries: 300, systemEntries: 200 });
  assert.equal(few.duLeftover.length, 2, "positive control: one du per root holding leftovers");
  assert.equal(many.duLeftover.length, few.duLeftover.length, "hundreds of entries cost the same du count as three");
  assert.equal(many.dfLeftover.length, few.dfLeftover.length, "one df per root, not per entry");
  assert.equal(few.dfLeftover.length, 2);
  assert.equal(many.findmntLeftover.length, 0, "no per-entry findmnt either");
  assert.ok(many.duLeftover.some(argv => argv.length > 300), "the entries ride as arguments of one du");
});

test("W1-T13190 criterion 2: the total and devices are today's, and a cut walk is unknown and named", () => {
  const { beat, leftoverKb } = measure({ accountEntries: 7, systemEntries: 4 });
  assert.equal(beat.consumer_tmp_leftovers_kb, String(leftoverKb), "the sum of each entry's own size");
  assert.equal(beat.consumer_tmp_leftovers_device, "/dev/account,/dev/system");
  assert.equal(beat.consumer_walk_budget_exhausted, undefined);

  const cut = measure({ accountEntries: 3, systemEntries: 2, slowSystem: true });
  assert.equal(cut.duLeftover.length, 2, "the slow root's walk started");
  assert.equal(cut.beat.consumer_tmp_leftovers_kb, "unknown", "the fast root's sum is never published as a partial total");
  assert.equal(cut.beat.consumer_walk_state, "budget_exhausted");
  assert.equal(cut.beat.consumer_walk_budget_exhausted, "tmp_leftovers,hand_worktrees");

  const none = measure({ accountEntries: 0, systemEntries: 0 });
  assert.equal(none.beat.consumer_tmp_leftovers_kb, "unknown", "no entries is unknown, never 0");
  assert.equal(none.beat.consumer_tmp_leftovers_device, "unknown");
});

test("W1-T13190 criterion 3: every other consumer's line is unchanged", () => {
  const { beat, other } = measure({ accountEntries: 5, systemEntries: 5 });
  assert.equal(beat.consumer_tsx_cache_kb, String(other.tsx_cache));
  assert.equal(beat.consumer_coverage_kb, String(other.coverage + 2), "coverage keeps its two live roots' extra read");
  assert.equal(beat.consumer_scratch_kb, String(other.scratch + 1), "scratch adds the live temp path's stubbed 1 KB");
  assert.equal(beat.consumer_hand_worktrees_kb, String(other.hand_worktrees));
  assert.equal(beat.consumer_tsx_cache_device, "/dev/account");
  assert.equal(beat.consumer_hand_worktrees_device, "/dev/root");
  for (const name of ["docker", "containerd", "npm_cache"])
    assert.equal(beat[`consumer_${name}_kb`], "unknown", `${name} keeps its unknown rule`);
});
