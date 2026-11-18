import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { parseHeartbeatPayload } from "#src/lib/host-resource-gardener.js";
import { makeTempDir } from "#src/lib/tmp.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const consumers = ["tsx_cache", "tmp_leftovers", "hand_worktrees"] as const;
const roots = ["account-tmp", "system-tmp", "scratch-tmp"] as const;

function nativeKb(path: string): number {
  const result = spawnSync("sh", ["-c", 'command -p du -sk "$1"', "du", path], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return Number(result.stdout.trim().split(/\s+/)[0]);
}

function measure(opts: { missing?: boolean; missingScratch?: boolean; duplicateTmp?: boolean; slow?: string; blind?: boolean } = {}) {
  const dir = makeTempDir("heartbeat-extra-consumers");
  try {
    for (const path of ["bin", "scripts", "home", "root/state", ...roots])
      mkdirSync(join(dir, path), { recursive: true });
    const sizes = { tsx_cache: 0, tmp_leftovers: 0, hand_worktrees: 0, coverage: 0 };
    const selected: Record<string, string[]> = { tsx_cache: [], tmp_leftovers: [], hand_worktrees: [] };
    const seed = (path: string) => {
      mkdirSync(join(dir, path), { recursive: true });
      writeFileSync(join(dir, path, "data"), Buffer.alloc(8192, 1));
      return join(dir, path);
    };
    if (!opts.missing) {
      for (const root of roots) {
        if (opts.missingScratch && root === "scratch-tmp") continue;
        for (const name of ["tsx-1000", "tsx-2000"])
          selected.tsx_cache.push(seed(`${root}/${name}`));
        for (const name of ["rmd-one", "remudero-two"])
          selected.tmp_leftovers.push(seed(`${root}/${name}`));
        const file = join(dir, root, "rmd-record");
        writeFileSync(file, Buffer.alloc(16384, 1));
        selected.tmp_leftovers.push(file);
        const coverage = seed(`${root}/rmd-c-coverage`);
        if (root === (opts.duplicateTmp ? "system-tmp" : "account-tmp")) sizes.coverage = nativeKb(coverage);
        seed(`${root}/tsx-owner`);
        seed(`${root}/unrelated/tsx-3000`);
        seed(`${root}/unrelated/rmd-nested`);
        writeFileSync(join(dir, root, "tsx-4000"), Buffer.alloc(32768, 1));
      }
      selected.hand_worktrees.push(seed("home/rmd-work"));
      for (const name of consumers)
        sizes[name] = selected[name].filter(path => !opts.duplicateTmp || !path.startsWith(join(dir, "account-tmp")))
          .reduce((sum, path) => sum + nativeKb(path), 0);
    }
    if (opts.missing || opts.missingScratch) {
      rmSync(join(dir, "scratch-tmp"), { recursive: true });
    }

    // Relocate only the two absolute temp roots; keep production globbing and measurement code.
    // The fixture's du refuses native walks outside its own namespace.
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
    stub("findmnt", "exit 1");
    stub("ionice", 'shift 2; exec "$@"');
    const epoch = spawnSync("date", ["+%s"], { encoding: "utf8" }).stdout.trim();
    stub("date", `
if [ "$*" = +%s ]; then
  if [ -e "$FIXTURE/budget-spent" ]; then printf '%s\\n' $((${epoch} + 2)); else printf '%s\\n' ${epoch}; fi
else command -p date "$@"; fi`);
    stub("df", `
p="\${@: -1}"
[ "\${BLIND:-}" != 1 ] || exit 1
case "$p" in
  "$FIXTURE"/account-tmp/*) device=/dev/account ;;
  "$FIXTURE"/system-tmp/*) device=/dev/system ;;
  "$FIXTURE"/scratch-tmp/*) device=/dev/scratch ;;
  "$HOME"/rmd-work) [ -e "$p" ] || exit 1; device=/dev/home ;;
  *) device=/dev/root ;;
esac
printf 'Filesystem 1024-blocks Used Available Capacity Mounted\\n%s 100000 1000 99000 1%% /\\n' "$device"`);
    // One du may walk several entries of a root (W1-T13190): record each path operand and its
    // grouped call, and stop at the slow path so later operands are not admitted.
    stub("du", `
args=()
for a in "$@"; do
  case "$a" in "$FIXTURE"/*|"$HOME"/*)
    args+=("$a")
    printf '%s\\n' "$a" >> "$FIXTURE/walks"
    if [ "$a" = "$FIXTURE/\${SLOW:-never}" ]; then touch "$FIXTURE/budget-spent"; exec sleep 10; fi
    ;;
  esac
done
printf '%s\\t' "\${args[@]}" >> "$FIXTURE/du-calls"; printf '\\n' >> "$FIXTURE/du-calls"
p="\${@: -1}"
case "$p" in
  "$FIXTURE"/account-tmp/*|"$FIXTURE"/system-tmp/*|"$FIXTURE"/scratch-tmp/*|"$HOME"/rmd-work)
    command -p du "$@" ;;
  "$FIXTURE"/*) printf '1\\t%s\\n' "$p" ;;
  *) exit 1 ;;
esac`);
    const result = spawnSync("bash", [script], {
      encoding: "utf8", timeout: 30_000,
      env: {
        ...process.env, PATH: `${join(dir, "bin")}:${process.env.PATH ?? ""}`,
        FIXTURE: dir, HOME: join(dir, "home"), RMD_ROOT: join(dir, "root"),
        TMPDIR: join(dir, opts.duplicateTmp ? "system-tmp" : "account-tmp"),
        RMD_HEARTBEAT_LOCK_HELD: "1", RMD_HEARTBEAT_DRY_RUN: "1",
        RMD_HEARTBEAT_DOCKER: join(dir, "bin/docker"),
        RMD_HEARTBEAT_SYSTEMCTL: join(dir, "bin/systemctl"),
        RMD_CONSUMER_WALK_BUDGET_S: opts.slow ? "2" : "120",
        SLOW: opts.slow ?? "", BLIND: opts.blind ? "1" : "",
      },
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    return {
      beat: parseHeartbeatPayload(result.stdout), sizes,
      walks: readFileSync(join(dir, "walks"), "utf8").trim().split("\n").map(path => path.slice(dir.length + 1)),
      duCalls: existsSync(join(dir, "du-calls"))
        ? readFileSync(join(dir, "du-calls"), "utf8").trim().split("\n").filter(Boolean).map(line =>
          line.split("\t").filter(Boolean).map(path => path.slice(dir.length + 1)))
        : [],
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("W1-T12258 criterion 1: tsx directories under all three temp roots are summed once", () => {
  for (const duplicateTmp of [false, true]) {
    const { beat, sizes, walks } = measure({ duplicateTmp });
    assert.equal(beat.consumer_tsx_cache_kb, String(sizes.tsx_cache));
    const paths = walks.filter(path => /\/tsx-[0-9]/.test(path));
    assert.equal(paths.length, duplicateTmp ? 4 : 6);
    assert.equal(new Set(paths).size, paths.length);
    assert.ok(!walks.some(path => path.includes("tsx-owner") || path.includes("tsx-4000") || path.includes("unrelated/")));
  }
});

test("W1-T12258 criterion 2: direct temp leftovers exclude coverage trees", () => {
  const { beat, sizes, walks, duCalls } = measure();
  assert.equal(beat.consumer_tmp_leftovers_kb, String(sizes.tmp_leftovers));
  assert.equal(beat.consumer_coverage_kb, String(sizes.coverage + 2));
  assert.equal(walks.filter(path => path.endsWith("/rmd-c-coverage")).length, 1,
    "only the existing coverage consumer walks its tree");
  const leftoverCalls = duCalls.filter(call => call.some(path => /\/(rmd-one|remudero-two|rmd-record)$/.test(path)));
  assert.equal(leftoverCalls.length, 3, "one bounded du walk per temp root, not one per leftover entry");
  assert.ok(leftoverCalls.every(call => call.filter(path => /\/(rmd-one|remudero-two|rmd-record)$/.test(path)).length === 3));
});

test("W1-T12258 criterion 3: hand worktrees measure the account's rmd-work directory", () => {
  const { beat, sizes, walks } = measure();
  assert.equal(beat.consumer_hand_worktrees_kb, String(sizes.hand_worktrees));
  assert.equal(walks.filter(path => path === "home/rmd-work").length, 1);
});

test("W1-T12258 criterion 4: devices accompany sizes and missing paths add no size", () => {
  const { beat } = measure();
  for (const name of ["tsx_cache", "tmp_leftovers"])
    assert.equal(beat[`consumer_${name}_device`], "/dev/account,/dev/scratch,/dev/system");
  assert.equal(beat.consumer_hand_worktrees_device, "/dev/home");
  const partial = measure({ missingScratch: true });
  for (const name of ["tsx_cache", "tmp_leftovers"] as const) {
    assert.equal(partial.beat[`consumer_${name}_kb`], String(partial.sizes[name]));
    assert.equal(partial.beat[`consumer_${name}_device`], "/dev/account,/dev/system");
  }
  const missing = measure({ missing: true }).beat;
  const blind = measure({ blind: true });
  for (const name of consumers) {
    assert.equal(missing[`consumer_${name}_kb`], "unknown");
    assert.equal(missing[`consumer_${name}_device`], "unknown");
    assert.equal(blind.beat[`consumer_${name}_kb`], String(blind.sizes[name]));
    assert.equal(blind.beat[`consumer_${name}_device`], "unknown");
  }
});

test("W1-T12258 criterion 5: each new consumer shares the walk deadline and reports a cut as unknown", () => {
  const paths = ["account-tmp/tsx-1000", "account-tmp/rmd-one", "home/rmd-work"];
  for (const [index, slow] of paths.entries()) {
    const { beat, duCalls } = measure({ slow });
    assert.ok(duCalls.at(-1)?.includes(slow), "the slow path's bounded walk started and no later du was admitted");
    assert.equal(beat.consumer_walk_state, "budget_exhausted");
    assert.equal(beat.consumer_walk_budget_exhausted, consumers.slice(index).join(","));
    for (const name of consumers.slice(index))
      assert.equal(beat[`consumer_${name}_kb`], "unknown", `${name} cannot report a partial size or zero`);
    for (const name of consumers.slice(0, index))
      assert.match(beat[`consumer_${name}_kb`], /^[1-9][0-9]*$/);
  }
});
