import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { monitorEventLoopDelay } from "node:perf_hooks";
import type { Clock } from "../src/lib/clock.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  buildDaemonHealthRoute,
  createEventLoopLagMonitor,
  parsePressure,
  readHostPressure,
  type DaemonHealthSnapshot,
} from "../src/lib/daemon-health.js";

// W1-T4102 — MEASURED 2026-09-23: one worker's four parallel coverage suites swapped
// remudero-serve out and every console tab timed out. The fix is the containers' cgroups: serve's
// memory is protected and its CPU weight is above every build daemon, and each build daemon has a
// memory ceiling that leaves serve's reserve free. These tests run the real launchers against a
// fake `docker` that records its argv, and a fake /proc/meminfo.

const REPO_ROOT = join(import.meta.dirname, "..");
const BASH = ["/opt/homebrew/opt/bash/bin/bash", "/usr/local/bin/bash", "/usr/bin/bash", "/bin/bash"].find(existsSync) ?? "bash";
const HOST_MIB = 15988;

function meminfo(dir: string, mib: number): string {
  const path = join(dir, "meminfo");
  writeFileSync(path, `MemTotal:       ${mib * 1024} kB\nMemFree:          100000 kB\n`);
  return path;
}

function recordingDocker(binDir: string): string {
  const calls = join(binDir, "..", "calls.tsv");
  writeFileSync(
    join(binDir, "docker"),
    [
      "#!/usr/bin/env bash",
      'printf "docker" >> "$RMD_TEST_CALLS"; for a in "$@"; do printf "\\t%s" "$a" >> "$RMD_TEST_CALLS"; done; printf "\\n" >> "$RMD_TEST_CALLS"',
      'if [ "$1" = "network" ]; then exit 0; fi',
      'if [ "$1" = "inspect" ] && [ "$2" != "--format" ]; then exit 1; fi',
      'if [ "$1" = "inspect" ] && [ "$2" = "--format" ] && [[ "$3" == *Mounts* ]]; then',
      '  printf "%s\\t/home/node/Remudero\\ttrue\\n" "$RMD_STATE_DIR"; printf "%s\\t/home/node/.claude\\ttrue\\n" "$RMD_CLAUDE_DIR"; exit 0',
      "fi",
      'if [ "$1" = "inspect" ] && [ "$2" = "--format" ]; then printf "sha256:PULLEDID\\n"; exit 0; fi',
      'if [ "$1" = "image" ] && [ "$2" = "inspect" ]; then printf "sha256:PULLEDID\\n"; exit 0; fi',
      'if [ "$1" = "pull" ]; then exit 0; fi',
      "exit 0",
      "",
    ].join("\n"),
  );
  writeFileSync(join(binDir, "az"), "#!/usr/bin/env bash\nexit 0\n");
  chmodSync(join(binDir, "docker"), 0o755);
  chmodSync(join(binDir, "az"), 0o755);
  writeFileSync(calls, "");
  return calls;
}

function dockerRun(callsFile: string): string[] {
  const call = readFileSync(callsFile, "utf8").split("\n").filter(Boolean).map((l) => l.split("\t"))
    .find(([bin, verb]) => bin === "docker" && verb === "run");
  assert.ok(call, "the launcher never reached docker run");
  return call.slice(2);
}

