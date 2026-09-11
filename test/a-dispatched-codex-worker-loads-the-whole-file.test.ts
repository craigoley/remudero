import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import { parseRuleHeadlines } from "../src/lib/learnings.js";
import { CODEX_PROJECT_DOC_MAX_BYTES, spawnCodexWorker } from "../src/lib/worker-provider.js";
import type { ContainedSpawnOptions } from "../src/lib/worker-containment.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const SCRIPT = join(REPO_ROOT, "scripts", "generate-agents-md.mjs");

// `scripts/**` is outside tsconfig's include, so use the runtime-import pattern the other
// generator tests use instead of a static import that TypeScript tries to type from source.
const {
  driftedAgentHeadlines,
  renderAgentsMd,
  renderedSizeVerdict,
} = (await import(pathToFileURL(SCRIPT).href)) as {
  driftedAgentHeadlines: (committed: string, fresh: string) => { missing: string[]; unexpected: string[] };
  renderAgentsMd: (sourceText: string) => string;
  renderedSizeVerdict: (
    rendered: string,
    sourceText: string,
  ) => { ok: boolean; renderedBytes: number; sourceBytes: number; limitBytes: number };
};

function runCheck(source: string, out: string) {
  return spawnSync(process.execPath, ["--import", "tsx", SCRIPT, "--source", source, "--out", out, "--check"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
}

function runGenerate(source: string, out: string) {
  return spawnSync(process.execPath, ["--import", "tsx", SCRIPT, "--source", source, "--out", out], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
}

function deferredCodexProcess() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const proc = Object.assign(new EventEmitter(), { stdin, stdout, stderr });
  return {
    process: proc,
    finish(exitCode = 0) {
      stdout.write(`${JSON.stringify({ type: "thread.started", thread_id: "codex-agents-md" })}\n`);
      stdout.write(`${JSON.stringify({ type: "turn.started" })}\n`);
      stdout.write(`${JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "done" } })}\n`);
      stdout.write(`${JSON.stringify({ type: "turn.completed", usage: {} })}\n`);
      stdout.end();
      queueMicrotask(() => proc.emit("exit", exitCode));
    },
  };
}

async function capturedArgs(): Promise<string[]> {
  const root = mkdtempSync(join(tmpdir(), "rmd-codex-agents-md-"));
  const controlled = deferredCodexProcess();
  let options: ContainedSpawnOptions | undefined;
  try {
    const promise = spawnCodexWorker(
      {
        workerHome: mkdtempSync(join(tmpdir(), "rmd-codex-agents-home-")),
        cwd: root,
        prompt: "probe",
        settingsFile: join(REPO_ROOT, "settings", "worker.json"),
        tools: ["Bash"],
        containment: {
          spawn: (opts) => {
            options = opts;
            return { process: controlled.process as never, pid: 31_267 };
          },
          teardown: () => {},
        },
      },
      {
        claudeBin: "/unused/claude",
        root,
        workerProviders: { enabled: ["codex" as const], codexBin: "/bin/sh", codexHome: join(root, "codex-home") },
      } as never,
    );
    controlled.finish();
    await promise;
    assert.ok(options, "the containment layer was asked to spawn Codex");
    return options.args;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("W1-T3267: committed AGENTS.md is a fresh generated index carrying every CLAUDE.md rule headline", () => {
  const source = readFileSync(join(REPO_ROOT, "CLAUDE.md"), "utf8");
  const committed = readFileSync(join(REPO_ROOT, "AGENTS.md"), "utf8");
  const fresh = renderAgentsMd(source);
  assert.equal(committed, fresh, "AGENTS.md must be generated from CLAUDE.md, not hand-maintained");

  const sourceHeadlines = parseRuleHeadlines(source).map((rule) => rule.headline);
  const agentsHeadlines = parseRuleHeadlines(committed).map((rule) => rule.headline);
  assert.deepEqual(agentsHeadlines, sourceHeadlines);
  assert.ok(sourceHeadlines.length > 0, "the source fixture must actually contain rule headlines");
});

test("W1-T3267: generated AGENTS.md is materially smaller than committed CLAUDE.md by live byte counts", () => {
  const source = readFileSync(join(REPO_ROOT, "CLAUDE.md"), "utf8");
  const committed = readFileSync(join(REPO_ROOT, "AGENTS.md"), "utf8");
  const verdict = renderedSizeVerdict(committed, source);
  assert.ok(
    verdict.ok,
    `AGENTS.md must fit the material-size bound: ${verdict.renderedBytes} bytes <= ${verdict.limitBytes} bytes`,
  );
  assert.ok(
    verdict.renderedBytes < verdict.sourceBytes,
    `AGENTS.md (${verdict.renderedBytes}) must be smaller than CLAUDE.md (${verdict.sourceBytes})`,
  );
});

test("W1-T3267: generate-agents-md --check turns a stale headline red and names the changed headline", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-agents-md-stale-"));
  try {
    const source = join(dir, "CLAUDE.md");
    const out = join(dir, "AGENTS.md");
    const body = `${"evidence ".repeat(200)}\n`;
    writeFileSync(source, `# rules\n\n- **Current Headline** ${body}`);
    writeFileSync(out, renderAgentsMd(`# rules\n\n- **Previous Headline** ${body}`));
    const result = runCheck(source, out);
    const output = result.stdout + result.stderr;
    assert.notEqual(result.status, 0, output);
    assert.match(output, /is STALE/);
    assert.match(output, /Missing headline\(s\): Current Headline/);
    assert.match(output, /Unexpected headline\(s\): Previous Headline/);

    const drift = driftedAgentHeadlines(readFileSync(out, "utf8"), renderAgentsMd(readFileSync(source, "utf8")));
    assert.deepEqual(drift, { missing: ["Current Headline"], unexpected: ["Previous Headline"] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W1-T3267: the same size check refuses an oversized generated fixture", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-agents-md-oversized-"));
  try {
    const source = join(dir, "CLAUDE.md");
    const out = join(dir, "AGENTS.md");
    writeFileSync(source, "# rules\n\n- **Tiny**\n");
    const gen = runGenerate(source, out);
    const output = gen.stdout + gen.stderr;
    assert.notEqual(gen.status, 0, output);
    assert.match(output, /is not materially smaller/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W1-T3267: the Codex spawn prefers AGENTS.md, keeps CLAUDE.md fallback, and leaves the cap pinned", async () => {
  const args = await capturedArgs();
  const fallback = args.find((arg) => arg.startsWith("project_doc_fallback_filenames="));
  assert.equal(fallback, 'project_doc_fallback_filenames=["AGENTS.md","CLAUDE.md"]');
  assert.ok(fallback.indexOf("AGENTS.md") < fallback.indexOf("CLAUDE.md"), "AGENTS.md must be preferred");

  const cap = args.find((arg) => arg.startsWith("project_doc_max_bytes="));
  assert.equal(cap, `project_doc_max_bytes=${CODEX_PROJECT_DOC_MAX_BYTES}`);
  assert.equal(CODEX_PROJECT_DOC_MAX_BYTES, 65536, "W1-T3135's pinned cap must not move in this task");
});
