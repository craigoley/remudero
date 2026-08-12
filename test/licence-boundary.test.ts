import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

/**
 * W1-T439 — the 2026-08-11 DECISIONS.md entry (PR #1599, merged 9f208c16) ratified that core
 * stays Apache-2.0, a "one-way door, accepted knowingly" (MASTER-PLAN §6A), with the relay's own
 * licence left for W1-T431 to decide. Nothing enforced that: the FIRST revision of PR #1599 (sha
 * 7af9c798, on a since-force-pushed branch) replaced LICENSE with the Functional Source License,
 * added a second root licence file, changed package.json's `license` field to a non-SPDX string,
 * and rewrote README's licence claim — and every automated check on that revision was green. The
 * only thing that stopped it was a human reading the diff.
 *
 * THIS IS A CONSISTENCY CHECK, NOT A LITERAL PIN (design clause (i)): pinning one string catches
 * a wholesale swap but misses a PARTIAL change that leaves the three declarations disagreeing.
 * This gate asserts instead that LICENSE's own text, package.json's `license` field, and
 * README's License-section claim all agree, and that the agreed value is Apache-2.0. It also
 * asserts COMPLETENESS over the licence-bearing surface (design clause (ii), same shape as
 * `ci-parity:drift`/`INSTRUMENT_SURFACE`): the live set of repo-root licence-bearing files is
 * DERIVED from the tracked tree rather than hand-maintained, and any file in that derived set
 * without a declared, reasoned entry fails the gate — the exact shape of the second file
 * (`LICENSE-APACHE-2.0`) the reverted revision added.
 *
 * This is a TEST, not a ci.yml job (design clause (iii), a hard constraint mirroring W1-T438's):
 * `judgeReview`'s instrument-isolation predicate forces review to failure whenever a diff touches
 * `.github/workflows/` alongside a src/ path, and `isProductPath` excludes `test/` — so wiring
 * this into CI would re-open the exact entanglement problem W1-T402 exists to prevent. It rides
 * the existing `ci` job's `npm run test:ci` instead.
 *
 * WHAT THIS DOES NOT DO (design clause (iv)): no legal protection, no moat. Everything published
 * to date is irrevocably Apache-2.0 already. This is a LEGIBILITY guard — it makes a licence move
 * impossible to land silently — not a defence, and it takes no position on the relay's own
 * licence (design clause (vi), explicitly out of scope here).
 */

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

function git(args: string[]): string {
  return execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8" });
}

/** The one licence identity the merged 2026-08-11 entry commits core to, and the only value the
 * three declarations below are permitted to agree on. Not a choice made by this task — read from
 * what the repository already is and what the merged entry already recommends (task note). */
const EXPECTED_LICENCE = "Apache-2.0";

/**
 * Repo-root files this gate has DECLARED as legitimate licence-bearing files, each with a
 * reason. Today that set is exactly one. A PR that adds a second root file matching
 * `LICENCE_FILE_NAME_RE` — as `LICENSE-APACHE-2.0` did in the reverted revision — must declare it
 * here with a reason, or the completeness check below fails naming it.
 */
const DECLARED_LICENCE_FILES: Readonly<Record<string, string>> = {
  LICENSE: "the sole, Apache-2.0, licence file for this repo (W1-T439)",
};

/**
 * Root-level filename shape that marks a file as licence-bearing: LICENSE/LICENCE/COPYING,
 * optionally followed by a separator and a suffix (e.g. the `-APACHE-2.0` the reverted revision
 * added). Case-insensitive because GitHub itself treats `license`/`licence` interchangeably when
 * choosing which root file to render as a repo's licence.
 */
const LICENCE_FILE_NAME_RE = /^(licen[cs]e|copying)([._-].*)?$/i;

/**
 * Derives the live set of repo-root licence-bearing files, tracked-only — design clause (ii)'s
 * "derive the live set from the tree rather than from a second hand-written list".
 */
function deriveRootLicenceFiles(trackedRootFiles: readonly string[]): string[] {
  return trackedRootFiles.filter((f) => LICENCE_FILE_NAME_RE.test(f)).sort();
}

/**
 * Identifies the licence a LICENSE file's own text declares, from its canonical opening lines.
 * Apache-2.0's boilerplate opens "Apache License" + "Version 2.0" within its first few lines;
 * anything else is reported by its own first non-blank line, so a divergence message can say
 * what it actually found rather than only that it isn't Apache-2.0 (design clause (v)).
 */
function identifyLicenceText(text: string): string {
  const head = text.split("\n").slice(0, 5).join("\n");
  if (/Apache License/i.test(head) && /Version 2\.0/i.test(head)) return "Apache-2.0";
  const firstLine = text.split("\n").find((l) => l.trim().length > 0) ?? "";
  return `unknown (${firstLine.trim().slice(0, 60)})`;
}

