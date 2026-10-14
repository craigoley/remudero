/**
 * W1-T2858: RUNTIME LAUNCH DRIFT REACHES THE CONSOLE.
 *
 * A live daemon can run with restart count zero and a current checkout while its Codex home and
 * provider config mounts are absent. The host heartbeat (scripts/fleet-heartbeat.sh) is the only
 * place that can see it, and `rmd serve` is deliberately given no Docker socket. This suite drives
 * the REAL heartbeat against a stubbed `docker`/`git`, then the REAL `GET /v1/status` route over the
 * snapshot it wrote, and pins the reader's refusal to call any unreadable input healthy.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  FLEET_RUNTIME_HEALTH_STALE_MS,
  fleetRuntimeHealthPath,
  fleetRuntimeHealthTelemetry,
  readFleetRuntimeHealth,
} from "../src/lib/fleet-runtime-health.js";
import { buildServeRoutes, buildServeServer, withFleetRuntimeHealth, type ServeDeps } from "../src/lib/serve.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { fakeGitHub } from "./helpers/fake-github.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const HEARTBEAT = join(REPO_ROOT, "scripts", "fleet-heartbeat.sh");
const READ_TOKEN = "runtime-health-read-token";
const WRITE_TOKEN = "runtime-health-write-token";
const bearerRead = { authorization: `Bearer ${READ_TOKEN}` };

interface Fixture {
  dir: string;
  root: string;
  home: string;
  bin: string;
  mountsFile: string;
  dockerLog: string;
  payloadFile: string;
  pushLog: string;
}

function fixture(t: { after: (fn: () => void) => void }): Fixture {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}runtime-health-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const f: Fixture = {
    dir,
    root: join(dir, "root"),
    home: join(dir, "home"),
    bin: join(dir, "bin"),
    mountsFile: join(dir, "mounts"),
    dockerLog: join(dir, "docker.log"),
    payloadFile: join(dir, "payload"),
    pushLog: join(dir, "push.log"),
  };
  for (const path of [join(f.root, "state"), join(f.home, ".claude"), join(f.home, ".codex"), join(f.home, ".config", "remudero-container"), f.bin]) {
    mkdirSync(path, { recursive: true });
  }
  writeFileSync(
    join(f.bin, "git"),
    [
      "#!/usr/bin/env bash",
      'args=("$@"); i=0',
      'while [ "${args[$i]}" = "-C" ]; do i=$((i+2)); done',
      'case "${args[$i]}" in',
      "  rev-parse) echo abc1234 ;;",
      `  hash-object) cat > ${JSON.stringify(f.payloadFile)}; echo 1111111111111111111111111111111111111111 ;;`,
      "  mktree) cat > /dev/null; echo 2222222222222222222222222222222222222222 ;;",
      "  commit-tree) echo 3333333333333333333333333333333333333333 ;;",
      `  push) echo push >> ${JSON.stringify(f.pushLog)} ;;`,
      "esac",
      "exit 0",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  writeFileSync(
    join(f.bin, "docker"),
    [
      "#!/usr/bin/env bash",
      `printf '%s\\n' "$*" >> ${JSON.stringify(f.dockerLog)}`,
      'for a in "$@"; do case "$a" in',
      `  *Mounts*) cat ${JSON.stringify(f.mountsFile)}; exit 0 ;;`,
      '  *RestartCount*) echo "0 0 unless-stopped running"; exit 0 ;;',
      "esac; done",
      'if [ "$1" = exec ]; then echo b25b305491a113d94b0cb2d8b9aa6bf730c2a23b; exit 0; fi',
      "exit 1",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  chmodSync(join(f.bin, "git"), 0o755);
  chmodSync(join(f.bin, "docker"), 0o755);
  return f;
}

/** The mounts the daemon container really has, in `docker inspect`'s Source/Destination/RW shape. */
function setMounts(f: Fixture, mounts: Array<[string, string]>): void {
  writeFileSync(f.mountsFile, mounts.map(([src, dest]) => `${src}\t${dest}\ttrue\n`).join(""));
}

function commissionedMounts(f: Fixture): Array<[string, string]> {
  return [
    [f.root, "/home/node/Remudero"],
    [join(f.home, ".claude"), "/home/node/.claude"],
    [join(f.home, ".codex"), "/home/node/.codex"],
    [join(f.home, ".config", "remudero-container"), "/home/node/.config/remudero"],
  ];
}

