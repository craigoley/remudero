import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  groundingSourceResolves,
  hasMarkdownSection,
  loadSkillRegistry,
  parseGroundingSource,
  searchGroundingSources,
  SkillError,
  skillsDir,
  unresolvedGroundingSources,
  assertGroundingSourcesResolve,
  validateSkill,
} from "../src/lib/skill.js";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

/** A minimal, VALID skill body — same base `test/skill.test.ts` uses for mutation. */
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
  const dir = mkdtempSync(join(tmpdir(), "skill-grounding-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── parseGroundingSource / hasMarkdownSection: the primitives ──────────────────────────────────

test("parseGroundingSource: splits on the FIRST '#' into { path, fragment }", () => {
  assert.deepEqual(parseGroundingSource("MASTER-PLAN.md#7C"), { path: "MASTER-PLAN.md", fragment: "7C" });
  const bare = parseGroundingSource("plan/tasks.yaml");
  assert.equal(bare.path, "plan/tasks.yaml");
  assert.equal(bare.fragment, undefined);
});

test("hasMarkdownSection: matches a heading whose text STARTS with the fragment on a word boundary, and only that", () => {
  const text = "intro\n\n## 3A. Campaigns (cross-repo)\n\nbody\n\n## 3AB Something Else\n";
  assert.equal(hasMarkdownSection(text, "3A"), true);
  // "3AB..." must NOT satisfy a search for "3A" — a prefix match on the fragment's own text is
  // not a boundary match; this is the "not silently widened" guarantee at the section level.
  assert.equal(hasMarkdownSection("only heading is\n\n## 3AB Something Else\n", "3A"), false);
  // A bare mention of the fragment in body prose (not a heading line) does not count either.
  assert.equal(hasMarkdownSection("this paragraph just talks about 3A in passing\n", "3A"), false);
});

// ── acceptance: "a skill declaring a grounding source that cannot resolve is named rather than
//    accepted silently" ─────────────────────────────────────────────────────────────────────────

test("groundingSourceResolves: a bare path with no file/dir on disk resolves false", () => {
  withTempDir((dir) => {
    assert.equal(groundingSourceResolves(dir, "nowhere.md"), false);
  });
});

test("assertGroundingSourcesResolve: throws SkillError NAMING the skill and the unresolvable entry", () => {
  withTempDir((dir) => {
    const skill = validateSkill({ ...goodRaw(), grounding_sources: ["missing.md"] }, "zzz-broken");
    assert.throws(
      () => assertGroundingSourcesResolve(dir, skill),
      (err: unknown) =>
        err instanceof SkillError && /zzz-broken/.test((err as Error).message) && /missing\.md/.test((err as Error).message),
    );
  });
});

test("assertGroundingSourcesResolve: a skill whose sources all resolve does not throw", () => {
  withTempDir((dir) => {
    writeFileSync(join(dir, "present.md"), "hello\n");
    const skill = validateSkill({ ...goodRaw(), grounding_sources: ["present.md"] }, "ok");
    assert.doesNotThrow(() => assertGroundingSourcesResolve(dir, skill));
  });
});

// ── acceptance: "every grounding source declared by every skill in the shipped registry
//    resolves" ────────────────────────────────────────────────────────────────────────────────

test("the SHIPPED .remudero/skills/ registry: every declared grounding_sources entry, in every skill, resolves under the repo root", () => {
  const skills = loadSkillRegistry(skillsDir(repoRoot));
  assert.ok(skills.length > 0, "expected the shipped registry to load at least one skill");
  for (const skill of skills) {
    assert.deepEqual(
      unresolvedGroundingSources(repoRoot, skill),
      [],
      `skill '${skill.name}' declares unresolvable grounding_sources`,
    );
    assert.doesNotThrow(() => assertGroundingSourcesResolve(repoRoot, skill));
  }
});

// ── acceptance: "a skill whose entire declared corpus is unresolvable is distinguishable from
//    one that searched and matched nothing" ────────────────────────────────────────────────────

test("unresolvedGroundingSources distinguishes 'grounded on nothing' from 'searched a real corpus and matched nothing' — searchGroundingSources alone cannot", () => {
  withTempDir((dir) => {
    writeFileSync(join(dir, "real.md"), "this file exists and has real content\n");
    const groundedOnReal = validateSkill({ ...goodRaw(), grounding_sources: ["real.md"] }, "real-corpus");
    const groundedOnNothing = validateSkill({ ...goodRaw(), grounding_sources: ["ghost.md"] }, "no-corpus");

    // Both searches come back empty for a query that doesn't appear anywhere — the SAME shape,
    // which is exactly the ambiguity this task is about: `searchGroundingSources` alone cannot
    // tell these two skills apart.
    const query = "NEVER-MATCHES-ANYTHING";
    assert.deepEqual(searchGroundingSources(dir, groundedOnReal, query), []);
    assert.deepEqual(searchGroundingSources(dir, groundedOnNothing, query), []);

    // The declaration-time check DOES tell them apart: one has a real, resolvable corpus; the
    // other's entire declared corpus is unresolvable.
    assert.deepEqual(unresolvedGroundingSources(dir, groundedOnReal), []);
    assert.deepEqual(unresolvedGroundingSources(dir, groundedOnNothing), groundedOnNothing.grounding_sources);
    assert.equal(unresolvedGroundingSources(dir, groundedOnNothing).length, groundedOnNothing.grounding_sources.length);
  });
});

// ── acceptance: "the section-anchor form is either resolved or refused, never silently widened
//    to the whole file" ─────────────────────────────────────────────────────────────────────────

test("groundingSourceResolves: a `path#fragment` entry resolves when the file has a matching heading", () => {
  withTempDir((dir) => {
    writeFileSync(join(dir, "doc.md"), "# Title\n\n## 7C. Design Review\n\nbody text\n");
    assert.equal(groundingSourceResolves(dir, "doc.md#7C"), true);
  });
});

test("groundingSourceResolves: a `path#fragment` entry resolves FALSE when the file exists but has NO matching heading — never silently widened to 'the whole file matched'", () => {
  withTempDir((dir) => {
    writeFileSync(join(dir, "doc.md"), "# Title\n\n## 9Z. Unrelated Section\n\nbody text\n");
    // The file itself is real and readable — a naive "file exists" check would pass it. The
    // fragment names a section that is NOT in this file, so it must resolve false, not silently
    // fall back to "the file exists, good enough".
    assert.equal(groundingSourceResolves(dir, "doc.md#7C"), false);
  });
});

test("the shipped registry's `#fragment` entries each resolve to a REAL heading, not a silently-widened whole-file match", () => {
  const skills = loadSkillRegistry(skillsDir(repoRoot));
  const fragmentEntries = skills.flatMap((s) => s.grounding_sources.map((source) => ({ skill: s.name, source, ...parseGroundingSource(source) }))).filter((e) => e.fragment !== undefined);
  assert.ok(fragmentEntries.length > 0, "expected the shipped registry to declare at least one #fragment source");
  for (const entry of fragmentEntries) {
    assert.equal(
      groundingSourceResolves(repoRoot, entry.source),
      true,
      `skill '${entry.skill}': '${entry.source}' must resolve to a real heading`,
    );
  }
});

// ── acceptance: "no skill declares a grounding source under a path absent from a fresh
//    checkout" ──────────────────────────────────────────────────────────────────────────────────

test("no shipped skill declares a grounding source under 'state/' — gitignored, absent from every fresh checkout by construction", () => {
  const skills = loadSkillRegistry(skillsDir(repoRoot));
  for (const skill of skills) {
    for (const source of skill.grounding_sources) {
      const { path } = parseGroundingSource(source);
      assert.equal(path.startsWith("state/"), false, `skill '${skill.name}': '${source}' rests on a gitignored 'state/' path`);
    }
  }
});

// ── acceptance: "a source that vanishes at runtime still degrades to no-match rather than
//    throwing" ──────────────────────────────────────────────────────────────────────────────────

test("searchGroundingSources: a declared source that has vanished from disk still degrades to no-match, not a throw — this task does not change that contract", () => {
  withTempDir((dir) => {
    writeFileSync(join(dir, "present.md"), "TARGET-QUERY is right here\n");
    // "vanished.md" is declared but was never written — the runtime-degradation case
    // `searchGroundingSources`'s `catch { continue }` exists for, distinct from the
    // declaration-time check this task adds.
    const skill = validateSkill({ ...goodRaw(), grounding_sources: ["vanished.md", "present.md"] }, "plan");

    assert.doesNotThrow(() => searchGroundingSources(dir, skill, "TARGET-QUERY"));
    const notes = searchGroundingSources(dir, skill, "TARGET-QUERY");
    assert.equal(notes.length, 1);
    assert.equal(notes[0].source, "present.md");

    // The declaration-time check, in contrast, DOES name it — the two are complementary, not
    // the same check run twice.
    assert.deepEqual(unresolvedGroundingSources(dir, skill), ["vanished.md"]);
  });
});
