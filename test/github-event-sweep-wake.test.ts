import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { EventEmitter } from "node:events";
import type { FSWatcher } from "node:fs";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runDaemon } from "../src/lib/daemon.js";
import {
  consumeSweepWakeMarker,
  createDeliveryDedupStore,
  createGitHubEventWakeHandler,
  createPersistentDeliveryDedupStore,
  createSweepWakeSignal,
  isAllowlistedGithubEvent,
  readGithubWebhookSecret,
  readSweepWakeMarker,
  sweepWakeMarkerPath,
  watchSweepWakeMarker,
  wireSweepWakeToDaemon,
  writeSweepWakeMarkerAtomic,
} from "../src/lib/github-event-wake.js";
import { createService, readBoundedRawBody, type Route } from "../src/lib/service.js";
import { loadPlan } from "../src/lib/plan.js";
import { daemonCommand } from "../src/run-task.js";

const SECRET = "test-webhook-secret";
const REPOSITORY = "craigoley/remudero";
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function signature(body: string): string {
  return `sha256=${createHmac("sha256", SECRET).update(body, "utf8").digest("hex")}`;
}

async function withRoute<T>(route: Route, run: (url: string) => Promise<T>): Promise<T> {
  const server = createService({ tokens: { read: "read", write: "write" }, routes: [route] });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    return await run(`http://127.0.0.1:${port}${route.path}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

function webhookHeaders(body: string, deliveryId: string, event = "check_run"): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-github-delivery": deliveryId,
    "x-github-event": event,
    "x-hub-signature-256": signature(body),
  };
}

function oneTaskPlan(root: string) {
  const path = join(root, "tasks.yaml");
  writeFileSync(path, "- id: W1-T2568\n  title: wake\n  repo: remudero\n  type: implement\n  depends_on: []\n  status: queued\n");
  return loadPlan(path);
}

test("pull-request review changes that alter merge eligibility all wake reconciliation", () => {
  assert.equal(isAllowlistedGithubEvent("pull_request_review", "submitted"), true);
  assert.equal(isAllowlistedGithubEvent("pull_request_review", "edited"), true);
  assert.equal(isAllowlistedGithubEvent("pull_request_review", "dismissed"), true);
});

test("the bounded delivery set survives a serve-process restart", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-github-dedup-"));
  const path = join(root, "state", "github-webhook-deliveries.json");
  try {
    const first = createPersistentDeliveryDedupStore(path, 2);
    assert.equal(first.has("delivery-a"), false);
    first.record("delivery-a");
    first.record("delivery-b");

    const restarted = createPersistentDeliveryDedupStore(path, 2);
    assert.equal(restarted.has("delivery-a"), true);
    assert.equal(restarted.has("delivery-b"), true);
    restarted.record("delivery-c");

    const bounded = createPersistentDeliveryDedupStore(path, 2);
    assert.equal(bounded.has("delivery-a"), false);
    assert.equal(bounded.has("delivery-b"), true);
    assert.equal(bounded.has("delivery-c"), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the in-memory delivery window evicts its oldest accepted id at capacity", () => {
  const store = createDeliveryDedupStore(2, ["delivery-a", "delivery-a", "delivery-b"]);
  store.record("delivery-c");
  assert.equal(store.has("delivery-a"), false);
  assert.equal(store.has("delivery-b"), true);
  assert.equal(store.has("delivery-c"), true);
});

test("persistent delivery writes remove a staged temp after rename failure without poisoning memory", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-github-dedup-rename-failure-"));
  const path = join(root, "state", "deliveries.json");
  mkdirSync(path, { recursive: true });
  const store = createPersistentDeliveryDedupStore(path, 2);
  try {
    assert.throws(() => store.record("delivery-a"));
    assert.equal(store.has("delivery-a"), false);
    assert.deepEqual(readdirSync(dirname(path)).sort(), ["deliveries.json"], "the failed atomic write leaves no temp file");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("persistent delivery cleanup preserves the original write error when no temp file exists", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-github-dedup-write-failure-"));
  const path = join(root, "x".repeat(300));
  const store = createPersistentDeliveryDedupStore(path, 2);
  try {
    assert.throws(() => store.record("delivery-a"));
    assert.equal(store.has("delivery-a"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a marker-write failure does not poison the delivery id", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-github-marker-failure-"));
  const markerPath = sweepWakeMarkerPath(root);
  const dedup = createDeliveryDedupStore(10);
  let failWrite = true;
  const route = createGitHubEventWakeHandler({
    secret: SECRET,
    repository: REPOSITORY,
    markerPath,
    dedup,
    writeMarker: (path, marker) => {
      if (failWrite) throw new Error("synthetic marker failure");
      mkdirSync(join(root, "state"), { recursive: true });
      writeFileSync(path, JSON.stringify(marker));
    },
  });
  const body = JSON.stringify({ action: "completed", repository: { full_name: REPOSITORY } });
  try {
    await withRoute(route, async (url) => {
      const failed = await fetch(url, { method: "POST", headers: webhookHeaders(body, "delivery-retry"), body });
      assert.equal(failed.status, 500);
      failWrite = false;
      const retried = await fetch(url, { method: "POST", headers: webhookHeaders(body, "delivery-retry"), body });
      assert.equal(retried.status, 202);
      assert.deepEqual(await retried.json(), { accepted: true });
      assert.equal(JSON.parse(readFileSync(markerPath, "utf8")).deliveryId, "delivery-retry");
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an oversized webhook receives 413 without resetting the connection", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-github-body-bound-"));
  const body = JSON.stringify({ action: "completed", repository: { full_name: REPOSITORY }, padding: "x".repeat(128) });
  const route = createGitHubEventWakeHandler({
    secret: SECRET,
    repository: REPOSITORY,
    markerPath: sweepWakeMarkerPath(root),
    dedup: createDeliveryDedupStore(10),
    maxBodyBytes: 64,
  });
  try {
    await withRoute(route, async (url) => {
      const response = await fetch(url, { method: "POST", headers: webhookHeaders(body, "delivery-large"), body });
      assert.equal(response.status, 413);
      assert.deepEqual(await response.json(), { error: "body_too_large" });
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a bounded raw-body read forwards a request-stream failure exactly once", async () => {
  const req = new EventEmitter() as IncomingMessage;
  const reading = readBoundedRawBody(req, 64);
  req.emit("error", new Error("synthetic socket failure"));
  req.emit("end");
  await assert.rejects(reading, /synthetic socket failure/);
});

test("the signed route names every refusal and writes only an accepted allowlisted delivery", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-github-route-"));
  const markerPath = sweepWakeMarkerPath(root);
  const logs: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const route = createGitHubEventWakeHandler({
    secret: SECRET,
    repository: REPOSITORY,
    markerPath,
    dedup: createDeliveryDedupStore(10),
    log: (step, extra) => logs.push({ step, extra }),
  });
  try {
    await withRoute(route, async (url) => {
      const valid = JSON.stringify({ action: "completed", repository: { full_name: REPOSITORY } });
      const invalidSignature = await fetch(url, {
        method: "POST",
        headers: { ...webhookHeaders(valid, "bad-signature"), "x-hub-signature-256": "sha256=00" },
        body: valid,
      });
      assert.equal(invalidSignature.status, 401);
      assert.equal(consumeSweepWakeMarker(markerPath), undefined);

      const invalidJson = "{";
      const invalidJsonResponse = await fetch(url, {
        method: "POST",
        headers: webhookHeaders(invalidJson, "bad-json"),
        body: invalidJson,
      });
      assert.equal(invalidJsonResponse.status, 400);
      assert.equal(consumeSweepWakeMarker(markerPath), undefined);

      const wrongRepo = JSON.stringify({ action: "completed", repository: { full_name: "somewhere/else" } });
      const wrongRepoResponse = await fetch(url, {
        method: "POST",
        headers: webhookHeaders(wrongRepo, "wrong-repo"),
        body: wrongRepo,
      });
      assert.equal(wrongRepoResponse.status, 403);
      assert.equal(consumeSweepWakeMarker(markerPath), undefined);

      const unsupported = JSON.stringify({ action: "queued", repository: { full_name: REPOSITORY } });
      const unsupportedResponse = await fetch(url, {
        method: "POST",
        headers: webhookHeaders(unsupported, "unsupported"),
        body: unsupported,
      });
      assert.equal(unsupportedResponse.status, 202);
      assert.deepEqual(await unsupportedResponse.json(), { error: "ignored" });
      assert.equal(consumeSweepWakeMarker(markerPath), undefined);

      const missingDeliveryHeaders = webhookHeaders(valid, "unused");
      delete missingDeliveryHeaders["x-github-delivery"];
      const missingDelivery = await fetch(url, { method: "POST", headers: missingDeliveryHeaders, body: valid });
      assert.equal(missingDelivery.status, 400);
      assert.equal(consumeSweepWakeMarker(markerPath), undefined);

      const accepted = await fetch(url, { method: "POST", headers: webhookHeaders(valid, "accepted"), body: valid });
      assert.equal(accepted.status, 202);
      assert.deepEqual(await accepted.json(), { accepted: true });
      assert.equal(consumeSweepWakeMarker(markerPath)?.deliveryId, "accepted");

      const duplicate = await fetch(url, { method: "POST", headers: webhookHeaders(valid, "accepted"), body: valid });
      assert.equal(duplicate.status, 202);
      assert.deepEqual(await duplicate.json(), { duplicate: true });
      assert.equal(consumeSweepWakeMarker(markerPath), undefined);
    });
    assert.deepEqual(
      logs.map((entry) => entry.step),
      [
        "github.wake.refused",
        "github.wake.refused",
        "github.wake.refused",
        "github.wake.ignored",
        "github.wake.refused",
        "github.wake.accepted",
        "github.wake.duplicate",
      ],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an unconfigured secret ships the route dark without writing state", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-github-dark-"));
  const markerPath = sweepWakeMarkerPath(root);
  const route = createGitHubEventWakeHandler({
    secret: undefined,
    repository: REPOSITORY,
    markerPath,
    dedup: createDeliveryDedupStore(10),
  });
  try {
    await withRoute(route, async (url) => {
      const response = await fetch(url, { method: "POST", body: "{}" });
      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), { error: "webhook_not_configured" });
      assert.equal(consumeSweepWakeMarker(markerPath), undefined);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("distinct deliveries coalesce to one durable marker carrying the latest wake", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-github-coalesce-"));
  const path = sweepWakeMarkerPath(root);
  try {
    writeSweepWakeMarkerAtomic(path, {
      deliveryId: "delivery-a",
      event: "check_run",
      action: "completed",
      repository: REPOSITORY,
      receivedAtIso: "2026-09-01T20:00:00.000Z",
    });
    writeSweepWakeMarkerAtomic(path, {
      deliveryId: "delivery-b",
      event: "status",
      action: undefined,
      repository: REPOSITORY,
      receivedAtIso: "2026-09-01T20:00:01.000Z",
    });
    assert.equal(consumeSweepWakeMarker(path)?.deliveryId, "delivery-b");
    assert.equal(consumeSweepWakeMarker(path), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an early wake cancels its timer instead of leaving it alive through shutdown", async () => {
  let scheduled: (() => void) | undefined;
  let cancelled = 0;
  const signal = createSweepWakeSignal(false, {
    setTimer: (callback) => {
      scheduled = callback;
      return 42;
    },
    clearTimer: (handle) => {
      assert.equal(handle, 42);
      cancelled++;
    },
  });
  const waiting = signal.sleep(60_000);
  assert.ok(scheduled);
  signal.wake();
  await waiting;
  assert.equal(cancelled, 1);
});

test("a boot marker and a live marker interrupt polling but remain durable until the sweep gate acknowledges them", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-github-wiring-"));
  const path = sweepWakeMarkerPath(root);
  const marker = (deliveryId: string) => ({
    deliveryId,
    event: "check_run",
    action: "completed",
    repository: REPOSITORY,
    receivedAtIso: "2026-09-01T20:00:00.000Z",
  });
  try {
    writeSweepWakeMarkerAtomic(path, marker("boot-delivery"));
    const boot = wireSweepWakeToDaemon(root);
    await Promise.race([
      boot.sleep(60_000),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("boot wake did not interrupt sleep")), 250)),
    ]);
    assert.equal(readSweepWakeMarker(path)?.deliveryId, "boot-delivery", "an interrupt alone must not claim unreconciled work");
    boot.acknowledge();
    assert.equal(consumeSweepWakeMarker(path), undefined);
    boot.close();

    const live = wireSweepWakeToDaemon(root);
    writeSweepWakeMarkerAtomic(path, marker("during-active-sweep"));
    await Promise.race([
      live.sleep(60_000),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`live wake did not interrupt sleep; marker=${JSON.stringify(readSweepWakeMarker(path))}`)),
          250,
        ),
      ),
    ]);
    assert.equal(readSweepWakeMarker(path)?.deliveryId, "during-active-sweep", "a live edge also stays durable until admission");
    live.acknowledge();
    assert.equal(consumeSweepWakeMarker(path), undefined);
    live.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("watch failure is reported once and leaves the timer sleep usable", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-github-watch-failure-"));
  const fake = new EventEmitter() as FSWatcher;
  fake.close = () => {};
  const logs: string[] = [];
  const signal = createSweepWakeSignal();
  const watcher = watchSweepWakeMarker(
    root,
    signal,
    (step) => logs.push(step),
    (() => fake) as typeof import("node:fs").watch,
  );
  try {
    fake.emit("error", new Error("first"));
    fake.emit("error", new Error("second"));
    assert.deepEqual(logs, ["github.wake.watch_failed"]);
    await signal.sleep(1);
  } finally {
    watcher.close();
    signal.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("the marker watcher ignores other filenames and wakes only when its durable target exists", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-github-watch-filter-"));
  const fake = new EventEmitter() as FSWatcher;
  fake.close = () => {};
  let callback: ((eventType: string, filename: string | Buffer | null) => void) | undefined;
  let wakes = 0;
  const watcher = watchSweepWakeMarker(
    root,
    { wake: () => { wakes++; } } as ReturnType<typeof createSweepWakeSignal>,
    () => {},
    ((_: string, listener: (eventType: string, filename: string | Buffer | null) => void) => {
      callback = listener;
      return fake;
    }) as typeof import("node:fs").watch,
  );
  try {
    assert.ok(callback);
    callback!("rename", "not-the-marker.json");
    callback!("rename", "SWEEP_WAKE_REQUESTED");
    assert.equal(wakes, 0);
    writeFileSync(sweepWakeMarkerPath(root), "{}\n");
    callback!("rename", "SWEEP_WAKE_REQUESTED");
    assert.equal(wakes, 1);
  } finally {
    watcher.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a durable marker still interrupts the poll when the filesystem watcher drops its event", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-github-missed-watch-"));
  const path = sweepWakeMarkerPath(root);
  const fake = new EventEmitter() as FSWatcher;
  fake.close = () => {};
  const wiring = wireSweepWakeToDaemon(root, () => {}, (() => fake) as typeof import("node:fs").watch);
  try {
    writeSweepWakeMarkerAtomic(path, {
      deliveryId: "missed-watch-delivery",
      event: "check_run",
      action: "completed",
      repository: REPOSITORY,
      receivedAtIso: "2026-09-01T20:00:00.000Z",
    });
    await Promise.race([
      wiring.sleep(60_000),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("durable marker did not backstop the missed watch")), 100)),
    ]);
    assert.equal(readSweepWakeMarker(path)?.deliveryId, "missed-watch-delivery");
  } finally {
    wiring.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("an event wake reaches the ordinary sweep gate and STOP or PAUSE still wins first", async () => {
  for (const gate of ["ordinary", "stop", "pause"] as const) {
    const root = mkdtempSync(join(tmpdir(), `rmd-github-${gate}-`));
    const path = sweepWakeMarkerPath(root);
    writeSweepWakeMarkerAtomic(path, {
      deliveryId: `${gate}-delivery`,
      event: "check_run",
      action: "completed",
      repository: REPOSITORY,
      receivedAtIso: "2026-09-01T20:00:00.000Z",
    });
    const wiring = wireSweepWakeToDaemon(root);
    let sweeps = 0;
    let stopChecks = 0;
    try {
      const summary = await runDaemon(
        oneTaskPlan(root),
        {
          refreshMerged: () => () => true,
          runOne: async () => {
            throw new Error("a merged fixture task must never dispatch");
          },
          sweep: async () => {
            sweeps++;
          },
          checkStop: () => {
            stopChecks++;
            if (gate === "stop") return "operator stop";
            if (gate === "pause" && stopChecks >= 2) return "stop after one paused wake";
            if (gate === "ordinary" && sweeps >= 1) return "stop after one event-triggered sweep";
            return undefined;
          },
          checkPause: () => (gate === "pause" ? "operator pause" : undefined),
          sleep: async () => {},
          sleepUntilSweepWake: async () => {},
          acknowledgeSweepWake: wiring.acknowledge,
        },
      );
      assert.equal(summary.stopReason, "stopped");
      assert.equal(sweeps, gate === "ordinary" ? 1 : 0, `${gate} must preserve the timer path's gate order`);
      assert.equal(
        readSweepWakeMarker(path)?.deliveryId,
        gate === "ordinary" ? undefined : `${gate}-delivery`,
        `${gate} must ${gate === "ordinary" ? "consume" : "retain"} the durable wake`,
      );
    } finally {
      wiring.close();
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("a delivery arriving during an active full sweep is reconciled by exactly one later full pass", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-github-active-sweep-"));
  const path = sweepWakeMarkerPath(root);
  const wiring = wireSweepWakeToDaemon(root);
  let sweeps = 0;
  const steps: string[] = [];
  let releaseFirst!: () => void;
  let reportFirstStarted!: () => void;
  const firstStarted = new Promise<void>((resolve) => {
    reportFirstStarted = resolve;
  });
  const holdFirst = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  try {
    const running = runDaemon(
      oneTaskPlan(root),
      {
        refreshMerged: () => () => true,
        runOne: async () => {
          throw new Error("a merged fixture task must never dispatch");
        },
        sweep: async () => {
          sweeps++;
          if (sweeps === 1) {
            reportFirstStarted();
            await holdFirst;
          }
        },
        checkStop: () => (sweeps >= 2 ? "second pass completed" : undefined),
        sleep: async () => {},
        sleepUntilSweepWake: (ms) => (sweeps >= 2 ? Promise.resolve() : wiring.sleep(ms)),
        acknowledgeSweepWake: wiring.acknowledge,
        log: (step) => steps.push(step),
      },
    );
    await firstStarted;
    writeSweepWakeMarkerAtomic(path, {
      deliveryId: "during-active-sweep",
      event: "check_run",
      action: "completed",
      repository: REPOSITORY,
      receivedAtIso: "2026-09-01T20:00:00.000Z",
    });
    releaseFirst();
    const timeout = new Promise<never>((_, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`event wake did not produce a later pass; sweeps=${sweeps}, steps=${steps.join(",")}`)),
        2_000,
      );
      timer.unref();
    });
    const summary = await Promise.race([running, timeout]);
    assert.equal(summary.stopReason, "stopped");
    assert.equal(sweeps, 2);
    assert.equal(consumeSweepWakeMarker(path), undefined);
  } finally {
    wiring.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("Azure wiring mounts the webhook secret into serve only and documents exact-path commissioning", () => {
  const serve = readFileSync(join(REPO_ROOT, "deploy", "serve-container.sh"), "utf8");
  const recycle = readFileSync(join(REPO_ROOT, "deploy", "recycle-container.sh"), "utf8");
  const hostUpdate = readFileSync(join(REPO_ROOT, "deploy", "host-update.sh"), "utf8");
  const runtimeVars = readFileSync(join(REPO_ROOT, "deploy", "runtime-env-vars.sh"), "utf8");
  const guide = readFileSync(join(REPO_ROOT, "docs", "operator-guide.md"), "utf8");

  assert.match(serve, /RMD_GITHUB_WEBHOOK_SECRET_PATH/);
  assert.match(serve, /RMD_GITHUB_WEBHOOK_SECRET_FILE=/);
  assert.match(serve, /GITHUB_WEBHOOK_SECRET_MOUNT_DEST="\/home\/node\/\.rmd-github-webhook-secret"/);
  assert.match(serve, /GITHUB_WEBHOOK_SECRET_ARGS=\(-v "\$\{GITHUB_WEBHOOK_SECRET_PATH\}:\$\{GITHUB_WEBHOOK_SECRET_MOUNT_DEST\}:ro"/);
  assert.doesNotMatch(recycle, /RMD_GITHUB_WEBHOOK_SECRET_(?:PATH|FILE)/);
  const printedDaemon = hostUpdate.slice(hostUpdate.indexOf("docker run -d --name remudero-daemon"), hostUpdate.indexOf("./bin/rmd daemon"));
  assert.doesNotMatch(printedDaemon, /RMD_GITHUB_WEBHOOK_SECRET_(?:PATH|FILE)/);
  assert.match(runtimeVars, /RMD_SERVE_RUNTIME_ENV_VARS=\([\s\S]*RMD_GITHUB_WEBHOOK_SECRET_FILE[\s\S]*\)/);
  assert.match(guide, /console\.remudero\.com\/v1\/hooks\/github/);
  assert.match(guide, /more-specific Access application/);
  assert.match(guide, /operator merge hold/);
});

test("the webhook secret reader trims a configured file and fails soft for absent input", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-github-secret-reader-"));
  const path = join(root, "secret");
  try {
    assert.equal(readGithubWebhookSecret(undefined), undefined);
    assert.equal(readGithubWebhookSecret(path), undefined);
    writeFileSync(path, "  configured-secret  \n");
    assert.equal(readGithubWebhookSecret(path), "configured-secret");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("daemon SIGTERM cleanup closes the GitHub wake watcher before re-raising the signal", async () => {
  const home = mkdtempSync(join(tmpdir(), "rmd-github-daemon-signal-"));
  const oldHome = process.env.HOME;
  const root = join(home, "Remudero");
  const planPath = join(home, "tasks.yaml");
  mkdirSync(join(home, ".config", "remudero"), { recursive: true });
  mkdirSync(join(root, "state"), { recursive: true });
  writeFileSync(join(home, ".config", "remudero", "config.json"), JSON.stringify({ claudeBin: "/bin/true", root }));
  writeFileSync(planPath, "[]\n");
  utimesSync(home, new Date(), new Date());
  let closes = 0;
  const reRaised: Array<{ pid: number; signal: NodeJS.Signals }> = [];
  process.env.HOME = home;
  try {
    const code = await daemonCommand(["--allow-self-target", "--plan", planPath, "--max", "0"], {
      wireSweepWake: () => ({
        sleep: async () => {},
        acknowledge: () => {},
        close: () => { closes++; },
      }),
      processKill: (pid, signal) => {
        assert.equal(closes, 1, "the signal path closes the watcher before re-raising");
        reRaised.push({ pid, signal });
        return true;
      },
      runDaemon: async () => {
        (process as EventEmitter).emit("SIGTERM", "SIGTERM");
        return { attempted: [], merged: [], stopReason: "stopped" as const, costUsd: 0, ticks: 0 };
      },
    });
    assert.equal(code, 0);
    assert.deepEqual(reRaised, [{ pid: process.pid, signal: "SIGTERM" }]);
    assert.equal(closes, 2, "ordinary finalization keeps the existing idempotent close path");
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    rmSync(home, { recursive: true, force: true });
  }
});