/** package.json's own `license` field, verbatim — undefined if absent, non-string, or malformed. */
function readPackageLicence(pkgJsonText: string): string | undefined {
  try {
    const pkg = JSON.parse(pkgJsonText) as { license?: unknown };
    return typeof pkg.license === "string" ? pkg.license : undefined;
  } catch {
    return undefined;
  }
}

/**
 * README's own claim about the project's licence status: the `## License` section's link text,
 * e.g. `[Apache-2.0](./LICENSE)`. Undefined if the section or the link is missing/reworded, so a
 * divergence message can name what it found instead (design clause (v)).
 */
function readReadmeLicenceClaim(readmeText: string): string | undefined {
  const section = readmeText.match(/^##\s*License\s*\n([\s\S]*?)(?:\n##\s|\n*$)/im);
  const body = section ? section[1] : readmeText;
  const m = body.match(/\[([A-Za-z0-9.\-+ ]+)\]\([^)]*LICEN[CS]E[^)]*\)/i);
  return m ? m[1].trim() : undefined;
}

/**
 * THE GATE ITSELF (design clauses (i), (ii), (v)), pure over its arguments so it is directly
 * exercised against fabricated fixtures (proving the mechanism in isolation) and against the real
 * tree's own reads (proving today's repo passes), without duplicating logic between the two.
 * Fails when any of the three declarations disagrees with EXPECTED_LICENCE, or when a derived
 * root licence-bearing file has no declared, reasoned entry — and names EVERY divergence found,
 * not just the first, citing the record the commitment comes from.
 */
function checkLicenceBoundary(input: {
  licenceFiles: readonly string[];
  declaredLicenceFiles: Readonly<Record<string, string>>;
  licenceText: string;
  packageLicence: string | undefined;
  readmeClaim: string | undefined;
}): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];

  const licenceIdentity = identifyLicenceText(input.licenceText);
  if (licenceIdentity !== EXPECTED_LICENCE) {
    reasons.push(`LICENSE's own text identifies as "${licenceIdentity}", not "${EXPECTED_LICENCE}"`);
  }
  if (input.packageLicence !== EXPECTED_LICENCE) {
    reasons.push(
      `package.json's "license" field is ${JSON.stringify(input.packageLicence)}, not "${EXPECTED_LICENCE}"`,
    );
  }
  if (input.readmeClaim !== EXPECTED_LICENCE) {
    reasons.push(`README's License section names ${JSON.stringify(input.readmeClaim)}, not "${EXPECTED_LICENCE}"`);
  }
  for (const f of input.licenceFiles) {
    if (!(f in input.declaredLicenceFiles)) {
      reasons.push(`${f} is a licence-bearing file at the repo root with no declared, reasoned entry`);
    }
  }

  if (reasons.length > 0) {
    reasons.push(
      "the core licence boundary (DECISIONS.md 2026-08-11 entry, MASTER-PLAN §6A: Apache-2.0, " +
        "a one-way door accepted knowingly) requires LICENSE, package.json and README to agree — see W1-T439",
    );
  }

  return { ok: reasons.length === 0, reasons };
}

// ── acceptance claim 1: a wholesale move away from Apache-2.0 fails, naming the disagreement ──

test("checkLicenceBoundary: LICENSE's identity moving away from Apache-2.0 fails and names it, leaving the still-Apache-2.0 declarations unmentioned", () => {
  const fslText = "Functional Source License, Version 1.1\n\nAbbreviation: FSL-1.1\n\nNotice\n";
  const result = checkLicenceBoundary({
    licenceFiles: ["LICENSE"],
    declaredLicenceFiles: DECLARED_LICENCE_FILES,
    licenceText: fslText,
    packageLicence: EXPECTED_LICENCE,
    readmeClaim: EXPECTED_LICENCE,
  });
  assert.equal(result.ok, false);
  assert.ok(
    result.reasons.some((r) => r.includes("LICENSE's own text identifies as") && r.includes("Functional Source License")),
    `expected a reason naming the LICENSE divergence, got: ${JSON.stringify(result.reasons)}`,
  );
  assert.ok(
    !result.reasons.some((r) => r.startsWith('package.json\'s "license" field')),
    "package.json still agrees, so it must not be reported as diverged",
  );
  assert.ok(
    !result.reasons.some((r) => r.startsWith("README's License section")),
    "README still agrees, so it must not be reported as diverged",
  );
});

// ── acceptance claim 2: a PARTIAL change (one declaration moves, others stale) fails too ───────

