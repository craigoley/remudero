import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  DEPENDABOT_IGNORE_MAJOR_COMMAND,
  buildDepReviewEscalation,
  changedFilesInDiff,
  decideDepReview,
  depReviewMigrationSubmissionKey,
  isDependabotAuthor,
  isManifestPath,
  majorMigrationBumps,
  offendingFiles,
  overallSemverLevel,
  parseAnchoredVersionBumps,
  parseDependabotBumpFacts,
  parseVersionBumps,
  renderDepReviewMigrationFeedback,
  redChecks,
  type DepReviewCheck,
} from "../src/lib/dep-review.js";

// ── Recorded fixtures (acceptance #1, the FALSIFIER) ────────────────────────
// These are RECORDED, not invented: live Dependabot PRs #80 (patch, grouped) and
// #81 (major) on craigoley/remudero, captured via `gh pr view`/`gh pr diff`
// (2026-07-15). A synthetic non-dependabot author and a synthetic source-touching
// diff round out the REFUSE branch (no such PR exists to record — refusing one is
// the point).

// PR #80 — "build(deps): bump @anthropic-ai/claude-agent-sdk from 0.3.209 to
// 0.3.210 in the npm-minor-and-patch group" — a grouped PATCH bump (0.3.209->0.3.210
// changes only the third component; the "npm-minor-and-patch" GROUP name covers both
// minor and patch update-types, it does not mean every bump in it is minor).
const PR80_TITLE = "build(deps): bump @anthropic-ai/claude-agent-sdk from 0.3.209 to 0.3.210 in the npm-minor-and-patch group";
const PR80_BODY = `Bumps the npm-minor-and-patch group with 1 update: [@anthropic-ai/claude-agent-sdk](https://github.com/anthropics/claude-agent-sdk-typescript).

Updates \`@anthropic-ai/claude-agent-sdk\` from 0.3.209 to 0.3.210
<details>
<summary>Release notes</summary>
<p><em>Sourced from <a href="https://github.com/anthropics/claude-agent-sdk-typescript/releases">@​anthropic-ai/claude-agent-sdk's releases</a>.</em></p>
<blockquote>
<h2>v0.3.210</h2>
<h2>What's changed</h2>
<ul>
<li>Added <code>timedOutAfterMs</code> to <code>BashToolOutput</code>, set when a command is auto-backgrounded on timeout</li>
</ul>
</blockquote>
</details>`;
const PR80_DIFF = `diff --git a/package-lock.json b/package-lock.json
index 68e22fa..8daeb9c 100644
--- a/package-lock.json
+++ b/package-lock.json
@@ -9,7 +9,7 @@
       "version": "0.0.0-pre-alpha",
       "dependencies": {
-        "@anthropic-ai/claude-agent-sdk": "^0.3.209",
+        "@anthropic-ai/claude-agent-sdk": "^0.3.210",
diff --git a/package.json b/package.json
index 1234567..89abcde 100644
--- a/package.json
+++ b/package.json
@@ -20,7 +20,7 @@
   "dependencies": {
-    "@anthropic-ai/claude-agent-sdk": "^0.3.209",
+    "@anthropic-ai/claude-agent-sdk": "^0.3.210",
`;

// PR #81 — "build(deps-dev): bump @types/node from 22.20.1 to 26.1.1" — a MAJOR bump.
const PR81_TITLE = "build(deps-dev): bump @types/node from 22.20.1 to 26.1.1";
const PR81_BODY = `Bumps [@types/node](https://github.com/DefinitelyTyped/DefinitelyTyped/tree/HEAD/types/node) from 22.20.1 to 26.1.1.
<details>
<summary>Commits</summary>
<ul>
<li>See full diff in <a href="https://github.com/DefinitelyTyped/DefinitelyTyped/commits/HEAD/types/node">compare view</a></li>
</ul>
</details>`;
const PR81_DIFF = `diff --git a/package-lock.json b/package-lock.json
index 68e22fa..5061081 100644
--- a/package-lock.json
+++ b/package-lock.json
@@ -18,7 +18,7 @@
       "devDependencies": {
-        "@types/node": "^22.20.1"
+        "@types/node": "^26.1.1"
       },
diff --git a/package.json b/package.json
index 1234567..89abcde 100644
--- a/package.json
+++ b/package.json
@@ -20,7 +20,7 @@
   "devDependencies": {
-    "@types/node": "^22.20.1"
+    "@types/node": "^26.1.1"
`;

