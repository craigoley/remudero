/**
 * W1-T13278: a serve replace swaps in a warm replacement before the old console stops.
 *
 * These drive the REAL deploy/serve-container.sh over a fake `docker` that keeps each container's
 * existence, running state and colour label in files and logs every call, so the order of the swap's
 * steps is read from what the script actually ran. The readiness probe the script runs inside the
 * replacement is run for real, by node, against a unix-socket server.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { readMountPlanDrift } from "#src/lib/deployer.js";
import { SMOKE_PATHS, STANDBY_READY_BOUND_MS } from "#src/lib/serve-supervisor.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const SERVE = join(REPO_ROOT, "deploy", "serve-container.sh");
const SCRATCH = join(REPO_ROOT, "deploy", "scratch-mounts.sh");
const NET = "rmd-test-net";
type Row = Record<string, unknown>;

/** A fake docker: containers are files under $FAKE/c/<name>/ (running, label); every call is one line of $FAKE/calls. */
const FAKE_DOCKER = `#!/usr/bin/env bash
F="$FAKE"; c="$F/c"; mkdir -p "$c"
printf '%s\\n' "$*" >> "$F/calls"
last="\${@: -1}"
case "$1" in
  network)
    case "$2" in
      inspect) [ "\${3:-}" = "--format" ] && printf 'cloudflared\\n'; exit 0 ;;
      connect) exit "\${CONNECT_RC:-0}" ;;
    esac ;;
  inspect)
    [ -d "$c/$last" ] || exit 1
    case "$*" in
      *State.Running*) [ -f "$c/$last/running" ] && echo true || echo false ;;
      *rmd.serve.color*) if [ -f "$c/$last/label" ]; then cat "$c/$last/label"; else echo '<no value>'; fi ;;
      *NetworkSettings.Networks*) echo yes ;;
    esac
    exit 0 ;;
  run)
    name=""; label=""; prev=""
    for a in "$@"; do
      [ "$prev" = --name ] && name="$a"
      [ "$prev" = --label ] && label="\${a#rmd.serve.color=}"
      prev="$a"
    done
    mkdir -p "$c/$name"; [ "\${RUN_DIES:-0}" = 1 ] || touch "$c/$name/running"
    [ -z "$label" ] || printf '%s\\n' "$label" > "$c/$name/label"
    exit 0 ;;
  exec)
    cat > /dev/null
    n=$(( $(cat "$F/probes" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$F/probes"
    if [ "$n" -ge "\${READY_AFTER:-1}" ]; then echo '{"ok":true}'; exit 0; fi
    echo '{"ok":false,"ready":503}'; exit 3 ;;
  stop) rm -f "$c/$last/running"; exit 0 ;;
  rm) rm -rf "\${c:?}/$last"; exit 0 ;;
  rename) mv "$c/$2" "$c/$3"; exit 0 ;;
  logs) echo 'listening on http://0.0.0.0:4317'; exit 0 ;;
  stats) echo '3GiB / 7.5GiB'; exit 0 ;;
  pull) exit 0 ;;
esac
exit 0
`;

interface Fixture {
  root: string;
  fake: string;
  scratch: string;
  run(env?: Record<string, string>, args?: string[]): { status: number | null; out: string };
  calls(): string[];
  rows(): Row[];
  live(name: string): { exists: boolean; running: boolean; label?: string };
  container(name: string, opts?: { label?: string; running?: boolean }): void;
}

