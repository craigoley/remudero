import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { serveCommand } from "../src/run-task.js";
import { ghShim } from "./helpers/gh-shim.js";

// W1-T5639: a REAL `rmd serve` assembly whose initial plan read fails. The board's own projection thread reads the
// same plan path and may publish a healthy board, while serve itself holds only a placeholder plan. Every plan-derived
// reader must say the plan was never read, never serve the placeholder as an empty healthy plan.

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const gatewayShim = ghShim([{ when: "api ", stdout: "[]" }], { kind: "plan-source-initial-gh" });

async function freePort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

test("real initial plan failure is unavailable across the serve readers, never a healthy empty plan", { timeout: 180_000 }, async (t) => {
  const port = await freePort();
  const home = mkdtempSync(join(tmpdir(), "rmd-plan-source-initial-"));
  const root = join(home, "Remudero");
  mkdirSync(join(home, ".config", "remudero"), { recursive: true });
  writeFileSync(join(home, ".config", "remudero", "config.json"), JSON.stringify({
    claudeBin: "/bin/true", root, installRoot: join(import.meta.dirname, ".."), serve: { host: "127.0.0.1", port },
  }));
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  const lines: string[] = [];
  const oldLog = console.log;
  console.log = (...args: unknown[]) => void lines.push(args.join(" "));
  const running = serveCommand([], {
    branch: () => "main",
    boardGhBin: join(gatewayShim.dir, "gh"),
    boardProjectionOptions: { delayMs: 200 },
    // Fails on the first read AND on serve's adoption read, so only the independent thread has the plan.
    loadBoardPlan: () => { throw new Error("forced initial board plan read failure"); },
  });
  t.after(async () => {
    process.emit("SIGTERM");
    await running;
    console.log = oldLog;
    process.env.HOME = oldHome;
  });
  const deadline = Date.now() + 90_000;
  while (!lines.some((line) => line.includes("listening on")) && Date.now() < deadline) await sleep(50);
  assert.ok(lines.some((line) => line.includes(`127.0.0.1:${port}`)), "the configured interface bound");
  const token = (JSON.parse(readFileSync(join(root, "state", "service-tokens.json"), "utf8")) as { read: string }).read;
  const get = async (path: string, auth = true) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { headers: auth ? { authorization: `Bearer ${token}` } : {} });
    return { status: response.status, body: await response.json() as Record<string, any> };
  };

  // Wait until the DEFAULT worker has published a board from the real on-disk plan: the reader that disagrees is serve's.
  const readyBy = Date.now() + 120_000;
  while ((await get("/v1/status")).status !== 200 && Date.now() < readyBy) await sleep(250);
  assert.equal((await get("/v1/status")).status, 200, "the independent default worker read the real plan");

  const view = await get("/v1/plan/view");
  assert.equal(view.status, 200);
  assert.equal(view.body.planSource.state, "unavailable");
  assert.equal(view.body.planSource.generation, 0);
  assert.match(view.body.planSource.failure.reason, /forced initial board plan read failure/);
  assert.equal(view.body.progress.unknown, true);
  assert.equal("total" in view.body.progress, false, "no exact healthy-zero count from a placeholder");
  assert.deepEqual(view.body.sections, []);

  for (const path of ["/v1/inbox", "/v1/inbox/threads", "/v1/inbox/attention-census"]) {
    const refused = await get(path);
    assert.equal(refused.status, 503, path);
    assert.equal(refused.body.error, "plan_source_unavailable", path);
    assert.equal(refused.body.planSource.state, "unavailable", path);
    assert.equal("counts" in refused.body || "items" in refused.body || "threads" in refused.body, false, `${path} invented no content`);
  }
  assert.equal((await get("/v1/plan/view", false)).status, 401);
  assert.match(readFileSync(join(root, "state", "ledger.ndjson"), "utf8"), /serve\.board_plan_unreadable/);
  process.emit("SIGTERM");
  assert.equal(await running, 0);
});