const GREEN_CHECKS: DepReviewCheck[] = [
  { name: "scan-pr", conclusion: "SKIPPED" }, // OSV-Scanner (PR): skips for dependabot[bot] (recon, PR #81)
  { name: "ci", conclusion: "SUCCESS" },
  { name: "Review", conclusion: "SUCCESS" }, // Dependency Review
];

// GraphQL (`gh pr view --json author`) reports Dependabot as `app/dependabot` —
// recon on live PRs #80/#81. The REST API instead reports `dependabot[bot]`;
// both must normalise to the same author.
const DEPENDABOT_GRAPHQL_AUTHOR = { login: "app/dependabot" };
const DEPENDABOT_REST_AUTHOR = { login: "dependabot[bot]" };

test("isDependabotAuthor: matches both the GraphQL (app/dependabot) and REST (dependabot[bot]) spellings", () => {
  assert.equal(isDependabotAuthor(DEPENDABOT_GRAPHQL_AUTHOR), true);
  assert.equal(isDependabotAuthor(DEPENDABOT_REST_AUTHOR), true);
  assert.equal(isDependabotAuthor({ login: "craigoley" }), false);
});

test("overallSemverLevel: PR #80's grouped title+body parses as patch", () => {
  assert.equal(overallSemverLevel(PR80_TITLE, PR80_BODY), "patch");
});

test("overallSemverLevel: PR #81's title+body parses as major", () => {
  assert.equal(overallSemverLevel(PR81_TITLE, PR81_BODY), "major");
});

test("overallSemverLevel: a grouped PR with ANY major constituent classifies the WHOLE group", () => {
  const groupedBody = "Updates `a` from 1.0.0 to 1.0.1\nUpdates `b` from 2.0.0 to 3.0.0\n";
  assert.equal(overallSemverLevel("Bump the group with 2 updates", groupedBody), "major");
});

test("overallSemverLevel: no parseable bump anywhere is unknown (fail closed)", () => {
  assert.equal(overallSemverLevel("chore: tidy up", "nothing to parse here"), "unknown");
});

test("parseVersionBumps: one pair per constituent, in title-order", () => {
  assert.deepEqual(parseVersionBumps("from 1.0.0 to 1.1.0, then from 1.1.0 to 2.0.0"), ["minor", "major"]);
});

test("isManifestPath / changedFilesInDiff / offendingFiles: PR #80/#81 diffs are fully confined to package.json + package-lock.json", () => {
  assert.deepEqual(changedFilesInDiff(PR80_DIFF), ["package-lock.json", "package.json"]);
  assert.ok(isManifestPath("package.json"));
  assert.ok(isManifestPath("package-lock.json"));
  assert.deepEqual(offendingFiles(PR80_DIFF), []);
  assert.deepEqual(offendingFiles(PR81_DIFF), []);
});

test("isManifestPath: a grouped actions bump touching a workflow file is confined; arbitrary source is not", () => {
  assert.ok(isManifestPath(".github/workflows/ci.yml"));
  assert.equal(isManifestPath("src/lib/dep-review.ts"), false);
});

// ── Regressions found in review (W1-T54): a DELETED or purely-RENAMED source
// file carries no `+++ b/<path>` header, so it must still be caught. ──────────

test("changedFilesInDiff: a DELETED source file (+++ /dev/null) is still named, via its --- a/<path> header", () => {
  const deleteDiff = `diff --git a/src/lib/old.ts b/src/lib/old.ts
deleted file mode 100644
--- a/src/lib/old.ts
+++ /dev/null
@@ -1,1 +0,0 @@
-export const x = 1;
`;
  assert.deepEqual(changedFilesInDiff(deleteDiff), ["src/lib/old.ts"]);
  assert.deepEqual(offendingFiles(deleteDiff), ["src/lib/old.ts"]);
});