function recycle(hostMib: number | undefined): { args: string[]; output: string } {
  const root = mkdtempSync(join(tmpdir(), "rmd-build-ceiling-"));
  try {
    const bin = join(root, "bin");
    mkdirSync(bin);
    mkdirSync(join(root, "state"));
    mkdirSync(join(root, "claude"));
    const calls = recordingDocker(bin);
    const r = spawnSync(BASH, [join(REPO_ROOT, "deploy", "recycle-container.sh")], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        GH_TOKEN: "test-token",
        RMD_TEST_CALLS: calls,
        RMD_STATE_DIR: join(root, "state"),
        RMD_CLAUDE_DIR: join(root, "claude"),
        RMD_CODEX_DIR: join(root, "codex-absent"),
        RMD_CONTAINER_CONFIG_DIR: join(root, "config-absent"),
        RMD_RECYCLE_FIRST_BOOT: "1",
        RMD_RECYCLE_WAIT_S: "1",
        RMD_RECYCLE_POLL_S: "1",
        RMD_RECYCLE_DOCKERENV_PATH: join(root, "no-dockerenv"),
        RMD_MEMINFO_PATH: hostMib === undefined ? join(root, "no-meminfo") : meminfo(root, hostMib),
      },
    });
    const output = `${r.stdout ?? ""}${r.stderr ?? ""}`;
    return { args: dockerRun(calls), output };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function serveDryRun(env: Record<string, string> = {}): { status: number | null; out: string } {
  const root = mkdtempSync(join(tmpdir(), "rmd-serve-share-"));
  try {
    const bin = join(root, "bin");
    mkdirSync(bin);
    mkdirSync(join(root, "state"));
    mkdirSync(join(root, "code"));
    recordingDocker(bin);
    const r = spawnSync(BASH, [join(REPO_ROOT, "deploy", "serve-container.sh"), "--dry-run"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        GH_TOKEN: "test-token",
        RMD_TEST_CALLS: join(root, "calls.tsv"),
        RMD_STATE_DIR: join(root, "state"),
        RMD_SERVE_REPO_DIR: join(root, "code"),
        RMD_SERVE_DOCKER_NETWORK: "rmd-test-net",
        RMD_SERVE_DOCKERENV_PATH: join(root, "no-dockerenv"),
        ...env,
      },
    });
    return { status: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const shares = (args: readonly string[]) => Number(args.find((a) => a.startsWith("--cpu-shares="))?.split("=")[1]);

test("W1-T4102: serve is launched with protected memory and a higher cpu weight than the daemons", () => {
  const serve = serveDryRun();
  assert.equal(serve.status, 0, serve.out);
  const line = serve.out.split("\n").find((l) => l.includes("docker run -d --name remudero-serve")) ?? "";
  const serveArgs = line.split(/\s+/);
  // Operator ruling 2026-10-19: --memory-reservation (memory.low) protected nothing — system.slice holds
  // memory.low=0 and the kernel caps a cgroup's effective low by its ancestors' — so it is gone, and
  // serve's share is its own memory.high, which reclaim does not push below while the host has room.
  assert.ok(!serveArgs.some((a) => a.startsWith("--memory-reservation")), `no ineffective memory.low: ${line}`);
  assert.ok(serveArgs.some((a) => a.startsWith("--annotation=org.systemd.property.MemoryHigh=")), `serve's share is its memory.high: ${line}`);
  const build = recycle(HOST_MIB).args;
  assert.ok(shares(serveArgs) > shares(build), `serve ${shares(serveArgs)} must outweigh a build daemon ${shares(build)}`);
});

function serveRunArgs(env: Record<string, string> = {}): { args: string[]; out: string } {
  const serve = serveDryRun(env);
  assert.equal(serve.status, 0, serve.out);
  return { args: (serve.out.split("\n").find((l) => l.includes("docker run -d --name remudero-serve")) ?? "").split(/\s+/), out: serve.out };
}

test("serve's memory ceiling fits an active generation and a booting standby during a handoff", () => {
  // Measured 2026-10-02 (E31): the active generation peaks at 5.28 GB with swap, a booting standby at 1.55 GB, plus
  // 0.15 GB supervisor overhead. Under a 5 GiB ceiling handoffs deferred for memory and fell back to legacy exits.
  const { args } = serveRunArgs();
  const mib = (flag: string): number => Number(args.find((a) => a.startsWith(`${flag}=`))?.slice(flag.length + 1).replace(/m$/, ""));
  const needMib = (5.28 + 1.55 + 0.15) * 1e9 / 2 ** 20;
  assert.ok(mib("--memory") >= needMib, `ceiling ${mib("--memory")} MiB holds two generations (${Math.round(needMib)} MiB)`);
});

test("serve is launched with a memory ceiling that bounds a leak and leaves room to swap", () => {
  const { args, out } = serveRunArgs();
  assert.ok(args.includes("--memory=7680m"), `a 7.5 GiB ceiling: an active generation (5.28 GB with swap) plus a booting standby (1.55 GB) during a handoff: ${args.join(" ")}`);
  assert.ok(args.some((a) => a.startsWith("--memory-swap=")), "room to swap before the kernel kills anything");
  assert.ok(!args.some((a) => a.startsWith("--cpus=")), "no CPU quota by default — the weight already wins contention");
  assert.match(out, /memory ceiling 7680 MiB \(\+\d+ MiB swap\)/);
});

test("operator ruling 2026-10-19: serve gets 2 GiB of swap and no memory reservation", () => {
  const { args, out } = serveRunArgs();
  // swap.max 1 GiB -> 2 GiB: at 1 GiB serve's swap read 95% full.
  assert.ok(args.includes("--memory-swap=9728m"), `2 GiB of swap over the 7.5 GiB ceiling: ${args.join(" ")}`);
  assert.ok(!args.some((a) => a.startsWith("--memory-reservation")), "no ineffective memory.low reservation");
  assert.match(out, /memory ceiling 7680 MiB \(\+2048 MiB swap\)/);
});

test("operator ruling 2026-10-19: serve runs the semi-space flag and the glibc malloc tuning, with no other NODE_OPTIONS", () => {
  const { args, out } = serveRunArgs();
  const env = args.flatMap((a, i) => (args[i - 1] === "-e" ? [a] : []));
  assert.deepEqual(env.filter((e) => e.startsWith("NODE_OPTIONS=")), ["NODE_OPTIONS=--max-semi-space-size=16"]);
  assert.deepEqual(env.filter((e) => e.startsWith("GLIBC_TUNABLES=")), ["GLIBC_TUNABLES=glibc.malloc.arena_max=2:glibc.malloc.trim_threshold=131072"]);
  assert.match(out, /resource policy — serve: cpu-shares 4096, no memory\.low, NODE_OPTIONS --max-semi-space-size=16, GLIBC_TUNABLES glibc\.malloc\.arena_max=2/);
});

test("operator ruling 2026-10-19: the policy merges its semi-space flag into any NODE_OPTIONS exactly once", () => {
  const merge = (value: string): string => {
    const r = spawnSync(BASH, ["-c", 'set -u; source "$1"; resource_policy_node_options "$2"', "p", join(REPO_ROOT, "deploy", "resource-policy.sh"), value], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout;
  };
  assert.equal(merge(""), "--max-semi-space-size=16", "serve: the flags are the whole value");
  assert.equal(merge("--max-old-space-size=8192"), "--max-old-space-size=8192 --max-semi-space-size=16", "the heap ceiling stays first");
  assert.equal(merge("--max-semi-space-size=64 --max_semi_space_size 32 --enable-source-maps"), "--enable-source-maps --max-semi-space-size=16", "both spellings and the two-word form are replaced");
  assert.equal(merge("--max-semi-space-size --trace-warnings"), "--trace-warnings --max-semi-space-size=16", "a two-word form never swallows a following flag");
});

test("operator ruling 2026-10-19: the rollback lever — emptied ruled values add nothing and drop a carried semi-space flag", () => {
  const r = spawnSync(BASH, ["-c", [
    'set -u; source "$1"; RESOURCE_POLICY_NODE_MEMORY_FLAGS=; RESOURCE_POLICY_GLIBC_TUNABLES=',
    'printf "merge=[%s]\\n" "$(resource_policy_node_options "--max-old-space-size=8192 --max-semi-space-size=16")"',
    'resource_policy_serve_args; printf "serve=%s\\n" "${RESOURCE_POLICY_SERVE_ARGS[*]}"; printf "note=%s\\n" "$RESOURCE_POLICY_NOTE"',
    'resource_policy_build_args; printf "build=%s\\n" "${RESOURCE_POLICY_BUILD_ARGS[*]}"',
  ].join("\n"), "p", join(REPO_ROOT, "deploy", "resource-policy.sh")], { encoding: "utf8", env: { ...process.env, RMD_MEMINFO_PATH: "/nonexistent" } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^merge=\[--max-old-space-size=8192\]$/m, "the heap ceiling alone, no trailing space");
  assert.match(r.stdout, /^serve=--cpu-shares=4096 --memory=7680m --memory-swap=9728m$/m, "no -e at all");
  assert.match(r.stdout, /^note=serve: cpu-shares 4096, no memory\.low, NODE_OPTIONS none, GLIBC_TUNABLES none/m);
  assert.match(r.stdout, /^build=--cpu-shares=512$/m);
});

test("operator ruling 2026-10-19: every build daemon launch carries the glibc malloc tuning", () => {
  const { args } = recycle(HOST_MIB);
  assert.ok(args.includes("GLIBC_TUNABLES=glibc.malloc.arena_max=2:glibc.malloc.trim_threshold=131072"), args.join(" "));
  assert.ok(args.some((a) => (a.startsWith("NODE_OPTIONS=") && a.endsWith(" --max-semi-space-size=16")) || a === "NODE_OPTIONS=--max-semi-space-size=16"), args.join(" "));
  // Dropping serve's memory.low leaves the build ceiling's arithmetic alone: serve's share still sizes it.
  assert.ok(args.includes(`--memory=${HOST_MIB - 5120 - 2048}m`));
});

test("the serve memory ceiling and a CPU quota are operator knobs without a code change", () => {
  const off = serveRunArgs({ RMD_SERVE_MEMORY_LIMIT_MIB: "0" });
  assert.ok(!off.args.some((a) => a.startsWith("--memory=")), "0 turns the ceiling off");
  assert.match(off.out, /NO memory ceiling/);
  const below = serveRunArgs({ RMD_SERVE_MEMORY_LIMIT_MIB: "1024" });
  assert.ok(!below.args.some((a) => a.startsWith("--memory=")), "a ceiling under the protected reserve is refused, not applied");
  const tuned = serveRunArgs({ RMD_SERVE_MEMORY_LIMIT_MIB: "6144", RMD_SERVE_CPUS: "4" });
  assert.ok(tuned.args.includes("--memory=6144m") && tuned.args.includes("--memory-swap=8192m"));
  assert.ok(tuned.args.includes("--cpus=4"));
});

test("W1-T4102: every build daemon is launched with a memory ceiling that leaves the host reserve free", () => {
  const { args, output } = recycle(HOST_MIB);
  const ceiling = HOST_MIB - 5120 - 2048;
  assert.ok(args.includes(`--memory=${ceiling}m`), `ceiling = host - serve reserve - overhead:\n${args.join(" ")}`);
  assert.ok(args.includes(`--memory-swap=${ceiling + 4096}m`), "swap is bounded, so the container pages its own memory");
  assert.ok(args.includes("--cpu-shares=512"));
  assert.match(output, /resource policy — build: cpu-shares 512; memory ceiling/);
});

test("W1-T4102: the resource policy derives its ceiling from the host's memory and prints its inputs", () => {
  const small = recycle(32 * 1024);
  assert.ok(small.args.includes(`--memory=${32 * 1024 - 5120 - 2048}m`), "a bigger host gets a bigger ceiling");
  assert.match(small.output, /host 32768 MiB - serve reserve 5120 MiB - overhead 2048 MiB/);

  const unreadable = recycle(undefined);
  assert.ok(!unreadable.args.some((a) => a.startsWith("--memory=")), "no guessed ceiling when the host's memory is unknown");
  assert.ok(unreadable.args.includes("--cpu-shares=512"), "the CPU weight still applies");
  assert.match(unreadable.output, /NO memory ceiling — host MemTotal unreadable/);

  const tiny = recycle(4096);
  assert.ok(!tiny.args.some((a) => a.startsWith("--memory=")), "a host too small for the reserve gets no ceiling rather than a useless one");
  assert.match(tiny.output, /under the 2048 MiB floor/);
});

function healthBody(deps: Partial<Parameters<typeof buildDaemonHealthRoute>[0]>): DaemonHealthSnapshot {
  const route = buildDaemonHealthRoute({
    ledgerPath: "/nonexistent/ledger.ndjson",
    readLedger: () => [],
    diskPath: "/",
    statfs: () => ({ bavail: 1, bsize: 1, blocks: 1 }),
    exec: () => "{}",
    ...deps,
  });
  let body = "";
  const res = { writeHead: () => res, end: (b: string) => void (body = b) } as unknown as ServerResponse;
  void route.handler({} as IncomingMessage, res, {} as never);
  return JSON.parse(body) as DaemonHealthSnapshot;
}

test("W1-T4102: daemon health carries serve event-loop lag and host pressure", () => {
  const psi = "some avg10=61.96 avg60=68.56 avg300=72.96 total=45113116285\nfull avg10=40.10 avg60=41.00 avg300=42.00 total=1\n";
  const body = healthBody({
    eventLoopLag: () => ({ p50Ms: 1.2, p99Ms: 812, maxMs: 8045, windowMs: 60_000 }),
    hostPressure: () => readHostPressure(() => psi),
  });
  assert.deepEqual(body.eventLoopLag, { p50Ms: 1.2, p99Ms: 812, maxMs: 8045, windowMs: 60_000 });
  assert.deepEqual(body.hostPressure.io, { someAvg10: 61.96, someAvg60: 68.56, fullAvg10: 40.1 });
});

test("W1-T4102: an unreadable pressure file reads unknown, not zero", () => {
  const missing = readHostPressure(() => {
    throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  });
  assert.deepEqual(missing, { cpu: "unknown", io: "unknown", memory: "unknown" });
  assert.equal(parsePressure("garbage"), undefined, "an unparseable file is unknown too");
  assert.deepEqual(parsePressure("some avg10=0.00 avg60=0.00 avg300=0.00 total=0\n"), { someAvg10: 0, someAvg60: 0 }, "a real zero is kept");
  const body = healthBody({ eventLoopLag: () => undefined, hostPressure: () => missing });
  assert.equal(body.hostPressure.memory, "unknown");
  assert.equal(body.eventLoopLag, undefined, "no lag reading is absent, never a zero");
});

test("the lag monitor starts on first read and rolls its window every minute", () => {
  let t = 1_000;
  let enabled = 0;
  let resets = 0;
  const fake = {
    enable: () => void enabled++,
    reset: () => void resets++,
    percentile: (p: number) => (p === 50 ? 1_000_000 : 812_000_000),
    max: 8_045_000_000,
    count: 42,
  } as unknown as ReturnType<typeof monitorEventLoopDelay>;
  const read = createEventLoopLagMonitor({ now: () => t } as Clock, () => fake);
  assert.equal(read(), undefined, "the first read only starts the monitor");
  assert.equal(enabled, 1);
  t += 30_000;
  assert.deepEqual(read(), { p50Ms: 1, p99Ms: 812, maxMs: 8045, windowMs: 30_000 });
  assert.equal(resets, 0);
  t += 30_000;
  assert.equal(read()?.windowMs, 60_000);
  assert.equal(resets, 1, "a full minute rolls the window");
  assert.equal(enabled, 1, "the monitor is started once");
});

test("the real lag monitor measures a blocked event loop", async () => {
  const read = createEventLoopLagMonitor();
  read();
  await new Promise((r) => setTimeout(r, 30));
  const until = Date.now() + 120;
  while (Date.now() < until) { /* block the loop */ }
  await new Promise((r) => setTimeout(r, 30));
  const lag = read();
  assert.ok(lag && lag.maxMs >= 80, `a 120 ms block shows as lag, got ${JSON.stringify(lag)}`);
});