function beat(f: Fixture, env: Record<string, string> = {}): { status: number; stdout: string; stderr: string } {
  const r = spawnSync("bash", [HEARTBEAT], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${f.bin}:${process.env.PATH ?? ""}`,
      HOME: f.home,
      RMD_ROOT: f.root,
      TMPDIR: f.dir,
      ...env,
    },
  });
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

const snapshotFile = (f: Fixture): string => fleetRuntimeHealthPath(f.root);
const payloadField = (f: Fixture, key: string): string | undefined =>
  readFileSync(f.payloadFile, "utf8").split("\n").find((l) => l.startsWith(`${key}=`))?.slice(key.length + 1);

function serveDeps(root: string): ServeDeps {
  mkdirSync(join(root, "state"), { recursive: true });
  mkdirSync(join(root, "plan"), { recursive: true });
  const ledgerPath = join(root, "state", "ledger.ndjson");
  const planPath = join(root, "plan", "tasks.yaml");
  writeFileSync(ledgerPath, "");
  writeFileSync(planPath, "[]\n");
  return {
    board: { plan: { tasks: [], byId: new Map() }, ledgerPath, github: fakeGitHub() },
    panelGraph: { root, planPath, ledgerPath, github: { prView: () => null }, statusGithub: fakeGitHub(), ratify: { approve: () => {}, reframe: () => {} } },
    ledgerPath,
    issues: { close: () => {} },
    fleetControlRoot: root,
    questionsRoot: root,
    tokens: { read: READ_TOKEN, write: WRITE_TOKEN },
    identity: { trustedLocalAddress: "127.0.0.1", capability: "example.com/cap/console-write" },
    log: () => {},
  };
}

async function status(deps: ServeDeps): Promise<Record<string, unknown>> {
  const server = buildServeServer(deps);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  try {
    const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/status`, { headers: bearerRead });
    assert.equal(res.status, 200);
    return (await res.json()) as Record<string, unknown>;
  } finally {
    server.close();
  }
}

function writeSnapshot(root: string, body: unknown): void {
  mkdirSync(join(root, "state"), { recursive: true });
  writeFileSync(fleetRuntimeHealthPath(root), typeof body === "string" ? body : JSON.stringify(body));
}

const NOW = Date.parse("2026-10-14T12:00:00.000Z");
const at = (msAgo: number): string => new Date(NOW - msAgo).toISOString();
const healthy = (over: Record<string, unknown> = {}) => ({
  version: 1, observed_at: at(60_000), host: "azure", container: "remudero-daemon", status: "healthy", checked: 4, drift: [], ...over,
});
const drifted = (over: Record<string, unknown> = {}) => ({
  version: 1, observed_at: at(60_000), host: "azure", container: "remudero-daemon", status: "drift", checked: 4,
  drift: [{ destination: "/home/node/.codex", reason: "missing" }], ...over,
});

test("bash -n: the committed heartbeat parses", () => {
  assert.equal(spawnSync("bash", ["-n", HEARTBEAT], { encoding: "utf8" }).status, 0);
});

test("the real host heartbeat writes one atomic sanitized runtime-health snapshot from the verifier while publishing its beat", (t) => {
  const f = fixture(t);
  setMounts(f, commissionedMounts(f));
  const r = beat(f);
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  // The normal beat still went out, and it carries the verdict beside its own liveness fields.
  assert.ok(existsSync(f.pushLog), "the beat must still be pushed");
  assert.equal(payloadField(f, "runtime_contract_verdict"), "healthy");
  assert.equal(payloadField(f, "restart_verdict"), "unlimited");
  const written = JSON.parse(readFileSync(snapshotFile(f), "utf8"));
  assert.equal(written.version, 1);
  assert.equal(written.status, "healthy");
  assert.equal(written.container, "remudero-daemon");
  assert.equal(written.checked, 4);
  assert.deepEqual(written.drift, []);
  // Atomic: the temp file was renamed over the target, nothing half-written or left behind.
  assert.deepEqual(readdirSync(join(f.root, "state")).filter((n) => n.startsWith(".fleet-runtime-health")), []);
  assert.equal(readFleetRuntimeHealth(f.root, Date.now()).state, "healthy");
});

