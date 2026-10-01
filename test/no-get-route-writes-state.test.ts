// Arch Phase 4 (design D5, P4-T05): a GET never writes state. A read that writes makes the state it
// writes depend on whether anyone happened to read: GET /v1/inbox wrote the classification the
// daemon's fleet lane acts on, so with no viewer the lane decided on readiness 6 h old.
//
// HOW IT ATTRIBUTES. Each fs write entry point, and each child-process entry point a git write could
// go through, is wrapped BEFORE serve.js loads (modules capture fs functions into default-deps
// objects at import time, so a later patch would miss them). Every request runs inside an
// AsyncLocalStorage context naming its route, so a write is charged to the route whose request
// caused it, including async work that request started. Pollers and prewarm run outside any request
// and are charged to nobody. The baseline (test/fixtures/get-write-baseline.json) names each known
// writer with its reason and its planned owner; it only shrinks.
import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import childProcess from "node:child_process";
import fs, { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import fsp from "node:fs/promises";
import { createServer } from "node:http";
import { syncBuiltinESMExports } from "node:module";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { test } from "node:test";
import type { Route } from "../src/lib/service.js";

const context = new AsyncLocalStorage<string>();
/** Each route's writes, as `<kind> <path relative to the fixture>`. */
const writes = new Map<string, Set<string>>();
let fixtureRoot = "";

function where(target: unknown): string {
  const path = String(target);
  if (fixtureRoot === "" || !path.startsWith(fixtureRoot)) return "<outside the fixture>";
  // A temp file's pid and random suffix differ per run; its name is what a write is.
  return relative(fixtureRoot, path).replace(/\.publish-\d+-[0-9a-f-]+$|\.\d+\.[0-9a-z]+\.tmp$|\.[0-9a-f-]{8,}\.tmp$|\.tmp-[^/]*$|\.\d+\.\d+\.tmp$/, ".<tmp>") || ".";
}

function charge(kind: string, target: unknown): void {
  const route = context.getStore();
  if (route === undefined) return;
  const set = writes.get(route) ?? new Set<string>();
  set.add(`${kind} ${where(target)}`);
  writes.set(route, set);
}

function spied<F extends (...args: never[]) => unknown>(kind: string, original: F, isWrite: (args: unknown[]) => boolean = () => true): F {
  return function (this: unknown, ...args: Parameters<F>) {
    if (isWrite(args)) charge(kind, args[0]);
    return original.apply(this, args);
  } as F;
}

const WRITE_FLAG = /[wa+]/;
const opensForWrite = (args: unknown[]): boolean => typeof args[1] === "string" ? WRITE_FLAG.test(args[1]) : typeof args[1] === "number" && (args[1] & (fs.constants.O_WRONLY | fs.constants.O_RDWR)) !== 0;
const GIT_WRITE_VERBS = new Set(["add", "commit", "push", "checkout", "reset", "merge", "rebase", "stash", "rm", "mv", "update-ref", "tag"]);
const gitWrite = (args: unknown[]): boolean => {
  if (args[0] !== "git" || !Array.isArray(args[1])) return false;
  const argv = (args[1] as unknown[]).map(String);
  const verb = argv.find((arg, i) => !arg.startsWith("-") && argv[i - 1] !== "-C" && argv[i - 1] !== "-c");
  return verb !== undefined && GIT_WRITE_VERBS.has(verb);
};

fs.writeFileSync = spied("write", fs.writeFileSync);
fs.appendFileSync = spied("append", fs.appendFileSync);
fs.renameSync = spied("rename", fs.renameSync, (args) => (charge("rename", args[1]), false));
fs.mkdirSync = spied("mkdir", fs.mkdirSync);
fs.rmSync = spied("rm", fs.rmSync);
fs.unlinkSync = spied("unlink", fs.unlinkSync);
fs.openSync = spied("open-for-write", fs.openSync, opensForWrite);
fs.writeFile = spied("write", fs.writeFile);
fs.appendFile = spied("append", fs.appendFile);
fs.rename = spied("rename", fs.rename, (args) => (charge("rename", args[1]), false));
fsp.writeFile = spied("write", fsp.writeFile);
fsp.appendFile = spied("append", fsp.appendFile);
fsp.rename = spied("rename", fsp.rename, (args) => (charge("rename", args[1]), false));
fsp.mkdir = spied("mkdir", fsp.mkdir);
childProcess.execFileSync = spied("git", childProcess.execFileSync, gitWrite);
childProcess.execFile = spied("git", childProcess.execFile, gitWrite);
childProcess.spawnSync = spied("git", childProcess.spawnSync, gitWrite);
syncBuiltinESMExports();

const { buildServeRoutes } = await import("../src/lib/serve.js");
const { appendLedger } = await import("../src/lib/ledger.js");
const { loadPlan } = await import("../src/lib/plan.js");

/** Queries a route needs to reach the code that writes; every other route is requested bare. */
const SAMPLE_QUERIES: Record<string, string> = {
  // A well-formed link whose signature does not verify: a refusal worth a ledger row.
  "/v1/escalation/confirm": `?e=ESC-1&c=MANUAL&r=${encodeURIComponent("/v1/drain/kick")}&x=9999999999999&s=${"0".repeat(64)}`,
};

const READ_TOKEN = "read-token";

interface Baseline {
  route: string;
  writes: string[];
  reason: string;
  owner: string;
}

const BASELINE = JSON.parse(readFileSync(new URL("./fixtures/get-write-baseline.json", import.meta.url), "utf8")) as { entries: Baseline[] };

function fixture(): { root: string; ledgerPath: string } {
  const root = mkdtempSync(join(tmpdir(), "rmd-get-writes-"));
  const state = join(root, "state");
  mkdirSync(state, { recursive: true });
  mkdirSync(join(root, "plan"), { recursive: true });
  writeFileSync(join(root, "plan", "tasks.yaml"), '- id: W1-T1\n  title: "fixture"\n  repo: remudero\n  type: implement\n');
  // An inbox to classify, and a feedback entry whose proposal PR has merged: the reconcile flips it.
  writeFileSync(join(state, "inbox-proposals.json"), JSON.stringify({ proposals: [{ id: "ruling:a", summary: "a", evidenceAnchors: [] }] }));
  mkdirSync(join(root, "plan", "feedback"), { recursive: true });
  writeFileSync(join(root, "plan", "feedback", "fb-merged.yaml"), ["id: fb-merged", "ts: '2026-09-20T00:00:00.000Z'", "raw: a fixture proposal", "attachments: []", "origin: cli", "status: proposed", `proposal_pr: '${MERGED_PR}'`, ""].join("\n"));
  const ledgerPath = join(state, "ledger.ndjson");
  writeFileSync(ledgerPath, `${JSON.stringify({ ts: "2026-09-22T11:00:00.000Z", host: "fixture", run_id: "R-1", task_id: "W1-T1", step: "run.start" })}\n`);
  return { root, ledgerPath };
}

const MERGED_PR = "https://github.com/o/r/pull/7";

/** W1-T1 merged in PR 7, which carries its trailer and run branch: a credit the projection finds. */
const mergedGithub = {
  getPr: async () => undefined, listOpenPrs: async () => [], listIssues: async () => [],
  prByRef: (ref: string | number) => (String(ref) === MERGED_PR ? { number: 7, url: MERGED_PR, state: "MERGED" } : null),
  findMergedByTrailer: (taskId: string) => (taskId === "W1-T1" ? { number: 7, url: MERGED_PR, state: "MERGED" } : null),
  headRefName: (url: string) => (url === MERGED_PR ? "run-W1-T1-1790000000000" : undefined),
  prBody: (url: string) => (url === MERGED_PR ? "Remudero-Task: W1-T1\n" : undefined),
};

function depsFor(root: string, ledgerPath: string): Parameters<typeof buildServeRoutes>[0] {
  const github = mergedGithub as never;
  return {
    board: { plan: loadPlan(join(root, "plan", "tasks.yaml")), ledgerPath, github },
    // A credit state the ledger has never recorded: a read of /v1/account-usage records the edge.
    accountUsage: { readAccount: () => ({ creditStateField: "usingCredits", creditStateRaw: true }) },
    panelGraph: { root, planPath: join(root, "plan", "tasks.yaml"), ledgerPath, github: { prView: () => null } as never, statusGithub: github, ratify: { approve: () => {}, reframe: () => {} } as never },
    ledgerPath,
    issues: {} as never,
    fleetControlRoot: root,
    questionsRoot: root,
    tokens: { read: READ_TOKEN, write: "write-token" },
    pollMs: 60_000,
    githubAppRefresh: { start: () => ({ armed: false }) },
    onboardingRepositoryInventory: { read: async () => "0" },
    daemonHealth: { exec: () => JSON.stringify({ resources: { core: { remaining: 4999, reset: 1_790_000_000 } } }) },
  } as never;
}

/** Idle until this route's charge has not moved for `quietMs`, so async work a request started lands in its count. */
async function settle(key: string, quietMs = 150, maxMs = 4_000): Promise<void> {
  const started = Date.now();
  let last = writes.get(key)?.size ?? 0;
  let stableSince = Date.now();
  while (Date.now() - started < maxMs) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    const now = writes.get(key)?.size ?? 0;
    if (now !== last) {
      last = now;
      stableSince = Date.now();
    } else if (Date.now() - stableSince >= quietMs) return;
  }
}

