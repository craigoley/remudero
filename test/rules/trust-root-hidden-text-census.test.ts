import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { isTrustRootPath, renderHiddenTextFinding, scanTrustRootText, TRUST_ROOT_DIRS, TRUST_ROOT_FILES } from "#src/lib/trust-root-text.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

// @source-text-subject: this census asserts over what the trust-root files say, character by character.
// @census-reads: CLAUDE.md AGENTS.md MASTER-PLAN.md DECISIONS.md LEARNINGS.md doctrine/ learnings/ .claude/ hooks/ plan/ — every file that instructs an agent.

function trustRootFiles(): string[] {
  const tracked = execFileSync("git", ["ls-files", "-z", "--", ...TRUST_ROOT_FILES, ...TRUST_ROOT_DIRS], { cwd: REPO_ROOT, encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024 }).split("\0").filter(Boolean);
  return tracked.filter(isTrustRootPath).sort();
}

test("no trust-root file holds a hidden character or a mixed-script word", () => {
  const files = trustRootFiles();
  // COVERAGE CONTROL: every family the trust root names was opened, and the excluded one was not.
  for (const family of [/^CLAUDE\.md$/, /^doctrine\/.+\.md$/, /^learnings\/.+\.ya?ml$/, /^\.claude\/skills\/[^/]+\/SKILL\.md$/,
    /^plan\/tasks\.d\/.+\.yaml$/, /^plan\/policy\.yaml$/, /^hooks\/deny-floor\.sh$/]) {
    assert.ok(files.some((path) => family.test(path)), `the census opened no file matching ${family}`);
  }
  assert.equal(files.some((path) => path.startsWith("plan/feedback/")), false, "plan/feedback/ is external input, not instructions");

  // POSITIVE CONTROL: the same scan over a real trust-root file with one planted character finds exactly it.
  const claude = readFileSync(join(REPO_ROOT, "CLAUDE.md"), "utf8");
  const planted = scanTrustRootText("CLAUDE.md", claude.replace("\n", "​\n"));
  assert.deepEqual(planted.map((f) => [f.line, f.detail]), [[1, "U+200B ZERO WIDTH SPACE"]]);

  const findings = files.flatMap((path) => scanTrustRootText(path, readFileSync(join(REPO_ROOT, path), "utf8")));
  assert.deepEqual(findings.map(renderHiddenTextFinding), [],
    `${findings.length} hidden character(s) or mixed-script word(s) in files that instruct an agent:\n` +
    findings.map(renderHiddenTextFinding).join("\n"));
});