test("a missing expected provider mount renders a prominent console drift alert while liveness and restart budget stay green", async (t) => {
  const f = fixture(t);
  setMounts(f, commissionedMounts(f).filter(([, dest]) => dest !== "/home/node/.codex" && dest !== "/home/node/.config/remudero"));
  const r = beat(f);
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  // The classic liveness probes are green: a running container with an untouched restart budget.
  assert.equal(payloadField(f, "restart_verdict"), "unlimited");
  assert.equal(payloadField(f, "restart_count"), "0");
  assert.equal(payloadField(f, "runtime_contract_verdict"), "drift");

  const body = await status(serveDeps(f.root));
  const health = body.fleetRuntimeHealth as { state: string; drift: Array<{ destination: string; reason: string }>; alert: Record<string, string> };
  assert.equal(health.state, "drift");
  assert.deepEqual(health.drift.map((d) => d.destination).sort(), ["/home/node/.codex", "/home/node/.config/remudero"]);
  assert.equal(health.alert.severity, "critical");
  assert.match(health.alert.detail, /\/home\/node\/\.codex \(missing\)/);
  assert.equal((body.repairLadder as { state: string }).state, "running", "the rest of the console still reads green");
});

test("healthy, drift, missing, malformed, future-version and stale snapshots remain distinct; no unreadable input is healthy", (t) => {
  const f = fixture(t);
  const read = () => readFleetRuntimeHealth(f.root, NOW);
  assert.deepEqual(read(), { state: "unknown", reason: "no-snapshot" });

  writeSnapshot(f.root, healthy());
  assert.equal(read().state, "healthy");
  writeSnapshot(f.root, drifted());
  assert.equal(read().state, "drift");

  const unreadable: Array<[string, unknown, string]> = [
    ["not json", "{not json", "malformed"],
    ["an array", "[]", "malformed"],
    ["no version", { ...healthy(), version: undefined }, "malformed"],
    ["a future version", healthy({ version: 2 }), "future-version"],
    ["stale", healthy({ observed_at: at(FLEET_RUNTIME_HEALTH_STALE_MS + 1_000) }), "stale"],
    ["stale drift", drifted({ observed_at: at(FLEET_RUNTIME_HEALTH_STALE_MS + 1_000) }), "stale"],
    ["dated in the future", healthy({ observed_at: at(-3_600_000) }), "clock-skew"],
    ["no timestamp", healthy({ observed_at: undefined }), "malformed"],
    ["an unparseable timestamp", healthy({ observed_at: "yesterday" }), "malformed"],
    ["healthy over zero expectations", healthy({ checked: 0 }), "malformed"],
    ["healthy that carries drift", healthy({ drift: [{ destination: "/home/node/.codex", reason: "missing" }] }), "malformed"],
    ["drift with no entries", drifted({ drift: [] }), "malformed"],
    ["an unknown drift reason", drifted({ drift: [{ destination: "/home/node/.codex", reason: "who-knows" }] }), "malformed"],
    ["a host path as a destination", drifted({ drift: [{ destination: "/root/.codex\n", reason: "missing" }] }), "malformed"],
    ["an unknown status", healthy({ status: "fine" }), "malformed"],
  ];
  for (const [label, body, reason] of unreadable) {
    writeSnapshot(f.root, body);
    const got = read();
    assert.equal(got.state, "unknown", `${label} must be unknown, got ${JSON.stringify(got)}`);
    assert.equal(got.reason, reason, label);
    assert.equal(got.alert, undefined, `${label} must not raise the drift alert`);
  }

  // The producer's own "I could not measure" is carried as a distinct unknown, not as healthy.
  writeSnapshot(f.root, { version: 1, observed_at: at(1_000), host: "azure", container: "remudero-daemon", status: "unknown", reason: "inspect-unreadable" });
  assert.deepEqual(
    { state: read().state, reason: read().reason },
    { state: "unknown", reason: "inspect-unreadable" },
  );
  // A directory where the file belongs is an unreadable snapshot, not an absent one.
  rmSync(snapshotFile(f));
  mkdirSync(snapshotFile(f));
  assert.deepEqual(read(), { state: "unknown", reason: "unreadable" });
});

