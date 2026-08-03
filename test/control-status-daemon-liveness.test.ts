// test/control-status-daemon-liveness.test.ts — W1-T288.
//
// THE DEFECT: GET /v1/control/status's body was flags-only ({paused, pauseDetail, stopped,
// stopDetail, quietHours}), and #controls-status's text was `status.stopped ? status.stopDetail
// : status.paused ? status.pauseDetail : "fleet is running"` -- a ternary with no liveness input
// at all. A CRASHED daemon leaves no STOP flag behind (that absence is exactly what distinguishes
// a crash from a deliberate stop), so "fleet is running" rendered identically whether the fleet
// was actually alive or had silently died. The flags are a CLAIM ("no one asked me to stop"); a
// ledger heartbeat is EVIDENCE of activity -- this suite proves the route now carries that
// evidence (`daemonLive`) and the shell renders a real third state ("not observed") rather than
// ever silently downgrading an unobserved fleet to "running".
//
// REUSES, never reinvents: `deriveLastPoll` (daemon-health.ts, already the GET /v1/daemon-health
// source of "last poll") and `DEFAULT_LIVENESS_BOUND_MS` (status.ts, the W1-T179 bound a task row
// already uses to decide "is this actually running") -- see panel-actions.ts's
// `buildControlStatusRoute` for the wiring.
//
// Both halves of the cross-file invariant ("unobserved never silently renders as running") are
// proven TOGETHER here: the route-level tests below assert what GET /v1/control/status's body
// carries; the shell-level tests assert what #controls-status's text becomes when fed each shape
// of that body -- extracted from the REAL served script (test/serve.test.ts's own `new Function`
// extraction technique for pure client-side render logic, e.g. its `needsMeTaskRowHtml` proof),
// never a reimplementation of the ternary under test.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AddressInfo } from "node:net";
import { createService } from "../src/lib/service.js";
import { buildControlStatusRoute, type ControlStatusDeps, type FleetControlStatus } from "../src/lib/panel-actions.js";
import { requestPause, requestStop } from "../src/lib/fleet-control.js";
import { DEFAULT_LIVENESS_BOUND_MS } from "../src/lib/status.js";
import { renderShellHtml } from "../src/lib/serve.js";

const READ_TOKEN = "control-status-liveness-read-token";
const WRITE_TOKEN = "control-status-liveness-write-token";

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "rmd-control-status-liveness-"));
}

function ledgerFile(lines: Array<Record<string, unknown>>): string {
  const dir = mkdtempSync(join(tmpdir(), "rmd-control-status-liveness-ledger-"));
  const p = join(dir, "ledger.ndjson");
  writeFileSync(p, lines.map((l) => JSON.stringify(l)).join("\n") + (lines.length ? "\n" : ""));
  return p;
}

async function withControlStatusService<T>(
  routeDeps: ControlStatusDeps,
  fn: (base: string) => Promise<T>,
): Promise<T> {
  const server = createService({ tokens: { read: READ_TOKEN, write: WRITE_TOKEN }, routes: [buildControlStatusRoute(routeDeps)] });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
  }
}

async function getStatus(base: string): Promise<FleetControlStatus> {
  const res = await fetch(`${base}/v1/control/status`, { headers: { authorization: `Bearer ${READ_TOKEN}` } });
  assert.equal(res.status, 200);
  return (await res.json()) as FleetControlStatus;
}

// ── ROUTE LEVEL: GET /v1/control/status carries daemonLive, never fabricated ────────────────

test("W1-T288: with NO daemon.* ledger line at all and no stop/pause flag, GET /v1/control/status omits daemonLive -- liveness is NOT OBSERVED, never a fabricated true", async () => {
  const root = tmpRoot();
  const ledgerPath = ledgerFile([]);
  await withControlStatusService({ root, ledgerPath }, async (base) => {
    const status = await getStatus(base);
    assert.equal(status.stopped, false);
    assert.equal(status.paused, false);
    assert.equal(status.daemonLive, undefined, "no heartbeat anywhere in the ledger -- must not claim liveness");
  });
});

