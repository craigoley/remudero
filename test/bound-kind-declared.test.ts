// test/bound-kind-declared.test.ts — W1-T1266: gate against a bound-shaped constant that never
// says whether it is a BACKSTOP or a PRIMARY CONTROL.
//
// THE DEFECT. CLAUDE.md already names this repo's recurring defect: "a bound that fires on a
// HEALTHY condition", and cites three instances (W1-T312, W1-T380/#1392, W1-T382/#1401). W1-T1219
// was a fourth: a fix-spawn bound derived from the wrong population, remediated by #2564. All four
// share one mechanism this task finally writes down: a BACKSTOP (fires only once something else has
// already failed) and a PRIMARY CONTROL (what normally stops the loop) are spelled identically —
// `export const SOMETHING_MAX = <number>` — so a backstop mis-sized under its healthy population
// becomes the primary control silently, and the site itself carries no signal either way.
//
// WHY A DECLARATION CHECK, NOT A PROSE RULE. Law 4 binds only where compliance is verifiable at
// invocation (W1-T438) — asking authors to remember to classify a bound is invisible in a diff and
// cannot be enforced. The declaration itself IS in the diff and IS greppable: a bound-shaped
// constant's own line, or the comment block directly above it, either names its kind or it does not.
// This test is that grep, scoped to `src/` and shaped exactly like test/no-raw-nul.test.ts's
// `git ls-files`-driven sweep — a source scan plus a grandfathering baseline
// (scripts/bound-kind-baseline.json) so the check bites only what is newly added. The existing
// corpus (76 declarations at this task's HEAD) is grandfathered rather than retrofitted: no existing
// bound is renamed, retagged, or resized by this change.
//
// WHAT "DECLARES ITS KIND" MEANS. The literal string BACKSTOP or PRIMARY CONTROL (upper-case,
// deliberate — not a case-insensitive match on ordinary prose) appears either on the declaration's
// own line or in the contiguous comment block immediately above it (no blank line between the
// comment and the declaration, matching this repo's existing JSDoc-above-a-constant style, e.g.
// RECON_MAX_TURNS in src/run-task.ts). Neither tag currently exists anywhere in the tree — that
// absence is exactly the defect this task names — so every one of the 76 grandfathered constants is
// undeclared today and stays that way until a future change re-derives and tags it; this task
// changes no number and adds no tag.
//
// OUT OF SCOPE (design (iv)): no compiled IR, no schema layer, no fix-rung descent argument, no
// renumbering. This is a name-shaped source scan and a grandfathering baseline, nothing else.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const BASELINE_PATH = "scripts/bound-kind-baseline.json";

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
};

/** Bound-shaped: the constant's own identifier contains one of the six spellings CLAUDE.md and
 *  this task's rationale name. Substring match, deliberately: `RECAP_ACK_HEADER` and
 *  `GITHUB_POSTURE_CAPABILITIES` are name-shaped false positives the same way a human skim would
 *  read them, and grandfathering — not a narrower regex — is how this task chooses to carry them. */
const BOUND_NAME_RE = /(MAX|CAP|LIMIT|CEIL|BOUND|TIMEOUT|THRESHOLD)/;

/** A top-level `export const NAME = ...` or `export const NAME: Type = ...` declaration. */
const DECL_LINE_RE = /^export const ([A-Z][A-Z0-9_]*)\s*(?::[^=]+)?=/;

/** The literal, deliberate kind tag. Upper-case only — this does not match ordinary prose that
 *  happens to say "backstop" in passing. */
const KIND_TAG_RE = /\bBACKSTOP\b|\bPRIMARY CONTROL\b/;

type BoundDeclaration = { path: string; name: string; line: number; declaresKind: boolean };

function isCommentLine(raw: string | undefined): boolean {
  if (raw === undefined) return false;
  const t = raw.trim();
  return t.startsWith("//") || t.startsWith("/*") || t.startsWith("*") || t === "*/";
}

/** The contiguous block of comment lines immediately above `idx` (0-based), stopping at the first
 *  line that is not itself a comment line — so a blank line, or ordinary code, ends the block. */
function precedingCommentBlock(lines: string[], idx: number): string {
  const collected: string[] = [];
  let i = idx - 1;
  while (i >= 0 && isCommentLine(lines[i])) {
    collected.unshift(lines[i]);
    i--;
  }
  return collected.join("\n");
}

/** Every bound-shaped exported constant declared under `src/` in the tracked tree at `root`,
 *  in `git ls-files` order, each paired with whether its declaration site names its kind. */
function findBoundDeclarations(root: string): BoundDeclaration[] {
  const listing = execFileSync("git", ["-C", root, "ls-files", "-z", "--", "src"], { encoding: "utf8" });
  const files = listing.split("\0").filter((f) => f.endsWith(".ts"));
  const found: BoundDeclaration[] = [];
  for (const path of files) {
    const lines = readFileSync(join(root, path), "utf8").split("\n");
    lines.forEach((line, idx) => {
      const m = line.match(DECL_LINE_RE);
      if (!m) return;
      const name = m[1];
      if (!BOUND_NAME_RE.test(name)) return;
      const declaresKind = KIND_TAG_RE.test(line) || KIND_TAG_RE.test(precedingCommentBlock(lines, idx));
      found.push({ path, name, line: idx + 1, declaresKind });
    });
  }
  return found;
}

/** Bound-shaped declarations that are neither grandfathered nor self-declaring — the set that
 *  fails the build. `baselineKeys` holds `${path}:${name}` identities, same shape as the JSON
 *  baseline file on disk. */