test("changedFilesInDiff: a pure RENAME (no content change, no +++/--- lines) is still named, via rename from/to", () => {
  const renameDiff = `diff --git a/src/lib/old.ts b/src/lib/new.ts
similarity index 100%
rename from src/lib/old.ts
rename to src/lib/new.ts
`;
  assert.deepEqual(changedFilesInDiff(renameDiff).sort(), ["src/lib/new.ts", "src/lib/old.ts"]);
  assert.deepEqual(offendingFiles(renameDiff).sort(), ["src/lib/new.ts", "src/lib/old.ts"]);
});

test("redChecks: SKIPPED/SUCCESS are clean; a real failure conclusion is red", () => {
  assert.deepEqual(redChecks(GREEN_CHECKS), []);
  assert.deepEqual(redChecks([{ name: "ci", conclusion: "FAILURE" }]), ["ci"]);
});

// ── Regression (W1-T54 review): a legacy commit-STATUS entry (the shape
// remudero-review itself is posted in — the Statuses API, not the Checks API)
// reports its result on `state`, not `conclusion`. A re-run of this lane against
// a PR that already carries one must still catch a red `state`. ──────────────
test("redChecks: a legacy commit-status entry (context/state, no conclusion) is read via state", () => {
  assert.deepEqual(redChecks([{ context: "remudero-review", state: "failure".toUpperCase() }]), ["remudero-review"]);
  assert.deepEqual(redChecks([{ context: "remudero-review", state: "success" }]), []);
});

// ── The three branches (acceptance #1) ──────────────────────────────────────

test("decideDepReview: PR #80 (patch, grouped, confined, gates green) -> ARM", () => {
  const r = decideDepReview({
    author: DEPENDABOT_GRAPHQL_AUTHOR,
    title: PR80_TITLE,
    body: PR80_BODY,
    diff: PR80_DIFF,
    checks: GREEN_CHECKS,
  });
  assert.equal(r.decision, "arm");
  assert.equal(r.semverLevel, "patch");
  assert.deepEqual(r.offendingFiles, []);
  assert.deepEqual(r.redChecks, []);
});

test("decideDepReview: PR #81 (major, confined, gates green) -> MIGRATE, no auto-merge", () => {
  const r = decideDepReview({
    author: DEPENDABOT_REST_AUTHOR,
    title: PR81_TITLE,
    body: PR81_BODY,
    diff: PR81_DIFF,
    checks: GREEN_CHECKS,
  });
  assert.equal(r.decision, "migrate");
  assert.equal(r.semverLevel, "major");
  assert.deepEqual(r.migrationBumps.map((b) => [b.dependency, b.fromVersion, b.toVersion, b.targetMajor]), [
    ["@types/node", "22.20.1", "26.1.1", 26],
  ]);
  assert.match(r.reason, /MAJOR/);
});

test("decideDepReview: a dep PR whose diff touches SOURCE files outside manifests -> REFUSE (no review posted)", () => {
  const diffWithSource = PR80_DIFF + `diff --git a/src/lib/worker.ts b/src/lib/worker.ts
--- a/src/lib/worker.ts
+++ b/src/lib/worker.ts
@@ -1,1 +1,1 @@
-old
+new
`;
  const r = decideDepReview({
    author: DEPENDABOT_GRAPHQL_AUTHOR,
    title: PR80_TITLE,
    body: PR80_BODY,
    diff: diffWithSource,
    checks: GREEN_CHECKS,
  });
  assert.equal(r.decision, "refuse");
  assert.deepEqual(r.offendingFiles, ["src/lib/worker.ts"]);
  assert.match(r.reason, /outside the manifest\/lockfile allowlist/);
});

test("decideDepReview: a non-Dependabot author -> REFUSE, even over an otherwise-clean dependency-shaped diff", () => {
  const r = decideDepReview({
    author: { login: "craigoley" },
    title: PR80_TITLE,
    body: PR80_BODY,
    diff: PR80_DIFF,
    checks: GREEN_CHECKS,
  });
  assert.equal(r.decision, "refuse");
  assert.match(r.reason, /not dependabot\[bot\]/);
});

test("decideDepReview: an unparseable semver level is treated like a major -> ESCALATE (fail closed)", () => {
  const r = decideDepReview({
    author: DEPENDABOT_GRAPHQL_AUTHOR,
    title: "Bump something",
    body: "no version pairs in here",
    diff: PR80_DIFF,
    checks: GREEN_CHECKS,
  });
  assert.equal(r.decision, "escalate");
  assert.equal(r.semverLevel, "unknown");
});

