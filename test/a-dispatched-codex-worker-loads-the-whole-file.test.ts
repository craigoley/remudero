import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import { parseRuleHeadlines } from "#src/lib/learnings.js";
import { CODEX_PROJECT_DOC_MAX_BYTES, spawnCodexWorker } from "#src/lib/worker-provider.js";
import type { ContainedSpawnOptions } from "#src/lib/worker-containment.js";

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
  ) => { ok: boolean; reason?: string; renderedBytes: number; sourceBytes: number; limitBytes: number; headerBytes: number };
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

function largeRuleSource(headline = "Generated Headline") {
  return `# rules\n\n- **${headline}** ${"evidence ".repeat(200)}\n`;
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
        workerProviders: { enabled: ["codex" as const], codexBin: "/bin/sh", codexModel: "gpt-6-luna", codexHome: join(root, "codex-home") },
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

test("W1-T3267: generated AGENTS.md carries only its header and headlines, and is smaller than committed CLAUDE.md", () => {
  const source = readFileSync(join(REPO_ROOT, "CLAUDE.md"), "utf8");
  const committed = readFileSync(join(REPO_ROOT, "AGENTS.md"), "utf8");
  const verdict = renderedSizeVerdict(committed, source);
  assert.ok(verdict.ok, `AGENTS.md must fit the headline-only bound: ${verdict.reason}`);
  assert.ok(
    verdict.renderedBytes < verdict.sourceBytes,
    `AGENTS.md (${verdict.renderedBytes}) must be smaller than CLAUDE.md (${verdict.sourceBytes})`,
  );
  // POSITIVE CONTROL: the bound is measured over the real corpus, not an empty headline set.
  assert.ok(verdict.limitBytes - verdict.headerBytes > 5_000, `headline bytes measured: ${verdict.limitBytes - verdict.headerBytes}`);
});

// The bound used to be AGENTS.md <= 0.7 x CLAUDE.md. Once the bodies moved to doctrine/ (W1-T3323),
// cutting a pointer or preamble byte from CLAUDE.md pushed that ratio UP, so the check refused the
// compression its source asks for. These two pin the replacement from both sides.
function bulletSource(headlines: string[], pointer: (i: number) => string): string {
  return `# rules\n\nA preamble the index never carries.\n\n## S\n\n${headlines.map((h, i) => `- **${h}**${pointer(i)}`).join("\n")}\n`;
}
const HEADLINES = Array.from({ length: 40 }, (_, i) => `Rule ${i}: state the instruction this headline carries, in full`);

test("W1-T3267: a CLAUDE.md compressed to headlines and short pointers still renders an index that passes the size check", () => {
  // Short pointers: the source is barely bigger than its headlines, so a ratio bound refuses it.
  const source = bulletSource(HEADLINES, (i) => ` → doctrine/s/r${i}.md`);
  const rendered = renderAgentsMd(source);
  const verdict = renderedSizeVerdict(rendered, source);
  assert.ok(verdict.renderedBytes / verdict.sourceBytes > 0.7, `fixture must sit above the old 0.7 ratio: ${verdict.renderedBytes}/${verdict.sourceBytes}`);
  assert.equal(verdict.reason, undefined);
  assert.equal(verdict.ok, true);
});

test("W1-T3267: a render that leaks pointers, bodies or preamble into the index is refused", () => {
  // The regression the ratio was written for: the index carrying rule prose, not just headlines.
  const source = bulletSource(HEADLINES, (i) => ` → doctrine/s/r${i}.md`);
  const fresh = renderAgentsMd(source);
  const leakedPointers = fresh.replace(/^(- \*\*Rule (\d+):.*\*\*)$/gm, "$1 → doctrine/s/r$2.md");
  assert.notEqual(leakedPointers, fresh, "fixture must actually inject the pointers");
  assert.match(renderedSizeVerdict(leakedPointers, source).reason ?? "", /carries more than its headlines/);
  const leakedPreamble = fresh.replace("## Rule Headlines", "A preamble the index never carries.\n\n## Rule Headlines");
  assert.match(renderedSizeVerdict(leakedPreamble, source).reason ?? "", /carries more than its headlines/);
  // …and the real corpus rendered as WHOLE bullets (pointer included) is refused the same way.
  const real = readFileSync(join(REPO_ROOT, "CLAUDE.md"), "utf8");
  const whole = renderAgentsMd(real).replace(/^## Rule Headlines\n\n[\s\S]*$/m, `## Rule Headlines\n\n${parseRuleHeadlines(real).map((r) => `- **${r.headline}**${r.body}`).join("\n")}\n`);
  assert.equal(renderedSizeVerdict(whole, real).ok, false);
});

test("W1-T3267: generate-agents-md --check turns a stale headline red and names the changed headline", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-agents-md-stale-"));
  try {
    const source = join(dir, "CLAUDE.md");
    const out = join(dir, "AGENTS.md");
    writeFileSync(source, largeRuleSource("Current Headline"));
    writeFileSync(out, renderAgentsMd(largeRuleSource("Previous Headline")));
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

test("W1-T3267: generate-agents-md covers cli write and fail-closed branches", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-agents-md-cli-"));
  try {
    const source = join(dir, "CLAUDE.md");
    const out = join(dir, "AGENTS.md");
    writeFileSync(source, largeRuleSource());

    const missingOutput = runCheck(source, out);
    assert.notEqual(missingOutput.status, 0, missingOutput.stderr);
    assert.match(missingOutput.stderr, /does not exist -- run 'npm run agents-md' to generate it/);

    const generated = runGenerate(source, out);
    assert.equal(generated.status, 0, generated.stderr);
    assert.match(generated.stdout, /wrote .*AGENTS\.md/);
    assert.equal(readFileSync(out, "utf8"), renderAgentsMd(readFileSync(source, "utf8")));

    const missingSource = runGenerate(join(dir, "missing-CLAUDE.md"), join(dir, "missing-AGENTS.md"));
    assert.notEqual(missingSource.status, 0, missingSource.stderr);
    assert.match(missingSource.stderr, /missing-CLAUDE\.md is unreadable/);

    const malformed = join(dir, "malformed-CLAUDE.md");
    writeFileSync(malformed, "# rules\n\n- **Open Headline\n");
    const renderFailure = runGenerate(malformed, join(dir, "malformed-AGENTS.md"));
    assert.notEqual(renderFailure.status, 0, renderFailure.stderr);
    assert.match(renderFailure.stderr, /cannot be rendered/);
    assert.match(renderFailure.stderr, /never closes it/);
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
    assert.match(output, /is not smaller than its source/);
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
