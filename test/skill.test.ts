import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  loadSkill,
  loadSkillRegistry,
  renderSkillList,
  searchGroundingSources,
  SkillError,
  skillsDir,
  validateSkill,
  type Skill,
} from "../src/lib/skill.js";
import { groundClarifyRequest } from "../src/lib/panel-skill-run.js";
import type { Task } from "../src/lib/plan.js";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

/** A minimal, VALID skill body used as the base for negative-case mutations. */
function goodRaw() {
  return {
    tools: ["Read", "Grep"],
    permission_profile: "architect",
    output_contract: "a plan-only PR gated by ci-gate+remudero-review",
    grounding_sources: ["MASTER-PLAN.md", "plan/tasks.yaml"],
    gate: "ci-gate+remudero-review",
    tier: "architect",
  };
}

function withTempDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "skill-test-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── skillsDir ────────────────────────────────────────────────────────────

test("skillsDir joins <root>/.remudero/skills", () => {
  assert.equal(skillsDir("/tmp/repo"), "/tmp/repo/.remudero/skills");
});

// ── validateSkill: the happy path resolves every §5B field ─────────────────

test("validateSkill: a well-formed body resolves all six §5B fields plus the filename-derived name", () => {
  const skill = validateSkill(goodRaw(), "plan");
  assert.deepEqual(skill, {
    name: "plan",
    tools: ["Read", "Grep"],
    permission_profile: "architect",
    output_contract: "a plan-only PR gated by ci-gate+remudero-review",
    grounding_sources: ["MASTER-PLAN.md", "plan/tasks.yaml"],
    gate: "ci-gate+remudero-review",
    tier: "architect",
  });
});

test("validateSkill: the skill's identity is the FILENAME argument, never a body field — a body `name:` is ignored", () => {
  const raw = { ...goodRaw(), name: "spoofed-name" };
  const skill = validateSkill(raw, "real-name");
  assert.equal(skill.name, "real-name");
});

// ── validateSkill: negative cases — every §5B field is required and typed ──

test("validateSkill: a non-mapping document throws SkillError", () => {
  assert.throws(() => validateSkill("not-a-mapping", "x"), SkillError);
  assert.throws(() => validateSkill(["a", "b"], "x"), SkillError);
  assert.throws(() => validateSkill(null, "x"), SkillError);
});

for (const field of ["tools", "grounding_sources"] as const) {
  test(`validateSkill: missing '${field}' (a required list) throws SkillError naming the skill + field`, () => {
    const raw: Record<string, unknown> = goodRaw();
    delete raw[field];
    assert.throws(
      () => validateSkill(raw, "review"),
      (err: unknown) => err instanceof SkillError && /review/.test((err as Error).message) && new RegExp(field).test((err as Error).message),
    );
  });

  test(`validateSkill: an empty '${field}' list throws SkillError (no vacuous registry entry)`, () => {
    const raw = { ...goodRaw(), [field]: [] };
    assert.throws(() => validateSkill(raw, "review"), SkillError);
  });

  test(`validateSkill: a '${field}' containing a non-string element throws SkillError`, () => {
    const raw = { ...goodRaw(), [field]: ["ok", 42] };
    assert.throws(() => validateSkill(raw, "review"), SkillError);
  });
}

for (const field of ["permission_profile", "output_contract", "gate", "tier"] as const) {
  test(`validateSkill: missing '${field}' (a required string) throws SkillError`, () => {
    const raw: Record<string, unknown> = goodRaw();
    delete raw[field];
    assert.throws(() => validateSkill(raw, "retro"), SkillError);
  });

  test(`validateSkill: a blank '${field}' throws SkillError`, () => {
    const raw = { ...goodRaw(), [field]: "   " };
    assert.throws(() => validateSkill(raw, "retro"), SkillError);
  });
}

// ── loadSkill: one file end-to-end (YAML parse + validate) ─────────────────