test("decideDepReview: a parseable major proposal reaches MIGRATE even when required checks are red", () => {
  const r = decideDepReview({
    author: DEPENDABOT_GRAPHQL_AUTHOR,
    title: PR81_TITLE,
    body: PR81_BODY,
    diff: PR81_DIFF,
    checks: [{ name: "ci", conclusion: "FAILURE" }],
  });
  assert.equal(r.decision, "migrate");
  assert.deepEqual(r.redChecks, ["ci"]);
  assert.equal(r.migrationBumps[0].dependency, "@types/node");
});

test("decideDepReview: a confined, correctly-authored, patch-level PR with a RED required check -> HOLD (nothing posted, try later)", () => {
  const r = decideDepReview({
    author: DEPENDABOT_GRAPHQL_AUTHOR,
    title: PR80_TITLE,
    body: PR80_BODY,
    diff: PR80_DIFF,
    checks: [{ name: "ci", conclusion: "FAILURE" }],
  });
  assert.equal(r.decision, "hold");
  assert.deepEqual(r.redChecks, ["ci"]);
});

test("decideDepReview: a confined, correctly-authored, minor-level PR with a RED required check -> HOLD too", () => {
  const r = decideDepReview({
    author: DEPENDABOT_GRAPHQL_AUTHOR,
    title: "build(deps): bump left-pad from 1.2.3 to 1.3.0",
    body: "Bumps [left-pad](https://example.test/left-pad) from 1.2.3 to 1.3.0.",
    diff: PR80_DIFF,
    checks: [{ name: "ci", conclusion: "FAILURE" }],
  });
  assert.equal(r.decision, "hold");
  assert.equal(r.semverLevel, "minor");
});

test("decideDepReview: an unparseable proposal still ESCALATES even with red checks", () => {
  const r = decideDepReview({
    author: DEPENDABOT_GRAPHQL_AUTHOR,
    title: "Bump something",
    body: "no version pairs in here",
    diff: PR80_DIFF,
    checks: [{ name: "ci", conclusion: "FAILURE" }],
  });
  assert.equal(r.decision, "escalate");
  assert.equal(r.semverLevel, "unknown");
});

test("decideDepReview: refuse takes priority over gate-redness (author/diff are checked first — no gate-polling for a PR that is refused anyway)", () => {
  const r = decideDepReview({
    author: { login: "someone-else" },
    title: PR80_TITLE,
    body: PR80_BODY,
    diff: PR80_DIFF,
    checks: [{ name: "ci", conclusion: "FAILURE" }],
  });
  assert.equal(r.decision, "refuse");
});

// ── The MANUAL escalation (release notes travel with the issue) ────────────

test("buildDepReviewEscalation: class MANUAL, no-auto-merge language, and the PR body (release notes) travel into the issue detail", () => {
  const e = buildDepReviewEscalation({
    prUrl: "https://github.com/craigoley/remudero/pull/81",
    prNumber: 81,
    title: PR81_TITLE,
    body: PR81_BODY,
    semverLevel: "major",
  });
  assert.equal(e.class, "MANUAL");
  assert.match(e.detail, /26\.1\.1/);
  assert.match(e.detail, /NOT armed/);
  assert.ok(e.options.length >= 2, "escalate() refuses zero-option escalations — this must carry real choices");
  assert.match(e.options[0].detail, /never auto-merge/);
  assert.equal(e.recommendation, "merge");
});

// ── anchored parsing: embedded release-notes must never classify THIS PR (#533 false-major) ──

const PR533_SHAPE_BODY = [
  "Bumps the actions-minor-and-patch group with 4 updates.",
  "",
  "Updates `actions/checkout` from 7.0.0 to 7.0.1",
  "<details><summary>Commits</summary>",
  "<li>Bump docker/login-action from 3.3.0 to 4.2.0 (#2479)</li>",
  "<li>Bump docker/build-push-action from 6.5.0 to 7.2.0 (#2478)</li>",
  "</details>",
  "Updates `github/codeql-action/init` from 4.37.0 to 4.37.3",
  "Updates `github/codeql-action/analyze` from 4.37.0 to 4.37.3",
].join("\n");

