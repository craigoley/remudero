/**
 * W1-T9292 — A SUFFIXED DRAFT PLACEHOLDER IS MINTED, AND AN UNMINTED ID NEVER LANDS IN THE PLAN.
 *
 * `rmd approve` ratification leaked unminted ids to main twice on 2026-10-13:
 *   - #11378 declared NEW-1A, NEW-1B and NEW-2. The placeholder declaration pattern read "NEW-1" out of
 *     "NEW-1A", and the word-boundary substitution of NEW-1 never matched inside NEW-1A, so only NEW-2
 *     became a real id and two shards landed declaring NEW-1A and NEW-1B.
 *   - #11402 declared NEW-1a and NEW-1b only. No `NEW-<digits>` declaration matched at all, so
 *     `materializeDraftTaskIds` took its zero-placeholder path and returned `ok: true` unchanged.
 * lint-plan never checked an id's shape, so it accepted all four.
 *
 * The materializer is driven with fake mint and reserveBlock deps; the lint is driven through the
 * real `lintPlanCommand --base` over a git fixture whose base already holds one unminted shard.
 */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

// The two shapes are read off the module namespaces, so this file still LOADS at a base without them and its tests
// fail there rather than the whole file refusing to link.
import * as inbox from "#src/lib/inbox.js";
import { materializeDraftTaskIds, type DraftTaskIdMintDeps } from "#src/lib/inbox.js";
import * as taskLinter from "#src/lib/task-linter.js";
import { lintPlanCommand } from "#src/run-task.js";
import { gitRepo, type GitRepo } from "#test/helpers/git-repo.js";

const record = (id: string, title: string, dependsOn: string[] | string = []) =>
  [
    `- id: ${id}`,
    `  title: "${title}"`,
    "  repo: remudero",
    typeof dependsOn === "string" ? dependsOn : `  depends_on: [${dependsOn.join(", ")}]`,
    "  type: implement",
    "  verify: auto",
    "  risk: medium",
    "  status: queued",
    "  attempts: 0",
    "  files: [src/lib/mounts.ts]",
    "  acceptance:",
    `    - claim: "${title} works"`,
    `      proof: "unit test: ${title} works"`,
    "",
  ].join("\n");

/** Fake deps that record every call, reserving consecutive ids from `start`. */
function recordingDeps(start: number): DraftTaskIdMintDeps & { reserved: number[][] } {
  const reserved: number[][] = [];
  return {
    reserved,
    mint: () => ({ n: start, degraded: [] }),
    reserveBlock: (startId, count) => {
      const ids = Array.from({ length: count }, (_, i) => startId + i);
      reserved.push(ids);
      return { ids };
    },
  };
}

test("W1-T9292: every suffixed and plain draft placeholder is minted and rewritten", () => {
  // The #11378 fragment shape: NEW-1A, NEW-1B, NEW-2, with NEW-1B depending on NEW-1A and NEW-2 on both
  // (one flow-list, one block-list depends_on).
  const fragmentYaml = [
    record("NEW-1A", "add a caller for validateMounts"),
    record("NEW-1B", "the symbol-no-caller rule passes for validateMounts", ["NEW-1A"]),
    record("NEW-2", "retire the adoption once both land", "  depends_on:\n    - NEW-1A\n    - NEW-1B"),
  ].join("");
  const stampLine = "- adoption:symbol-no-caller:src/lib/mounts.ts:validateMounts — RATIFIED 2026-10-13 -> NEW-1A, NEW-1B, NEW-2.";
  const deps = recordingDeps(9167);

  const result = materializeDraftTaskIds({ fragmentYaml, stampLine }, deps);

  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok) return;
  assert.deepEqual(deps.reserved, [[9167, 9168, 9169]], "three distinct placeholders reserve three ids");
  assert.deepEqual(result.ids, ["W1-T9167", "W1-T9168", "W1-T9169"]);
  assert.deepEqual(
    [...result.fragmentYaml.matchAll(/^- id: (\S+)$/gm)].map((m) => m[1]),
    ["W1-T9167", "W1-T9168", "W1-T9169"],
    "every declaration is rewritten, in declaration order",
  );
  assert.match(result.fragmentYaml, /depends_on: \[W1-T9167\]/, "NEW-1B's depends_on on NEW-1A is rewritten");
  assert.match(result.fragmentYaml, /depends_on:\n {4}- W1-T9167\n {4}- W1-T9168\n/, "NEW-2's block-list depends_on is rewritten");
  assert.doesNotMatch(result.fragmentYaml, /NEW-/, "no placeholder token survives in the fragment");
  assert.equal(
    result.stampLine,
    "- adoption:symbol-no-caller:src/lib/mounts.ts:validateMounts — RATIFIED 2026-10-13 -> W1-T9167, W1-T9168, W1-T9169.",
  );
});