test("loadSkill: parses a real file and derives the name from its filename (foo.yaml -> 'foo')", () => {
  withTempDir((dir) => {
    const path = join(dir, "triage.yaml");
    writeFileSync(
      path,
      "tools: [Read, WebSearch]\npermission_profile: architect\noutput_contract: proposes a plan PR\ngrounding_sources: [MASTER-PLAN.md]\ngate: ci-gate+remudero-review\ntier: architect\n",
    );
    const skill = loadSkill(path);
    assert.equal(skill.name, "triage");
    assert.deepEqual(skill.tools, ["Read", "WebSearch"]);
  });
});

test("loadSkill: invalid YAML throws SkillError naming the path", () => {
  withTempDir((dir) => {
    const path = join(dir, "broken.yaml");
    writeFileSync(path, "tools: [Read\n  bad: [indent");
    assert.throws(
      () => loadSkill(path),
      (err: unknown) => err instanceof SkillError && err.message.includes(path),
    );
  });
});

// ── loadSkillRegistry: the directory-scan contract (W1-T44's core claim) ───

test("loadSkillRegistry: a MISSING directory is not an error — returns [] (no registry yet)", () => {
  assert.deepEqual(loadSkillRegistry("/no/such/dir/anywhere"), []);
});

test("loadSkillRegistry: loads every *.yaml in the dir, sorted by filename, ignoring non-yaml files", () => {
  withTempDir((dir) => {
    writeFileSync(join(dir, "zeta.yaml"), yamlOf(goodRaw()));
    writeFileSync(join(dir, "alpha.yaml"), yamlOf(goodRaw()));
    writeFileSync(join(dir, "README.md"), "not a skill");
    const skills = loadSkillRegistry(dir);
    assert.deepEqual(skills.map((s) => s.name), ["alpha", "zeta"]);
  });
});

test("loadSkillRegistry: dropping ONE new <name>.yaml into the dir is the entire diff — the loader needs no change to pick it up", () => {
  withTempDir((dir) => {
    assert.deepEqual(loadSkillRegistry(dir), []);
    writeFileSync(join(dir, "brand-new-skill.yaml"), yamlOf(goodRaw()));
    const skills = loadSkillRegistry(dir);
    assert.equal(skills.length, 1);
    assert.equal(skills[0].name, "brand-new-skill");
  });
});

test("loadSkillRegistry: a single malformed shard fails the WHOLE load (fail loud, not a silent partial registry)", () => {
  withTempDir((dir) => {
    writeFileSync(join(dir, "good.yaml"), yamlOf(goodRaw()));
    writeFileSync(join(dir, "bad.yaml"), "tools: []\n");
    assert.throws(() => loadSkillRegistry(dir), SkillError);
  });
});

function yamlOf(obj: ReturnType<typeof goodRaw>): string {
  return (
    `tools: [${obj.tools.join(", ")}]\n` +
    `permission_profile: ${obj.permission_profile}\n` +
    `output_contract: "${obj.output_contract}"\n` +
    `grounding_sources: [${obj.grounding_sources.join(", ")}]\n` +
    `gate: ${obj.gate}\n` +
    `tier: ${obj.tier}\n`
  );
}

// ── renderSkillList: rmd skill list's actual rendering ──────────────────────

test("renderSkillList: an empty registry renders a non-empty, non-throwing hint (not silence)", () => {
  const out = renderSkillList([]);
  assert.match(out, /no skills registered/);
});

function reEscape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

test("renderSkillList: every field is resolved and visible for each skill, in one block per skill", () => {
  const skills: Skill[] = [validateSkill(goodRaw(), "plan"), validateSkill({ ...goodRaw(), tier: "worker" }, "review")];
  const out = renderSkillList(skills);
  for (const s of skills) {
    assert.match(out, new RegExp(reEscape(s.name)));
    assert.match(out, new RegExp(reEscape(s.tools.join(", "))));
    assert.match(out, new RegExp(reEscape(s.permission_profile)));
    assert.match(out, new RegExp(reEscape(s.gate)));
    assert.match(out, new RegExp(reEscape(s.tier)));
  }
});

// ── The SHIPPED .remudero/skills/ registry — the v1 lineup (MASTER-PLAN §5B) ─

const V1_SKILLS = ["setup", "plan", "feedback", "retro", "review", "refactor", "design-review"];

