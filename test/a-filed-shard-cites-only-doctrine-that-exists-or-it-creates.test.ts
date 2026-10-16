/**
 * A FILED SHARD CITES ONLY DOCTRINE THAT EXISTS, OR THAT ITS OWN BUILD CREATES.
 *
 * 2026-10-16: #12389 filed W1-T9875 citing doctrine/plan-and-task-hygiene/new-tests-go-in-their-computed-folder.md,
 * the page its build will write. The census of doctrine citations resolves every such path in plan/, so main went red
 * at merge. `rmd lint-plan` now refuses that citation at filing, unless the shard's own `files:` declares the page.
 * The lint-plan end-to-end case lives in test/a-grep-proof-that-already-matches-is-refused-at-filing.test.ts, which
 * already drives `lintPlanCommand` over a fixture checkout.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { Task } from "../src/lib/plan.js";
import { lintTask, type LintOpts } from "../src/lib/task-linter.js";
import { DOCTRINE_PATH_RE } from "../src/lib/doctrine-citations.js";

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

test("a doctrine path names a section and a page, never a bare page", () => {
  assert.equal(DOCTRINE_PATH_RE.test(KEPT), true);
  assert.equal(DOCTRINE_PATH_RE.test("doctrine/README.md"), false, "a page outside any section is no citation");
  assert.equal(DOCTRINE_PATH_RE.test("doctrine/Plan/Page.md"), false, "doctrine slugs are lower case");
});

test("a checkout with no doctrine/ has no doctrine sections, so lint-plan cites nothing there", async () => {
  const { withTempDir } = await import("../src/lib/tmp.js");
  const { doctrineCitationFactsAt } = await import("../src/lib/doctrine-citation-facts.js");
  await withTempDir("no-doctrine", (root) => {
    const facts = doctrineCitationFactsAt(root);
    assert.equal(facts.sections.size, 0);
    assert.deepEqual(lintTask(task(), { doctrineCitations: facts }).violations.filter((v) => v.check === "doctrine-citation-unresolved"), []);
  });
});