test("a verifier that cannot read Docker, or a host with none, publishes unknown and still beats", (t) => {
  const f = fixture(t);
  writeFileSync(join(f.bin, "docker"), "#!/usr/bin/env bash\nexit 1\n", { mode: 0o755 });
  const r = beat(f);
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  assert.ok(existsSync(f.pushLog), "monitoring must not go silent because the verifier failed");
  assert.equal(payloadField(f, "runtime_contract_verdict"), "unknown");
  assert.deepEqual(JSON.parse(readFileSync(snapshotFile(f), "utf8")).reason, "inspect-unreadable");
  assert.equal(readFleetRuntimeHealth(f.root, Date.now()).state, "unknown");
});

test("the snapshot and console response contain no host paths, credential contents, Docker environment, command args, tokens or inspect output", async (t) => {
  const f = fixture(t);
  writeFileSync(join(f.home, ".codex", "auth.json"), '{"OPENAI_API_KEY":"sk-secret-codex-credential"}');
  setMounts(f, commissionedMounts(f).filter(([, dest]) => dest !== "/home/node/.codex"));
  assert.equal(beat(f, { GITHUB_TOKEN: "ghp_secret_token_value", RMD_CODEX_DIR: join(f.home, ".codex") }).status, 0);

  const file = readFileSync(snapshotFile(f), "utf8");
  const response = JSON.stringify(await status(serveDeps(f.root)));
  const forbidden = [f.dir, f.home, f.root, "sk-secret-codex-credential", "ghp_secret_token_value", "auth.json", "Env", "Cmd", "Args", "HostConfig", READ_TOKEN, WRITE_TOKEN];
  for (const [label, text] of [["snapshot", file], ["response", response]] as const) {
    for (const needle of forbidden) assert.ok(!text.includes(needle), `${label} leaked ${needle}: ${text.slice(0, 400)}`);
  }
  // Only the container-side destination is named.
  assert.match(file, /"destination":"\/home\/node\/\.codex"/);

  // A forged snapshot cannot smuggle extra fields through the reader's projection.
  writeSnapshot(f.root, drifted({ env: ["TOKEN=x"], source: "/root/.codex", cmd: ["rm"], drift: [{ destination: "/home/node/.codex", reason: "missing", source: "/root/.codex" }] }));
  const projected = JSON.stringify(readFleetRuntimeHealth(f.root, NOW));
  for (const needle of ["TOKEN=x", "/root/.codex", "rm"]) assert.ok(!projected.includes(needle), `projection leaked ${needle}`);
});

test("Serve obtains runtime health only from shared state, with no Docker socket, child Docker command or GitHub request", async (t) => {
  const f = fixture(t);
  writeSnapshot(f.root, drifted({ observed_at: new Date().toISOString() }));
  const priorPath = process.env.PATH;
  const priorFetch = globalThis.fetch;
  const outbound: string[] = [];
  process.env.PATH = `${f.bin}:${priorPath ?? ""}`;
  globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.startsWith("http://127.0.0.1:")) outbound.push(url);
    return priorFetch(input, init);
  }) as typeof fetch;
  try {
    const body = await status(serveDeps(f.root));
    assert.equal((body.fleetRuntimeHealth as { state: string }).state, "drift");
  } finally {
    process.env.PATH = priorPath;
    globalThis.fetch = priorFetch;
  }
  assert.deepEqual(outbound, [], "reading the snapshot must make no outbound request");
  assert.equal(existsSync(f.dockerLog), false, "reading the snapshot must run no docker command");
  // The reader's only I/O seam is a text read of the one state file.
  const reads: string[] = [];
  const got = readFleetRuntimeHealth(f.root, Date.now(), (path) => {
    reads.push(path);
    return readFileSync(path, "utf8");
  });
  assert.equal(got.state, "drift");
  assert.deepEqual(reads, [snapshotFile(f)]);
});

test("the alert names the supported recycle remedy but cannot start, stop, restart, recycle, build or deploy either container", async (t) => {
  const f = fixture(t);
  writeSnapshot(f.root, drifted({ observed_at: new Date().toISOString() }));
  const deps = serveDeps(f.root);
  const body = await status(deps);
  const alert = (body.fleetRuntimeHealth as { alert: Record<string, unknown> }).alert;
  assert.deepEqual(Object.keys(alert).sort(), ["detail", "remedy", "severity", "title"]);
  assert.equal(alert.remedy, "deploy/recycle-container.sh");
  // A name, not an action: no route is added for it, and showing it ran nothing.
  const paths = buildServeRoutes(deps).map((route) => `${route.method} ${route.path}`);
  assert.deepEqual(paths.filter((p) => /recycle|runtime-health|runtime_health|lifecycle/i.test(p)), []);
  assert.equal(existsSync(f.dockerLog), false);
});

