// W1-T3718: THE FIX RUNG COULD NOT SPAWN AND NOTHING SAID SO. Measured 2026-09-17: every provider
// refused, both paid rungs were switched off, and the only trace was one `fix.spawn_infra_blocked`
// row among 731 -- the operator's sole symptom was red PRs that stopped moving. These tests hold the
// four things that make such a stall visible and decidable: one durable fleet state, surfaced with
// its age, that tells a FULL provider from one that CANNOT BE ASKED, and clears on the first spawn
// that works -- plus a verb that prices the paid rungs and never switches one on.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { clockFromMillisFn } from "../src/lib/clock.js";
import type { Config } from "../src/lib/config.js";
import { boundConsoleReadRoute, buildServeServer, withRepairLadder, type ServeDeps } from "../src/lib/serve.js";
import { RouteResponseBuffer } from "../src/lib/console-snapshot-cache.js";
import type { Route } from "../src/lib/service.js";
import { repairLadderCommand, trackRepairLadder } from "../src/lib/sweep.js";
import type { SpawnWorkerArgs } from "../src/lib/worker.js";
import {
  ProviderCapacityBlockedError,
  claudeCapacityFromUsage,
  priceRepairLadderRungs,
  recordRepairLadderStall,
  renderRepairLadderReport,
  providerRefusalCondition,
  readRepairLadderState,
  repairLadderStatePath,
  selectCodexModel,
  type ProviderCapacity,
} from "../src/lib/worker-provider.js";

const READ_TOKEN = "repair-ladder-read-token";

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "rmd-repair-ladder-"));
  mkdirSync(join(root, "state"), { recursive: true });
  return root;
}

function configFor(root: string, extra: Partial<Config> = {}): Config {
  return { claudeBin: "/bin/true", root, workerProviders: { enabled: ["claude", "codex"] }, ...extra } as Config;
}

/** The two readings the 2026-09-17 ledger carried: a Claude probe that never answered, and a Codex
 *  account that answered and was below its reserve. */
const CANNOT_BE_ASKED: ProviderCapacity = claudeCapacityFromUsage(undefined);
const FULL: ProviderCapacity = {
  provider: "codex",
  readable: false,
  exhausted: true,
  windows: [{ name: "codex primary", usedPercent: 98 }],
  detail: "balanced Codex models have no reserved headroom",
};

function blocked(): ProviderCapacityBlockedError {
  return new ProviderCapacityBlockedError([CANNOT_BE_ASKED, FULL]);
}

function recorder(): { rows: Array<{ step: string; extra?: Record<string, unknown> }>; log: (step: string, extra?: Record<string, unknown>) => void } {
  const rows: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  return { rows, log: (step, extra) => rows.push({ step, extra }) };
}

const FIX_ARGS = { cwd: "/nowhere", prompt: "fix", tools: ["Read", "Edit", "Bash"] } as unknown as SpawnWorkerArgs;

test("a stalled repair ladder is one fleet state, not a per-attempt line", async () => {
  const root = fixtureRoot();
  const ledger = recorder();
  let clock = Date.parse("2026-09-17T01:18:55.000Z");
  const refused = blocked();
  const spawn = trackRepairLadder(async () => { throw refused; }, { config: configFor(root), log: ledger.log, clock: clockFromMillisFn(() => clock) });

  // Three refused strikes across ninety minutes: the per-attempt shape this task replaces.
  for (const stepMs of [0, 45 * 60_000, 45 * 60_000]) {
    clock += stepMs;
    await assert.rejects(spawn(FIX_ARGS), (error) => error === refused, "the refusal propagates unchanged");
  }

  const record = JSON.parse(readFileSync(repairLadderStatePath(root), "utf8"));
  assert.equal(record.since, "2026-09-17T01:18:55.000Z", "ONE state: the first-seen instant survives every later refusal");
  assert.equal(record.lastSeen, "2026-09-17T02:48:55.000Z");
  assert.equal("count" in record || "refusals" in record, false, "no refusal count -- the shape nobody read");
  assert.deepEqual(record.fallbacks.map((f: { rung: string }) => f.rung), ["cash", "overflow"]);
  assert.match(record.fallbacks[0].refusal, /cashFallbackWhenBlocked/);
  assert.match(record.fallbacks[1].refusal, /overflow/);
  assert.deepEqual(
    ledger.rows.filter((row) => row.step === "repair_ladder.stalled").length,
    1,
    "the fleet state is announced once when it begins, not once per attempt",
  );

  // A refusal that is NOT "no provider would take the work" is a per-spawn fault, not this state.
  const otherRoot = fixtureRoot();
  const other = trackRepairLadder(async () => { throw new Error("worktree vanished"); }, { config: configFor(otherRoot), log: () => {} });
  await assert.rejects(other(FIX_ARGS), /worktree vanished/);
  assert.equal(existsSync(repairLadderStatePath(otherRoot)), false);
});