function fixture(t: TestContext): Fixture {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}serve-swap-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const fake = join(root, "fake");
  const scratch = join(root, "mnt", "scratch");
  for (const dir of ["bin", "fake/c", "state/state", "serve-repo", scratch]) mkdirSync(join(dir.startsWith("/") ? "" : root, dir), { recursive: true });
  writeFileSync(join(root, "bin", "docker"), FAKE_DOCKER);
  chmodSync(join(root, "bin", "docker"), 0o755);
  writeFileSync(join(root, "bin", "az"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(root, "bin", "az"), 0o755);
  writeFileSync(join(root, "mounts"), `/dev/nvme1n1 ${scratch} ext4 rw,noatime 0 0\n`);
  writeFileSync(join(root, "scratch-mounts.on"), "");
  const container = (name: string, opts: { label?: string; running?: boolean } = {}) => {
    mkdirSync(join(fake, "c", name), { recursive: true });
    if (opts.running !== false) writeFileSync(join(fake, "c", name, "running"), "");
    if (opts.label) writeFileSync(join(fake, "c", name, "label"), `${opts.label}\n`);
  };
  container("remudero-serve");
  const base: Record<string, string | undefined> = { ...process.env };
  for (const k of ["RMD_SERVE_GENS_DIR", "RMD_SERVE_SUPERVISOR", "RMD_SCRATCH", "RMD_SERVE_BLUE_GREEN", "RMD_SERVE_BLUE_GREEN_SWITCH",
    "RMD_INSTANCE_REGISTRY", "RMD_SELECTED_INSTANCE_REGISTRY", "RMD_SERVE_REPLACE_ADMISSION", "RMD_SCRATCH_CHECKOUTS"]) delete base[k];
  return {
    root, fake, scratch,
    run: (env = {}, args = ["--replace"]) => {
      const r = spawnSync("bash", [SERVE, ...args], {
        cwd: REPO_ROOT, encoding: "utf8", timeout: 60_000,
        env: {
          ...base, PATH: `${join(root, "bin")}:${process.env.PATH ?? ""}`, HOME: root, FAKE: fake, GH_TOKEN: "fixture-token",
          RMD_STATE_DIR: join(root, "state"), RMD_SERVE_REPO_DIR: join(root, "serve-repo"),
          RMD_SERVE_DOCKER_NETWORK: NET, RMD_SERVE_DOCKERENV_PATH: join(root, "no-marker"),
          RMD_SERVE_BANNER_WAIT_S: "1", RMD_SERVE_BANNER_POLL_S: "1", RMD_SCRATCH: "off",
          RMD_CLAUDE_JSON_PATH: join(root, "absent.json"), RMD_GITHUB_WEBHOOK_SECRET_PATH: "",
          RMD_SERVE_BLUE_GREEN_POLL_S: "1", RMD_SERVE_BLUE_GREEN_READY_S: "30",
          REGISTRY: "test-registry", IMAGE: "remudero", TAG: "sha-test",
          ...env,
        },
      });
      return { status: r.status, out: `${r.stdout}${r.stderr}` };
    },
    calls: () => (existsSync(join(fake, "calls")) ? readFileSync(join(fake, "calls"), "utf8").trim().split("\n") : []),
    rows: () => {
      const path = join(root, "state", "state", "ledger.ndjson");
      return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Row) : [];
    },
    live: (name) => ({
      exists: existsSync(join(fake, "c", name)),
      running: existsSync(join(fake, "c", name, "running")),
      label: existsSync(join(fake, "c", name, "label")) ? readFileSync(join(fake, "c", name, "label"), "utf8").trim() : undefined,
    }),
    container,
  };
}

/** The index of the first call matching `re`; fails when there is none. */
function at(calls: string[], re: RegExp): number {
  const i = calls.findIndex((c) => re.test(c));
  assert.notEqual(i, -1, `no call matching ${re}:\n${calls.join("\n")}`);
  return i;
}
const runCall = (calls: string[]) => calls.find((c) => c.startsWith("run "));
const phases = (rows: Row[]) => rows.filter((r) => r.step === "recycle.phase").map((r) => r.phase);