test("W1-T288: a STALE daemon.* heartbeat (older than the liveness bound) also omits daemonLive -- 'cannot observe' covers a dead daemon too, not just an empty ledger", async () => {
  const root = tmpRoot();
  const now = () => Date.parse("2026-08-03T12:00:00.000Z");
  const staleTs = new Date(now() - (DEFAULT_LIVENESS_BOUND_MS + 60_000)).toISOString();
  const ledgerPath = ledgerFile([{ ts: staleTs, step: "daemon.idle", tick: 1 }]);
  await withControlStatusService({ root, ledgerPath, now }, async (base) => {
    const status = await getStatus(base);
    assert.equal(status.daemonLive, undefined, "a heartbeat older than the liveness bound is exactly the crashed-daemon case -- not live");
  });
});

test("W1-T288: a RECENT daemon.* heartbeat (within the SAME liveness bound W1-T179 already uses) reports daemonLive: true", async () => {
  const root = tmpRoot();
  const now = () => Date.parse("2026-08-03T12:00:00.000Z");
  const freshTs = new Date(now() - 60_000).toISOString(); // 1 minute old, well inside the 30-minute bound
  const ledgerPath = ledgerFile([{ ts: freshTs, step: "daemon.iteration", task: "W1-T1" }]);
  await withControlStatusService({ root, ledgerPath, now }, async (base) => {
    const status = await getStatus(base);
    assert.equal(status.daemonLive, true);
    assert.equal(status.stopped, false);
    assert.equal(status.paused, false);
  });
});

test("W1-T288: an injected livenessBoundMs is honoured (never a second, differently-tuned bound reinvented here) -- a heartbeat just inside a SHORT injected bound is live, just outside is not", async () => {
  const root = tmpRoot();
  const now = () => Date.parse("2026-08-03T12:00:00.000Z");
  const ts = new Date(now() - 5_000).toISOString(); // 5s old
  const ledgerPath = ledgerFile([{ ts, step: "daemon.idle" }]);
  await withControlStatusService({ root, ledgerPath, now, livenessBoundMs: 10_000 }, async (base) => {
    assert.equal((await getStatus(base)).daemonLive, true, "5s old, 10s bound -- inside");
  });
  await withControlStatusService({ root, ledgerPath, now, livenessBoundMs: 1_000 }, async (base) => {
    assert.equal((await getStatus(base)).daemonLive, undefined, "5s old, 1s bound -- outside");
  });
});

test("W1-T288: STOP still wins in the route body's own flags regardless of a live heartbeat -- daemonLive and stopped are independent fields, precedence is the shell's job", async () => {
  const root = tmpRoot();
  requestStop(root, "operator stop");
  const now = () => Date.parse("2026-08-03T12:00:00.000Z");
  const freshTs = new Date(now() - 60_000).toISOString();
  const ledgerPath = ledgerFile([{ ts: freshTs, step: "daemon.idle" }]);
  await withControlStatusService({ root, ledgerPath, now }, async (base) => {
    const status = await getStatus(base);
    assert.equal(status.stopped, true);
    assert.match(status.stopDetail ?? "", /operator stop/);
    assert.equal(status.daemonLive, true, "the daemon really is alive -- the route reports BOTH facts, truthfully");
  });
});

test("W1-T288: PAUSE still wins in the route body's own flags regardless of a live heartbeat, mirroring STOP's precedence", async () => {
  const root = tmpRoot();
  requestPause(root, "taste iteration");
  const now = () => Date.parse("2026-08-03T12:00:00.000Z");
  const freshTs = new Date(now() - 60_000).toISOString();
  const ledgerPath = ledgerFile([{ ts: freshTs, step: "daemon.idle" }]);
  await withControlStatusService({ root, ledgerPath, now }, async (base) => {
    const status = await getStatus(base);
    assert.equal(status.paused, true);
    assert.match(status.pauseDetail ?? "", /taste iteration/);
    assert.equal(status.daemonLive, true);
  });
});

// ── SHELL LEVEL: #controls-status renders THREE states, never silently 'running' ────────────
//
// Extracted verbatim from the REAL served script -- proving the actual ternary that ships,
// never a reimplementation of it (learnings#probe-must-exercise-the-real-consuming-client).