test("the stalled ladder reaches the status surface with its age", async () => {
  const root = fixtureRoot();
  const ledgerPath = join(root, "state", "ledger.ndjson");
  writeFileSync(ledgerPath, "");
  const since = Date.now() - 95 * 60_000;
  writeFileSync(repairLadderStatePath(root), JSON.stringify({
    version: 1,
    since: new Date(since).toISOString(),
    lastSeen: new Date(since + 60_000).toISOString(),
    reason: blocked().message,
    providers: [{ provider: "claude", condition: "cannot-be-asked", detail: "capacity unreadable" }],
    fallbacks: [{ rung: "cash", refusal: "operator has not enabled workerProviders.cashFallbackWhenBlocked" }],
  }));
  const github = { prByRef: () => null, findMergedByTrailer: () => null, headRefName: () => undefined, prBody: () => undefined, readFailed: () => false };
  const deps = {
    board: { plan: { tasks: [], byId: new Map() }, ledgerPath, github },
    panelGraph: { root, planPath: join(root, "tasks.yaml"), ledgerPath, github: { prView: () => null }, statusGithub: github, ratify: { approve() {}, reframe() {} } },
    ledgerPath,
    issues: { close() {} },
    fleetControlRoot: root,
    questionsRoot: root,
    tokens: { read: READ_TOKEN, write: "repair-ladder-write-token" },
    daemonHealth: { exec: () => "{}", statfs: () => ({ bavail: 1, bsize: 1 }) },
    githubAppRefresh: { start: () => ({ armed: false }) },
    log: () => {},
  } as unknown as ServeDeps;
  const server = buildServeServer(deps);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    for (const path of ["/v1/status", "/v1/daemon-health"]) {
      const response = await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${READ_TOKEN}` } });
      assert.equal(response.status, 200, path);
      const body = (await response.json()) as { repairLadder?: { state: string; ageMs: number; downFor: string; since: string; infrastructureFault: boolean } };
      assert.equal(body.repairLadder?.state, "stalled", `${path} says the repair ladder is down`);
      assert.equal(body.repairLadder?.since, new Date(since).toISOString());
      assert.ok((body.repairLadder?.ageMs ?? 0) >= 95 * 60_000, `${path} says for how long`);
      assert.match(body.repairLadder?.downFor ?? "", /^1h 3[5-9]m$/);
      assert.equal(body.repairLadder?.infrastructureFault, true);
    }
  } finally {
    server.close();
  }
});

test("an unreadable capacity probe is not reported as no headroom", () => {
  // The Claude probe that never answered, and the Codex account that answered FULL.
  assert.equal(providerRefusalCondition(CANNOT_BE_ASKED), "cannot-be-asked");
  assert.equal(providerRefusalCondition(FULL), "full");
  const message = blocked().message;
  assert.match(message, /claude=cannot be asked \(capacity unreadable\)/);
  assert.match(message, /codex=full \(balanced Codex models have no reserved headroom\)/);

  // The Codex selector itself used to say "no reserved headroom" for a quota it could not READ.
  const models = [{ id: "gpt-5.6-terra", displayName: "GPT-5.6-Terra", defaultReasoningEffort: "medium", supportedReasoningEfforts: [{ reasoningEffort: "medium" }] }];
  const config = { claudeBin: "/unused", root: "/tmp", workerProviders: { enabled: ["codex"] as Array<"codex">, codexModel: "gpt-5.6-terra" } };
  const unreadable = selectCodexModel(models, { rateLimitsByLimitId: { terra: { limitId: "terra", limitName: "GPT-5.6-Terra", primary: null } } }, config, undefined, "medium");
  assert.equal(unreadable.readable, false);
  assert.doesNotMatch(unreadable.detail ?? "", /no reserved headroom/, "an unreadable quota is not a full one");
  assert.match(unreadable.detail ?? "", /quota is unreadable/);
  assert.equal(providerRefusalCondition(unreadable), "cannot-be-asked");

  const exhausted = selectCodexModel(models, { rateLimitsByLimitId: { terra: { limitId: "terra", limitName: "GPT-5.6-Terra", primary: { usedPercent: 99 } } } }, config, undefined, "medium");
  assert.match(exhausted.detail ?? "", /no reserved headroom/);
  assert.equal(providerRefusalCondition(exhausted), "full");
});

test("a successful spawn clears the stalled ladder state", async () => {
  const root = fixtureRoot();
  const ledger = recorder();
  let refuse = true;
  let clock = Date.parse("2026-09-17T01:18:55.000Z");
  const spawn = trackRepairLadder(async () => {
    if (refuse) throw blocked();
    return "worker ran";
  }, { config: configFor(root), log: ledger.log, clock: clockFromMillisFn(() => clock) });

  await assert.rejects(spawn(FIX_ARGS));
  assert.equal(readRepairLadderState(root, clock).state, "stalled");

  // Provider capacity recovers on its own -- no restart, no config change.
  refuse = false;
  clock += 90 * 60_000;
  assert.equal(await spawn(FIX_ARGS), "worker ran");
  assert.deepEqual(readRepairLadderState(root, clock), { state: "running" });
  const recovered = ledger.rows.find((row) => row.step === "repair_ladder.recovered");
  assert.equal(recovered?.extra?.down_ms, 90 * 60_000);

  // The NEXT stall is a new one, with its own first-seen instant.
  refuse = true;
  clock += 60_000;
  await assert.rejects(spawn(FIX_ARGS));
  const next = readRepairLadderState(root, clock);
  assert.equal(next.state === "stalled" ? next.since : undefined, new Date(clock).toISOString());
});

test("the ladder verb prices the rungs and flips nothing", () => {
  const root = fixtureRoot();
  const configPath = join(root, "config.json");
  const config = Object.freeze(configFor(root, { dailyCapUsd: 20, workerProviders: { enabled: ["claude", "codex", "cash"] } }));
  const bytes = `${JSON.stringify(config)}\n`;
  writeFileSync(configPath, bytes);
  const snapshot = JSON.stringify(config);

  const printed: string[] = [];
  const exit = repairLadderCommand(["--json"], config, ["Read", "Edit", "Bash"], {}, (line) => printed.push(line));
  assert.equal(exit, 0);
  const report = JSON.parse(printed[0]) as { ladder: { state: string }; rungs: Array<Record<string, unknown>> };
  assert.equal(report.ladder.state, "running");
  const [cash, overflow] = report.rungs;
  assert.equal(cash.rung, "cash");
  assert.equal(cash.armed, false);
  assert.equal(cash.switchSetting, "workerProviders.cashFallbackWhenBlocked: true");
  assert.equal(cash.dailyCeilingUsd, 20);
  assert.match(String(cash.price), /\$20\/UTC day/);
  assert.match(String(cash.stillBlockedBy), /tool surface/, "priced honestly: the switch alone would not arm the fix lane");
  assert.equal(overflow.rung, "overflow");
  assert.equal(overflow.switchSetting, 'overflow: "api_key"');
  assert.equal(overflow.dailyCeilingUsd, 20);
  assert.match(String(overflow.stillBlockedBy), /ANTHROPIC_API_KEY/);

  const text: string[] = [];
  assert.equal(repairLadderCommand([], config, ["Read"], {}, (line) => text.push(line)), 0);
  assert.match(text.join("\n"), /changes nothing/);

  // FLIPS NOTHING: the config it read is byte-identical, in memory and on disk, and no rung armed.
  assert.equal(JSON.stringify(config), snapshot);
  assert.equal(readFileSync(configPath, "utf8"), bytes);
  assert.equal(config.workerProviders?.cashFallbackWhenBlocked, undefined);
  assert.equal(config.overflow, undefined);
  assert.equal(repairLadderCommand(["--enable"], config, undefined, {}, () => {}), 2, "there is no enabling flag");
});

async function call(route: Route): Promise<{ status: number; body: string }> {
  const buffer = new RouteResponseBuffer();
  await route.handler({ headers: {}, url: route.path, method: route.method } as never, buffer as never, {} as never);
  const buffered = buffer.buffered(0);
  return { status: buffered.status, body: buffered.body };
}

function fakeRoute(path: string, contentType: string, body: string): Route {
  return {
    method: "GET",
    path,
    scope: "read",
    handler: (_req, res) => {
      res.writeHead(200, { "content-type": contentType });
      res.end(body);
    },
  } as Route;
}

test("the ladder's unhealthy arms stay loud: an unreadable record, a failed clear and a cold cache", async () => {
  const root = fixtureRoot();
  const path = repairLadderStatePath(root);

  // A record with no first-seen instant, and one that is not JSON at all: both UNREADABLE, never
  // read as a running ladder.
  writeFileSync(path, JSON.stringify({ reason: "no since" }));
  assert.deepEqual(readRepairLadderState(root), { state: "unreadable", reason: "repair-ladder record has no readable first-seen instant" });
  writeFileSync(path, "{torn");
  const torn = readRepairLadderState(root);
  assert.equal(torn.state, "unreadable");
  const unreadableReport = renderRepairLadderReport(torn, []).join("\n");
  assert.match(unreadableReport, /UNREADABLE/);

  // A torn prior record is not evidence of an earlier stall: this one starts now.
  const started = recordRepairLadderStall(root, { reason: "r", providers: [], fallbacks: [] }, Date.parse("2026-09-17T01:00:00.000Z"));
  assert.equal(started.began, true);
  assert.equal(started.record.since, "2026-09-17T01:00:00.000Z");

  // The stalled report names each provider's condition and the infrastructure fault.
  const stalled = readRepairLadderState(root, Date.parse("2026-09-18T03:00:00.000Z"));
  assert.equal(stalled.state === "stalled" ? stalled.downFor : "", "1d 2h");
  const report = renderRepairLadderReport(
    { ...(stalled as Extract<typeof stalled, { state: "stalled" }>), infrastructureFault: true, providers: [
      { provider: "claude", condition: "cannot-be-asked", detail: "capacity unreadable" },
      { provider: "codex", condition: "full", detail: "2% remaining" },
    ] },
    [],
  ).join("\n");
  assert.match(report, /STALLED for 1d 2h/);
  assert.match(report, /claude: CANNOT BE ASKED — capacity unreadable/);
  assert.match(report, /codex: FULL — 2% remaining/);
  assert.match(report, /infrastructure fault/);

  // An inverted cap pair is refused, never guessed: priced with NO ceiling, and says why.
  const [inverted] = priceRepairLadderRungs({ dailyCapUsd: { normal: 25, squeezed: 10 } }, [{ rung: "cash", refusal: "off" }]);
  assert.equal(inverted.dailyCeilingUsd, null);
  assert.match(inverted.price, /NO daily ceiling \(dailyCapUsd\.squeezed/);

  // A clear that cannot remove the record is ledgered, and the spawn's own outcome still stands.
  const stuckRoot = fixtureRoot();
  mkdirSync(repairLadderStatePath(stuckRoot));
  const ledger = recorder();
  const spawn = trackRepairLadder(async () => "worker ran", { config: configFor(stuckRoot), log: ledger.log });
  assert.equal(await spawn(FIX_ARGS), "worker ran");
  const failed = ledger.rows.find((row) => row.step === "repair_ladder.write_failed");
  assert.equal(failed?.extra?.phase, "clear");

  // The splice passes a body it cannot extend through byte-identical.
  const read = () => ({ state: "running" }) as const;
  for (const [contentType, body] of [["text/plain", "plain"], ["application/json", "{torn"], ["application/json", "[1,2]"]]) {
    assert.deepEqual(await call(withRepairLadder(fakeRoute("/v1/daemon-health", contentType, body), read)), { status: 200, body });
  }

  // A COLD cache still carries the ladder: the fallback body of both surfaces reads it.
  const coldRoot = fixtureRoot();
  recordRepairLadderStall(coldRoot, { reason: "r", providers: [], fallbacks: [] });
  const coldDeps = {
    board: { plan: { tasks: [], byId: new Map() }, ledgerPath: join(coldRoot, "ledger.ndjson") },
    fleetControlRoot: coldRoot,
    log: () => {},
  } as unknown as ServeDeps;
  for (const coldPath of ["/v1/status", "/v1/daemon-health"]) {
    const never: Route = { method: "GET", path: coldPath, scope: "read", handler: () => new Promise<void>(() => {}) } as Route;
    const cold = await call(boundConsoleReadRoute(never, coldDeps, 5));
    assert.equal((JSON.parse(cold.body) as { repairLadder?: { state: string } }).repairLadder?.state, "stalled", coldPath);
  }
});

test("rmd repair-ladder is registered and reads the host config it is run against", async () => {
  // The CONSUMING CLIENT is the CLI verb, so this goes through the real HANDLERS entry.
  const { HANDLERS } = await import("../src/run-task.js");
  const home = mkdtempSync(join(tmpdir(), "rmd-repair-ladder-home-"));
  const root = join(home, "Remudero");
  mkdirSync(join(home, ".config", "remudero"), { recursive: true });
  const configBytes = JSON.stringify({ claudeBin: "/bin/true", root, dailyCapUsd: 20, workerProviders: { enabled: ["claude", "codex", "cash"] } });
  writeFileSync(join(home, ".config", "remudero", "config.json"), configBytes);
  const priorHome = process.env.HOME;
  const priorLog = console.log;
  const printed: string[] = [];
  process.env.HOME = home;
  console.log = (line: unknown) => { printed.push(String(line)); };
  try {
    assert.equal(await HANDLERS.get("repair-ladder")!(["--json"]), 0);
  } finally {
    process.env.HOME = priorHome;
    console.log = priorLog;
  }
  const report = JSON.parse(printed.join("")) as { ladder: { state: string }; rungs: Array<{ rung: string; armed: boolean; dailyCeilingUsd: number }> };
  assert.equal(report.ladder.state, "running");
  assert.deepEqual(report.rungs.map((rung) => [rung.rung, rung.armed, rung.dailyCeilingUsd]), [["cash", false, 20], ["overflow", false, 20]]);
  assert.equal(readFileSync(join(home, ".config", "remudero", "config.json"), "utf8"), configBytes, "the verb wrote nothing");
});