test("the SHIPPED .remudero/skills/ registry loads cleanly and enumerates exactly the v1 lineup", () => {
  const skills = loadSkillRegistry(skillsDir(repoRoot));
  assert.deepEqual(
    skills.map((s) => s.name).sort(),
    [...V1_SKILLS].sort(),
  );
});

test("every SHIPPED v1 skill resolves non-empty tools/permission_profile/gate/tier (the acceptance-2 proof shape)", () => {
  const skills = loadSkillRegistry(skillsDir(repoRoot));
  for (const skill of skills) {
    assert.ok(skill.tools.length > 0, `${skill.name}.tools must be non-empty`);
    assert.ok(skill.permission_profile.length > 0, `${skill.name}.permission_profile must be non-empty`);
    assert.ok(skill.gate.length > 0, `${skill.name}.gate must be non-empty`);
    assert.ok(skill.tier.length > 0, `${skill.name}.tier must be non-empty`);
    assert.ok(skill.output_contract.length > 0, `${skill.name}.output_contract must be non-empty`);
    assert.ok(skill.grounding_sources.length > 0, `${skill.name}.grounding_sources must be non-empty`);
  }
});

test("design-review is the ONLY shipped skill granted a playwright/browser tool (§7C: browser egress is per-skill, never global)", () => {
  const skills = loadSkillRegistry(skillsDir(repoRoot));
  for (const skill of skills) {
    const hasBrowserTool = skill.tools.some((t) => /playwright|browser/i.test(t));
    assert.equal(hasBrowserTool, skill.name === "design-review", `${skill.name}: unexpected browser-tool grant state`);
  }
});

test("design-review never grants browser_run_code_unsafe (§7C: HARD-DENIED, RCE-equivalent)", () => {
  const skills = loadSkillRegistry(skillsDir(repoRoot));
  const designReview = skills.find((s) => s.name === "design-review");
  assert.ok(designReview, "design-review must be a shipped skill");
  assert.ok(!designReview!.tools.some((t) => /browser_run_code_unsafe/.test(t)));
});

// ── searchGroundingSources: the declared-corpus lookup primitive (W1-T933) ─────────────────
//
// W1-T933's shard: the `grounding_sources` search embedded in `panel-skill-run.ts`'s
// `groundClarifyRequest` was TRAPPED in the console panel path (bound to 127.0.0.1:4317, no
// published port). This lifts it into `searchGroundingSources` here so any caller can ask "what
// does the declared corpus already say about X" directly, and refactors `groundClarifyRequest`
// onto it rather than leaving it duplicated. Four proofs, matching the shard's acceptance table:
//   1. searchable off the panel path — call the primitive with no panel/HTTP plumbing at all.
//   2. the clarify path calls the shared lookup, not its own copy.
//   3. a source the skill does not declare is never searched, even if it contains a match.
//   4. the lookup makes no model call and is deterministic (same input -> same output, offline).

test("W1-T933: declared grounding sources are searchable off the panel path", () => {
  withTempDir((dir) => {
    writeFileSync(join(dir, "notes.md"), "line one\nW9-T9 mentioned right here\nline three\n");
    const skill = validateSkill({ ...goodRaw(), grounding_sources: ["notes.md"] }, "plan");

    // No `panel-skill-run.ts`, no HTTP route, no console/127.0.0.1:4317 plumbing anywhere in this
    // call chain — the primitive is reachable directly off `lib/skill.ts`.
    const notes = searchGroundingSources(dir, skill, "W9-T9");
    assert.equal(notes.length, 1);
    assert.equal(notes[0].source, "notes.md");
    assert.match(notes[0].excerpts[0], /W9-T9/);
  });
});

