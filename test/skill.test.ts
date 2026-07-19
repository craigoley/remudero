import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  loadSkill,
  loadSkillRegistry,
  renderSkillList,
  SkillError,
  skillsDir,
  validateSkill,
  type Skill,
} from "../src/lib/skill.js";

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
