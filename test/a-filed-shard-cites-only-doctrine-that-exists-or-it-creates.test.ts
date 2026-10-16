/**
 * A FILED SHARD CITES ONLY DOCTRINE THAT EXISTS, OR THAT ITS OWN BUILD CREATES.
 *
 * 2026-10-16: #12389 filed W1-T9875 citing doctrine/plan-and-task-hygiene/new-tests-go-in-their-computed-folder.md,
 * the page its build will write. The census of doctrine citations resolves every such path in plan/, so main went red
 * at merge. `rmd lint-plan` now refuses that citation at filing, unless the shard's own `files:` declares the page.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import type { Task } from "../src/lib/plan.js";
import { lintTask, type LintOpts } from "../src/lib/task-linter.js";
import { lintPlanCommand } from "../src/run-task.js";
import { isolatedCheckout } from "./helpers/isolated-checkout.js";

const PAGE = "doctrine/plan-and-task-hygiene/new-tests-go-in-their-computed-folder.md";
const KEPT = "doctrine/plan-and-task-hygiene/status-is-not-completion.md";

function task(over: Partial<Task> = {}): Task {
  return {
    id: "W1-T9875",
    title: "fixture",
    repo: "remudero",
    depends_on: [],
    type: "implement",
    verify: "auto",
    risk: "medium",
    status: "queued",
    attempts: 0,
    origin: "architect",
    files: ["src/lib/inbox.ts"],
    design: `Add a headline pointing at ${PAGE}.`,
    ...over,
  };
}

const facts = {
  sections: new Set(["plan-and-task-hygiene"]),
  resolves: (path: string) => path === KEPT,
};

/** Through `lintTask`, the aggregate every caller runs, so the check is proven wired and not only defined. */
const doctrineCitationViolations = (t: Task, opts: LintOpts = {}) =>
  lintTask(t, opts).violations.filter((v) => v.check === "doctrine-citation-unresolved");

test("a filed shard citing a doctrine page that neither exists nor is aliased is refused", () => {
  const found = doctrineCitationViolations(task(), { doctrineCitations: facts });
  assert.equal(found.length, 1);
  assert.equal(found[0]!.check, "doctrine-citation-unresolved");
  assert.equal(found[0]!.severity, "block");
  assert.match(found[0]!.message, new RegExp(PAGE.replaceAll(".", "\\.")));
  assert.equal(lintTask(task(), { doctrineCitations: facts }).ok, false, "the refusal blocks the shard");
});

test("a filed shard may cite a doctrine page its own files: creates, or one that exists", () => {
  assert.deepEqual(doctrineCitationViolations(task({ files: ["src/lib/inbox.ts", PAGE] }), { doctrineCitations: facts }), []);
  assert.deepEqual(doctrineCitationViolations(task({ design: `See ${KEPT}.` }), { doctrineCitations: facts }), []);
  // `doctrine/x/y.md` names no real section: an example, never a citation.
  assert.deepEqual(doctrineCitationViolations(task({ design: "e.g. doctrine/x/y.md" }), { doctrineCitations: facts }), []);
  // Without the checkout's facts (the whole-plan pass, the engine) the check is silent.
  assert.deepEqual(doctrineCitationViolations(task()), []);
});

const FIXTURE = isolatedCheckout(process.cwd());
test.after(() => FIXTURE.cleanup());

function shard(id: string, files: string[]): string {
  return [
    `- id: ${id}`,
    '  title: "doctrine citation fixture"',
    "  repo: remudero",
    "  depends_on: []",
    "  type: implement",
    "  verify: auto",
    "  risk: low",
    "  status: queued",
    "  attempts: 0",
    "  origin: architect",
    `  files: [${files.join(", ")}]`,
    "  design: |",
    `    Add a CLAUDE.md headline pointing at ${PAGE}.`,
    "  acceptance:",
    '    - claim: "the fixture claim"',
    '      proof: "grep: a line no file holds yet in src/lib/plan.ts"',
    "",
  ].join("\n");
}

async function lintFiling(id: string, files: string[]): Promise<{ exitCode: number; output: string }> {
  mkdirSync(join(FIXTURE.root, "plan", "tasks.d"), { recursive: true });
  const rel = `plan/tasks.d/${id}-fixture.yaml`;
  writeFileSync(join(FIXTURE.root, rel), shard(id, files));
  const base = execFileSync("git", ["-C", FIXTURE.root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  execFileSync("git", ["-C", FIXTURE.root, "add", rel]);
  execFileSync("git", ["-C", FIXTURE.root, "-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "commit", "-q", "-m", `fixture(plan): file ${id}`]);
  const lines: string[] = [];
  const original = { log: console.log, warn: console.warn, error: console.error };
  console.log = (m?: unknown) => void lines.push(String(m));
  console.warn = (m?: unknown) => void lines.push(String(m));
  console.error = (m?: unknown) => void lines.push(String(m));
  try {
    const exitCode = await lintPlanCommand(["--plan", join(FIXTURE.root, "plan", "tasks.yaml"), "--base", base], {
      repoRoot: FIXTURE.root,
      offline: true,
    });
    return { exitCode, output: lines.join("\n") };
  } finally {
    console.log = original.log;
    console.warn = original.warn;
    console.error = original.error;
  }
}

test("rmd lint-plan refuses a filing that cites a doctrine page no file holds and its files: does not create", async () => {
  const refused = await lintFiling("W1-T99001", ["src/lib/plan.ts"]);
  assert.equal(refused.exitCode, 1, refused.output);
  assert.match(refused.output, /\[doctrine-citation-unresolved\]/);
  const planned = await lintFiling("W1-T99002", ["src/lib/plan.ts", PAGE]);
  assert.doesNotMatch(planned.output, /doctrine-citation-unresolved/);
});