test("W1-T933: the clarify path calls the shared lookup", () => {
  withTempDir((dir) => {
    const skillsDirPath = skillsDir(dir);
    mkdirSync(skillsDirPath, { recursive: true });
    writeFileSync(
      join(skillsDirPath, "plan.yaml"),
      "tools:\n  - Read\npermission_profile: implement\noutput_contract: a PR\ngrounding_sources:\n  - notes.md\ngate: ci\ntier: G-17\n",
    );
    writeFileSync(join(dir, "notes.md"), "W9-T5 discussed here\n");
    const task = { id: "W9-T5", title: "example" } as unknown as Task;

    const viaClarify = groundClarifyRequest(dir, task);
    const planSkill = loadSkill(join(skillsDirPath, "plan.yaml"));
    const viaPrimitiveDirectly = searchGroundingSources(dir, planSkill, task.id);

    // `groundClarifyRequest` is now a thin wrapper: it resolves the "plan" skill, then delegates
    // to the SAME `searchGroundingSources` primitive a direct caller would use — not its own
    // parallel copy of the search loop. Identical inputs through either route -> identical output.
    assert.deepEqual(viaClarify, viaPrimitiveDirectly);
    assert.equal(viaClarify.length, 1);
    assert.equal(viaClarify[0].source, "notes.md");
  });
});

test("W1-T933: an undeclared source is never searched", () => {
  withTempDir((dir) => {
    writeFileSync(join(dir, "declared.md"), "nothing relevant\n");
    // `undeclared.md` DOES contain a match for the query, but the skill never names it under
    // `grounding_sources` — it must not be opened, let alone show up in the results.
    writeFileSync(join(dir, "undeclared.md"), "SECRET-TARGET lives right here\n");
    const skill = validateSkill({ ...goodRaw(), grounding_sources: ["declared.md"] }, "plan");

    const notes = searchGroundingSources(dir, skill, "SECRET-TARGET");
    // Empty results proves `undeclared.md` was never opened: it DOES contain a match, so a
    // non-empty result here could only mean the search reached beyond `grounding_sources`.
    assert.deepEqual(notes, []);
  });
});

test("W1-T933: a declared source that cannot be read is skipped not fatal", () => {
  withTempDir((dir) => {
    writeFileSync(join(dir, "present.md"), "W9-T3 is here\nunrelated\n");
    // "absent.md" is DECLARED but never written — the shape a skill hits when a grounding
    // source is renamed or has not landed yet. `readFileSync` throws and the loop's `continue`
    // swallows it; before this test that catch arm never executed, so a `throw` where the
    // `continue` sits would have shipped and taken the whole lookup down on one missing file.
    const skill = validateSkill({ ...goodRaw(), grounding_sources: ["absent.md", "present.md"] }, "plan");

    const notes = searchGroundingSources(dir, skill, "W9-T3");

    // Skipped, not fatal, and NOT silently empty: the readable sibling still answers.
    assert.equal(notes.length, 1);
    assert.equal(notes[0].source, "present.md");
    assert.deepEqual(notes[0].excerpts, ["W9-T3 is here"]);
  });
});

test("W1-T933: the lookup stays deterministic and offline", () => {
  withTempDir((dir) => {
    writeFileSync(join(dir, "notes.md"), "W9-T2 appears once\nW9-T2 appears twice\nirrelevant\n");
    const skill = validateSkill({ ...goodRaw(), grounding_sources: ["notes.md"] }, "plan");

    const originalFetch = globalThis.fetch;
    // Deliberately poison network access for the duration of this assertion.
    globalThis.fetch = (() => {
      throw new Error("searchGroundingSources must never make a network/model call");
    }) as typeof fetch;
    let first: ReturnType<typeof searchGroundingSources>;
    let second: ReturnType<typeof searchGroundingSources>;
    try {
      // POSITIVE CONTROL ON THE POISON ITSELF. Without it this test asserts a zero it never
      // proved it could see: a fake assigned to the wrong global (or silently dropped by the
      // cast) leaves `fetch` unarmed, `searchGroundingSources` makes no call either way, and
      // "deterministic and offline" passes vacuously. Firing it once proves the trap is live
      // BEFORE the real assertion leans on it never firing.
      assert.throws(() => (globalThis.fetch as unknown as () => unknown)(), /never make a network\/model call/);
      first = searchGroundingSources(dir, skill, "W9-T2");
      second = searchGroundingSources(dir, skill, "W9-T2");
    } finally {
      globalThis.fetch = originalFetch;
    }

    // Same input -> byte-identical output, with `fetch` armed to throw for the whole call —
    // proves both "no model/network call" and "deterministic" in one assertion.
    assert.deepEqual(first, second);
    assert.equal(first.length, 1);
    assert.equal(first[0].excerpts.length, 2);
  });
});
