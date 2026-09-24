/**
 * W1-T4402 — an `edited` pull_request event re-runs only what reads the title or body.
 *
 * `edited` fires on a title, body or base change and nothing else (labels and assignees are their own
 * activity types), so a workflow earns the trigger only when its verdict can change with that text.
 * MEASURED 2026-09-23 on origin/main: exactly four workflows carry it, and each earns it —
 * pr-title-lint reads the title, acceptance-author-gate and proof-discrimination read the body, and
 * ci-gate re-aggregates their new verdicts (it reads neither, but without `edited` a body repair would
 * leave its required context stale until a sweep re-drove it).
 *
 * WHY NO `changes.body` FILTER. The shard proposed narrowing the body readers further. A job-level
 * `if:` on `github.event.changes` would make a title-only edit produce a SKIPPED run, and ci-gate
 * reads a check's LATEST attempt and treats skipped as OK — so a red acceptance gate followed by a
 * title edit would pass. The second test pins that no edited-triggered job carries such a guard.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOWS = join(REPO_ROOT, ".github/workflows");

type Job = { name?: string; if?: string; steps?: Array<{ run?: string; if?: string }> };
type Workflow = { on?: { pull_request?: { types?: string[] } | null }; jobs?: Record<string, Job>; env?: Record<string, string> };

/** Evidence that code reads the PR title or body: the event payload's fields, or a live read. */
const READS_TITLE_OR_BODY = /pull_request\.(?:title|body)|\bpr\.body\b|payload\.body\b|--json (?:title|body)\b/;

function parse(text: string): Workflow {
  return parseYaml(text) as Workflow;
}

function firesOnEdited(wf: Workflow): boolean {
  return wf.on?.pull_request?.types?.includes("edited") ?? false;
}

/** A job's run bodies plus the repo scripts they invoke — the body is usually read one layer down. */
function runsAndScripts(wf: Workflow, readScript: (path: string) => string): string {
  const runs = Object.values(wf.jobs ?? {}).flatMap((j) => (j.steps ?? []).map((s) => s.run ?? ""));
  const scripts = runs.flatMap((r) => [...r.matchAll(/\b(scripts\/[\w./-]+\.mjs)\b/g)].map((m) => readScript(m[1]!)));
  return [...runs, ...scripts].join("\n");
}

function checkNames(wf: Workflow): string[] {
  return Object.entries(wf.jobs ?? {}).map(([id, j]) => j.name ?? id);
}

/** Every edited-triggered workflow that has no reason for the trigger, by file name. A workflow has a
 *  reason when it reads the title or body, or when it is the aggregator that must re-read the new
 *  verdicts of the workflows that do (its REQUIRED list names each of their checks). */
function unjustifiedEditedTriggers(files: Record<string, string>, readScript: (path: string) => string): string[] {
  const parsed = Object.entries(files).map(([file, text]) => ({ file, wf: parse(text) }));
  const edited = parsed.filter(({ wf }) => firesOnEdited(wf));
  const readers = edited.filter(({ wf }) => READS_TITLE_OR_BODY.test(runsAndScripts(wf, readScript)));
  const readerChecks = readers.flatMap(({ wf }) => checkNames(wf));
  return edited
    .filter(({ file, wf }) => {
      if (readers.some((r) => r.file === file)) return false;
      const required = JSON.parse(wf.jobs?.["ci-gate"] ? ((wf.jobs["ci-gate"] as { env?: { REQUIRED?: string } }).env?.REQUIRED ?? "[]") : "[]") as string[];
      const aggregatesEveryReader = readerChecks.length > 0 && readerChecks.every((c) => required.includes(c));
      return !aggregatesEveryReader;
    })
    .map(({ file }) => file);
}

function realWorkflows(): Record<string, string> {
  return Object.fromEntries(
    readdirSync(WORKFLOWS)
      .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
      .map((f) => [f, readFileSync(join(WORKFLOWS, f), "utf8")]),
  );
}

const readScript = (path: string) => readFileSync(join(REPO_ROOT, path), "utf8");

test("W1-T4402: only workflows that read the body keep the edited trigger", () => {
  const files = realWorkflows();
  assert.deepEqual(unjustifiedEditedTriggers(files, readScript), []);
  // The census is not vacuous: it sees the four workflows that fire on edited today.
  const edited = Object.entries(files).filter(([, text]) => firesOnEdited(parse(text))).map(([f]) => f).sort();
  assert.deepEqual(edited, ["acceptance-author-gate.yml", "ci-gate.yml", "pr-title-lint.yml", "proof-discrimination-gate.yml"]);

  // Falsifier: a workflow that fires on edited and reads nothing is named.
  const idle = "on:\n  pull_request:\n    types: [opened, synchronize, edited]\njobs:\n  lint:\n    steps:\n      - run: npx eslint .\n";
  assert.deepEqual(unjustifiedEditedTriggers({ ...files, "idle.yml": idle }, readScript), ["idle.yml"]);
  // A body reader earns it, including one that reads the body in the script it runs.
  const reader = "on:\n  pull_request:\n    types: [edited]\njobs:\n  g:\n    name: acceptance-author-gate\n    steps:\n      - run: node scripts/acceptance-author-gate.mjs\n";
  assert.deepEqual(unjustifiedEditedTriggers({ ...files, "reader.yml": reader }, readScript), []);
  // ci-gate earns it only while it aggregates every body reader: drop one from REQUIRED and it is named.
  const gate = files["ci-gate.yml"]!.replace(/(REQUIRED: >-[^\]]*?)\n\s*"proof-discrimination",/, "$1");
  assert.notEqual(gate, files["ci-gate.yml"], "the fixture edit must land");
  assert.deepEqual(unjustifiedEditedTriggers({ ...files, "ci-gate.yml": gate }, readScript), ["ci-gate.yml"]);
});

test("W1-T4402: no edited-triggered job skips on which field changed", () => {
  // A skip keyed on github.event.changes turns a title-only edit into a SKIPPED latest attempt, which
  // ci-gate reads as OK — a red body gate would then pass. Every edited trigger must re-run in full.
  const offenders = Object.entries(realWorkflows()).flatMap(([file, text]) => {
    const wf = parse(text);
    if (!firesOnEdited(wf)) return [];
    return Object.entries(wf.jobs ?? {})
      .filter(([, j]) => [j.if, ...(j.steps ?? []).map((s) => s.if)].some((cond) => cond?.includes("event.changes")))
      .map(([id]) => `${file}#${id}`);
  });
  assert.deepEqual(offenders, []);
  // The control: the same scan names a job that carries that guard.
  const guarded = parse("on:\n  pull_request:\n    types: [edited]\njobs:\n  g:\n    if: github.event.changes.body\n    steps: []\n");
  assert.ok(Object.values(guarded.jobs!).some((j) => j.if?.includes("event.changes")));
});
