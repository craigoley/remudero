import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { SHARE_ENV, Worker } from "node:worker_threads";
import { parseSync } from "@swc/core";

// @source-text-subject: this test IS a census of `new Worker(` spawn sites in src. serve and the daemon
// re-mint process.env.GH_TOKEN hourly, and a thread spawned without `env: SHARE_ENV` keeps the token it
// copied at spawn, so the property lives in how the source writes the constructor call.

const root = fileURLToPath(new URL("..", import.meta.url));

type Site = { file: string; kind: string; shared: boolean };

/** Why a spawn site may omit `env: SHARE_ENV`. Keyed `file#kind`, where kind is the nearest named
 * function, variable, method or defaulted parameter around the `new Worker(` call. A row naming no live
 * site is STALE and fails, so this table cannot outlive the code it excuses. */
const EXEMPT: Record<string, string> = {
  "src/lib/board-worker.ts#start": "board facts are proxied to the PARENT's github gateway; the thread makes no GitHub call itself",
  "src/lib/config-gardener.ts#configMeasurementOffLoop": "one-shot per spawn: a fresh env copy is taken every call, local measurement only",
  "src/lib/console-projection-worker.ts#ensure": "pure projection of ledger rows; no GitHub call",
  "src/lib/read-model-slow-lane.ts#spawn": "no GitHub call: its header and `SlowLaneGithubRefused` refuse one",
  "src/lib/read-model-worker.ts#spawnIntegrityCheck": "one-shot per spawn: a fresh env copy is taken every check",
  "src/lib/read-model-worker.ts#threadIssueRequest": "one-shot per spawn: a fresh env copy is taken every request",
  "src/lib/repo-dashboard-route.ts#startRepoTelemetryWorker": "ledger-only telemetry; no GitHub call",
  "src/lib/secret-boundary.ts#startSocketThread": "explicit `env: { ...process.env }`; the credential helper mints from the App key, never from GH_TOKEN",
  "src/lib/serve-plan-reload.ts#readServePlanOffLoop": "one-shot per spawn: reads the plan from a local ref, fresh env copy every call",
  "src/lib/status.ts#runPrewarmWorker": "one-shot board prewarm per spawn: a fresh env copy is taken every walk",
  "src/lib/worker-provider.ts#workerFactory": "short codex runtime probe, one-shot per spawn; options are forwarded by the caller",
};

type Node = Record<string, unknown> & { type?: string };
const isNode = (value: unknown): value is Node => !!value && typeof value === "object";
const identifierName = (node: unknown): string | undefined =>
  isNode(node) && node.type === "Identifier" ? (node.value as string) : undefined;

/** The name a node gives to the code inside it, when it gives one. */
function nameOf(node: Node): string | undefined {
  switch (node.type) {
    case "FunctionDeclaration": return identifierName(node.identifier);
    // `const thread = new Worker(...)` names the handle, not the spawner around it.
    case "VariableDeclarator": return isNode(node.init) && node.init.type === "NewExpression" ? undefined : identifierName(node.id);
    case "AssignmentPattern": return identifierName(node.left);
    case "ClassMethod":
    case "MethodProperty":
    case "KeyValueProperty": return identifierName(node.key);
    default: return undefined;
  }
}

/** Every `new Worker(...)` / `new ns.Worker(...)` in `text`, found by walking the parsed tree, so a
 * comment or a string that merely says it never counts. */
function workerSites(file: string, text: string): Site[] {
  const parsed = parseSync(text, { syntax: "typescript", target: "es2022" });
  const sharedImported = new Set<string>();
  for (const item of parsed.body) {
    if (item.type !== "ImportDeclaration" || item.source.value !== "node:worker_threads") continue;
    for (const spec of item.specifiers) {
      if (spec.type === "ImportSpecifier" && (spec.imported ?? spec.local).value === "SHARE_ENV") sharedImported.add(spec.local.value);
    }
  }
  const found: Site[] = [];
  const visit = (value: unknown, names: string[]): void => {
    if (Array.isArray(value)) { for (const item of value) visit(item, names); return; }
    if (!isNode(value)) return;
    const own = nameOf(value);
    const next = own ? [...names, own] : names;
    if (value.type === "NewExpression") {
      const callee = value.callee as Node;
      const isWorker = identifierName(callee) === "Worker"
        || (callee.type === "MemberExpression" && identifierName(callee.property) === "Worker");
      if (isWorker) {
        const options = (value.arguments as Array<{ expression: Node }> | null)?.[1]?.expression;
        const props = options?.type === "ObjectExpression" ? (options.properties as Node[]) : [];
        const shared = props.some((prop) => prop.type === "KeyValueProperty" && identifierName(prop.key) === "env"
          && sharedImported.has(identifierName(prop.value) ?? "\0"));
        found.push({ file, kind: next[next.length - 1] ?? "<module>", shared });
      }
    }
    for (const child of Object.values(value)) visit(child, next);
  };
  visit(parsed.body, []);
  return found;
}

/** Sites that neither share the parent env nor sit in an exemption row, and exemption rows no live site uses. */
function audit(sites: Site[], exempt: Record<string, string>): { unexempt: string[]; stale: string[] } {
  const live = new Set(sites.map((site) => `${site.file}#${site.kind}`));
  const unexempt = sites.filter((site) => !site.shared && !(`${site.file}#${site.kind}` in exempt))
    .map((site) => `${site.file}#${site.kind}`);
  return { unexempt: [...new Set(unexempt)], stale: Object.keys(exempt).filter((key) => !live.has(key)) };
}

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sources(path) : /\.tsx?$/.test(name) && !name.endsWith(".d.ts") ? [path] : [];
  });
}

