// W1-T12555: the daemon's tick reads run in a read-plane worker thread, and the board's status walk runs
// in its own worker thread. A worker loads its own copy of github-transport.ts, so before this task the
// status walk's reads asked a second, unconfigured budget. Both workers now join the main thread's
// atomic budget state, so their reads take their share of the one process allowance.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startWorker } from "#src/lib/child-entry-argv.js";
import { systemClock } from "#src/lib/clock.js";
import { createInstallationBudget, createInstallationBudgetState } from "#src/lib/github-installation-budget.js";
import { configureGithubInstallationBudget, githubInstallationBudget } from "#src/lib/github-transport.js";
import { loadPlan } from "#src/lib/plan.js";
import { startReadPlane } from "#src/lib/read-plane.js";
import { buildBatchedGithub } from "#src/lib/status.js";
import { startTickReadWorker, tickReadWorkerUrl, type TickReadFacts, type TickReadOptions, type TickReadRequest } from "#src/lib/tick-read-worker.js";
import { makeTempDir } from "#src/lib/tmp.js";
import { withGhShim, type GhShim, type GhShimRoute } from "#test/helpers/gh-shim.js";

const LIMIT = 1000;
const HOUR_S = 3600;
const nowS = (): number => Math.floor(systemClock.now() / 1000);

/** A GitHub response with core rate-limit headers, as `gh api -i` prints it. */
function withHeaders(remaining: number, reset: number, body = "[]"): string {
  return `HTTP/2.0 200 OK\r\nX-Ratelimit-Remaining: ${remaining}\r\nX-Ratelimit-Limit: ${LIMIT}\r\n` +
    `X-Ratelimit-Reset: ${reset}\r\nX-Ratelimit-Resource: core\r\n\r\n${body}`;
}

/** The main thread's budget, as the daemon sets it at start: shared atomic state, two consumers. */
function configureSharedBudget(): void {
  configureGithubInstallationBudget(createInstallationBudget({
    consumers: 2, instance: "core", clock: systemClock, sharedState: createInstallationBudgetState(),
  }));
}

/** Spend every read the main thread's allowance has left, and return how many there were. */
function spendRest(): number {
  let reads = 0;
  while (githubInstallationBudget().claimRead().ok) reads += 1;
  return reads;
}

