// @source-text-subject: this census's subject IS the source text of every `new Worker(...)` call under src/ —
// whether its options carry `env: SHARE_ENV` is a property of the call's tokens, not of any runtime behaviour a
// fixture could drive; the behavioural arm below (a SHARE_ENV thread reads a GH_TOKEN its parent changed) proves
// what the option buys, and the planted-source controls prove the census itself can fail.

import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { SHARE_ENV, Worker } from "node:worker_threads";
import { createScanner, SyntaxKind } from "typescript/unstable/ast";

/**
 * A `new Worker(url, opts)` WITHOUT `env: SHARE_ENV` copies the spawning thread's `process.env` once, at spawn.
 * serve and the daemon re-mint `process.env.GH_TOKEN` hourly, so a persistent thread that calls GitHub then
 * 401s for the rest of its life (#9156: the daemon read plane; #9160: the read-model threads). Every spawn site
 * therefore either passes `env: SHARE_ENV` or is named in EXEMPT below, with the reason the copy is harmless.
 */
const ROOT = fileURLToPath(new URL("..", import.meta.url));

type ExemptionClass = "one-shot" | "no-github" | "explicit-env";
type Exemption = { count: number; class: ExemptionClass; reason: string };
type Site = { file: string; kind: string; shared: boolean; line: number };

/** Keyed `<file>::<kind>`; `kind` is the workerData `kind:` constant, else the variable the thread is bound to. */
const EXEMPT: Record<string, Exemption> = {
  "src/lib/secret-boundary.ts::SOCKET_THREAD_KIND": { count: 1, class: "explicit-env", reason: "passes `env: { ...process.env }` and mints its credential from the App key, never GH_TOKEN" },
  "src/lib/status.ts::worker": { count: 1, class: "one-shot", reason: "board prewarm thread is terminated after its one message; each prewarm spawns a fresh env copy" },
  "src/lib/repo-dashboard-route.ts::REPO_TELEMETRY_WORKER_KIND": { count: 1, class: "no-github", reason: "repo telemetry reads the ledger only" },
  "src/lib/read-model-slow-lane.ts::spawned": { count: 1, class: "no-github", reason: "slow lane makes no GitHub call (SlowLaneGithubRefused)" },
  "src/lib/config-gardener.ts::CONFIG_MEASUREMENT_WORKER_KIND": { count: 1, class: "one-shot", reason: "measurement thread does local work and is spawned per measurement" },
  "src/lib/read-model-worker.ts::READ_MODEL_INTEGRITY_KIND": { count: 1, class: "one-shot", reason: "integrity thread is spawned per request and copies a fresh env each time" },
  "src/lib/read-model-worker.ts::READ_MODEL_ISSUE_KIND": { count: 1, class: "one-shot", reason: "issue thread is spawned per request and copies a fresh env each time" },
  "src/lib/board-worker.ts::thread": { count: 1, class: "no-github", reason: "board facts are proxied over a port to the parent's `github`; the thread holds no token" },
  "src/lib/console-projection-worker.ts::CONSOLE_PROJECTION_WORKER_KIND": { count: 1, class: "no-github", reason: "pure projection, no GitHub call" },
  "src/lib/serve-plan-reload.ts::PLAN_RELOAD_WORKER_KIND": { count: 1, class: "one-shot", reason: "plan reload thread does local work per spawn" },
  "src/lib/worker-provider.ts::anonymous": { count: 1, class: "one-shot", reason: "short codex capacity probe, spawned per probe" },
};

function tokens(text: string): { kind: SyntaxKind; value: string; line: number }[] {
  const scanner = createScanner(true, undefined, text);
  const out: { kind: SyntaxKind; value: string; line: number }[] = [];
  const braces: boolean[] = []; // true = a `${` template substitution awaiting its closing brace
  const lineStarts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") lineStarts.push(i + 1);
  const lineAt = (pos: number): number => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid]! <= pos) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
  const divisionAfter = new Set<SyntaxKind>([
    SyntaxKind.Identifier, SyntaxKind.NumericLiteral, SyntaxKind.StringLiteral, SyntaxKind.CloseParenToken,
    SyntaxKind.CloseBracketToken, SyntaxKind.CloseBraceToken, SyntaxKind.NoSubstitutionTemplateLiteral,
    SyntaxKind.TemplateTail, SyntaxKind.ThisKeyword,
  ]);
  let token = scanner.scan();
  while (token !== SyntaxKind.EndOfFile) {
    const start = scanner.getTokenStart();
    if (token === SyntaxKind.SlashToken || token === SyntaxKind.SlashEqualsToken) {
      const previous = out[out.length - 1]?.kind;
      if (previous === undefined || !divisionAfter.has(previous)) token = scanner.reScanSlashToken();
    }
    if (token === SyntaxKind.OpenBraceToken) braces.push(false);
    else if (token === SyntaxKind.CloseBraceToken) {
      if (braces.pop()) token = scanner.reScanTemplateToken(false);
    }
    if (token === SyntaxKind.TemplateHead || token === SyntaxKind.TemplateMiddle) braces.push(true);
    out.push({ kind: token, value: scanner.getTokenValue(), line: lineAt(start) });
    token = scanner.scan();
  }
  return out;
}