test("checkLicenceBoundary: package.json alone moving away from Apache-2.0 fails, even though LICENSE and README still agree", () => {
  const apacheText = "Apache License\nVersion 2.0, January 2004\nhttp://www.apache.org/licenses/\n";
  const result = checkLicenceBoundary({
    licenceFiles: ["LICENSE"],
    declaredLicenceFiles: DECLARED_LICENCE_FILES,
    licenceText: apacheText,
    packageLicence: "SEE LICENSE IN LICENSE-APACHE-2.0",
    readmeClaim: EXPECTED_LICENCE,
  });
  assert.equal(result.ok, false);
  assert.ok(
    result.reasons.some((r) => r.includes('package.json\'s "license" field is "SEE LICENSE IN LICENSE-APACHE-2.0"')),
    `expected a reason naming the package.json divergence, got: ${JSON.stringify(result.reasons)}`,
  );
  assert.ok(
    !result.reasons.some((r) => r.startsWith("LICENSE's own text")),
    "LICENSE still agrees, so it must not be reported as diverged",
  );
});

test("checkLicenceBoundary: README alone going stale (still claiming Apache-2.0 after the other two silently moved) is caught as two separate divergences, not silently averaged away", () => {
  const fslText = "Functional Source License, Version 1.1\n\nAbbreviation: FSL-1.1\n";
  const result = checkLicenceBoundary({
    licenceFiles: ["LICENSE"],
    declaredLicenceFiles: DECLARED_LICENCE_FILES,
    licenceText: fslText,
    packageLicence: "FSL-1.1",
    readmeClaim: EXPECTED_LICENCE,
  });
  assert.equal(result.ok, false);
  assert.equal(
    result.reasons.filter((r) => r.includes("LICENSE's own text") || r.includes('package.json\'s "license" field')).length,
    2,
    "both the moved declarations must be named individually",
  );
  assert.ok(
    !result.reasons.some((r) => r.startsWith("README's License section")),
    "README (stale, still Apache-2.0) is not itself the divergent one — it is what the other two should have matched",
  );
});

// ── acceptance claim 3: an undeclared second licence-bearing file fails completeness ───────────

test("checkLicenceBoundary: an undeclared second root licence file fails completeness, even when all three declarations still agree on Apache-2.0", () => {
  const apacheText = "Apache License\nVersion 2.0, January 2004\nhttp://www.apache.org/licenses/\n";
  const result = checkLicenceBoundary({
    licenceFiles: ["LICENSE", "LICENSE-APACHE-2.0"],
    declaredLicenceFiles: DECLARED_LICENCE_FILES,
    licenceText: apacheText,
    packageLicence: EXPECTED_LICENCE,
    readmeClaim: EXPECTED_LICENCE,
  });
  assert.equal(result.ok, false);
  assert.ok(
    result.reasons.some((r) => r.startsWith("LICENSE-APACHE-2.0 is a licence-bearing file")),
    `expected the undeclared file to be named, got: ${JSON.stringify(result.reasons)}`,
  );
  assert.ok(
    !result.reasons.some((r) => r.startsWith("LICENSE is a licence-bearing file")),
    "the DECLARED file must never itself be reported as undeclared",
  );
});

test("deriveRootLicenceFiles: a tracked root file named LICENSE-APACHE-2.0 is derived as licence-bearing (the exact shape the reverted revision added)", () => {
  const derived = deriveRootLicenceFiles(["LICENSE", "LICENSE-APACHE-2.0", "README.md", "package.json"]);
  assert.deepEqual(derived, ["LICENSE", "LICENSE-APACHE-2.0"]);
});

// ── acceptance claim 4: the repository as it stands today passes — not red on arrival ──────────

test("licence boundary: the repository as it stands today agrees across LICENSE, package.json and README, and has no undeclared licence-bearing file", () => {
  const trackedRootFiles = git(["ls-files"])
    .split("\n")
    .filter(Boolean)
    .filter((f) => !f.includes("/"));
  assert.ok(trackedRootFiles.includes("LICENSE"), "sanity: LICENSE is actually tracked at the repo root");

  const licenceFiles = deriveRootLicenceFiles(trackedRootFiles);
  const licenceText = readFileSync(join(REPO_ROOT, "LICENSE"), "utf8");
  const packageLicence = readPackageLicence(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));
  const readmeClaim = readReadmeLicenceClaim(readFileSync(join(REPO_ROOT, "README.md"), "utf8"));

  const result = checkLicenceBoundary({
    licenceFiles,
    declaredLicenceFiles: DECLARED_LICENCE_FILES,
    licenceText,
    packageLicence,
    readmeClaim,
  });

  assert.deepEqual(result.reasons, []);
  assert.equal(result.ok, true);
});
