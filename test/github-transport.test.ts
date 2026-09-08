import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  DEFAULT_GH_CALL_TIMEOUT_MS,
  ghJson,
  ghJsonAsync,
  ghOptionsWithDefaultTimeout,
  parseGhRateLimitHeaders,
} from "../src/lib/github-transport.js";
import { classifyGhFailure } from "../src/lib/status.js";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

function dataModuleUrl(source: string): string {
  return `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
}

test("ghOptionsWithDefaultTimeout preserves caller options and adds the transport timeout", () => {
  const opts = ghOptionsWithDefaultTimeout({ encoding: "utf8" as const, maxBuffer: 12 });
  assert.equal(opts.timeout, DEFAULT_GH_CALL_TIMEOUT_MS);
  assert.equal(opts.encoding, "utf8");
  assert.equal(opts.maxBuffer, 12);
});

test("ghOptionsWithDefaultTimeout preserves an explicit tighter caller timeout", () => {
  assert.equal(ghOptionsWithDefaultTimeout({ timeout: 123 }).timeout, 123);
});

test("ghJson adds the default timeout to the single sync transport spawn", () => {
  const calls: Array<{ file: string; args: string[]; timeout: number }> = [];
  const body = ghJson(["api", "repos/o/r"], undefined, (file, args, opts) => {
    calls.push({ file, args, timeout: opts.timeout });
    return "HTTP/2 200\r\nX-Ratelimit-Remaining: 4\r\n\r\n{\"ok\":true}";
  });

  assert.deepEqual(body, { ok: true });
  assert.deepEqual(calls, [{ file: "gh", args: ["api", "repos/o/r", "-i"], timeout: DEFAULT_GH_CALL_TIMEOUT_MS }]);
});

test("ghJsonAsync adds the default timeout to the single async transport spawn", async () => {
  const calls: Array<{ file: string; args: readonly string[]; timeout: number }> = [];
  const body = await ghJsonAsync(["api", "repos/o/r"], async (file, args, opts) => {
    calls.push({ file, args, timeout: opts.timeout });
    return { stdout: "{\"ok\":true}", stderr: "" };
  });

  assert.deepEqual(body, { ok: true });
  assert.deepEqual(calls, [{ file: "gh", args: ["api", "repos/o/r"], timeout: DEFAULT_GH_CALL_TIMEOUT_MS }]);
});

test("a timed-out transport call keeps the named ETIMEDOUT failure shape", () => {
  assert.equal(classifyGhFailure(null, "", "ETIMEDOUT"), "transport");
});

test("parseGhRateLimitHeaders still reads the response headers used by ghJson", () => {
  assert.deepEqual(parseGhRateLimitHeaders("X-Ratelimit-Remaining: 0\r\nX-Ratelimit-Resource: core\r\n"), {
    remaining: 0,
    used: undefined,
    limit: undefined,
    reset: undefined,
    resource: "core",
  });
});

test("the spike reaches both GitHub CLI calls through ghExec", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-spike-transport-"));
  const loaderPath = join(root, "spike-loader.mjs");
  const fakeRoot = JSON.stringify(root);

  const modules = {
    config: dataModuleUrl(`
      export function loadConfig() {
        return { claudeBin: "/tmp/fake-claude", root: ${fakeRoot}, workerProviders: { enabled: ["claude"] } };
      }
    `),
    fs: dataModuleUrl(`
      export { existsSync, mkdirSync } from "node:fs";
      export function appendFileSync(path) {
        console.log("SPIKE_TEST_APPEND:" + path);
      }
    `),
    gitPush: dataModuleUrl(`
      export function gitPushRunBranch() {
        console.log("SPIKE_TEST_GIT_PUSH_FALLBACK");
      }
    `),
    githubTransport: dataModuleUrl(`
      export function ghExec(args) {
        console.log("SPIKE_TEST_GH_EXEC:" + args.join(" "));
        if (args[0] === "pr" && args[1] === "create") {
          return "https://github.com/craigoley/remudero-sandbox/pull/123\\n";
        }
        return "";
      }
    `),
    liveWriteGuard: dataModuleUrl(`
      export function assertLiveWriteAllowed() {}
    `),
    worker: dataModuleUrl(`
      export const DENY_FLOOR_FALLBACK_MODE = "dontAsk";
      const result = (text, sessionId = "spike-session") => ({
        text,
        blocks: [],
        stderr: "",
        permissionDenials: [],
        childEnvKeys: [],
        subtype: "success",
        costUsd: 0,
        sessionId,
        isError: false,
      });
      export function evaluateDenyFloor() {
        return { heldUnderBypass: true, usedDontAskFallback: false, contained: true };
      }
      export function ghPrMergeSquash(prUrl) {
        console.log("SPIKE_TEST_MERGE:" + prUrl);
        return "merged";
      }
      export function ghPrView(prUrl) {
        console.log("SPIKE_TEST_VIEW:" + prUrl);
        return { state: "MERGED", mergeable: "MERGEABLE", url: prUrl };
      }
      export function parseDecisionRequest(text) {
        if (!text.includes("DECISION_REQUEST")) return null;
        return { raw: text, options: ["docs/spike.md", "docs/spike-hello.md"], recommended: "docs/spike-hello.md" };
      }
      export function parseReport(text) {
        const match = /^PR_URL: (https:\\/\\/github\\.com\\/[^\\s]+\\/pull\\/\\d+)/m.exec(text);
        return match ? { raw: text, prUrl: match[1] } : null;
      }
      export function renderWorkerSettings(opts) {
        console.log("SPIKE_TEST_SETTINGS:" + opts.outPath);
        return opts.outPath;
      }
      export async function spawnWorker(args) {
        if (args.resumeSessionId) return result("REPORT\\nno pr url yet", args.resumeSessionId);
        if (args.prompt.includes("DECISION_REQUEST")) {
          return result("DECISION_REQUEST\\n- docs/spike.md\\n- docs/spike-hello.md (RECOMMENDED)\\nRECOMMENDED: docs/spike-hello.md");
        }
        return result("REPORT\\nstep1: denied\\nstep2: denied\\nstep3: ok");
      }
      export function worktreeAdd() {
        console.log("SPIKE_TEST_WORKTREE_ADD");
      }
      export function worktreeRemove() {
        console.log("SPIKE_TEST_WORKTREE_REMOVE");
      }
      export function worktreesDir() {
        return ${JSON.stringify(join(root, "worktrees"))};
      }
    `),
  };

  writeFileSync(
    loaderPath,
    `
      const replacements = new Map([
        ["node:fs", ${JSON.stringify(modules.fs)}],
        ["./lib/config.js", ${JSON.stringify(modules.config)}],
        ["./lib/git-push.js", ${JSON.stringify(modules.gitPush)}],
        ["./lib/github-transport.js", ${JSON.stringify(modules.githubTransport)}],
        ["./lib/live-write-guard.js", ${JSON.stringify(modules.liveWriteGuard)}],
        ["./lib/worker.js", ${JSON.stringify(modules.worker)}],
      ]);
      const resolvedReplacements = new Map([
        ["/src/lib/config.ts", ${JSON.stringify(modules.config)}],
        ["/src/lib/git-push.ts", ${JSON.stringify(modules.gitPush)}],
        ["/src/lib/github-transport.ts", ${JSON.stringify(modules.githubTransport)}],
        ["/src/lib/live-write-guard.ts", ${JSON.stringify(modules.liveWriteGuard)}],
        ["/src/lib/worker.ts", ${JSON.stringify(modules.worker)}],
      ]);

      export async function resolve(specifier, context, nextResolve) {
        if ((context.parentURL ?? "").endsWith("/src/spike.ts") && replacements.has(specifier)) {
          return { url: replacements.get(specifier), shortCircuit: true };
        }
        const resolved = await nextResolve(specifier, context);
        if ((context.parentURL ?? "").endsWith("/src/spike.ts")) {
          for (const [suffix, url] of resolvedReplacements) {
            if (resolved.url.endsWith(suffix)) return { url, shortCircuit: true };
          }
        }
        return resolved;
      }
    `,
  );
  const registerLoader = `data:text/javascript,${encodeURIComponent(
    [
      'import { register } from "node:module";',
      'import { pathToFileURL } from "node:url";',
      `register(${JSON.stringify(pathToFileURL(loaderPath).href)}, pathToFileURL("./"));`,
    ].join(" "),
  )}`;

  const out = execFileSync(
    process.execPath,
    ["--enable-source-maps", "--import", "tsx", "--import", registerLoader, "src/spike.ts"],
    {
      cwd: repoRoot,
      encoding: "utf8",
      env: { ...process.env, HOME: join(root, "home") },
      maxBuffer: 1 << 20,
      timeout: 10_000,
    },
  );

  assert.match(out, /SPIKE_TEST_GH_EXEC:repo clone craigoley\/remudero-sandbox /);
  assert.match(out, /SPIKE_TEST_GH_EXEC:pr create --repo craigoley\/remudero-sandbox --base main --head spike-hello-\d+ --fill/);
  assert.match(out, /### SPIKE COMPLETE all steps executed/);
});
