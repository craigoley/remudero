/**
 * W1-T8711: host-wide serve state comes from a current shared producer (serve's published observation in the shared
 * host-memory evidence directory), never from a peer instance's local ledger silence. Missing, stale, corrupt, foreign,
 * future-dated and local-only evidence is UNKNOWN; a stop is fenced by producer generation.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { fixedClock } from "../src/lib/clock.js";
import {
  HOST_SERVE_FRESH_MS,
  HOST_SERVE_SUBDIR,
  publishHostServeEvidence,
  readHostServeEvidence,
  resetHostServeDiagnosticsForTests,
  type HostServeEvidenceOptions,
  type HostServePublishOptions,
  type HostServeReading,
  type HostServeScenario,
} from "../src/lib/host-serve-evidence.js";
import {
  defaultShadowMemoryPorts,
  gatherShadowInputs,
  type HostMemoryBudgetPolicy,
  type ShadowInputs,
} from "../src/lib/host-memory-shadow.js";

const NOW = Date.parse("2026-10-12T16:07:07.954Z");
const BOOT = "boot-aaaa";
const MIN = 60_000;

const POLICY: HostMemoryBudgetPolicy = {
  mode: "shadow", hostReserveMib: 2048, containerReserveMib: 1024, swapInPagesPerSecMax: 256, psiSomeAvg10Max: 10,
  psiFullAvg10Max: 2, serveColdStartReserveMib: 7680, uncertaintyMarginMib: 256, daemonGrowthUnmeasuredMib: 1024,
  daemonGrowthMinSamples: 6, staleReadingMs: 600_000,
};

function scratch(): { dir: string; opts: HostServeEvidenceOptions; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "rmd-host-serve-"));
  return {
    dir,
    opts: { location: () => ({ dir, scope: "host" }), hostBoot: () => BOOT, clock: fixedClock(NOW) },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** One producer generation: serve in `instance`, started at `startedAt`, as process `pid`. */
function producer(base: HostServeEvidenceOptions, pid: number, startedAt: number, over: Partial<HostServePublishOptions> = {}): HostServePublishOptions {
  return {
    ...base,
    instance: () => ({ name: "serve-core", hostUnique: true }),
    process: () => ({ pid, start: `proc:${pid}` }),
    generationStartedAt: () => startedAt,
    revision: "abc1234",
    ...over,
  };
}

const publish = (base: HostServeEvidenceOptions, pid: number, startedAt: number, scenario: HostServeScenario, over: Partial<HostServePublishOptions> = {}) =>
  publishHostServeEvidence({ scenario }, producer(base, pid, startedAt, over));

function enoent(path: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
}

/** The serve scenario a consumer instance gathers when ITS ledger holds no serve row in 90 minutes. */
function gatheredServe(instance: string, readHostServe: (now: number) => HostServeReading, ledgerRows = ""): ShadowInputs["serve"] {
  const alive = JSON.stringify({ ts: new Date(NOW - 90 * MIN).toISOString(), step: "daemon.alive", rss_bytes: 1 });
  const ports = {
    ...defaultShadowMemoryPorts(),
    clock: fixedClock(NOW),
    readFile: (path: string): string => { throw enoent(path); },
    readTail: () => [alive, ledgerRows].filter(Boolean).join("\n"),
    readLedger: () => undefined,
    instance: () => instance,
    daemonPid: () => undefined,
    listStateDir: () => [],
    estimate: () => 900,
    typical: () => 900,
    readReviewDemand: () => ({ state: "present" as const, rows: [], unreadableRows: 0 }),
    readHostServe,
  };
  return gatherShadowInputs({ workerClass: "implement", root: `/home/node/${instance}` }, ports, POLICY).serve;
}

