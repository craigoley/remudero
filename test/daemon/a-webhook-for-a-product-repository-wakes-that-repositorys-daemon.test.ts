// W1-T14806: a verified GitHub webhook wakes the daemon that owns its repository, not only core.
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { daemonInstanceRegistryPath } from "#src/lib/deployer.js";
import { createDeliveryDedupStore, createGitHubEventWakeHandler, sweepWakeMarkerPath } from "#src/lib/github-event-wake.js";
import type { IssueCloser } from "#src/lib/panel-actions.js";
import type { RatifyCliGateway } from "#src/lib/panel-graph.js";
import type { Plan } from "#src/lib/plan.js";
import { buildServeServer, githubWakeMarkerResolver, type ServeDeps } from "#src/lib/serve.js";
import type { GitHub } from "#src/lib/status.js";
import type { TraceGithub } from "#src/lib/trace.js";
import { createService } from "#src/lib/service.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";

const SECRET = "w1-t14806-secret";
const CORE = "craigoley/remudero";

function fixture(): { base: string; coreRoot: string; stateBase: string; registryPath: string; writeRegistry: (names: string[]) => void } {
  const base = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1-t14806-`));
  const coreRoot = join(base, "core");
  mkdirSync(join(coreRoot, "state"), { recursive: true });
  const stateBase = join(base, "instances");
  const registryPath = join(base, "daemon-instances.yaml");
  const row = (name: string, repo: string) => [`  ${name}:`, `    repo: ${repo}`, `    project: remudero`, `    github_repo: craigoley/${repo}`, `    state_dir: /host/${name}-state`];
  const writeRegistry = (names: string[]) => {
    for (const name of names) mkdirSync(join(stateBase, name, "state"), { recursive: true });
    writeFileSync(registryPath, ["instances:", ...row("core", "remudero"), ...names.flatMap((n) => row(n, n)), ""].join("\n"));
  };
  return { base, coreRoot, stateBase, registryPath, writeRegistry };
}

function signedPost(url: string, repository: string, deliveryId: string): Promise<{ status: number; body: unknown }> {
  const body = JSON.stringify({ action: "synchronize", repository: { full_name: repository }, pull_request: { number: 1 } });
  return fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-delivery": deliveryId,
      "x-github-event": "pull_request",
      "x-hub-signature-256": `sha256=${createHmac("sha256", SECRET).update(body, "utf8").digest("hex")}`,
    },
    body,
  }).then(async (res) => ({ status: res.status, body: await res.json() }));
}

async function withRoute<T>(f: ReturnType<typeof fixture>, run: (url: string) => Promise<T>): Promise<T> {
  const route = createGitHubEventWakeHandler({
    secret: SECRET,
    repository: CORE,
    markerPath: sweepWakeMarkerPath(f.coreRoot),
    resolveMarkerPath: githubWakeMarkerResolver(CORE, f.coreRoot, { registryPath: f.registryPath, stateBase: f.stateBase }),
    dedup: createDeliveryDedupStore(50),
  });
  const server = createService({ tokens: { read: "read", write: "write" }, routes: [route] });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    return await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}${route.path}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

test("W1-T14806: a webhook for a product repository wakes that repository's daemon", async () => {
  const f = fixture();
  try {
    f.writeRegistry(["wreckterra"]);
    await withRoute(f, async (url) => {
      const res = await signedPost(url, "craigoley/wreckterra", "d-product");
      assert.equal(res.status, 202);
      assert.deepEqual(res.body, { accepted: true });
    });
    const marker = JSON.parse(readFileSync(sweepWakeMarkerPath(join(f.stateBase, "wreckterra")), "utf8")) as Record<string, unknown>;
    assert.equal(marker.repository, "craigoley/wreckterra");
    assert.equal(marker.deliveryId, "d-product");
    assert.equal(existsSync(sweepWakeMarkerPath(f.coreRoot)), false, "core's root must stay untouched");
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});

test("W1-T14806: a webhook for core still wakes core", async () => {
  const f = fixture();
  try {
    f.writeRegistry(["wreckterra"]);
    await withRoute(f, async (url) => assert.equal((await signedPost(url, CORE, "d-core")).status, 202));
    assert.equal(existsSync(sweepWakeMarkerPath(f.coreRoot)), true);
    assert.equal(existsSync(sweepWakeMarkerPath(join(f.stateBase, "wreckterra"))), false);
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});

test("W1-T14806: a webhook for an unmanaged repository answers 202 and writes nothing", async () => {
  const f = fixture();
  try {
    f.writeRegistry(["wreckterra"]);
    await withRoute(f, async (url) => {
      const res = await signedPost(url, "craigoley/remudero-sandbox", "d-unmanaged");
      assert.equal(res.status, 202);
      assert.deepEqual(res.body, { error: "unmanaged_repository" });
    });
    assert.equal(existsSync(sweepWakeMarkerPath(f.coreRoot)), false);
    assert.equal(existsSync(sweepWakeMarkerPath(join(f.stateBase, "wreckterra"))), false);
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});

test("W1-T14806: an instance onboarded after serve started is woken", async () => {
  const f = fixture();
  try {
    f.writeRegistry([]);
    await withRoute(f, async (url) => {
      assert.deepEqual((await signedPost(url, "craigoley/oley-arcade", "d-before")).body, { error: "unmanaged_repository" });
      f.writeRegistry(["oley-arcade"]);
      assert.deepEqual((await signedPost(url, "craigoley/oley-arcade", "d-after")).body, { accepted: true });
    });
    assert.equal(existsSync(sweepWakeMarkerPath(join(f.stateBase, "oley-arcade"))), true);
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});

test("W1-T14806: the served route reads the registry at its default path, with no instances injected", async () => {
  const f = fixture();
  try {
    const planPath = join(f.coreRoot, "plan-tasks.yaml");
    writeFileSync(planPath, "[]\n");
    const ledgerPath = join(f.coreRoot, "state", "ledger.ndjson");
    const github: GitHub = { prByRef: () => null, findMergedByTrailer: () => null, headRefName: () => undefined, prBody: () => undefined };
    f.writeRegistry(["wreckterra"]);
    // The registry sits where serve's own gateway reads it: daemonInstanceRegistryPath(questionsRoot).
    const defaultRegistry = daemonInstanceRegistryPath(f.coreRoot);
    mkdirSync(dirname(defaultRegistry), { recursive: true });
    copyFileSync(f.registryPath, defaultRegistry);
    const deps: ServeDeps = {
      board: { plan: { tasks: [], byId: new Map() } as Plan, ledgerPath, github },
      panelGraph: { root: f.coreRoot, planPath, ledgerPath, github: { prView: () => null } as TraceGithub, statusGithub: github, ratify: { approve: () => {}, reframe: () => {} } as RatifyCliGateway },
      ledgerPath,
      issues: { close: () => {} } as IssueCloser,
      fleetControlRoot: f.coreRoot,
      questionsRoot: f.coreRoot,
      tokens: { read: "r", write: "w" },
      pollMs: 50,
      githubEventWake: { secret: SECRET, repository: CORE },
      // Only the state base is pointed at the fixture; `registryPath` is left to its default, as in production.
      instances: { stateBase: f.stateBase },
    };
    const server = buildServeServer(deps);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/hooks/github`;
      const res = await signedPost(url, "craigoley/wreckterra", "d-served");
      assert.deepEqual([res.status, res.body], [202, { accepted: true }]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    assert.equal(existsSync(sweepWakeMarkerPath(join(f.stateBase, "wreckterra"))), true);
    assert.equal(existsSync(sweepWakeMarkerPath(f.coreRoot)), false, "core's root must stay untouched");
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});

test("W1-T14806: an instance whose state is not mounted resolves to no daemon", () => {
  const f = fixture();
  try {
    f.writeRegistry(["site"]);
    const resolve = githubWakeMarkerResolver(CORE, f.coreRoot, { registryPath: f.registryPath, stateBase: f.stateBase }, () => false);
    assert.equal(resolve("craigoley/site"), undefined);
    assert.equal(githubWakeMarkerResolver(CORE, f.coreRoot, undefined)("craigoley/site"), undefined);
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});
