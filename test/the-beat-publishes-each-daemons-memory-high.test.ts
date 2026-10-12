import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { makeTempDir } from "../src/lib/tmp.js";
import { REAL_SCRIPT } from "./helpers/fleet-heartbeat-harness.js";

const MIB = 1024 * 1024;
const CORE_ID = "a2de44c57d10f524349c8dc666cfa31ce685e668e32ea4b502061057ba820803";
const CONSOLE_ID = "46794206b53f5b0df64ee3f4f60ae78cdd1cd1ba404cb529032466fecda188b8";
const SITE_ID = "bc97ccaa94377675f602d4f65ff66208e177359cfaf2254101018b2470798c13";

interface Run {
  beat: Record<string, string>;
  snapshot?: string;
}

/**
 * One beat over fixture cgroup files shaped like the fleet host on 2026-10-10: core pinned at 95% of
 * its memory.max with a tuner record, console never tuned, site's cgroup unreadable.
 */
function beatOnce(opts: { prevAgoS?: number; prevCoreId?: string; publish?: boolean; consoleHighMib?: number; registry?: "repo" | "env" } = {}): Run {
  const dir = makeTempDir("heartbeat-mem");
  try {
    for (const path of ["bin", "scripts", "home", "state-root/state", "tmp", "scratch"]) mkdirSync(join(dir, path), { recursive: true });
    const script = join(dir, "scripts", "fleet-heartbeat.sh");
    writeFileSync(script, readFileSync(REAL_SCRIPT), { mode: 0o755 });

    const cg = join(dir, "cgroup");
    const scope = (id: string) => join(cg, "system.slice", `docker-${id}.scope`);
    const memory = (id: string, f: { high: string; max: string; current: number; anon: number; file: number; high_events: number; refault: number }) => {
      mkdirSync(scope(id), { recursive: true });
      writeFileSync(join(scope(id), "memory.high"), `${f.high}\n`);
      writeFileSync(join(scope(id), "memory.max"), `${f.max}\n`);
      writeFileSync(join(scope(id), "memory.current"), `${f.current}\n`);
      writeFileSync(join(scope(id), "memory.events"), `low 0\nhigh ${f.high_events}\nmax 0\noom 0\noom_kill 0\n`);
      writeFileSync(join(scope(id), "memory.stat"), `anon ${f.anon}\nfile ${f.file}\nkernel 1000\nworkingset_refault_anon 5\nworkingset_refault_file ${f.refault}\n`);
    };
    memory(CORE_ID, { high: String(8379 * MIB), max: String(8820 * MIB), current: 5690 * MIB, anon: 4146 * MIB, file: 1309 * MIB, high_events: 403_335, refault: 12_518_220 });
    memory(CONSOLE_ID, { high: String((opts.consoleHighMib ?? 2560) * MIB), max: "max", current: 1946 * MIB, anon: 1607 * MIB, file: 278 * MIB, high_events: 0, refault: 14_289 });

    const state = join(dir, "state-root/state");
    writeFileSync(join(state, "memory-high-tuned-remudero-daemon.json"),
      '{"container":"remudero-daemon","high_mib":8379,"policy_mib":8192,"updated_at":"2026-10-09T23:34:01Z","reason":"grow: 174611 high events and 10132 MiB of file refaults per 5 min; step bounded by half the 5415 MiB headroom above two reserves"}\n');
    writeFileSync(join(state, "ledger.ndjson"), [
      '{"ts":"2026-10-09T22:00:00.000Z","run_id":"HOST-MEMORY-HIGH","task_id":"HOST","step":"host.memory_high.adjusted","lane":"host","container":"remudero-site-daemon","action":"grow","before_mib":1536,"after_mib":1792,"policy_mib":1536,"tier":0,"write":"systemd","reason":"older"}',
      '{"ts":"2026-10-09T22:30:00.000Z","run_id":"HOST-MEMORY-HIGH","task_id":"HOST","step":"host.memory_high.adjusted","lane":"host","container":"remudero-site-daemon","action":"shrink","before_mib":1792,"after_mib":1536,"policy_mib":1536,"tier":3,"write":"systemd","reason":"tier 3 (host pressure)"}',
    ].join("\n") + "\n");
    // Each instance's own state root, as the launchers read it from the registry: core lives at
    // RMD_ROOT, console in a state_dir of its own — where its tuner records what it did.
    if (opts.registry) {
      const consoleState = join(dir, "console-state", "state");
      mkdirSync(consoleState, { recursive: true });
      writeFileSync(join(consoleState, "memory-high-tuned-remudero-console-daemon.json"),
        '{"container":"remudero-console-daemon","high_mib":2816,"policy_mib":2048,"updated_at":"2026-10-10T02:12:41Z","reason":"grow: 24 high events and 1 MiB of file refaults per 5 min; step bounded by half the 3869 MiB headroom above two reserves"}\n');
      const registry = join(dir, opts.registry === "repo" ? ".remudero" : "elsewhere", "daemon-instances.yaml");
      mkdirSync(join(registry, ".."), { recursive: true });
      writeFileSync(registry, [
        "instances:",
        "  core:",
        "    repo: remudero",
        "    container_name: remudero-daemon",
        `    state_dir: ${join(dir, "state-root")}`,
        "  console:",
        "    repo: remudero-console  # the console app",
        "    container_name: remudero-console-daemon",
        `    state_dir: ${join(dir, "console-state")}`,
      ].join("\n") + "\n");
    }
    const prevAgoS = opts.prevAgoS ?? 300;
    if (prevAgoS > 0) {
      writeFileSync(join(state, "heartbeat-mem.txt"), [
        `epoch ${Math.floor(Date.now() / 1000) - prevAgoS}`,
        `cg remudero-daemon ${opts.prevCoreId ?? CORE_ID} 403000 12384706`,
        `cg remudero-console-daemon ${CONSOLE_ID} 0 14289`,
      ].join("\n") + "\n");
    }
    writeFileSync(join(state, "heartbeat-count.txt"), "1");

    const stub = (name: string, body: string) => writeFileSync(join(dir, "bin", name), `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
    stub("git", 'printf "fixture-sha\\n"');
    stub("uname", 'printf "Linux\\n"');
    stub("docker", `
case "$1" in
  ps) printf '%s %s\\n' "${CORE_ID}" remudero-daemon "${CONSOLE_ID}" remudero-console-daemon "${SITE_ID}" remudero-site-daemon 31335f60 cloudflared ;;
  inspect)
    case "$*" in
      *"org.systemd.property.MemoryHigh"*)
        printf '/remudero-daemon uint64 %s\\n/remudero-console-daemon uint64 %s\\n/remudero-site-daemon <no value>\\n' ${8379 * MIB} ${2560 * MIB} ;;
      *) exit 1 ;;
    esac ;;
  *) exit 1 ;;