type Measured = { key: string; status: number | "unanswered" };

/** Each GET read route, requested twice, inside its attribution context. */
async function measure(routes: readonly Route[]): Promise<Measured[]> {
  const out: Measured[] = [];
  for (const route of routes) {
    if (route.method !== "GET" || route.scope !== "read") continue;
    const key = `${route.method} ${route.path}`;
    const url = route.path.replace(/:([A-Za-z]+)/g, "fixture") + (SAMPLE_QUERIES[route.path] ?? "");
    let status: Measured["status"] = "unanswered";
    const server = createServer((req, res) => {
      context.run(key, () => {
        Promise.resolve(route.handler(req, res, { params: {} } as never)).catch(() => {
          if (!res.headersSent) res.writeHead(500);
          res.end();
        });
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      for (let i = 0; i < 2; i++) {
        try {
          const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}${url}`, { headers: { authorization: `Bearer ${READ_TOKEN}` }, signal: AbortSignal.timeout(8_000) });
          await res.arrayBuffer();
          status = res.status;
        } catch {
          status = "unanswered";
        }
        await settle(key);
      }
    } finally {
      server.close();
    }
    out.push({ key, status });
  }
  return out;
}

function observed(): Array<{ route: string; writes: string[] }> {
  return [...writes].map(([route, set]) => ({ route, writes: [...set].sort() })).sort((a, b) => (a.route < b.route ? -1 : 1));
}

test("no get route writes state outside the baseline", async () => {
  const { root, ledgerPath } = fixture();
  fixtureRoot = root;
  writes.clear();
  try {
    const measured = await measure(buildServeRoutes(depsFor(root, ledgerPath)));
    const answered = measured.filter((m) => m.status !== "unanswered");
    assert.ok(answered.length >= 40, `expected the read-route table to be driven, answered ${answered.length}`);
    const seen = observed();
    const known = new Map(BASELINE.entries.map((entry) => [entry.route, new Set(entry.writes)]));
    const unbaselined = seen.flatMap(({ route, writes: w }) => w.filter((write) => !known.get(route)?.has(write)).map((write) => `${route}: ${write}`));
    assert.deepEqual(unbaselined, [], "a GET route that newly writes state is refused by name; move the write to an owner a change triggers, never a reader");
    const byRoute = new Map(seen.map(({ route, writes: w }) => [route, new Set(w)]));
    const gone = BASELINE.entries.flatMap((entry) => entry.writes.filter((write) => !byRoute.get(entry.route)?.has(write)).map((write) => `${entry.route}: ${write}`));
    assert.deepEqual(gone, [], "a baselined GET write no longer happens: delete it from test/fixtures/get-write-baseline.json, which only shrinks");
  } finally {
    fixtureRoot = "";
    rmSync(root, { recursive: true, force: true });
  }
});

test("a synthetic get route that appends to the ledger is caught by the census", async () => {
  const { root, ledgerPath } = fixture();
  fixtureRoot = root;
  writes.clear();
  try {
    const appends: Route = {
      method: "GET", path: "/v1/synthetic-append", scope: "read",
      handler: async (_req, res) => {
        await new Promise((resolve) => setImmediate(resolve));
        appendLedger(ledgerPath, { run_id: "R-synthetic", task_id: "W1-T1", step: "synthetic.read_wrote" });
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
      },
    };
    const [m] = await measure([appends]);
    assert.equal(m?.status, 200);
    assert.deepEqual(observed().filter((o) => o.route === "GET /v1/synthetic-append"), [{ route: "GET /v1/synthetic-append", writes: ["mkdir state", "open-for-write state/ledger.ndjson"] }]);
  } finally {
    fixtureRoot = "";
    rmSync(root, { recursive: true, force: true });
  }
});