test("W1-T9292: a fragment declaring only suffixed placeholders is still minted", () => {
  // The #11402 shape: NEW-1a and NEW-1b, no `NEW-<digits>` declaration at all.
  const fragmentYaml = [
    record("NEW-1a", "add automatic git remote detection in the runner module", ["W1-T60"]),
    record("NEW-1b", "integrate automatic git remote detection into the rmd sweep flow", ["NEW-1a"]),
  ].join("");
  const stampLine = "- verify-human-automate:W1-T5760 — RATIFIED 2026-10-13 -> NEW-1a, NEW-1b.";
  const deps = recordingDeps(9300);

  const result = materializeDraftTaskIds({ fragmentYaml, stampLine }, deps);

  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok) return;
  assert.deepEqual(deps.reserved, [[9300, 9301]], "the suffixed placeholders are minted, not passed through");
  assert.deepEqual(result.ids, ["W1-T9300", "W1-T9301"]);
  assert.notEqual(result.fragmentYaml, fragmentYaml, "the fragment must not come back unchanged");
  assert.match(result.fragmentYaml, /^- id: W1-T9300$/m);
  assert.match(result.fragmentYaml, /^- id: W1-T9301$/m);
  assert.match(result.fragmentYaml, /depends_on: \[W1-T60\]/, "a real existing depends_on is untouched");
  assert.match(result.fragmentYaml, /depends_on: \[W1-T9300\]/);
  assert.doesNotMatch(result.fragmentYaml, /NEW-/);
  assert.equal(result.stampLine, "- verify-human-automate:W1-T5760 — RATIFIED 2026-10-13 -> W1-T9300, W1-T9301.");

  // Case is part of the token: NEW-1a and NEW-1A are two placeholders, and NEW-1 never rewrites part of either.
  const mixed = materializeDraftTaskIds(
    { fragmentYaml: [record("NEW-1", "plain"), record("NEW-1a", "lower", ["NEW-1"]), record("NEW-1A", "upper", ["NEW-1a"])].join(""), stampLine: "-> NEW-1, NEW-1a, NEW-1A" },
    recordingDeps(400),
  );
  assert.equal(mixed.ok, true, JSON.stringify(mixed));
  if (!mixed.ok) return;
  assert.deepEqual(mixed.ids, ["W1-T400", "W1-T401", "W1-T402"]);
  assert.equal(mixed.stampLine, "-> W1-T400, W1-T401, W1-T402");
  assert.match(mixed.fragmentYaml, /^- id: W1-T401\n(?:.*\n)*? {2}depends_on: \[W1-T400\]$/m);
  assert.match(mixed.fragmentYaml, /^- id: W1-T402\n(?:.*\n)*? {2}depends_on: \[W1-T401\]$/m);
});

