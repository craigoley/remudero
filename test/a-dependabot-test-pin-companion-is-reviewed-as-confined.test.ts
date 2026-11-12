import assert from "node:assert/strict";
import { test } from "node:test";
import { decideDepReview, type DepReviewCheck } from "#src/lib/dep-review.js";

// Recorded from Dependabot PR #17928 (head 4692356055ea748026d13c0f98fc12e3d6f75193), 2026-11-11.
// The body keeps Dependabot's summary lines and drops the release notes.
const OLD_SHA = "9b3254085494b55a0f7c4c2b3d2d52cc712ce370";
const NEW_SHA = "33d7b85da1a04171e211befe2c739303b9a4c066";
const TITLE = "chore(deps): bump the actions-minor-and-patch group with 3 updates";
const BODY = [
  "Bumps the actions-minor-and-patch group with 3 updates: [github/codeql-action/init](https://github.com/github/codeql-action), " +
    "[github/codeql-action/analyze](https://github.com/github/codeql-action) and " +
    "[github/codeql-action/upload-sarif](https://github.com/github/codeql-action).",
  "",
  "Updates `github/codeql-action/init` from 4.39.1 to 4.39.3",
  "Updates `github/codeql-action/analyze` from 4.39.1 to 4.39.3",
  "Updates `github/codeql-action/upload-sarif` from 4.39.1 to 4.39.3",
].join("\n");
const WORKFLOW_DIFF = `diff --git a/.github/workflows/codeql.yml b/.github/workflows/codeql.yml
index a8c7d06c8a..2e2327e8f7 100644
--- a/.github/workflows/codeql.yml
+++ b/.github/workflows/codeql.yml
@@ -73,7 +73,7 @@ jobs:
         uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
 
       - name: Initialize CodeQL
-        uses: github/codeql-action/init@${OLD_SHA} # v4.39.1
+        uses: github/codeql-action/init@${NEW_SHA} # v4.39.3
         with:
           languages: \${{ matrix.language }}
           build-mode: \${{ matrix.build-mode }}
@@ -83,7 +83,7 @@ jobs:
 
       - name: Perform CodeQL Analysis
         id: analyze
-        uses: github/codeql-action/analyze@${OLD_SHA} # v4.39.1
+        uses: github/codeql-action/analyze@${NEW_SHA} # v4.39.3
         with:
           category: "/language:\${{ matrix.language }}"
 
diff --git a/.github/workflows/scorecard.yml b/.github/workflows/scorecard.yml
index 0db5151058..7eb0164e14 100644
--- a/.github/workflows/scorecard.yml
+++ b/.github/workflows/scorecard.yml
@@ -48,6 +48,6 @@ jobs:
           retention-days: 5
 
       - name: Upload to code-scanning
-        uses: github/codeql-action/upload-sarif@${OLD_SHA} # v4.39.1
+        uses: github/codeql-action/upload-sarif@${NEW_SHA} # v4.39.3
         with:
           sarif_file: results.sarif
diff --git a/.github/workflows/semgrep.yml b/.github/workflows/semgrep.yml
index afc2ffd140..09ab2bc9cb 100644
--- a/.github/workflows/semgrep.yml
+++ b/.github/workflows/semgrep.yml
@@ -117,7 +117,7 @@ jobs:
             --receipt "$RUNNER_TEMP/semgrep-scan-inventory.json"
 
       - name: Upload SARIF to code scanning
-        uses: github/codeql-action/upload-sarif@${OLD_SHA} # v4.39.1
+        uses: github/codeql-action/upload-sarif@${NEW_SHA} # v4.39.3
         if: always()
         with:
           sarif_file: semgrep.sarif
`;
const TEST_FILE = "test/semgrep-native-install.test.ts";
const testSection = (removed: string, added: string, header = "") => `diff --git a/${TEST_FILE} b/${TEST_FILE}
${header}index e134164257..2d5ab16d43 100644
--- a/${TEST_FILE}
+++ b/${TEST_FILE}
@@ -135,7 +135,7 @@ test("native Semgrep retains all four rule packs, PR-only baseline and SARIF upl
   assert.match(scan.run!, /--sarif --output semgrep\\.sarif/);
   const upload = step("Upload SARIF to code scanning");
${removed}
${added}
   assert.equal(upload.if, "always()");
`;
const PIN_LINE = (sha: string) => `  assert.equal(upload.uses, "github/codeql-action/upload-sarif@${sha}");`;
const PR17928_DIFF = WORKFLOW_DIFF + testSection(`-${PIN_LINE(OLD_SHA)}`, `+${PIN_LINE(NEW_SHA)}`);
const DEPENDABOT = { login: "app/dependabot" };
const GREEN: DepReviewCheck[] = [{ name: "ci-gate", conclusion: "SUCCESS" }];
const decide = (diff: string, title = TITLE, body = BODY) => decideDepReview({ author: DEPENDABOT, title, body, diff, checks: GREEN });