/** Every `new Worker(` in `text`, found on tokens so a comment or string that says so never counts. */
export function workerSites(file: string, text: string): Site[] {
  const toks = tokens(text);
  const importsShareEnv = /import\s*(?:type\s*)?\{[^}]*\bSHARE_ENV\b[^}]*\}\s*from\s*["'](?:node:)?worker_threads["']/.test(text);
  const sites: Site[] = [];
  for (let i = 0; i + 2 < toks.length; i++) {
    if (toks[i]!.kind !== SyntaxKind.NewKeyword || toks[i + 1]!.kind !== SyntaxKind.Identifier || toks[i + 1]!.value !== "Worker" ||
        toks[i + 2]!.kind !== SyntaxKind.OpenParenToken) continue;
    const openers: SyntaxKind[] = [SyntaxKind.OpenParenToken];
    let shared = false;
    let workerDataKind: string | undefined;
    let j = i + 3;
    for (; j < toks.length && openers.length > 0; j++) {
      const t = toks[j]!;
      if (t.kind === SyntaxKind.OpenParenToken || t.kind === SyntaxKind.OpenBraceToken || t.kind === SyntaxKind.OpenBracketToken) openers.push(t.kind);
      else if (t.kind === SyntaxKind.CloseParenToken || t.kind === SyntaxKind.CloseBraceToken || t.kind === SyntaxKind.CloseBracketToken) openers.pop();
      else if (t.kind === SyntaxKind.Identifier && t.value === "env" && openers.length === 2 && openers[1] === SyntaxKind.OpenBraceToken &&
               (toks[j - 1]!.kind === SyntaxKind.OpenBraceToken || toks[j - 1]!.kind === SyntaxKind.CommaToken) &&
               toks[j + 1]?.kind === SyntaxKind.ColonToken && toks[j + 2]?.kind === SyntaxKind.Identifier && toks[j + 2]!.value === "SHARE_ENV" &&
               (toks[j + 3]?.kind === SyntaxKind.CommaToken || toks[j + 3]?.kind === SyntaxKind.CloseBraceToken)) shared = importsShareEnv;
      else if (t.kind === SyntaxKind.Identifier && t.value === "workerData" && toks[j + 1]?.kind === SyntaxKind.ColonToken &&
               toks[j + 2]?.kind === SyntaxKind.OpenBraceToken && toks[j + 3]?.value === "kind" && toks[j + 4]?.kind === SyntaxKind.ColonToken &&
               toks[j + 5]?.kind === SyntaxKind.Identifier) workerDataKind = toks[j + 5]!.value;
    }
    const bound = toks[i - 1]?.kind === SyntaxKind.EqualsToken && toks[i - 2]?.kind === SyntaxKind.Identifier ? toks[i - 2]!.value : undefined;
    sites.push({ file, kind: workerDataKind ?? bound ?? "anonymous", shared, line: toks[i]!.line });
  }
  return sites;
}

/** The census verdict for a population of source texts against an exemption table. */
export function judge(files: Record<string, string>, exempt: Record<string, Exemption>): { violations: string[]; stale: string[] } {
  const live = new Map<string, number>();
  const violations: string[] = [];
  for (const [file, text] of Object.entries(files)) {
    for (const site of workerSites(file, text)) {
      if (site.shared) continue;
      const key = `${site.file}::${site.kind}`;
      const seen = (live.get(key) ?? 0) + 1;
      live.set(key, seen);
      if (seen > (exempt[key]?.count ?? 0)) {
        violations.push(`${site.file}:${site.line} kind ${site.kind}: new Worker() without env: SHARE_ENV and no exemption row — GH_TOKEN is frozen at spawn`);
      }
    }
  }
  const stale = Object.entries(exempt)
    .filter(([key, row]) => live.get(key) !== row.count)
    .map(([key, row]) => `${key}: exemption row records ${row.count} site(s) but the tree has ${live.get(key) ?? 0}`);
  return { violations, stale };
}

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sources(path) : /\.tsx?$/.test(name) && !name.endsWith(".d.ts") ? [path] : [];
  });
}

function tree(): Record<string, string> {
  return Object.fromEntries(sources(join(ROOT, "src")).map((path) => [relative(ROOT, path).replaceAll("\\", "/"), readFileSync(path, "utf8")]));
}

const IMPORT = `import { Worker, SHARE_ENV } from "node:worker_threads";\n`;