const HTML = renderShellHtml();

function clientFn(name: string): string {
  const re = new RegExp("function " + name + "\\([^)]*\\) \\{[\\s\\S]*?\\n  \\}");
  const src = HTML.match(re)?.[0];
  assert.ok(src, `the shell's inline script must define ${name}()`);
  return src as string;
}

interface FakeButton {
  disabled: boolean;
  title: string;
  ariaPressed?: string;
  active?: boolean;
  setAttribute(name: string, value: string): void;
  classList: { toggle(cls: string, on: boolean): void };
}

function fakeButton(): FakeButton {
  const self: FakeButton = {
    disabled: false,
    title: "",
    setAttribute(name, value) {
      if (name === "aria-pressed") self.ariaPressed = value;
    },
    classList: {
      toggle(cls, on) {
        if (cls === "active") self.active = on;
      },
    },
  };
  return self;
}

/** Builds a fresh sandbox around the REAL applyControlStatus, over a stub DOM -- mirrors
 *  test/serve-write-errors.test.ts's harness() for postJson. */
function harness() {
  const pauseBtn = fakeButton();
  const resumeBtn = fakeButton();
  const stopBtn = fakeButton();
  const quietHours = { disabled: false, title: "", checked: false };
  const controlsStatus = { textContent: "" };
  const elements: Record<string, unknown> = {
    "pause-btn": pauseBtn,
    "resume-btn": resumeBtn,
    "stop-btn": stopBtn,
    "quiet-hours": quietHours,
    "drain-now-btn": null, // never mounted in this sandbox -- applyControlStatus must tolerate that
    "controls-status": controlsStatus,
  };
  const factory = new Function(
    "elements",
    [
      "var document = { getElementById: function (id) { return elements[id] === undefined ? null : elements[id]; } };",
      "var hasWriteScope = true;",
      "var lastControlStatus;",
      clientFn("applyControlStatus"),
      "return { applyControlStatus: applyControlStatus };",
    ].join("\n"),
  ) as (els: unknown) => { applyControlStatus: (status: unknown) => void };
  const built = factory(elements);
  return {
    apply: (status: unknown) => built.applyControlStatus(status),
    text: () => controlsStatus.textContent,
  };
}

test("W1-T288: with no stop/pause flag and daemonLive NOT carried (unobserved), #controls-status does NOT read 'fleet is running'", () => {
  const h = harness();
  h.apply({ paused: false, stopped: false, quietHours: false });
  assert.notEqual(h.text(), "fleet is running", "the falsifier: absence of flags alone must never render as running");
  assert.doesNotMatch(h.text(), /^fleet is running$/);
});

test("W1-T288: a fleet whose liveness cannot be observed renders as UNOBSERVED text, a real third state -- never silently 'running'", () => {
  const h = harness();
  h.apply({ paused: false, stopped: false, quietHours: false });
  assert.match(h.text(), /not observed|unobserved/i, `expected an explicit unobserved-liveness message, got ${JSON.stringify(h.text())}`);
});

test("W1-T288: a live daemon with a recent heartbeat (daemonLive: true) still renders 'fleet is running'", () => {
  const h = harness();
  h.apply({ paused: false, stopped: false, quietHours: false, daemonLive: true });
  assert.equal(h.text(), "fleet is running");
});

test("W1-T288: STOP still wins over liveness exactly as today -- even with daemonLive: true, a stopped fleet shows its stopDetail, never 'fleet is running'", () => {
  const h = harness();
  h.apply({ paused: false, stopped: true, stopDetail: "operator stop: taste test", quietHours: false, daemonLive: true });
  assert.equal(h.text(), "operator stop: taste test");
});

test("W1-T288: PAUSE still wins over an UNOBSERVED liveness exactly as today -- a paused fleet shows its pauseDetail, never the unobserved message", () => {
  const h = harness();
  h.apply({ paused: true, pauseDetail: "taking a breather", stopped: false, quietHours: false });
  assert.equal(h.text(), "taking a breather");
});