test("W1-T13278 criterion 1: the replacement is warmed off the tunnel, joins it by alias once ready, and only then is the old console stopped", (t) => {
  const f = fixture(t);
  const r = f.run({ RMD_SERVE_BLUE_GREEN: "on", READY_AFTER: "3" });
  assert.equal(r.status, 0, r.out);
  const calls = f.calls();
  const run = runCall(calls) ?? "";
  assert.match(run, /--name remudero-serve-next /, "the replacement starts under its own name");
  assert.match(run, /--network bridge /, "off the tunnel's network, so nothing reaches it before it is ready");
  assert.match(run, /--label rmd\.serve\.color=green /, "a blue console is replaced by a green one");
  assert.match(run, new RegExp(`-v ${f.root}/serve-repo-green:/home/node/Remudero/remudero `), "with its own code checkout");
  assert.match(run, new RegExp(`-v ${f.root}/rmd-serve-gens-green:/home/node/rmd-serve-gens `), "and its own generations dir");
  const started = at(calls, /^run /);
  const probes = calls.map((c, i) => (c.startsWith("exec -i remudero-serve-next node - /v1/version /v1/status /v1/views/versions") ? i : -1)).filter((i) => i >= 0);
  assert.equal(probes.length, 3, "polled until the third probe answered ready");
  const joined = at(calls, new RegExp(`^network connect --alias remudero-serve ${NET} remudero-serve-next$`));
  const stopped = at(calls, /^stop remudero-serve$/);
  const removed = at(calls, /^rm -f remudero-serve$/);
  const renamed = at(calls, /^rename remudero-serve-next remudero-serve$/);
  assert.ok(started < probes[0]! && probes[2]! < joined, "the alias is given only after a ready probe");
  assert.ok(joined < stopped && stopped < removed && removed < renamed, calls.join("\n"));
  assert.deepEqual(f.live("remudero-serve"), { exists: true, running: true, label: "green" }, "the replacement is now the console");
  assert.equal(f.live("remudero-serve-next").exists, false);
  assert.deepEqual(phases(f.rows()), ["pull", "start_replacement", "ready", "alias", "stop", "remove", "rename"]);
  const swapped = f.rows().find((row) => row.step === "serve.recycle_swapped");
  assert.equal(swapped?.from_color, "blue");
  assert.equal(swapped?.to_color, "green");
});

test("W1-T13278 criterion 1: the colour alternates, so a green console is replaced by a blue one on today's dirs", (t) => {
  const f = fixture(t);
  rmSync(join(f.fake, "c", "remudero-serve"), { recursive: true });
  f.container("remudero-serve", { label: "green" });
  const r = f.run({ RMD_SERVE_BLUE_GREEN: "on" });
  assert.equal(r.status, 0, r.out);
  const run = runCall(f.calls()) ?? "";
  assert.match(run, /--label rmd\.serve\.color=blue /);
  assert.match(run, new RegExp(`-v ${f.root}/serve-repo:/home/node/Remudero/remudero `));
  assert.match(run, new RegExp(`-v ${f.root}/rmd-serve-gens:/home/node/rmd-serve-gens `));
  assert.equal(f.live("remudero-serve").label, "blue");
});