test("unit test: peer local silence never changes a shared current serve observation", () => {
  const { dir, opts, cleanup } = scratch();
  try {
    // Positive control: with NO shared evidence, a peer whose ledger is silent for 90 minutes still reads the old,
    // local-only answer when the store is not shared across the host.
    const local = gatheredServe("state2", () => readHostServeEvidence({ ...opts, location: () => ({ dir, scope: "local" }) }));
    assert.equal(local.scenario, "serve-stopped", "no shared store at all: the local ledger is the only evidence, unchanged");

    const published = publish(opts, 4242, NOW - 3 * 60 * MIN, "serve-steady");
    assert.equal(published.state, "published");
    const reading = readHostServeEvidence(opts);
    assert.equal(reading.state, "present");
    assert.equal(reading.state === "present" && reading.scenario, "serve-steady");

    // Two same-host consumers whose own ledgers hold no serve row read the one shared observation.
    for (const instance of ["state2", "state3"]) {
      const serve = gatheredServe(instance, (now) => readHostServeEvidence({ ...opts, clock: fixedClock(now) }));
      assert.equal(serve.scenario, "serve-steady", `${instance}: its local silence does not make serve stopped`);
      assert.match(serve.basis, /host serve evidence/);
      assert.match(serve.basis, /serve-core/);
    }

    // What the file carries: identity and a scenario, no payload.
    const [file] = readdirSync(join(dir, HOST_SERVE_SUBDIR));
    assert.ok(file);
    const row = JSON.parse(readFileSync(join(dir, HOST_SERVE_SUBDIR, file!), "utf8")) as Record<string, unknown>;
    assert.deepEqual(Object.keys(row).sort(), ["generation", "hostBoot", "observedAt", "process", "producer", "revision", "scenario", "schema"]);
    assert.equal(row.hostBoot, BOOT);
  } finally {
    cleanup();
  }
});

test("unit test: unavailable host serve evidence is unknown not stopped", () => {
  const { dir, opts, cleanup } = scratch();
  const evidence = join(dir, HOST_SERVE_SUBDIR);
  const expectUnknown = (reading: HostServeReading, cause: string): void => {
    assert.equal(reading.state, "unknown", `${cause}: ${JSON.stringify(reading)}`);
    assert.equal(reading.state === "unknown" && reading.cause, cause);
    assert.ok(!("scenario" in reading), `${cause} names no scenario at all`);
  };
  try {
    // missing: nothing was ever published
    expectUnknown(readHostServeEvidence(opts), "missing");

    // stale: a running observation older than three serve.memory periods
    publish({ ...opts, clock: fixedClock(NOW - HOST_SERVE_FRESH_MS - 1) }, 4242, NOW - 60 * MIN, "serve-steady");
    expectUnknown(readHostServeEvidence(opts), "stale");
    assert.equal(readHostServeEvidence({ ...opts, clock: fixedClock(NOW - 1000) }).state, "present", "the positive control: inside the bound it is read");
    rmSync(evidence, { recursive: true, force: true });

    // future-dated
    publish({ ...opts, clock: fixedClock(NOW + 10 * MIN) }, 4242, NOW - 60 * MIN, "serve-steady");
    expectUnknown(readHostServeEvidence(opts), "future-dated");
    rmSync(evidence, { recursive: true, force: true });

    // corrupt: torn JSON and a wrong shape
    mkdirSync(evidence, { recursive: true });
    writeFileSync(join(evidence, "serve-core.1-1.json"), "{\"schema\":1,");
    writeFileSync(join(evidence, "serve-core.2-2.json"), JSON.stringify({ schema: 2, scenario: "serve-steady" }));
    expectUnknown(readHostServeEvidence(opts), "corrupt");
    rmSync(evidence, { recursive: true, force: true });

    // foreign: a fresh observation written on another boot of this host
    publish({ ...opts, hostBoot: () => "boot-bbbb" }, 4242, NOW - 60 * MIN, "serve-steady");
    expectUnknown(readHostServeEvidence(opts), "foreign-host");
    rmSync(evidence, { recursive: true, force: true });

    // local-only: a fresh observation in a store that is not shared across the host
    publish(opts, 4242, NOW - 60 * MIN, "serve-steady");
    expectUnknown(readHostServeEvidence({ ...opts, location: () => ({ dir, scope: "local" }) }), "local-only");

    // an unreadable directory
    expectUnknown(readHostServeEvidence({ ...opts, list: () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); } }), "unreadable");

    // A stop beside an unreadable file is not a verified stop.
    rmSync(evidence, { recursive: true, force: true });
    publish(opts, 4242, NOW - 60 * MIN, "serve-stopped");
    assert.equal(readHostServeEvidence(opts).state, "present", "the positive control: a lone dated explicit stop");
    writeFileSync(join(evidence, "serve-core.9-9.json"), "garbage");
    expectUnknown(readHostServeEvidence(opts), "corrupt");

    // At the consumer: a shared store that establishes nothing makes the scenario unknown, never serve-stopped,
    // even though this instance's own ledger has been silent for 90 minutes.
    rmSync(evidence, { recursive: true, force: true });
    for (const cause of ["missing", "stale", "corrupt", "foreign-host", "future-dated", "unreadable"] as const) {
      const serve = gatheredServe("state2", () => ({ state: "unknown", cause, basis: `fixture ${cause}` }));
      assert.equal(serve.scenario, "unknown", cause);
      assert.match(serve.basis, new RegExp(`host serve evidence ${cause}`));
    }
    const throwing = gatheredServe("state2", () => { throw new Error("reader exploded"); });
    assert.equal(throwing.scenario, "unknown", "a reader failure is named and bounded, not stopped");
    assert.match(throwing.basis, /reader exploded/);
    const serveStop = gatheredServe("state2", () => ({ state: "unknown", cause: "missing", basis: "none" }),
      JSON.stringify({ ts: new Date(NOW - 60 * MIN).toISOString(), step: "serve.stop" }));
    assert.equal(serveStop.scenario, "unknown", "a local serve.stop carries no producer generation to verify");
  } finally {
    cleanup();
  }
});