test("W1-T12369: a #17928-shaped bump with its test pin edit arms and names the pin", () => {
  const r = decide(PR17928_DIFF);
  assert.equal(r.decision, "arm");
  assert.equal(r.semverLevel, "patch");
  assert.deepEqual(r.offendingFiles, []);
  assert.deepEqual(r.acceptedPinFiles, [
    { file: TEST_FILE, pins: [{ dependency: "github/codeql-action/upload-sarif", from: OLD_SHA, to: NEW_SHA }] },
  ]);
  assert.match(r.reason, /test pin edit accepted: test\/semgrep-native-install\.test\.ts/);
  // Without the test edit the bump is confined, as before, and names no accepted file.
  assert.equal(decide(WORKFLOW_DIFF).acceptedPinFiles, undefined);
});

test("W1-T12369: any other edit in the test file is still refused", () => {
  const plantedAssertion = "assert." + "ok(true);";
  const variants = [
    // The pin moves and something else on the same line changes.
    WORKFLOW_DIFF + testSection(`-${PIN_LINE(OLD_SHA)}`, `+${PIN_LINE(NEW_SHA)} // moved`),
    // The pin moves and one more line changes in the same run.
    WORKFLOW_DIFF + testSection(`-${PIN_LINE(OLD_SHA)}\n-  const x = 1;`, `+${PIN_LINE(NEW_SHA)}\n+  const x = 2;`),
    // A line is added with no removed partner.
    WORKFLOW_DIFF + testSection(`-${PIN_LINE(OLD_SHA)}`, `+${PIN_LINE(NEW_SHA)}\n+  ${plantedAssertion}`),
    // A second hunk changes an assertion with no pin in it.
    PR17928_DIFF + `@@ -200,1 +200,1 @@\n-  assert.equal(a, 1);\n+  assert.equal(a, 2);\n`,
    // A pure deletion of the pin assertion.
    WORKFLOW_DIFF + testSection(`-${PIN_LINE(OLD_SHA)}`, "").replace(`${PIN_LINE(OLD_SHA)}\n\n`, `${PIN_LINE(OLD_SHA)}\n`),
  ];
  for (const diff of variants) {
    const r = decide(diff);
    assert.equal(r.decision, "refuse", diff.slice(-200));
    assert.deepEqual(r.offendingFiles, [TEST_FILE]);
    assert.equal(r.acceptedPinFiles, undefined);
    assert.doesNotMatch(r.reason, /test pin edit accepted/);
    // The workflow half of each variant is the same bump that arms with its pin edit alone, so the
    // refusal is caused by the extra test edit and by nothing else.
    assert.equal(decide(WORKFLOW_DIFF).decision, "arm");
  }
  // The pure deletion variant really removes the pin assertion and adds nothing in the test file.
  const deletion = variants[variants.length - 1]!;
  const testHalf = deletion.slice(deletion.indexOf(`diff --git a/${TEST_FILE}`));
  assert.equal(testHalf.split("\n").filter((l) => l.startsWith("-") && !l.startsWith("---")).length, 1);
  assert.equal(testHalf.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++")).length, 0);
});

test("W1-T12369: a pin the bump does not change is still refused", () => {
  const otherSha = "c".repeat(40);
  const variants = [
    // The test moves a SHA the bump never mentions.
    WORKFLOW_DIFF + testSection(`-${PIN_LINE(otherSha)}`, `+${PIN_LINE(NEW_SHA)}`),
    // The test moves the old SHA to a value other than the new one.
    WORKFLOW_DIFF + testSection(`-${PIN_LINE(OLD_SHA)}`, `+${PIN_LINE(otherSha)}`),
    // A version string for a dependency the bump does not name.
    WORKFLOW_DIFF + testSection(`-  assert.equal(pkg.version, "other-lib@4.39.1");`, `+  assert.equal(pkg.version, "other-lib@4.39.3");`),
    // A longer version that only contains the bumped one.
    WORKFLOW_DIFF + testSection(`-  assert.equal(v, "github/codeql-action/init 14.39.1");`, `+  assert.equal(v, "github/codeql-action/init 14.39.3");`),
  ];
  for (const diff of variants) {
    const r = decide(diff);
    assert.equal(r.decision, "refuse");
    assert.deepEqual(r.offendingFiles, [TEST_FILE]);
  }
  // The version a bump moves is accepted when the line names that dependency.
  const version = decide(WORKFLOW_DIFF + testSection(
    `-  assert.equal(v, "github/codeql-action/init v4.39.1");`, `+  assert.equal(v, "github/codeql-action/init v4.39.3");`));
  assert.equal(version.decision, "arm");
  assert.deepEqual(version.acceptedPinFiles?.[0]?.pins, [{ dependency: "github/codeql-action/init", from: "4.39.1", to: "4.39.3" }]);
});

test("W1-T12369: a pin edit outside test/ or a test file add or delete is still refused", () => {
  const source = PR17928_DIFF.replaceAll(TEST_FILE, "src/lib/semgrep-pin.ts");
  assert.equal(decide(source).decision, "refuse");
  assert.deepEqual(decide(source).offendingFiles, ["src/lib/semgrep-pin.ts"]);
  for (const header of ["new file mode 100644\n", "deleted file mode 100644\n", "old mode 100644\nnew mode 100755\n"]) {
    const r = decide(WORKFLOW_DIFF + testSection(`-${PIN_LINE(OLD_SHA)}`, `+${PIN_LINE(NEW_SHA)}`, header));
    assert.equal(r.decision, "refuse", header);
    assert.deepEqual(r.offendingFiles, [TEST_FILE]);
  }
  const binary = WORKFLOW_DIFF + `diff --git a/${TEST_FILE} b/${TEST_FILE}\nindex e134164257..2d5ab16d43 100644\nBinary files a/${TEST_FILE} and b/${TEST_FILE} differ\n`;
  assert.equal(decide(binary).decision, "refuse");
  const renamed = WORKFLOW_DIFF + `diff --git a/${TEST_FILE} b/test/renamed.test.ts\nsimilarity index 100%\nrename from ${TEST_FILE}\nrename to test/renamed.test.ts\n`;
  assert.equal(decide(renamed).decision, "refuse");
});

test("W1-T12369: a major or unparseable bump with a test pin edit is still refused", () => {
  const majorBody = BODY.replaceAll("from 4.39.1 to 4.39.3", "from 4.39.1 to 5.0.0");
  const major = decide(PR17928_DIFF, TITLE, majorBody);
  assert.equal(major.semverLevel, "major");
  assert.equal(major.decision, "refuse");
  assert.deepEqual(major.offendingFiles, [TEST_FILE]);
  const unknown = decide(PR17928_DIFF, "chore(deps): bump the actions group", "Bumps the actions group.");
  assert.equal(unknown.semverLevel, "unknown");
  assert.equal(unknown.decision, "refuse");
  assert.deepEqual(unknown.offendingFiles, [TEST_FILE]);
  const human = decideDepReview({ author: { login: "cao825" }, title: TITLE, body: BODY, diff: PR17928_DIFF, checks: GREEN });
  assert.equal(human.decision, "refuse");
  assert.deepEqual(human.offendingFiles, [TEST_FILE]);
});