test("W1-T13278 criterion 1: on scratch, green owns its /tmp, checkout and generations, and the drift check reads green's plan for a green console", (t) => {
  const f = fixture(t);
  const scratchEnv = {
    RMD_SCRATCH: "on", RMD_SCRATCH_ROOT: f.scratch, RMD_SCRATCH_MOUNTS_FILE: join(f.root, "mounts"),
    RMD_SCRATCH_CHECKOUTS: "on", RMD_SERVE_REPO_DIR: "",
  };
  const r = f.run({ RMD_SERVE_BLUE_GREEN: "on", ...scratchEnv });
  assert.equal(r.status, 0, r.out);
  const base = join(f.scratch, "rmd", "state");
  const run = runCall(f.calls()) ?? "";
  assert.match(run, new RegExp(`-v ${base}/containers/remudero-serve-green/tmp:/tmp `), "never the live console's /tmp");
  assert.match(run, new RegExp(`-v ${base}/serve-repo-green:/home/node/Remudero/remudero `));
  assert.match(run, new RegExp(`-v ${base}/serve-gens-green:/home/node/rmd-serve-gens `));
  const manifest = readFileSync(join(f.root, "state", ".scratch-mounts"), "utf8");
  assert.match(manifest, /containers\/remudero-serve-green\/tmp/, "the boot-time restore recreates green's dirs");
  assert.match(manifest, /serve-gens-green/);

  // The deployer's mount-plan drift check, run for real, compares a green console with green's plan.
  const inspectJson = (tmp: string) => JSON.stringify({ Mounts: [
    { Source: `${base}/worktrees`, Destination: "/home/node/Remudero/worktrees" },
    { Source: `${base}/tmp`, Destination: "/home/node/Remudero/tmp" },
    { Source: `${base}/remudero-coverage`, Destination: "/home/node/Remudero/.remudero-coverage" },
    { Source: `${base}/repos`, Destination: "/home/node/Remudero/repos" },
    { Source: `${base}/repos-coverage`, Destination: "/home/node/Remudero/repos/.remudero-coverage" },
    { Source: `${base}/read-model`, Destination: "/home/node/rmd-scratch/read-model" },
    { Source: `${base}/worker-homes`, Destination: "/home/node/rmd-scratch/worker-homes" },
    { Source: tmp, Destination: "/tmp" },
    { Source: join(f.scratch, "rmd", "test-slots"), Destination: "/home/node/rmd-scratch/test-slots" },
  ], Env: [
    "RMD_READ_MODEL_DB_DIR=/home/node/Remudero/state:/home/node/rmd-scratch/read-model",
    "RMD_WORKER_HOME_DIR=/home/node/Remudero:/home/node/rmd-scratch/worker-homes",
    "RMD_TEST_SLOT_DIR=/home/node/rmd-scratch/test-slots",
  ] });
  const drift = (tmp: string) => readMountPlanDrift((cmd, args) => {
    if (cmd === "docker") return inspectJson(tmp);
    const out = spawnSync(cmd, args, { encoding: "utf8", env: { ...process.env, ...scratchEnv, HOME: f.root, FAKE: f.fake, PATH: `${join(f.root, "bin")}:${process.env.PATH ?? ""}` } });
    if (out.status !== 0) throw new Error(out.stderr);
    return out.stdout;
  }, REPO_ROOT, join(f.root, "state"), "remudero-serve");
  assert.deepEqual(drift(`${base}/containers/remudero-serve-green/tmp`), [], "a green console on green's /tmp has not drifted");
  writeFileSync(join(f.fake, "c", "remudero-serve", "label"), "blue\n");
  assert.deepEqual((drift(`${base}/containers/remudero-serve-green/tmp`) ?? []).map((d) => d.target), ["/tmp"], "a blue console on green's /tmp has");
});

test("W1-T13278 criterion 1: the readiness probe asks the newest generation socket for /v1/ready and every smoke route", async (t) => {
  assert.deepEqual([...SMOKE_PATHS], ["/v1/version", "/v1/status", "/v1/views/versions"], "the script's list is this list");
  const script = readFileSync(SERVE, "utf8");
  assert.match(script, /^SERVE_SMOKE_PATHS=\(\/v1\/version \/v1\/status \/v1\/views\/versions\)$/m);
  assert.match(script, new RegExp(`^SERVE_BLUE_GREEN_READY_S="\\$\\{RMD_SERVE_BLUE_GREEN_READY_S:-${STANDBY_READY_BOUND_MS / 1000}\\}"$`, "m"), "the supervisor's own standby bound");
  const js = /^SERVE_READY_PROBE_JS='\n([\s\S]*?)\n'$/m.exec(script)?.[1];
  assert.ok(js, "the probe is in the script");
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}serve-probe-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const probe = (): Promise<{ code: number | null; out: string }> => new Promise((done) => {
    const child = spawn(process.execPath, ["-", ...SMOKE_PATHS], { env: { ...process.env, RMD_SERVE_PROBE_DIR: dir } });
    let out = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.on("close", (code) => done({ code, out: out.trim() }));
    child.stdin.end(js);
  });
  assert.equal((await probe()).code, 4, "no generation socket yet");

  let ready = 503;
  const seen: string[] = [];
  const server = createServer((req, res) => {
    seen.push(req.url ?? "");
    res.writeHead(req.url === "/v1/ready" ? ready : 200).end("{}");
  });
  await new Promise<void>((done) => server.listen(join(dir, "rmd-serve-gen-7-1.sock"), done));
  t.after(() => server.close());
  const degraded = await probe();
  assert.equal(degraded.code, 3, degraded.out);
  assert.deepEqual(seen, ["/v1/ready"], "a degraded generation is not smoke-tested");
  ready = 200;
  const up = await probe();
  assert.equal(up.code, 0, up.out);
  assert.deepEqual(seen.slice(1), ["/v1/ready", ...SMOKE_PATHS]);
  assert.equal(JSON.parse(up.out).ok, true);
});