test("overallSemverLevel: a grouped PATCH PR whose embedded changelogs quote OTHER projects' MAJOR bumps classifies patch, not major (the #533 false-major)", () => {
  assert.equal(overallSemverLevel("chore(deps): bump the actions-minor-and-patch group with 4 updates", PR533_SHAPE_BODY), "patch");
});

test("overallSemverLevel: a genuine MAJOR on Dependabot's own Updates line still escalates the whole group", () => {
  const body = PR533_SHAPE_BODY + "\nUpdates `left-pad` from 1.3.0 to 2.0.0";
  assert.equal(overallSemverLevel("chore(deps): bump the actions group with 5 updates", body), "major");
});

test("overallSemverLevel: a single-dependency 'Bumps [pkg] from X to Y' body line still parses (the non-grouped shape)", () => {
  assert.equal(overallSemverLevel("chore(deps): bump lodash from 4.17.20 to 4.17.21", "Bumps [lodash](https://github.com/lodash/lodash) from 4.17.20 to 4.17.21."), "patch");
});

test("parseAnchoredVersionBumps: prose-only from/to pairs yield NOTHING — mid-changelog quotes are somebody else's bumps", () => {
  assert.deepEqual(parseAnchoredVersionBumps("<li>Bump strip-ansi from 6.0.1 to 7.2.0</li>"), []);
});

test("parseDependabotBumpFacts: dependency facts come from the title and anchored summary lines only", () => {
  assert.deepEqual(parseDependabotBumpFacts(PR81_TITLE, PR81_BODY), [
    {
      dependency: "@types/node",
      fromVersion: "22.20.1",
      toVersion: "26.1.1",
      level: "major",
      targetMajor: 26,
    },
  ]);
  assert.deepEqual(majorMigrationBumps(PR81_TITLE, PR81_BODY).map((b) => `${b.dependency}@${b.targetMajor}`), [
    "@types/node@26",
  ]);
});

test("depReviewMigrationSubmissionKey: #81 and #3654 shapes converge on one dependency target-major key", () => {
  const pr81 = majorMigrationBumps(PR81_TITLE, PR81_BODY);
  const pr3654 = majorMigrationBumps(
    "build(deps-dev): bump @types/node from 22.20.1 to 26.4.0",
    "Bumps [@types/node](https://github.com/DefinitelyTyped/DefinitelyTyped/tree/HEAD/types/node) from 22.20.1 to 26.4.0.",
  );
  assert.equal(
    depReviewMigrationSubmissionKey("CraigOley", "Remudero", pr81),
    depReviewMigrationSubmissionKey("craigoley", "remudero", pr3654),
  );
});

test("renderDepReviewMigrationFeedback: raw evidence carries PR URL, versions, red checks and release notes", () => {
  const raw = renderDepReviewMigrationFeedback({
    prUrl: "https://github.com/craigoley/remudero/pull/3654",
    prNumber: 3654,
    title: "build(deps-dev): bump @types/node from 22.20.1 to 26.4.0",
    body: PR81_BODY,
    bumps: majorMigrationBumps(PR81_TITLE, PR81_BODY),
    redChecks: ["ci-shard 1"],
  });
  assert.match(raw, /pull\/3654/);
  assert.match(raw, /@types\/node 22\.20\.1 -> 26\.1\.1/);
  assert.match(raw, /ci-shard 1/);
  assert.match(raw, /Dependabot proposal body:/);
});

