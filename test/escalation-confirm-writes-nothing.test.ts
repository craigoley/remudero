// W1-T5057 (arch Phase 4 design §5, GET write 2): GET /v1/escalation/confirm is unauthenticated, so a
// crawler retrying a stale link appended a ledger row per request, and the first request created the
// link secret. The GET now reads the secret without creating it, and holds refusals in memory: one
// escalation.link_refused_rollup row per (escalation, reason) per hour, and the rest when serve exits.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { escalationLinkSecretPath, EscalationLinkSecretMissingError, loadEscalationLinkSecret, mintOptionLink, readEscalationLinkSecret } from "../src/lib/escalate.js";
import { InvalidSecretFileError } from "../src/lib/fs-race-safe.js";
import { createLinkRefusalRollup, LINK_REFUSAL_ROLLUP_MAX_KEYS } from "../src/lib/panel-actions.js";
import { buildServeRoutes } from "../src/lib/serve.js";
import { loadPlan } from "../src/lib/plan.js";
import type { Route } from "../src/lib/service.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const NOW = 1_790_000_000_000;

function fixture(): { root: string; ledgerPath: string } {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}esc-confirm-`));
  mkdirSync(join(root, "state"), { recursive: true });
  mkdirSync(join(root, "plan"), { recursive: true });
  writeFileSync(join(root, "plan", "tasks.yaml"), '- id: W1-T1\n  title: "fixture"\n  repo: remudero\n  type: implement\n');
  const ledgerPath = join(root, "state", "ledger.ndjson");
  writeFileSync(ledgerPath, `${JSON.stringify({ ts: "2026-09-22T11:00:00.000Z", run_id: "R-1", task_id: "W1-T1", step: "run.start" })}\n`);
  return { root, ledgerPath };
}

function confirmRoute(root: string, ledgerPath: string): Route {
  const github = { getPr: async () => undefined, listOpenPrs: async () => [], listIssues: async () => [], prByRef: () => null } as never;
  const routes = buildServeRoutes({
    board: { plan: loadPlan(join(root, "plan", "tasks.yaml")), ledgerPath, github },
    panelGraph: { root, planPath: join(root, "plan", "tasks.yaml"), ledgerPath, github: { prView: () => null } as never, statusGithub: github, ratify: { approve: () => {}, reframe: () => {} } as never },
    ledgerPath, issues: {} as never, fleetControlRoot: root, questionsRoot: root, tokens: { read: "r", write: "w" }, pollMs: 60_000,
    githubAppRefresh: { start: () => ({ armed: false }) },
  } as never);
  const route = routes.find((r) => r.method === "GET" && r.path === "/v1/escalation/confirm");
  assert.ok(route, "serve mounts GET /v1/escalation/confirm");
  return route;
}

async function get(route: Route, url: string): Promise<{ status: number; body: string }> {
  const server = createServer((req, res) => void route.handler(req, res, { params: {} } as never));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}${url}`);
    return { status: res.status, body: await res.text() };
  } finally {
    server.close();
  }
}

/** A link the ping minted under this root's secret, with its signature replaced: a forged refusal. */
function forgedLink(root: string): string {
  const url = mintOptionLink("ESC-9", "MANUAL", { type: "executable", route: "/v1/control/pause", tier: "middle" }, loadEscalationLinkSecret(root), Date.now(), "https://console.example/")!;
  return url.replace("https://console.example", "").replace(/s=[0-9a-f]{64}/, `s=${"0".repeat(64)}`);
}