test("W1-T9292: materialization refuses a fragment that still holds an unminted id", () => {
  const never: DraftTaskIdMintDeps = {
    mint: () => {
      throw new Error("must never be called: the fragment is refused before anything is minted");
    },
    reserveBlock: () => {
      throw new Error("must never be called: the fragment is refused before anything is reserved");
    },
  };

  // The zero-placeholder path: no NEW- token at all, but the declared id is not a minted id.
  const unrecognised = materializeDraftTaskIds(
    { fragmentYaml: record("draft-1", "a drafted task"), stampLine: "-> draft-1" },
    never,
  );
  assert.equal(unrecognised.ok, false, "a fragment declaring only unrecognised ids must not pass through");
  if (!unrecognised.ok) assert.match(unrecognised.reason, /draft-1/);

  // A dangling depends_on reference to a placeholder nothing declares.
  const dangling = materializeDraftTaskIds(
    { fragmentYaml: record("NEW-1", "a drafted task", ["NEW-7"]), stampLine: "-> NEW-1" },
    never,
  );
  assert.equal(dangling.ok, false, "an undeclared NEW- reference must refuse");
  if (!dangling.ok) assert.match(dangling.reason, /NEW-7/);

  // A stamp naming a placeholder the fragment never declares.
  const stamp = materializeDraftTaskIds(
    { fragmentYaml: record("NEW-1", "a drafted task"), stampLine: "-> NEW-1, NEW-3" },
    never,
  );
  assert.equal(stamp.ok, false, "a stamp carrying an undeclared NEW- token must refuse");
  if (!stamp.ok) assert.match(stamp.reason, /NEW-3/);

  // A scalar depends_on naming an undeclared placeholder, a fragment that does not parse, one that is not a list, and a
  // list entry that is not a task: none of them can show what it declares, so each refuses.
  const scalarDep = materializeDraftTaskIds(
    { fragmentYaml: record("NEW-1", "a drafted task", "  depends_on: NEW-8"), stampLine: "-> NEW-1" },
    never,
  );
  assert.equal(scalarDep.ok, false);
  if (!scalarDep.ok) assert.match(scalarDep.reason, /NEW-8/);
  for (const [fragmentYaml, why] of [
    ["- id: NEW-1\n  title: [unclosed\n", /does not parse/],
    ["id: NEW-1\ntitle: a map, not a list\n", /not a YAML list/],
    ["- just a string\n", /id ""/],
  ] as const) {
    const refused = materializeDraftTaskIds({ fragmentYaml, stampLine: "" }, never);
    assert.equal(refused.ok, false, fragmentYaml);
    if (!refused.ok) assert.match(refused.reason, why);
  }

  // After substitution: a reservation that hands back fewer ids than asked leaves an unminted id behind.
  const shortBlock = materializeDraftTaskIds(
    { fragmentYaml: [record("NEW-1", "one"), record("NEW-2", "two")].join(""), stampLine: "-> NEW-1, NEW-2" },
    { mint: () => ({ n: 500, degraded: [] }), reserveBlock: (startId) => ({ ids: [startId] }) },
  );
  assert.equal(shortBlock.ok, false, "a residue left by substitution must refuse, never land");
  if (!shortBlock.ok) assert.match(shortBlock.reason, /W1-Tundefined|NEW-2/);

  // CONTROL: an already-minted fragment still passes through untouched, with nothing minted.
  const minted = materializeDraftTaskIds(
    { fragmentYaml: record("W1-T900", "already minted", ["W1-T12e"]), stampLine: "-> W1-T900" },
    never,
  );
  assert.equal(minted.ok, true, JSON.stringify(minted));
});

test("W1-T9292: the placeholder and minted-id shapes accept what they name and refuse what they do not", () => {
  const { DRAFT_PLACEHOLDER_IN_TEXT_RE } = inbox;
  const { MINTED_TASK_ID_RE } = taskLinter;
  assert.equal(DRAFT_PLACEHOLDER_IN_TEXT_RE.test("-> NEW-1A, W1-T5"), true);
  assert.equal(DRAFT_PLACEHOLDER_IN_TEXT_RE.test("depends_on: [NEW-1b]"), true);
  assert.equal(DRAFT_PLACEHOLDER_IN_TEXT_RE.test("-> W1-T9167, RENEW-1"), false);
  assert.equal(MINTED_TASK_ID_RE.test("W1-T9167"), true);
  assert.equal(MINTED_TASK_ID_RE.test("W1-T12e"), true);
  assert.equal(MINTED_TASK_ID_RE.test("CONSOLE-T42"), true);
  assert.equal(MINTED_TASK_ID_RE.test("NEW-1A"), false);
  assert.equal(MINTED_TASK_ID_RE.test("W1-T12ab"), false);
  assert.equal(MINTED_TASK_ID_RE.test("W1-Tundefined"), false);
});

// ── lint-plan ────────────────────────────────────────────────────────────────────────────────