function boundKindViolations(root: string, baselineKeys: ReadonlySet<string>): BoundDeclaration[] {
  return findBoundDeclarations(root).filter(
    (d) => !d.declaresKind && !baselineKeys.has(`${d.path}:${d.name}`),
  );
}

function loadBaselineKeys(root: string): Set<string> {
  const raw = JSON.parse(readFileSync(join(root, BASELINE_PATH), "utf8")) as { grandfathered: string[] };
  return new Set(raw.grandfathered);
}

test("PROPERTY every bound-shaped constant under src/ either declares its kind or is grandfathered", () => {
  const violations = boundKindViolations(REPO_ROOT, loadBaselineKeys(REPO_ROOT));
  assert.deepEqual(
    violations,
    [],
    `undeclared, non-grandfathered bound(s): ${violations.map((v) => `${v.path}:${v.name}`).join(", ")}`,
  );
});

test("PROPERTY the baseline names only constants that actually exist and are actually undeclared", () => {
  // Guards the baseline itself against rot: an entry pointing at a renamed or deleted constant
  // would silently stop grandfathering anything, and an entry for a constant that already declares
  // its kind would silently mask that declaration. Either way the baseline must track reality.
  const found = findBoundDeclarations(REPO_ROOT);
  const byKey = new Map(found.map((d) => [`${d.path}:${d.name}`, d]));
  const baselineKeys = loadBaselineKeys(REPO_ROOT);
  for (const key of baselineKeys) {
    const decl = byKey.get(key);
    assert.notEqual(decl, undefined, `baseline entry ${key} no longer matches any declaration`);
    assert.equal(decl?.declaresKind, false, `baseline entry ${key} already declares its kind — drop it`);
  }
});

/** A scratch git repo with `src/lib/<name>.ts` holding exactly one line, used to plant a single
 *  bound-shaped declaration in isolation from the real tree. */
function plantFixture(dir: string, relPath: string, line: string): void {
  mkdirSync(join(dir, relPath, ".."), { recursive: true });
  writeFileSync(join(dir, relPath), `${line}\n`);
}

function initFixtureRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "bound-kind-fixture-"));
  execFileSync("git", ["init", "--quiet", "-b", "main", dir], { encoding: "utf8", env: GIT_ENV });
  return dir;
}

function commitFixture(dir: string): void {
  execFileSync("git", ["-C", dir, "add", "-A"], { encoding: "utf8", env: GIT_ENV });
  execFileSync("git", ["-C", dir, "commit", "--quiet", "-m", "fixture"], { encoding: "utf8", env: GIT_ENV });
}

test("PROPERTY a newly added bound-shaped constant with no declared kind fails and names it", () => {
  const dir = initFixtureRepo();
  try {
    plantFixture(dir, "src/lib/legacy.ts", "export const LEGACY_MAX = 10;");
    plantFixture(dir, "src/lib/newbound.ts", "export const NEW_FEATURE_CAP = 5;");
    commitFixture(dir);

    const baseline = new Set(["src/lib/legacy.ts:LEGACY_MAX"]);
    const violations = boundKindViolations(dir, baseline);
    assert.deepEqual(violations, [{ path: "src/lib/newbound.ts", name: "NEW_FEATURE_CAP", line: 1, declaresKind: false }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("PROPERTY a newly added bound that declares BACKSTOP or PRIMARY CONTROL passes unchanged", () => {
  const dir = initFixtureRepo();
  try {
    plantFixture(dir, "src/lib/legacy.ts", "export const LEGACY_MAX = 10;");
    plantFixture(dir, "src/lib/trailing.ts", "export const TRAILING_CAP = 5; // BACKSTOP: see design doc");
    mkdirSync(join(dir, "src", "lib"), { recursive: true });
    writeFileSync(
      join(dir, "src", "lib", "leading.ts"),
      ["/** PRIMARY CONTROL: this is what normally stops the loop. */", "export const LEADING_LIMIT = 3;", ""].join(
        "\n",
      ),
    );
    commitFixture(dir);

    const baseline = new Set(["src/lib/legacy.ts:LEGACY_MAX"]);
    const violations = boundKindViolations(dir, baseline);
    assert.deepEqual(violations, []);

    // And the declarations really were read as self-declaring, not merely absent from this sweep.
    const found = findBoundDeclarations(dir);
    const byName = new Map(found.map((d) => [d.name, d]));
    assert.equal(byName.get("TRAILING_CAP")?.declaresKind, true);
    assert.equal(byName.get("LEADING_LIMIT")?.declaresKind, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("PROPERTY an existing grandfathered bound with no declared kind still passes the build", () => {
  const dir = initFixtureRepo();
  try {
    plantFixture(dir, "src/lib/legacy.ts", "export const LEGACY_MAX = 10;");
    commitFixture(dir);

    const violations = boundKindViolations(dir, new Set(["src/lib/legacy.ts:LEGACY_MAX"]));
    assert.deepEqual(violations, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("PROPERTY a constant whose name is not bound-shaped is never flagged, tagged or not", () => {
  const dir = initFixtureRepo();
  try {
    plantFixture(dir, "src/lib/ordinary.ts", "export const DEFAULT_GREETING = \"hi\";");
    commitFixture(dir);

    assert.deepEqual(findBoundDeclarations(dir), []);
    assert.deepEqual(boundKindViolations(dir, new Set()), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