test("unit test: host serve evidence fences stop by current generation", () => {
  const { dir, opts, cleanup } = scratch();
  const evidence = join(dir, HOST_SERVE_SUBDIR);
  try {
    const GEN1 = NOW - 5 * 60 * MIN;
    const GEN2 = NOW - 2 * MIN;

    // The old generation (pid 100) runs, then the new one (pid 200) takes over and withdraws the old file.
    publish(opts, 100, GEN1, "serve-steady");
    publish(opts, 200, GEN2, "serve-steady");
    assert.equal(readdirSync(evidence).length, 1, "the superseded generation's observation is withdrawn");

    // The old generation's late explicit stop lands AFTER the new one is running: it must not defeat it.
    publish(opts, 100, GEN1, "serve-stopped");
    assert.equal(readdirSync(evidence).length, 2, "the late stop is on disk, beside the newer generation");
    const running = readHostServeEvidence(opts);
    assert.equal(running.state, "present");
    assert.equal(running.state === "present" && running.scenario, "serve-steady", "an older generation's stop cannot defeat the current one");
    assert.equal(running.state === "present" && running.superseded, 1);
    assert.match(running.state === "present" ? running.basis : "", /pid 200/);

    // The old generation's late stop cannot stand in for the new one once the new one has gone silent either.
    const later = readHostServeEvidence({ ...opts, clock: fixedClock(NOW + HOST_SERVE_FRESH_MS + MIN) });
    assert.equal(later.state, "unknown", "silence from the current generation is stale, and the old stop does not certify stopped");
    assert.equal(later.state === "unknown" && later.cause, "stale");

    // The current generation's own dated explicit stop is retained as stopped.
    publish(opts, 200, GEN2, "serve-stopped");
    const stopped = readHostServeEvidence(opts);
    assert.equal(stopped.state, "present");
    assert.equal(stopped.state === "present" && stopped.scenario, "serve-stopped");
    assert.match(stopped.state === "present" ? stopped.basis : "", /explicit serve-stopped from serve-core \(pid 200\)/);

    // A stop is retained however old it is (a dated explicit stop, not silence), but only on this boot.
    const old = readHostServeEvidence({ ...opts, clock: fixedClock(NOW + 6 * 60 * MIN) });
    assert.equal(old.state === "present" && old.scenario, "serve-stopped");
    const reboot = readHostServeEvidence({ ...opts, hostBoot: () => "boot-cccc" });
    assert.equal(reboot.state === "unknown" && reboot.cause, "foreign-host");

    // A new generation after a stop supersedes it.
    publish(opts, 300, NOW - MIN, "serve-cold-start");
    const cold = readHostServeEvidence(opts);
    assert.equal(cold.state === "present" && cold.scenario, "serve-cold-start");
  } finally {
    cleanup();
  }
});

test("a publisher failure is named once and never thrown", () => {
  const { opts, cleanup } = scratch();
  resetHostServeDiagnosticsForTests();
  try {
    const events: Array<Record<string, unknown>> = [];
    const failing = producer(opts, 1, NOW, { write: () => { throw Object.assign(new Error("full"), { code: "ENOSPC" }); }, log: (e) => events.push(e) });
    for (let i = 0; i < 3; i += 1) assert.deepEqual(publishHostServeEvidence({ scenario: "serve-steady" }, failing), { state: "failed", reason: "ENOSPC" });
    assert.equal(events.length, 1, "one deduplicated diagnostic");
    assert.equal(publishHostServeEvidence({ scenario: "serve-steady" }, producer(opts, 1, NOW, { hostBoot: () => undefined })).state, "failed");
    assert.equal(publishHostServeEvidence({ scenario: "serve-steady" }, producer(opts, 1, NOW, { process: () => undefined })).state, "failed");
  } finally {
    cleanup();
  }
});