esac`);

    const result = spawnSync("bash", [script], {
      encoding: "utf8",
      timeout: 20_000,
      env: {
        ...process.env,
        PATH: `${join(dir, "bin")}:${process.env.PATH ?? ""}`,
        HOME: join(dir, "home"),
        TMPDIR: join(dir, "tmp"),
        RMD_ROOT: join(dir, "state-root"),
        RMD_SCRATCH_ROOT: join(dir, "scratch"),
        RMD_HEARTBEAT_LOCK_HELD: "1",
        RMD_HEARTBEAT_DRY_RUN: opts.publish ? "" : "1",
        RMD_HEARTBEAT_BRANCH: "heartbeat-mem-fixture",
        RMD_HEARTBEAT_DOCKER: join(dir, "bin", "docker"),
        RMD_HEARTBEAT_CONTAINER: "none",
        RMD_DISKSTATS: join(dir, "no-diskstats"),
        RMD_CGROUP_ROOT: cg,
        RMD_JANITOR_LOGS: join(dir, "none.log"),
        RMD_INSTANCE_REGISTRY: opts.registry === "env" ? join(dir, "elsewhere", "daemon-instances.yaml") : "",
      },
    });
    assert.equal(result.status, 0, `${result.error ?? ""}\n${result.stderr}`);
    const beat = Object.fromEntries(result.stdout.split("\n").filter((line) => line.includes("="))
      .map((line) => { const at = line.indexOf("="); return [line.slice(0, at), line.slice(at + 1)]; }));
    const snapshotPath = join(state, "heartbeat-mem.txt");
    return { beat, ...(existsSync(snapshotPath) ? { snapshot: readFileSync(snapshotPath, "utf8") } : {}) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("the beat publishes each daemon's live and policy memory.high, memory.max, current and anon", () => {
  const { beat } = beatOnce();
  assert.equal(beat.mem_containers, "remudero-daemon,remudero-console-daemon,remudero-site-daemon", "daemons only, never cloudflared");
  assert.equal(beat["mem_remudero-daemon_high_mib"], "8379");
  assert.equal(beat["mem_remudero-daemon_max_mib"], "8820");
  assert.equal(beat["mem_remudero-daemon_policy_high_mib"], "8192", "the tuner's recorded policy, not the learned launch annotation");
  assert.equal(beat["mem_remudero-daemon_policy_source"], "tuned_state");
  assert.equal(beat["mem_remudero-daemon_current_mib"], "5690");
  assert.equal(beat["mem_remudero-daemon_anon_mib"], "4146");
  assert.equal(beat["mem_remudero-daemon_file_mib"], "1309");
  assert.equal(beat["mem_remudero-console-daemon_max_mib"], "max", "no memory.max reads max, not a number");
  assert.equal(beat["mem_remudero-console-daemon_policy_high_mib"], "2560", "never tuned: the launch annotation is the policy");
  assert.equal(beat["mem_remudero-console-daemon_policy_source"], "launch_annotation");
});

test("the beat publishes high-event and file-refault deltas over the beat, and the tuner's last word", () => {
  const { beat } = beatOnce();
  const dt = Number(beat.mem_interval_s);
  assert.ok(dt >= 300 && dt <= 305, `interval ${beat.mem_interval_s}`);
  assert.equal(beat["mem_remudero-daemon_high_events_delta"], "335");
  assert.equal(beat["mem_remudero-daemon_refault_file_pages_delta"], String(12_518_220 - 12_384_706));
  assert.equal(beat["mem_remudero-console-daemon_high_events_delta"], "0", "a measured zero stays zero");
  assert.equal(beat["mem_remudero-daemon_tuner_action"], "grow");
  assert.equal(beat["mem_remudero-daemon_tuner_ts"], "2026-10-09T23:34:01Z");
  assert.match(beat["mem_remudero-daemon_tuner_reason"] ?? "", /^174611 high events and 10132 MiB of file refaults per 5 min/);
  assert.equal(beat["mem_remudero-console-daemon_tuner_action"], "none");
  assert.equal(beat["mem_remudero-site-daemon_tuner_action"], "shrink", "no state file: the latest ledger row");
  assert.equal(beat["mem_remudero-site-daemon_tuner_reason"], "tier 3 (host pressure)");
  assert.equal(beat["mem_remudero-site-daemon_policy_high_mib"], "1536");
});

test("an unreadable cgroup, a first beat and a recycled container publish unknown, never a zero", () => {
  const { beat } = beatOnce();
  for (const key of ["high_mib", "max_mib", "current_mib", "anon_mib", "high_events_delta", "refault_file_pages_delta"])
    assert.equal(beat[`mem_remudero-site-daemon_${key}`], "unknown", key);
  const first = beatOnce({ prevAgoS: 0 }).beat;
  assert.equal(first.mem_interval_s, "unknown");
  assert.equal(first["mem_remudero-daemon_high_events_delta"], "unknown");
  assert.equal(first["mem_remudero-daemon_refault_file_pages_delta"], "unknown");
  assert.equal(first["mem_remudero-daemon_high_mib"], "8379", "levels need no previous beat");
  const recycled = beatOnce({ prevCoreId: CONSOLE_ID }).beat;
  assert.equal(recycled["mem_remudero-daemon_high_events_delta"], "unknown", "a new container id starts its counters from zero");
  assert.equal(recycled["mem_remudero-console-daemon_refault_file_pages_delta"], "0");
});

test("a published beat keeps the raw counters so the next beat can take a delta", () => {
  const { snapshot } = beatOnce({ publish: true });
  assert.ok(snapshot, "the published beat must write state/heartbeat-mem.txt");
  assert.match(snapshot, /^epoch [0-9]+$/m);
  assert.match(snapshot, new RegExp(`^cg remudero-daemon ${CORE_ID} 403335 12518220$`, "m"));
  assert.doesNotMatch(snapshot, /remudero-site-daemon/, "an unreadable cgroup leaves no counters to subtract from");
  assert.match(beatOnce().snapshot ?? "", /403000/, "a dry run leaves the previous counters alone");
});

test("each instance's tuner record is read from its own registry state_dir, not the heartbeat's root", () => {
  for (const registry of ["repo", "env"] as const) {
    const { beat } = beatOnce({ consoleHighMib: 2816, registry });
    assert.equal(beat["mem_remudero-console-daemon_tuner_action"], "grow", registry);
    assert.equal(beat["mem_remudero-console-daemon_tuner_ts"], "2026-10-10T02:12:41Z", registry);
    assert.match(beat["mem_remudero-console-daemon_tuner_reason"] ?? "", /^24 high events and 1 MiB of file refaults/);
    assert.equal(beat["mem_remudero-console-daemon_policy_high_mib"], "2048", "its recorded policy, not the learned launch annotation");
    assert.equal(beat["mem_remudero-console-daemon_policy_source"], "tuned_state");
    assert.equal(beat["mem_remudero-daemon_tuner_action"], "grow", "core's own state_dir is still read");
  }
});

test("a memory.high above policy with no tuner record found reads unknown, never none", () => {
  const { beat } = beatOnce({ consoleHighMib: 2816 });
  assert.equal(beat["mem_remudero-console-daemon_high_mib"], "2816");
  assert.equal(beat["mem_remudero-console-daemon_policy_high_mib"], "2560");
  assert.equal(beat["mem_remudero-console-daemon_tuner_action"], "unknown", "something raised it; none would be a false claim");
  assert.equal(beat["mem_remudero-console-daemon_tuner_ts"], "unknown");
  assert.equal(beatOnce().beat["mem_remudero-console-daemon_tuner_action"], "none", "at its policy with no record, none stays true");
});