const LINT_DEPS = {
  offline: true,
  loadConfig: (() => ({ root: "/synthetic" })) as never,
  resolveOwnerRepo: (() => ({ owner: "o", repo: "r" })) as never,
  ghGateway: (() => ({})) as never,
  projectPlan: ((plan: { tasks: { id: string }[] }) => new Map(plan.tasks.map((t) => [t.id, { merged: false }]))) as never,
};

const shard = (id: string, title: string) =>
  [
    `- id: ${id}`,
    `  title: "${title}"`,
    "  repo: remudero",
    "  depends_on: []",
    "  type: implement",
    "  verify: human",
    "  risk: high",
    "  status: queued",
    '  origin: "W1-T9292 test fixture"',
    "  files: [test/w1-t9292-fixture.test.ts]",
    "  acceptance:",
    '    - claim: "something is proven"',
    '      proof: "unit test: test/w1-t9292-fixture.test.ts"',
    "",
  ].join("\n");

function writeShard(repo: GitRepo, id: string, title: string): void {
  writeFileSync(join(repo.dir, "plan", "tasks.d", `${id}-fixture.yaml`), shard(id, title), "utf8");
}

async function lint(repo: GitRepo, args: string[]): Promise<{ code: number; out: string[] }> {
  const out: string[] = [];
  const orig = { error: console.error, warn: console.warn, log: console.log };
  console.error = console.warn = console.log = (...a: unknown[]) => void out.push(a.map(String).join(" "));
  try {
    const code = await lintPlanCommand(args, { ...LINT_DEPS, repoRoot: repo.dir } as never);
    return { code, out };
  } finally {
    Object.assign(console, orig);
  }
}

test("W1-T9292: lint-plan fails an added unminted id and warns for one already on the base", async () => {
  // base: one minted shard and one unminted shard (the NEW-1A that #11378 landed).
  const repo = gitRepo({ kind: "w1-t9292" });
  mkdirSync(join(repo.dir, "plan", "tasks.d"), { recursive: true });
  writeFileSync(join(repo.dir, "plan", "tasks.yaml"), "[]\n", "utf8");
  writeShard(repo, "ZZ-T1", "a minted task");
  writeShard(repo, "NEW-1A", "an unminted task already on the base");
  repo.git("add", "plan");
  repo.git("commit", "-q", "-m", "base");
  repo.git("checkout", "-q", "-b", "feature");

  // The branch edits the base's NEW-1A (pulling it into the changed-tasks scope) and adds nothing else.
  writeShard(repo, "NEW-1A", "an unminted task already on the base, edited");
  repo.git("add", "plan");
  repo.git("commit", "-q", "-m", "edit the base's unminted shard");
  const inherited = await lint(repo, ["--base", "main"]);
  assert.equal(inherited.code, 0, `an id already on the base must only warn:\n${inherited.out.join("\n")}`);
  assert.ok(
    inherited.out.some((l) => /⚠ NEW-1A: \[unminted-task-id\]/.test(l)),
    `the base's unminted id must stay visible as a warning:\n${inherited.out.join("\n")}`,
  );

  // The branch ADDS a NEW-9 shard: that one fails, naming the id.
  writeShard(repo, "NEW-9", "an unminted task this branch adds");
  repo.git("add", "plan");
  repo.git("commit", "-q", "-m", "add an unminted shard");
  const added = await lint(repo, ["--base", "main"]);
  assert.equal(added.code, 1, `an added unminted id must fail lint-plan:\n${added.out.join("\n")}`);
  const failLine = added.out.findIndex((l) => l.startsWith("✗ NEW-9:"));
  assert.ok(failLine >= 0, `NEW-9 must be reported failing:\n${added.out.join("\n")}`);
  assert.ok(
    added.out.slice(failLine + 1).some((l) => /^ {4}\[unminted-task-id\].*NEW-9/.test(l)),
    `NEW-9's failure must be the unminted-task-id rule:\n${added.out.join("\n")}`,
  );
  assert.ok(!added.out.some((l) => l.startsWith("✗ NEW-1A:")), `the base's NEW-1A must not fail:\n${added.out.join("\n")}`);
  assert.ok(!added.out.some((l) => l.startsWith("✗ ZZ-T1:")), added.out.join("\n"));
});
