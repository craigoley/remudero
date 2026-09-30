// @source-text-subject: this suite's subject is the source text declaring `*Deps` interfaces/types.

import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const SRC_ROOT = join(REPO_ROOT, "src");
const BASELINE_PATH = join(REPO_ROOT, "scripts", "deps-interface-baseline.json");

// The counters live in scripts/deps-interface-census.mjs so scripts/census-precheck.mjs counts through the
// same module without starting this suite (`scripts/**` sits outside tsconfig's `include`).
const { DEPS_DECLARATION, SEAM_DECLARATION, depsInterfaceNames, inlineAndAliasedSeams } = (await import(
  pathToFileURL(join(REPO_ROOT, "scripts", "deps-interface-census.mjs")).href
)) as {
  DEPS_DECLARATION: RegExp;
  SEAM_DECLARATION: RegExp;
  depsInterfaceNames: (contents: Iterable<string>) => string[];
  inlineAndAliasedSeams: (contents: Iterable<string>) => { inline: number; aliased: string[] };
};

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...listTsFiles(full));
    else if (entry.endsWith(".ts")) out.push(full);
  }
  return out;
}

function toRepoRelative(path: string): string {
  return relative(REPO_ROOT, path).split(sep).join("/");
}

function srcTexts(): string[] {
  return listTsFiles(SRC_ROOT).map((file) => readFileSync(file, "utf8"));
}

export function depsInterfaceDeclarations(): string[] {
  return depsInterfaceNames(srcTexts());
}

/** W1-T3744: count the two spellings which used to walk around the `*Deps` census. */
export function countsInlineAndAliasedSeams(): { inline: number; aliased: string[] } {
  return inlineAndAliasedSeams(srcTexts());
}

function declarationBodies(): Array<{ name: string; body: string }> {
  const out: Array<{ name: string; body: string }> = [];
  for (const file of listTsFiles(SRC_ROOT)) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(SEAM_DECLARATION)) {
      const open = text.indexOf("{", match.index! + match[0].length);
      if (open < 0) continue;
      let depth = 0;
      for (let i = open; i < text.length; i += 1) {
        if (text[i] === "{") depth += 1;
        else if (text[i] === "}" && --depth === 0) {
          out.push({ name: match[1]!, body: text.slice(open + 1, i) });
          break;
        }
      }
    }
  }
  return out;
}

/** Report, but do not refuse, declarations carrying an identical member-set. */
export function identicalMemberSetReport(): string[] {
  const groups = new Map<string, string[]>();
  for (const declaration of declarationBodies()) {
    const key = declaration.body.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "").replace(/\s+/g, " ").trim();
    const names = groups.get(key) ?? [];
    names.push(declaration.name);
    groups.set(key, names);
  }
  return [...groups.entries()]
    .filter(([, names]) => names.length > 1)
    .map(([members, names]) => `identical member-set: ${names.sort().join(", ")} => ${members}`)
    .sort();
}

function declarationFilesByName(): Map<string, string[]> {
  const byName = new Map<string, string[]>();
  for (const file of listTsFiles(SRC_ROOT)) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(DEPS_DECLARATION)) {
      const name = match[1]!;
      byName.set(name, [...(byName.get(name) ?? []), toRepoRelative(file)]);
    }
  }
  return byName;
}

function readBaseline(): { depsInterfaceCount: number } {
  const raw = JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as { depsInterfaceCount?: unknown };
  assert.equal(
    typeof raw.depsInterfaceCount,
    "number",
    "scripts/deps-interface-baseline.json must record depsInterfaceCount as a number",
  );
  return { depsInterfaceCount: raw.depsInterfaceCount as number };
}

test("the count of Deps interface/type declarations is recorded in scripts/deps-interface-baseline.json", () => {
  const baseline = readBaseline();
  assert.ok(Number.isInteger(baseline.depsInterfaceCount));
  assert.ok(baseline.depsInterfaceCount > 100, "the baseline must be a real census, not an empty placeholder");
});

test("the count of Deps interface/type declarations under src cannot grow", () => {
  const baseline = readBaseline();
  const actual = depsInterfaceDeclarations();
  assert.ok(actual.length > 100, "the census must see the existing declaration population");
  assert.ok(
    actual.length <= baseline.depsInterfaceCount,
    `Deps declarations grew from ${baseline.depsInterfaceCount} to ${actual.length}. ` +
      "Move wiring behind the composition root or reuse an existing seam instead of adding another *Deps shape.",
  );
});

test("each counted Deps declaration name resolves to at least one source file", () => {
  const byName = declarationFilesByName();
  for (const name of depsInterfaceDeclarations()) {
    assert.ok((byName.get(name) ?? []).length > 0, `${name} must name the file(s) that declared it`);
  }
});

test("inline and aliased seams are counted and identical member-sets are reported without refusing", () => {
  const counts = countsInlineAndAliasedSeams();
  const raw = JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as {
    inlineSeamCount?: number;
    aliasedSeamCount?: number;
  };
  assert.ok(counts.inline > 0, "the census must see at least one inline structural seam");
  assert.ok(counts.aliased.length > 0, "the census must see at least one *Seams declaration");
  assert.ok(counts.inline <= (raw.inlineSeamCount ?? 0), `inline seams grew from ${raw.inlineSeamCount} to ${counts.inline}`);
  assert.ok(counts.aliased.length <= (raw.aliasedSeamCount ?? 0), `aliased seams grew from ${raw.aliasedSeamCount} to ${counts.aliased.length}`);
  const report = identicalMemberSetReport();
  if (report.length > 0) console.log(report.join("\n"));
  assert.ok(Array.isArray(report), "identical member-set reporting is advisory");
});

test("W1-T4107: no two deps declarations share a member-set", () => {
  // Positive control: the census really reads declarations.
  assert.ok(depsInterfaceDeclarations().length > 100, "the census sees the corpus");
  assert.deepEqual(identicalMemberSetReport(), [], "a shape declared twice is folded into one declaration");
});

test("W1-T4107: the census population fell by the declarations removed", () => {
  // 160 declarations before W1-T4107; it folded 8 into 3. The ceiling stays at 160: the census guards the
  // POPULATION, and this room is what the knowledge rungs' named seams may use without it ever growing.
  assert.ok(depsInterfaceDeclarations().length <= readBaseline().depsInterfaceCount, "the population stays at or under the unchanged ceiling");
  assert.deepEqual(
    ["LedgerWriterDeps", "ClaimGitDeps", "FollowupRegistryDeps"].filter((n) => !depsInterfaceDeclarations().includes(n)),
    [],
    "the three shared declarations exist",
  );
  assert.deepEqual(
    ["MutationGateVerdictDeps", "FollowupHarvestDeps", "ContradictionResolutionDeps", "RecordReplayResultsDeps", "DispatchClaimGitDeps", "TriageClaimGitDeps", "PruneFollowupsDeps", "RetireFollowupsDeps"].filter((n) =>
      depsInterfaceDeclarations().includes(n),
    ),
    [],
    "the eight folded names are gone, not aliased",
  );
});