function readLedgerObjects(path: string): Array<Record<string, unknown>> {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

function migrationCaptureRecorder(events: string[], opts: { fail?: boolean } = {}) {
  const entries = new Map<string, Record<string, unknown>>();
  const calls: Array<{ id: string; raw: string; submissionKey: string }> = [];
  return {
    calls,
    capture(args: { id: string; raw: string; submissionKey: string }) {
      events.push("capture");
      calls.push(args);
      if (opts.fail) throw new Error("capture boom");
      const existing = entries.get(args.submissionKey);
      if (existing) return existing;
      const entry = {
        id: args.id,
        ts: "2026-09-07T00:00:00.000Z",
        raw: args.raw,
        attachments: [],
        origin: "repair#dep-review",
        status: "new",
        proposal_pr: null,
        submission_key: args.submissionKey,
      };
      entries.set(args.submissionKey, entry);
      return entry;
    },
  };
}

function mutationRecorder(
  events: string[],
  opts: { failComment?: boolean; failClose?: () => boolean } = {},
) {
  const comments: Array<{ prUrl: string; body: string }> = [];
  const closes: Array<{ prUrl: string; comment: string; deleteBranch: false }> = [];
  return {
    comments,
    closes,
    mutations: {
      comment(prUrl: string, body: string) {
        events.push("comment");
        comments.push({ prUrl, body });
        if (opts.failComment) throw new Error("comment boom");
      },
      close(prUrl: string, closeOpts: { comment: string; deleteBranch: false }) {
        events.push(`close:${closeOpts.deleteBranch}`);
        closes.push({ prUrl, comment: closeOpts.comment, deleteBranch: closeOpts.deleteBranch });
        if (opts.failClose?.()) throw new Error("close boom");
      },
    },
  };
}

async function driveMigrationDepReview(opts: {
  prNumber?: number;
  title?: string;
  body?: string;
  checks?: DepReviewCheck[];
  events?: string[];
  capture?: ReturnType<typeof migrationCaptureRecorder>;
  mutations?: ReturnType<typeof mutationRecorder>;
}) {
  const { depReviewCommand } = await import("../src/run-task.js");
  const tmp = mkdtempSync(join(tmpdir(), "rmd-t2705-depreview-"));
  const ledgerPath = join(tmp, "state", "ledger.ndjson");
  const events = opts.events ?? [];
  const capture = opts.capture ?? migrationCaptureRecorder(events);
  const mutations = opts.mutations ?? mutationRecorder(events);
  const statusCalls: string[] = [];
  const armCalls: string[] = [];
  const printed: string[] = [];
  const realLog = console.log;
  console.log = (...a: unknown[]) => void printed.push(a.map(String).join(" "));
  let code: number;
  try {
    code = await depReviewCommand(String(opts.prNumber ?? 3654), ["--repo", "remudero"], {
      config: { root: tmp, ledger: ledgerPath } as never,
      gh: () => ({
        number: opts.prNumber ?? 3654,
        url: `https://github.com/craigoley/remudero/pull/${opts.prNumber ?? 3654}`,
        title: opts.title ?? "build(deps-dev): bump @types/node from 22.20.1 to 26.4.0",
        body:
          opts.body ??
          "Bumps [@types/node](https://github.com/DefinitelyTyped/DefinitelyTyped/tree/HEAD/types/node) from 22.20.1 to 26.4.0.",
        headRefOid: "feedface1234",
        author: { login: "app/dependabot" },
        statusCheckRollup: opts.checks ?? [{ name: "ci-shard 1", conclusion: "FAILURE" }],
      }),
      prDiff: () => PR81_DIFF,
      postStatus: (async () => {
        statusCalls.push("called");
        return { posted: true };
      }) as never,
      arm: () => {
        armCalls.push("called");
        return "armed";
      },
      captureMigrationFeedback: capture.capture as never,
      prMutations: mutations.mutations,
      issues: { create: () => "https://github.com/craigoley/remudero/issues/999", ensureLabel: () => true } as never,
    });
  } finally {
    console.log = realLog;
  }
  return {
    code,
    events,
    capture,
    mutations,
    statusCalls,
    armCalls,
    printed,
    ledgerPath,
    ledger: readLedgerObjects(ledgerPath),
    tmp,
  };
}

test("depReviewCommand migrate: capture completes before exact Dependabot ignore and close, with no status or arm", async () => {
  const r = await driveMigrationDepReview({});
  assert.equal(r.code, 0);
  assert.deepEqual(r.events, ["capture", "comment", "close:false"]);
  assert.deepEqual(r.mutations.comments, [
    { prUrl: "https://github.com/craigoley/remudero/pull/3654", body: DEPENDABOT_IGNORE_MAJOR_COMMAND },
  ]);
  assert.equal(r.mutations.closes[0].deleteBranch, false);
  assert.deepEqual(r.statusCalls, []);
  assert.deepEqual(r.armCalls, []);
  assert.equal(r.ledger.some((l) => l.step === "review.posted"), false);
  assert.equal(r.ledger.some((l) => String(l.step).startsWith("automerge.")), false);
  assert.equal(r.ledger.some((l) => l.step === "dep-review.migrate.completed"), true);
  rmSync(r.tmp, { recursive: true, force: true });
});

test("depReviewCommand migrate: capture failure leaves the PR open with no outward mutation", async () => {
  const events: string[] = [];
  const r = await driveMigrationDepReview({
    events,
    capture: migrationCaptureRecorder(events, { fail: true }),
    mutations: mutationRecorder(events),
  });
  assert.equal(r.code, 1);
  assert.deepEqual(r.events, ["capture"]);
  assert.deepEqual(r.mutations.comments, []);
  assert.deepEqual(r.mutations.closes, []);
  assert.equal(r.ledger.some((l) => l.step === "dep-review.migrate.capture_failed"), true);
  assert.equal(r.ledger.some((l) => l.step === "dep-review.migrate.completed"), false);
  rmSync(r.tmp, { recursive: true, force: true });
});

test("depReviewCommand migrate: repeated target-major proposals reuse one feedback key while both PR observations are ledgered", async () => {
  const events: string[] = [];
  const capture = migrationCaptureRecorder(events);
  const mutations = mutationRecorder(events);
  const first = await driveMigrationDepReview({ prNumber: 81, title: PR81_TITLE, body: PR81_BODY, events, capture, mutations });
  const second = await driveMigrationDepReview({ prNumber: 3654, events, capture, mutations });
  const capturedIds = [...first.ledger, ...second.ledger]
    .filter((l) => l.step === "dep-review.migrate.feedback_captured")
    .map((l) => [l.pr_url, l.feedback_id, l.submission_key]);
  assert.deepEqual(
    capturedIds.map((r) => r[0]),
    ["https://github.com/craigoley/remudero/pull/81", "https://github.com/craigoley/remudero/pull/3654"],
  );
  assert.equal(capturedIds[0][1], capturedIds[1][1]);
  assert.equal(capturedIds[0][2], capturedIds[1][2]);
  assert.equal(capture.calls.length, 2, "both PR observations are submitted to the capture seam");
  assert.equal(new Set(capture.calls.map((c) => c.submissionKey)).size, 1, "but they share one durable key");
  rmSync(first.tmp, { recursive: true, force: true });
  rmSync(second.tmp, { recursive: true, force: true });
});

test("depReviewCommand migrate: failed comment or close is ledgered incomplete and a later pass retries", async () => {
  const commentEvents: string[] = [];
  const commentFailure = await driveMigrationDepReview({
    events: commentEvents,
    capture: migrationCaptureRecorder(commentEvents),
    mutations: mutationRecorder(commentEvents, { failComment: true }),
  });
  assert.equal(commentFailure.code, 1);
  assert.deepEqual(commentFailure.events, ["capture", "comment"]);
  assert.equal(commentFailure.ledger.some((l) => l.step === "dep-review.migrate.incomplete" && l.action === "comment"), true);
  assert.equal(commentFailure.ledger.some((l) => l.step === "dep-review.migrate.completed"), false);

  const closeEvents: string[] = [];
  let closeAttempts = 0;
  const capture = migrationCaptureRecorder(closeEvents);
  const mutations = mutationRecorder(closeEvents, {
    failClose: () => ++closeAttempts === 1,
  });
  const first = await driveMigrationDepReview({ events: closeEvents, capture, mutations });
  const second = await driveMigrationDepReview({ events: closeEvents, capture, mutations });
  assert.equal(first.code, 1);
  assert.equal(second.code, 0);
  assert.equal(first.ledger.some((l) => l.step === "dep-review.migrate.incomplete" && l.action === "close"), true);
  assert.equal(first.ledger.some((l) => l.step === "dep-review.migrate.completed"), false);
  assert.equal(second.ledger.some((l) => l.step === "dep-review.migrate.completed"), true);
  assert.deepEqual(closeEvents, ["capture", "comment", "close:false", "capture", "comment", "close:false"]);
  rmSync(commentFailure.tmp, { recursive: true, force: true });
  rmSync(first.tmp, { recursive: true, force: true });
  rmSync(second.tmp, { recursive: true, force: true });
});