const PLANTED_IMPORT = `import { Worker, SHARE_ENV } from "node:worker_threads";\n`;

test("the census fails by file and kind on a Worker spawn with neither env SHARE_ENV nor an exemption row", () => {
  const copying = workerSites("src/lib/planted.ts",
    `${PLANTED_IMPORT}export function spawnLongLived(url: URL) { return new Worker(url, { workerData: {} }); }`);
  assert.deepEqual(audit(copying, {}), { unexempt: ["src/lib/planted.ts#spawnLongLived"], stale: [] });

  // An explicit env copy is a snapshot too: only SHARE_ENV keeps the thread current.
  const explicit = workerSites("src/lib/planted.ts",
    `${PLANTED_IMPORT}export const spawnCopy = (url: URL) => new Worker(url, { env: { ...process.env } });`);
  assert.deepEqual(audit(explicit, {}).unexempt, ["src/lib/planted.ts#spawnCopy"]);

  // A namespace-qualified constructor is still a spawn.
  const qualified = workerSites("src/lib/planted.ts",
    `import * as wt from "node:worker_threads";\nexport function viaNamespace(url: URL) { return new wt.Worker(url); }`);
  assert.deepEqual(audit(qualified, {}).unexempt, ["src/lib/planted.ts#viaNamespace"]);

  // A local SHARE_ENV that is not node's does not count.
  const shadowed = workerSites("src/lib/planted.ts",
    `import { Worker } from "node:worker_threads";\nconst SHARE_ENV = {};\nexport function lookalike(url: URL) { return new Worker(url, { env: SHARE_ENV }); }`);
  assert.deepEqual(audit(shadowed, {}).unexempt, ["src/lib/planted.ts#lookalike"]);

  // The same copying spawn is admitted once a reasoned row names it.
  assert.deepEqual(audit(copying, { "src/lib/planted.ts#spawnLongLived": "one-shot" }), { unexempt: [], stale: [] });
});

test("the census admits env SHARE_ENV and ignores comments and strings that merely mention a Worker", () => {
  const shared = workerSites("src/lib/planted.ts",
    `${PLANTED_IMPORT}export function spawnShared(url: URL) { return new Worker(url, { workerData: {}, env: SHARE_ENV }); }`);
  assert.deepEqual(shared, [{ file: "src/lib/planted.ts", kind: "spawnShared", shared: true }]);
  assert.deepEqual(audit(shared, {}), { unexempt: [], stale: [] });

  const prose = workerSites("src/lib/planted.ts",
    `// new Worker(url) copies the env\n/* new Worker(url) */\nexport const note = "new Worker(url)";`);
  assert.deepEqual(prose, []);
});

test("the census fails on a stale exemption row that names no live spawn site", () => {
  const sites = workerSites("src/lib/planted.ts", `${PLANTED_IMPORT}export function spawnShared(url: URL) { return new Worker(url, { env: SHARE_ENV }); }`);
  assert.deepEqual(audit(sites, { "src/lib/gone.ts#spawnGone": "was one-shot", "src/lib/planted.ts#spawnShared": "live site, row is not stale" }).stale,
    ["src/lib/gone.ts#spawnGone"]);
});

test("the census passes on the recorded src tree", () => {
  const all = sources(join(root, "src")).flatMap((path) => workerSites(relative(root, path).replaceAll("\\", "/"), readFileSync(path, "utf8")));
  // Positive controls: the sites #9156 and #9160 fixed are seen and share the env.
  for (const [file, minimum] of [["src/lib/read-plane.ts", 2], ["src/lib/read-model-worker.ts", 3]] as const) {
    const shared = all.filter((site) => site.file === file && site.shared);
    assert.ok(shared.length >= minimum, `${file}: expected >= ${minimum} SHARE_ENV spawns, saw ${shared.length}`);
  }
  const { unexempt, stale } = audit(all, EXEMPT);
  assert.deepEqual(unexempt, [], `a new Worker without \`env: SHARE_ENV\` keeps the GH_TOKEN it copied at spawn and 401s once serve or the daemon re-mints it; pass \`env: SHARE_ENV\` or add a reasoned row to EXEMPT: ${unexempt.join(", ")}`);
  assert.deepEqual(stale, [], `EXEMPT rows naming no live spawn site; delete them: ${stale.join(", ")}`);
  for (const [key, reason] of Object.entries(EXEMPT)) assert.ok(reason.trim().length > 20, `${key}: an exemption states its reason`);
});

test("a SHARE_ENV fixture thread reads a GH_TOKEN its parent changed after spawn", async () => {
  const body = `const { parentPort } = require("node:worker_threads");
    parentPort.on("message", () => parentPort.postMessage(process.env.GH_TOKEN ?? null));`;
  const ask = (thread: Worker): Promise<string | null> => new Promise((resolve, reject) => {
    thread.once("message", resolve);
    thread.once("error", reject);
    thread.postMessage("read");
  });
  const prior = process.env.GH_TOKEN;
  process.env.GH_TOKEN = "token-minted-before-spawn";
  const shared = new Worker(body, { eval: true, env: SHARE_ENV });
  const copied = new Worker(body, { eval: true });
  try {
    process.env.GH_TOKEN = "token-re-minted-after-spawn";
    assert.equal(await ask(shared), "token-re-minted-after-spawn", "env: SHARE_ENV sees the hourly refresh");
    assert.equal(await ask(copied), "token-minted-before-spawn", "control: a thread without env keeps its spawn-time copy");
  } finally {
    if (prior === undefined) delete process.env.GH_TOKEN; else process.env.GH_TOKEN = prior;
    await Promise.all([shared.terminate(), copied.terminate()]);
  }
});