test("census passes on the recorded tree, and sees the sites it is meant to guard", () => {
  const files = tree();
  const verdict = judge(files, EXEMPT);
  assert.deepEqual(verdict.violations, [], "every Worker spawn passes env: SHARE_ENV or has an exemption row");
  assert.deepEqual(verdict.stale, [], "no exemption row names a site that is gone");
  for (const [key, row] of Object.entries(EXEMPT)) assert.ok(row.reason.length > 0 && ["one-shot", "no-github", "explicit-env"].includes(row.class), `${key} carries a class and a reason`);
  const sharing = Object.entries(files).flatMap(([file, text]) => workerSites(file, text)).filter((site) => site.shared).map((site) => site.file);
  assert.ok(sharing.includes("src/lib/read-plane.ts"), "positive control: the daemon read plane is seen passing SHARE_ENV");
  assert.ok(sharing.includes("src/lib/read-model-worker.ts"), "positive control: the read-model threads are seen passing SHARE_ENV");
});

test("census fails by file and kind on a Worker spawn with neither SHARE_ENV nor an exemption row", () => {
  const planted = {
    "src/lib/new-poller.ts": `${IMPORT}const K = "x";\nexport const go = () => { const thread = new Worker(url, { workerData: { kind: POLLER_KIND }, execArgv: [] }); return thread; };\n`,
    "src/lib/read-plane-copy.ts": `${IMPORT}export const w = () => new Worker(url, { workerData, env: SHARE_ENV });\n`,
    "src/lib/prose.ts": `${IMPORT}// new Worker(url, {})\nexport const s = "new Worker(url)";\n`,
  };
  const verdict = judge(planted, {});
  assert.equal(verdict.violations.length, 1, "only the unshared spawn is refused; SHARE_ENV and comment/string mentions are not");
  assert.match(verdict.violations[0]!, /^src\/lib\/new-poller\.ts:3 kind POLLER_KIND: /);
  const regressed = judge({ "src/lib/read-plane.ts": `${IMPORT}new Worker(url, { workerData, execArgv: [] });` }, {});
  assert.match(regressed.violations[0]!, /^src\/lib\/read-plane\.ts:2 kind anonymous: /, "removing SHARE_ENV from read-plane.ts is named");
  const shadowed = judge({ "src/lib/shadow.ts": `const SHARE_ENV = {};\nnew Worker(url, { env: SHARE_ENV });` }, {});
  assert.equal(shadowed.violations.length, 1, "a SHARE_ENV not imported from worker_threads does not count");
  const templated = judge({ "src/lib/tpl.ts": `${IMPORT}new Worker(\`a\${JSON.stringify(1)}b\`, { eval: true, env: SHARE_ENV }); /re/.test("x");` }, {});
  assert.deepEqual(templated.violations, [], "a template-literal first argument does not hide the options object");
});

test("census fails on a stale exemption row and on a second spawn under a one-site row", () => {
  const spawn = `${IMPORT}export const a = () => { const thread = new Worker(url, { workerData: { kind: GONE_KIND } }); return thread; };\n`;
  const row: Exemption = { count: 1, class: "one-shot", reason: "planted" };
  assert.deepEqual(judge({ "src/lib/a.ts": spawn }, { "src/lib/a.ts::GONE_KIND": row }), { violations: [], stale: [] });
  const stale = judge({ "src/lib/a.ts": `${IMPORT}export const a = 1;\n` }, { "src/lib/a.ts::GONE_KIND": row });
  assert.equal(stale.stale.length, 1);
  assert.match(stale.stale[0]!, /^src\/lib\/a\.ts::GONE_KIND: .*has 0/);
  const doubled = judge({ "src/lib/a.ts": spawn + spawn }, { "src/lib/a.ts::GONE_KIND": row });
  assert.equal(doubled.violations.length, 1, "the second same-kind spawn is not covered by a one-site row");
  assert.equal(doubled.stale.length, 1, "and the row no longer describes the tree");
});

test("a SHARE_ENV fixture thread reads a GH_TOKEN its parent changed after spawn", async () => {
  const body = `const { parentPort } = require("node:worker_threads");
    parentPort.on("message", () => parentPort.postMessage(process.env.GH_TOKEN ?? null));
    parentPort.postMessage("ready");`;
  const was = process.env.GH_TOKEN;
  const spawn = (options: ConstructorParameters<typeof Worker>[1]): Promise<{ worker: Worker; ask: () => Promise<unknown> }> =>
    new Promise((resolve, reject) => {
      const worker = new Worker(body, { eval: true, ...options });
      worker.once("error", reject);
      worker.once("message", () => resolve({
        worker,
        ask: () => new Promise((answer) => { worker.once("message", answer); worker.postMessage("read"); }),
      }));
    });
  try {
    process.env.GH_TOKEN = "token-minted-before-spawn";
    const shared = await spawn({ env: SHARE_ENV });
    const copied = await spawn({});
    process.env.GH_TOKEN = "token-refreshed-after-spawn";
    assert.equal(await shared.ask(), "token-refreshed-after-spawn", "the SHARE_ENV thread sees the refreshed token");
    assert.equal(await copied.ask(), "token-minted-before-spawn", "control: a thread spawned without env keeps the stale copy");
    await Promise.all([shared.worker.terminate(), copied.worker.terminate()]);
  } finally {
    if (was === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = was;
  }
});