test("normal console liveness, provider-routing and board behavior is unchanged when the snapshot is absent", async (t) => {
  const f = fixture(t);
  const deps = serveDeps(f.root);
  const without = await status(deps);
  assert.deepEqual(without.fleetRuntimeHealth, { state: "unknown", reason: "no-snapshot" });
  assert.deepEqual(without.tasks, []);
  assert.equal((without.repairLadder as { state: string }).state, "running");
  assert.ok("counts" in without && "staleness" in without && "prQueue" in without);

  // Every other key is what the same console says with a healthy snapshot present.
  writeSnapshot(f.root, healthy({ observed_at: new Date().toISOString() }));
  const withHealthy = await status(deps);
  const strip = ({ fleetRuntimeHealth: _h, generated_at: _g, staleness: _s, ...rest }: Record<string, unknown>) => rest;
  assert.deepEqual(strip(withHealthy), strip(without));
  assert.equal((withHealthy.fleetRuntimeHealth as { state: string }).state, "healthy");

  // Other routes carry no new field.
  const server = buildServeServer(deps);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  try {
    const port = (server.address() as AddressInfo).port;
    const health = await (await fetch(`http://127.0.0.1:${port}/v1/daemon-health`, { headers: bearerRead })).json();
    assert.ok(!("fleetRuntimeHealth" in (health as object)));
  } finally {
    server.close();
  }
});

test("telemetry is change-only and bounded", () => {
  const lines: string[] = [];
  const report = fleetRuntimeHealthTelemetry((line) => lines.push(line));
  const drift = readFleetRuntimeHealth("/nonexistent", NOW, () => JSON.stringify(drifted()));
  const absent = readFleetRuntimeHealth("/nonexistent", NOW, () => { throw Object.assign(new Error("x"), { code: "ENOENT" }); });
  for (const h of [absent, absent, absent, drift, drift, absent]) report(h);
  assert.equal(lines.length, 3, lines.join("\n"));
  assert.deepEqual(JSON.parse(lines[1]!), { event: "serve.fleet_runtime_health", state: "drift", reason: null, drift: 1 });
  assert.ok(lines.every((line) => line.length < 200));
});

test("removing the snapshot projection makes a live daemon with missing provider mounts look fully healthy again", async (t) => {
  const f = fixture(t);
  setMounts(f, commissionedMounts(f).filter(([, dest]) => dest !== "/home/node/.codex"));
  assert.equal(beat(f).status, 0);
  // The control: the host really did record the drift.
  assert.equal(JSON.parse(readFileSync(snapshotFile(f), "utf8")).status, "drift");

  const deps = serveDeps(f.root);
  const status200 = { method: "GET" as const, path: "/v1/status", scope: "read" as const, handler: (_req: unknown, res: { writeHead: (s: number, h: object) => void; end: (b: string) => void }) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ generated_at: "2026-10-14T12:00:00.000Z", tasks: [], repairLadder: { state: "running" } }));
  } };
  const call = async (route: typeof status200): Promise<Record<string, unknown>> => {
    let body = "";
    await (route.handler as (req: unknown, res: unknown, ctx: unknown) => Promise<void>)(
      {}, { writeHead: () => {}, end: (b: string) => { body = b; }, setHeader: () => {} }, {});
    return JSON.parse(body) as Record<string, unknown>;
  };
  const projected = await call(withFleetRuntimeHealth(status200 as never, (nowMs) => readFleetRuntimeHealth(deps.fleetControlRoot, nowMs)) as typeof status200);
  assert.equal((projected.fleetRuntimeHealth as { state: string }).state, "drift");

  // THE MUTANT: the same route with the projection removed says nothing about the missing mounts.
  const mutant = await call(status200);
  assert.ok(!("fleetRuntimeHealth" in mutant));
  assert.deepEqual((mutant.repairLadder as { state: string }), { state: "running" });
  assert.ok(!JSON.stringify(mutant).includes("drift"), "without the projection nothing in the response reports the drift");
});