test("W1-T13278 criterion 2: a replacement that is not ready inside the bound is removed and the old console keeps serving", (t) => {
  const f = fixture(t);
  const r = f.run({ RMD_SERVE_BLUE_GREEN: "on", READY_AFTER: "999", RMD_SERVE_BLUE_GREEN_READY_S: "2" });
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /ABORTED/);
  const calls = f.calls();
  assert.equal(calls.some((c) => /^(stop|rename) /.test(c) || c === "rm -f remudero-serve" || c.startsWith("network connect")), false, calls.join("\n"));
  at(calls, /^rm -f remudero-serve-next$/);
  assert.deepEqual(f.live("remudero-serve"), { exists: true, running: true, label: undefined }, "the old console was never touched");
  assert.equal(f.live("remudero-serve-next").exists, false);
  const aborted = f.rows().find((row) => row.step === "serve.recycle_aborted");
  assert.equal(aborted?.reason, "not_ready");
  assert.equal(aborted?.replacement, "remudero-serve-next");
  assert.match(String(aborted?.probe), /"ready":503/);
  assert.ok(Number(aborted?.waited_s) >= 2);
});

test("W1-T13278 criterion 2: a replacement that exits, or cannot join the network, is aborted the same way", (t) => {
  const died = fixture(t);
  const r = died.run({ RMD_SERVE_BLUE_GREEN: "on", RUN_DIES: "1" });
  assert.equal(r.status, 1, r.out);
  assert.equal(died.rows().find((row) => row.step === "serve.recycle_aborted")?.reason, "exited");
  assert.equal(died.live("remudero-serve").running, true);

  const unjoined = fixture(t);
  const u = unjoined.run({ RMD_SERVE_BLUE_GREEN: "on", CONNECT_RC: "1" });
  assert.equal(u.status, 1, u.out);
  assert.equal(unjoined.rows().find((row) => row.step === "serve.recycle_aborted")?.reason, "network_connect_failed");
  assert.equal(unjoined.calls().some((c) => c.startsWith("stop ")), false);
  assert.equal(unjoined.live("remudero-serve-next").exists, false);
});

test("W1-T13278 criterion 2: a leftover replacement is cleared first, and an interrupted rename is finished, not replaced", (t) => {
  const left = fixture(t);
  left.container("remudero-serve-next");
  const r = left.run({ RMD_SERVE_BLUE_GREEN: "on" });
  assert.equal(r.status, 0, r.out);
  const calls = left.calls();
  assert.ok(at(calls, /^rm -f remudero-serve-next$/) < at(calls, /^run /));

  const torn = fixture(t);
  rmSync(join(torn.fake, "c", "remudero-serve"), { recursive: true });
  torn.container("remudero-serve-next", { label: "green" });
  const s = torn.run({ RMD_SERVE_BLUE_GREEN: "on" });
  assert.equal(s.status, 0, s.out);
  assert.match(s.out, /finished an interrupted swap/);
  assert.equal(torn.calls().some((c) => c.startsWith("run ")), false, "nothing new is started");
  assert.deepEqual(torn.live("remudero-serve"), { exists: true, running: true, label: "green" });
});