async function until(done: () => boolean, what: string, ms = 60_000): Promise<void> {
  const deadline = systemClock.now() + ms;
  while (!done()) {
    if (systemClock.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

interface Plane {
  read(): Promise<{ source: string }>;
  rows: Array<{ step: string; extra?: Record<string, unknown> }>;
  stop(): Promise<void>;
}

/** A real read-plane worker thread, started the way the daemon starts it, on its own plan and config root. */
function tickReadPlane(start: (options: TickReadOptions) => ReturnType<typeof startTickReadWorker> = (o) => startTickReadWorker(o)): Plane {
  const root = makeTempDir("w12555-tick-read");
  mkdirSync(join(root, "state"), { recursive: true });
  const planPath = join(root, "tasks.yaml");
  writeFileSync(planPath, "- {id: A, title: a, repo: r, type: implement, files: [src/a.ts], depends_on: [], status: queued}\n");
  const ledgerPath = join(root, "state", "ledger.ndjson");
  writeFileSync(ledgerPath, "");
  const options = { owner: "o", repo: "r", config: { root, claudeBin: process.execPath }, ledgerPath, checkoutRoot: root } as unknown as TickReadOptions;
  const rows: Plane["rows"] = [];
  const plane = startReadPlane<TickReadRequest, TickReadFacts>({
    workerUrl: tickReadWorkerUrl(), workerInput: options, spawn: () => start(options),
    inline: () => { throw new Error("the inline fallback ran"); },
    log: (step, extra) => rows.push({ step, extra }),
  });
  return {
    read: () => plane.read({ plan: loadPlan(planPath) }),
    rows,
    async stop() {
      await plane.stop();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

const standDowns = (rows: Plane["rows"]): number =>
  rows.filter((row) => String(row.extra?.message ?? "").includes("gh call pacer stood down")).length;

/** Plain answers: no rate-limit headers, so only the main thread's reading counts. */
const PLAIN: GhShimRoute[] = [{ when: "", stdout: "[]" }];

async function withBudget(routes: GhShimRoute[], body: (shim: GhShim) => Promise<void>): Promise<void> {
  const bundled = process.env.RMD_BUNDLED_WORKERS;
  process.env.RMD_BUNDLED_WORKERS = "0"; // the .ts source under tsx: this tree carries no worker bundle
  try {
    await withGhShim(routes, body, { kind: "w12555-gh" });
  } finally {
    configureGithubInstallationBudget(undefined);
    if (bundled === undefined) delete process.env.RMD_BUNDLED_WORKERS;
    else process.env.RMD_BUNDLED_WORKERS = bundled;
  }
}

test("W1-T12555 criterion 1: a tick read in the worker thread counts each read and hands its newest reading to the main thread", async () => {
  await withBudget(PLAIN, async (shim) => {
    configureSharedBudget();
    const reset = nowS() + HOUR_S;
    githubInstallationBudget().record({ remaining: 600, limit: LIMIT, reset, resource: "core" });
    assert.equal(githubInstallationBudget().allowance(), 250, "floor((600 - 100) / 2)");
    const plane = tickReadPlane();
    try {
      assert.equal((await plane.read()).source, "worker");
      const workerReads = shim.calls().length;
      assert.ok(workerReads > 0, "positive control: the tick read made GitHub reads");
      assert.equal(spendRest(), 250 - workerReads, "the main thread's allowance counts each read the worker made");

      githubInstallationBudget().record({ remaining: 600, limit: LIMIT, reset, resource: "core" });
      shim.addRoute({ when: "state=open", stdout: withHeaders(900, reset) });
      assert.equal((await plane.read()).source, "worker");
      assert.ok(shim.calls().some((call) => call.includes("state=open")), "the second generation read the open PRs");
      assert.equal(githubInstallationBudget().allowance(), 400, "the main thread holds the worker's newest reading: floor((900 - 100) / 2)");
    } finally {
      await plane.stop();
    }
  });
});

test("W1-T12555 criterion 2: with the share spent, the worker reads nothing before the reset, and a newer reading lets it read again", async () => {
  await withBudget(PLAIN, async (shim) => {
    configureSharedBudget();
    const plane = tickReadPlane();
    try {
      assert.equal((await plane.read()).source, "worker", "the worker has started");
      // A share of one read: the worker's first read spends it, and the share stays spent until the reset.
      const reset = nowS() + 5;
      githubInstallationBudget().record({ remaining: 102, limit: LIMIT, reset, resource: "core" });
      assert.equal(githubInstallationBudget().allowance(), 1);
      const before = shim.calls().length;
      const generation = plane.read();
      await until(() => standDowns(plane.rows) > 0, "the synchronous reads to stand down");
      assert.ok(systemClock.now() < reset * 1000, "the stand-down came before the reset");
      assert.equal(shim.calls().length, before + 1, "no GitHub read beyond the share before the reset");
      assert.equal((await generation).source, "worker");
      assert.ok(systemClock.now() >= reset * 1000, "the async reads waited for the reset");
      assert.ok(shim.calls().length > before, "the async reads went after the reset");

      const later = nowS() + HOUR_S;
      githubInstallationBudget().record({ remaining: 102, limit: LIMIT, reset: later, resource: "core" });
      spendRest();
      assert.equal(githubInstallationBudget().admit().ok, false, "the share is spent again");
      githubInstallationBudget().record({ remaining: 900, limit: LIMIT, reset: later, resource: "core" });
      const refused = standDowns(plane.rows);
      const again = shim.calls().length;
      assert.equal((await plane.read()).source, "worker");
      assert.ok(shim.calls().length > again, "the newer, larger reading lets the worker read again");
      assert.equal(standDowns(plane.rows), refused, "no read stood down under the newer reading");
    } finally {
      await plane.stop();
    }
  });
});

/** The board's status walk, run once on its worker thread or, when the worker cannot start, on this thread. */
async function walk(workerUrl?: URL): Promise<string | undefined> {
  const gh = buildBatchedGithub("o", "r", workerUrl === undefined ? {} : { workerUrl });
  gh.warm?.();
  await until(() => gh.readState?.() !== "in_flight" && gh.readState?.() !== "not_attempted", "the status walk to settle");
  return gh.readState?.();
}

for (const [where, workerUrl] of [
  ["its worker thread", undefined],
  // A non-file worker URL makes `new Worker` throw at once, so the walk runs on the main thread.
  ["the main-thread fallback", new URL("https://invalid.example/prewarm-worker.js")],
] as const) {
  test(`W1-T12555 criterion 3: the status walk on ${where} records its reading and counts its calls in the main thread's budget`, async () => {
    const reset = nowS() + HOUR_S;
    await withBudget([{ when: "", stdout: withHeaders(900, reset) }], async (shim) => {
      configureSharedBudget();
      githubInstallationBudget().record({ remaining: 600, limit: LIMIT, reset, resource: "core" });
      assert.equal(await walk(workerUrl), "ok");
      assert.equal(shim.calls().length, 3, "positive control: open, merged and issues");
      assert.equal(githubInstallationBudget().allowance(), 400, "the walk's reading reached the main thread");
    });
    await withBudget(PLAIN, async (shim) => {
      configureSharedBudget();
      githubInstallationBudget().record({ remaining: 600, limit: LIMIT, reset, resource: "core" });
      assert.equal(await walk(workerUrl), "ok");
      assert.equal(spendRest(), 250 - shim.calls().length, "each of the walk's calls counts against the allowance");
    });
    await withBudget(PLAIN, async (shim) => {
      configureSharedBudget();
      githubInstallationBudget().record({ remaining: 600, limit: LIMIT, reset, resource: "core" });
      spendRest();
      assert.equal(await walk(workerUrl), "failed", "a walk that starts with the share spent reads nothing");
      assert.equal(shim.calls().length, 0, "no GitHub read before the reset");
    });
  });
}

test("W1-T12555 criterion 4: with a budget every worker read asks the one allowance; with none, reads pace as before", async () => {
  await withBudget(PLAIN, async (shim) => {
    configureSharedBudget();
    githubInstallationBudget().record({ remaining: 102, limit: LIMIT, reset: nowS() + HOUR_S, resource: "core" });
    spendRest();
    const plane = tickReadPlane();
    try {
      void plane.read().catch(() => undefined);
      await until(() => plane.rows.some((row) => row.step === "read_plane.worker_started"), "the worker to start");
      await new Promise((resolve) => setTimeout(resolve, 2000));
      assert.equal(await walk(), "failed");
      assert.equal(shim.calls().length, 0, "no thread read GitHub without asking the allowance");
    } finally {
      await plane.stop();
    }
  });
  await withBudget(PLAIN, async (shim) => {
    configureGithubInstallationBudget(undefined);
    const inputs: unknown[] = [];
    const plane = tickReadPlane((options) => startTickReadWorker(options, {
      start: (url, workerOptions, opts) => {
        inputs.push((workerOptions?.workerData as { input: unknown } | undefined)?.input);
        return startWorker(url, workerOptions, opts);
      },
    }));
    try {
      assert.equal((await plane.read()).source, "worker");
      assert.equal(inputs.length, 1);
      assert.equal("githubInstallationBudget" in (inputs[0] as object), false, "no budget state goes to the worker");
      assert.ok(shim.calls().length > 0, "the tick read reads GitHub");
      assert.equal(standDowns(plane.rows), 0);
      assert.equal(githubInstallationBudget().allowance(), undefined);
    } finally {
      await plane.stop();
    }
    const calls = shim.calls().length;
    assert.equal(await walk(), "ok");
    assert.equal(shim.calls().length, calls + 3, "the status walk reads open, merged and issues");
  });
});
