import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { checkCommitMessage, CONVENTIONAL_LIMITS } from "../src/lib/commit-message.js";
import {
  fitDependabotTitle, GROUP_BUMP_RE, isActionShaPinOnlyProposal, overallSemverLevel, parseDependabotBumpFacts, reconcileDependabotTitle, SINGLE_BUMP_RE, TITLE_CLAUSE_RE,
} from "../src/lib/dep-review.js";

// #11968's title as Dependabot wrote it (and restored it on 2026-10-16T16:44:30Z), 162 characters.
const PR11968_TITLE = "chore(deps): bump google/osv-scanner-action/.github/workflows/osv-scanner-reusable.yml from 2.6.0 to 2.7.0 " +
  "in the actions-minor-and-patch group across 1 directory";
const PR11968_BODY = [
  "Bumps the actions-minor-and-patch group with 1 update in the / directory: " +
    "[google/osv-scanner-action/.github/workflows/osv-scanner-reusable.yml](https://github.com/google/osv-scanner-action).",
  "",
  "Updates `google/osv-scanner-action/.github/workflows/osv-scanner-reusable.yml` from 2.6.0 to 2.7.0",
  "- [Release notes](https://github.com/google/osv-scanner-action/releases)",
].join("\n");
const LONG_NAME = `@scope/${"a".repeat(80)}`;
const UNFITTABLE_TITLE = `chore(deps): bump ${LONG_NAME} from 1.2.3 to 1.2.4 in /`;

test("a full-SHA Dependabot title is fitted only while its body retains exact pin evidence", async (t) => {
  const from = "8ac9e5ce44cc7178e0e04229a91bdcc003166e57";
  const to = "9a96bc4d2b09685b6142bcfe25a3dc17cb2d7347";
  for (const action of ["google/osv-scanner-action/osv-scanner-action", "google/osv-scanner-action/osv-reporter-action"]) {
    const title = `chore(deps): bump ${action} from ${from} to ${to}`;
    const body = `Bumps [${action}](https://github.com/google/osv-scanner-action) from ${from} to ${to}.`;
    const diff = `diff --git a/.github/workflows/scan.yml b/.github/workflows/scan.yml\n--- a/.github/workflows/scan.yml\n+++ b/.github/workflows/scan.yml\n@@ -1 +1 @@\n-        uses: ${action}@${from} # v2.0.0\n+        uses: ${action}@${to} # v2.0.0\n`;
    const fit = fitDependabotTitle(title, body);
    assert.equal(fit.kind, "fitted");
    if (fit.kind !== "fitted") throw new Error("expected fitted title");
    assert.deepEqual(checkCommitMessage(fit.title), []);
    assert.equal(fit.title, `chore(deps): bump ${action} to ${to.slice(0, 12)}`);
    assert.equal(isActionShaPinOnlyProposal(title, body, diff), true);
    assert.equal(isActionShaPinOnlyProposal(fit.title, body, diff), true, "the exact diff still requires the full body pins");
    assert.equal(isActionShaPinOnlyProposal(fit.title, body.replace(to, "f".repeat(40)), diff), false);
    for (const missing of ["", body.replace(from, "f".repeat(40)), body.replace(to, "f".repeat(40)), body.replace(action, "other/action")]) {
      assert.equal(fitDependabotTitle(title, missing).kind, "unfittable");
    }
    const f = lane(t, title, body);
    assert.equal(await f.run(), "retitled");
    assert.deepEqual(f.writes, [fit.title]);
    assert.equal(await f.run(), "fits");
    assert.equal(f.writes.length, 1);
  }
  const action = "owner/" + "long-action/".repeat(10) + "scanner";
  assert.equal(fitDependabotTitle(`chore(deps): bump ${action} from ${from} to ${to}`,
    `Bumps ${action} from ${from} to ${to}`).kind, "unfittable");
});

test("W1-T9828: an over-long Dependabot title is fitted keeping its dependency and versions", () => {
  assert.ok(PR11968_TITLE.length > CONVENTIONAL_LIMITS.headerMaxLength, "the recorded fixture is the real over-long title");
  const fit = fitDependabotTitle(PR11968_TITLE, PR11968_BODY);
  assert.equal(fit.kind, "fitted");
  const title = (fit as { title: string }).title;
  assert.equal(title, "chore(deps): bump google/osv-scanner-action/…/osv-scanner-reusable.yml from 2.6.0 to 2.7.0");
  assert.ok(title.length <= CONVENTIONAL_LIMITS.headerMaxLength);
  assert.ok(title.startsWith("chore(deps): "), "the type(scope) is kept byte-for-byte");
  assert.deepEqual(checkCommitMessage(title), [], "the fitted title passes every checked commitlint rule");

  // A directory clause outlives the group clauses and is dropped only when nothing else fits.
  const dir = `ci(deps): bump actions/checkout from 4.1.1 to 4.2.0 in /deploy in the ${"g".repeat(40)} group across 2 directories`;
  assert.deepEqual(fitDependabotTitle(dir, ""), { kind: "fitted", title: "ci(deps): bump actions/checkout from 4.1.1 to 4.2.0 in /deploy" });
  const grouped = `chore(deps): bump the ${"g".repeat(45)} group in /deploy across 2 directories with 3 updates`;
  assert.deepEqual(fitDependabotTitle(grouped, ""), { kind: "fitted", title: `chore(deps): bump the ${"g".repeat(45)} group in /deploy with 3 updates` });
  assert.deepEqual(fitDependabotTitle("chore(deps): bump actions/checkout from 4.1.1 to 4.2.0", ""), { kind: "fits" });
});