test("W1-T13278 criterion 2: a swap the host has no memory for falls back to the old replace instead of holding", (t) => {
  const f = fixture(t);
  writeFileSync(join(f.root, "meminfo"), "MemAvailable:    3072000 kB\n");
  writeFileSync(join(f.root, "vmstat"), "pswpin 0\nzswpin 0\n");
  writeFileSync(join(f.root, "psi"), "some avg10=0.00 avg60=0.00 avg300=0.00 total=0\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n");
  const r = f.run({
    RMD_SERVE_BLUE_GREEN: "on", RMD_SERVE_REPLACE_ADMISSION: "required",
    RMD_SERVE_ADMIT_MEMINFO_PATH: join(f.root, "meminfo"), RMD_SERVE_ADMIT_VMSTAT_PATH: join(f.root, "vmstat"),
    RMD_SERVE_ADMIT_PSI_PATH: join(f.root, "psi"), RMD_SERVE_ADMIT_SAMPLE_S: "0.01",
    RMD_SERVE_ADMIT_HOST_RESERVE_MIB: "1000", RMD_SERVE_ADMIT_SWAPIN_MAX: "100", RMD_SERVE_ADMIT_PSI_SOME_AVG10_MAX: "50",
    RMD_SERVE_ADMIT_PSI_FULL_AVG10_MAX: "50", RMD_SERVE_ADMIT_CANDIDATE_MIB: "4000",
  });
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /HELD \(host_headroom\).*freed 0/, "beside the live console nothing is freed: 3000 < 1000 + 4000");
  const calls = f.calls();
  assert.ok(at(calls, /^stop remudero-serve$/) < at(calls, /^run /), "the old way: stop, then start");
  const run = runCall(calls) ?? "";
  assert.match(run, new RegExp(`--name remudero-serve --restart=unless-stopped --network ${NET} --label rmd\\.serve\\.color=green `));
  assert.equal(calls.some((c) => c.startsWith("exec ") || c.startsWith("network connect")), false);
  assert.ok(f.rows().some((row) => row.step === "serve.recycle_blue_green_fallback"));
  assert.equal(f.live("remudero-serve").label, "green", "the fallback keeps the colour its dirs belong to");
});

test("W1-T13278 criterion 3: with the switch unset, a replace stops the old console and starts the new one exactly as before", (t) => {
  const envs: Record<string, string>[] = [{}, { RMD_SERVE_BLUE_GREEN: "off" }, { RMD_SERVE_BLUE_GREEN_SWITCH: "/nonexistent/serve-blue-green.on" }];
  for (const env of envs) {
    const f = fixture(t);
    const r = f.run(env);
    assert.equal(r.status, 0, r.out);
    const calls = f.calls();
    assert.equal(calls.some((c) => /remudero-serve-next|^exec |^network connect|^rename |rmd\.serve\.color/.test(c)), false, calls.join("\n"));
    const run = runCall(calls) ?? "";
    assert.match(run, new RegExp(`^run -d --name remudero-serve --restart=unless-stopped --network ${NET} --user 1000:1000 `));
    assert.match(run, new RegExp(`-v ${f.root}/serve-repo:/home/node/Remudero/remudero `));
    assert.match(run, new RegExp(`-v ${f.root}/rmd-serve-gens:/home/node/rmd-serve-gens `));
    assert.ok(at(calls, /^stop remudero-serve$/) < at(calls, /^rm remudero-serve$/) && at(calls, /^rm remudero-serve$/) < at(calls, /^run /));
    assert.deepEqual(phases(f.rows()), ["pull", "stop", "remove", "start"]);
    assert.doesNotMatch(r.out, /blue-green/);
  }
  const switched = fixture(t);
  writeFileSync(join(switched.root, "serve-blue-green.on"), "");
  const on = switched.run({ RMD_SERVE_BLUE_GREEN_SWITCH: join(switched.root, "serve-blue-green.on") });
  assert.equal(on.status, 0, on.out);
  assert.match(on.out, /blue-green swap ON/, "the host switch file turns it on");
});