test("W1-T5057: repeating a refused escalation confirm get appends no ledger row", async () => {
  const { root, ledgerPath } = fixture();
  try {
    const link = forgedLink(root);
    const route = confirmRoute(root, ledgerPath);
    const before = readFileSync(ledgerPath, "utf8");
    for (let i = 0; i < 3; i++) {
      const { status, body } = await get(route, link);
      assert.equal(status, 403, body);
      assert.match(body, /cannot be used/);
    }
    assert.equal(readFileSync(ledgerPath, "utf8"), before, "a refused confirm GET appended to the ledger");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T5057: a confirm get under a root with no secret answers unavailable and creates none", async () => {
  const { root, ledgerPath } = fixture();
  try {
    const { status, body } = await get(confirmRoute(root, ledgerPath), `/v1/escalation/confirm?e=ESC-1&c=MANUAL&r=${encodeURIComponent("/v1/control/pause")}&x=9999999999999&s=${"0".repeat(64)}`);
    assert.equal(status, 503, body);
    assert.match(body, /escalation-link-secret-missing/);
    assert.equal(existsSync(escalationLinkSecretPath(root)), false, "the GET created the link secret");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T5057: the read-only secret reader returns what the minter wrote and refuses a malformed file", () => {
  const { root } = fixture();
  try {
    assert.throws(() => readEscalationLinkSecret(root), EscalationLinkSecretMissingError);
    const minted = loadEscalationLinkSecret(root);
    assert.equal(readEscalationLinkSecret(root), minted);
    writeFileSync(escalationLinkSecretPath(root), "short\n");
    assert.throws(() => readEscalationLinkSecret(root), InvalidSecretFileError);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function rows(ledgerPath: string): Array<Record<string, unknown>> {
  return readFileSync(ledgerPath, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>).filter((r) => r.step === "escalation.link_refused_rollup");
}

test("W1-T5057: refusals are flushed as one hourly rollup row per escalation and reason", async () => {
  const { root, ledgerPath } = fixture();
  let now = NOW;
  const rollup = createLinkRefusalRollup({ ledgerPath, now: () => now });
  try {
    rollup.record("ESC-1", "forged", "signature did not verify");
    now += 1_000;
    rollup.record("ESC-1", "forged", "signature did not verify");
    rollup.record("ESC-1", "expired", "link expired");
    now += 1_000;
    rollup.record("ESC-2", "forged", "signature did not verify");
    rollup.record("ESC-1", "forged", "signature did not verify");
    assert.deepEqual(rows(ledgerPath), [], "a refusal is held, never appended when it happens");
    rollup.flush();
    const flushed = rows(ledgerPath).map((r) => ({ escalation: r.escalation, reason: r.reason, count: r.count, firstAt: r.firstAt, lastAt: r.lastAt, task_id: r.task_id, phase: r.phase }));
    assert.deepEqual(flushed, [
      { escalation: "ESC-1", reason: "forged", count: 3, firstAt: new Date(NOW).toISOString(), lastAt: new Date(NOW + 2_000).toISOString(), task_id: "ESC-1", phase: "confirm" },
      { escalation: "ESC-1", reason: "expired", count: 1, firstAt: new Date(NOW + 1_000).toISOString(), lastAt: new Date(NOW + 1_000).toISOString(), task_id: "ESC-1", phase: "confirm" },
      { escalation: "ESC-2", reason: "forged", count: 1, firstAt: new Date(NOW + 2_000).toISOString(), lastAt: new Date(NOW + 2_000).toISOString(), task_id: "ESC-2", phase: "confirm" },
    ]);
    rollup.flush();
    assert.equal(rows(ledgerPath).length, 3, "a flushed window is not written twice");
    // Shutdown writes what the window still holds.
    rollup.record("ESC-3", "already-used", "used");
    rollup.stop();
    assert.deepEqual(rows(ledgerPath).map((r) => [r.escalation, r.count]).at(-1), ["ESC-3", 1]);
  } finally {
    rollup.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T5057: the rollup flushes on its own cadence with no reader", async () => {
  const { root, ledgerPath } = fixture();
  const rollup = createLinkRefusalRollup({ ledgerPath, now: () => NOW, intervalMs: 20 });
  try {
    rollup.record("ESC-1", "expired", "link expired");
    const deadline = Date.now() + 2_000;
    while (rows(ledgerPath).length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(rows(ledgerPath).map((r) => [r.escalation, r.reason, r.count]), [["ESC-1", "expired", 1]]);
  } finally {
    rollup.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T5057: invented escalation ids past the key backstop fold into one row", () => {
  const { root, ledgerPath } = fixture();
  const rollup = createLinkRefusalRollup({ ledgerPath, now: () => NOW });
  try {
    for (let i = 0; i < LINK_REFUSAL_ROLLUP_MAX_KEYS + 5; i++) rollup.record(`ESC-${i}`, "forged", "signature did not verify");
    rollup.record("ESC-0", "forged", "signature did not verify");
    rollup.flush();
    const flushed = rows(ledgerPath);
    assert.equal(flushed.length, LINK_REFUSAL_ROLLUP_MAX_KEYS + 1);
    assert.equal(flushed.find((r) => r.escalation === "(over-key-backstop)")?.count, 5);
    assert.equal(flushed.find((r) => r.escalation === "ESC-0")?.count, 2, "a held key keeps counting past the backstop");
  } finally {
    rollup.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T5057: a rollup flush that cannot append keeps its counts for the next one", () => {
  const { root, ledgerPath } = fixture();
  const blocked = join(root, "not-a-dir");
  writeFileSync(blocked, "");
  const rollup = createLinkRefusalRollup({ ledgerPath: join(blocked, "ledger.ndjson"), now: () => NOW });
  const errors: string[] = [];
  const original = console.error;
  console.error = (message: string) => void errors.push(message);
  try {
    rollup.record("ESC-1", "forged", "signature did not verify");
    rollup.flush();
    assert.match(errors.join("\n"), /flush failed, counts kept/);
  } finally {
    console.error = original;
    rmSync(blocked);
    mkdirSync(blocked);
    rollup.stop();
    assert.equal(rows(join(blocked, "ledger.ndjson"))[0]?.count, 1, "the held count survived the failed flush");
    rmSync(root, { recursive: true, force: true });
  }
});