test("W1-T9828: a fitted Dependabot title parses to the same bump facts as the original", () => {
  const fit = fitDependabotTitle(PR11968_TITLE, PR11968_BODY);
  assert.equal(fit.kind, "fitted");
  const title = (fit as { title: string }).title;
  const original = parseDependabotBumpFacts(PR11968_TITLE, PR11968_BODY);
  assert.equal(original.length, 1);
  assert.deepEqual(parseDependabotBumpFacts(title, PR11968_BODY), original, "the elided title fact folds into the body fact");
  assert.equal(original[0].dependency, "google/osv-scanner-action/.github/workflows/osv-scanner-reusable.yml");
  assert.equal(overallSemverLevel(title, PR11968_BODY), overallSemverLevel(PR11968_TITLE, PR11968_BODY));
  assert.equal(overallSemverLevel(title, PR11968_BODY), "minor");
  // With no body fact to fold into, the elided name would be a second identity, so the fit is refused.
  assert.equal(fitDependabotTitle(PR11968_TITLE, "").kind, "unfittable");
  // An elided name never folds into a dependency whose ends differ.
  assert.equal(parseDependabotBumpFacts("chore(deps): bump google/osv-scanner-action/…/other.yml from 2.6.0 to 2.7.0", PR11968_BODY).length, 2);
});

test("W1-T9828: the title grammar regexes match Dependabot's shapes and nothing else", () => {
  assert.equal(SINGLE_BUMP_RE.test("bump actions/checkout from 4.1.1 to v4.2.0 in /"), true);
  assert.equal(SINGLE_BUMP_RE.test("bump the actions group across 1 directory"), false, "a group title is not a single bump");
  assert.equal(GROUP_BUMP_RE.test("bump the actions-minor-and-patch group with 3 updates"), true);
  assert.equal(GROUP_BUMP_RE.test("bump actions/checkout from 4.1.1 to 4.2.0"), false);
  const clause = (text: string) => { TITLE_CLAUSE_RE.lastIndex = 0; return TITLE_CLAUSE_RE.test(text); };
  assert.equal(clause(" in the npm group"), true);
  assert.equal(clause(" across 2 directories"), true);
  assert.equal(clause(" in /deploy"), true);
  assert.equal(clause(" for the release train"), false, "an unknown clause is not Dependabot's grammar");
});

test("W1-T9828: an unfittable Dependabot title is refused, never truncated", async (t) => {
  const fit = fitDependabotTitle(UNFITTABLE_TITLE, "");
  assert.equal(fit.kind, "unfittable");
  assert.match((fit as { reason: string }).reason, /exceed 100 characters/);
  assert.ok(!("title" in fit), "no cut-down title is ever offered");
  assert.deepEqual(fitDependabotTitle("chore(deps): something else entirely ".repeat(4), ""),
    { kind: "unfittable", reason: "the title is not Dependabot's bump grammar" });

  const f = lane(t, UNFITTABLE_TITLE, "");
  assert.equal(await f.run(), "refused");
  assert.equal(await f.run(), "refused");
  assert.deepEqual(f.writes, [], "an unfittable title is never written");
  const refused = f.rows.filter((r) => r.step === "dep-review.retitle_refused");
  assert.equal(refused.length, 1, "refused once per head and title");
  assert.equal(refused[0].old_title, UNFITTABLE_TITLE);
});

test("W1-T9828: dep-review retitles an over-long Dependabot PR and ledgers both titles", async (t) => {
  const f = lane(t, PR11968_TITLE, PR11968_BODY);
  assert.equal(await f.run(), "retitled");
  assert.deepEqual(f.writes, [FITTED]);
  assert.deepEqual(f.rows, [{ step: "dep-review.retitled", pr_number: 11968, head_sha: "f".repeat(40), old_title: PR11968_TITLE, new_title: FITTED }]);
  assert.equal(await f.run(), "fits", "a fitting title is not written");
  assert.deepEqual(f.writes, [FITTED]);
});

test("W1-T9828: a failed title write is ledgered with its candidate", async (t) => {
  const f = lane(t, PR11968_TITLE, PR11968_BODY, () => { throw new Error("HTTP 502"); });
  assert.equal(await f.run(), "failed");
  assert.deepEqual(f.rows, [{ step: "dep-review.retitle_failed", pr_number: 11968, head_sha: "f".repeat(40),
    old_title: PR11968_TITLE, candidate: FITTED, error: "HTTP 502" }]);
});

const FITTED = "chore(deps): bump google/osv-scanner-action/…/osv-scanner-reusable.yml from 2.6.0 to 2.7.0";

function lane(t: { after(fn: () => void): void }, title: string, body: string, write?: () => void) {
  const root = mkdtempSync(join(tmpdir(), "rmd-dep-retitle-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const view = { title };
  const writes: string[] = [];
  const rows: Array<Record<string, unknown>> = [];
  return {
    writes, rows,
    run: () => reconcileDependabotTitle({
      statePath: join(root, "holds", "PR11968.json"), prNumber: 11968, headSha: "f".repeat(40), title: view.title, body,
      retitle: async (next) => { write?.(); writes.push(next); view.title = next; },
      log: (step, extra) => { rows.push({ step, ...extra }); },
    }),
  };
}
