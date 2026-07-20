import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  issueFeedbackId,
  normalizeIssue,
  pollIssues,
  renderIssuesSummary,
  type IssueListGateway,
  type RawIssue,
} from "../src/lib/issues-intake.js";
import { feedbackEntryPath, listFeedback } from "../src/lib/feedback.js";
import { summarize as summarizeDigest, renderDigest } from "../src/lib/digest.js";
import type { ManagedRepo } from "../src/lib/managed-repos.js";

function tmpRoot(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function ledgerPath(): string {
  return join(tmpRoot("rmd-issues-ledger-"), "ledger.ndjson");
}

const NOW = Date.parse("2026-07-20T12:00:00Z");

// ── Seeded payloads (fixture-driven, per the acceptance's own proof shape) ──
// Mirrors the real `gh api repos/<owner>/<repo>/issues?state=open` response shape — two open
// issues, one CLOSED issue that must not be reviewed, and one PULL REQUEST (carries a
// `pull_request` key, exactly like GitHub's issues-list endpoint returns) that must be filtered
// out entirely, proving the state + not-a-PR gates actually gate.

const ACME_WIDGETS_RAW = [
  {
    number: 42,
    title: "digest fires twice on DST fallback",
    body: "seen at 2am local twice in one run",
    state: "open",
    created_at: "2026-07-18T12:00:00Z",
    html_url: "https://github.com/acme/widgets/issues/42",
    labels: [{ name: "bug" }, "digest"],
  },
  {
    number: 43,
    title: "closed already",
    body: "n/a",
    state: "closed",
    created_at: "2026-07-01T12:00:00Z",
    html_url: "https://github.com/acme/widgets/issues/43",
    labels: [],
  },
  {
    number: 44,
    title: "a pull request, not an issue",
    body: "should never appear as a reviewed issue",
    state: "open",
    created_at: "2026-07-19T12:00:00Z",
    html_url: "https://github.com/acme/widgets/pull/44",
    labels: [],
    pull_request: { url: "https://api.github.com/repos/acme/widgets/pulls/44" },
  },
];

const ACME_GADGETS_RAW = [
  {
    number: 7,
    title: "gadget catalog missing SKUs",
    body: "",
    state: "open",
    created_at: "2026-07-15T12:00:00Z",
    html_url: "https://github.com/acme/gadgets/issues/7",
    labels: [],
  },
];

/** Mirrors ghIssueListGateway's own pull_request filter — a fixture gateway simulates the WHOLE list() contract, not just the normalizer. */
function seededGateway(): IssueListGateway {
  return {
    list(owner, repo) {
      const raw =
        owner === "acme" && repo === "widgets"
          ? ACME_WIDGETS_RAW
          : owner === "acme" && repo === "gadgets"
            ? ACME_GADGETS_RAW
            : [];
      return raw.filter((r) => (r as { pull_request?: unknown }).pull_request === undefined).map((r) => normalizeIssue(owner, repo, r));
    },
  };
}

const MANAGED: ManagedRepo[] = [
  { owner: "acme", repo: "widgets" },
  { owner: "acme", repo: "gadgets" },
];

// ── normalizeIssue ───────────────────────────────────────────────────────────

test("normalizeIssue flattens string and {name} labels, defaults missing fields", () => {
  const i = normalizeIssue("acme", "widgets", ACME_WIDGETS_RAW[0]);
  assert.deepEqual(i, {
    owner: "acme",
    repo: "widgets",
    number: 42,
    title: "digest fires twice on DST fallback",
    body: "seen at 2am local twice in one run",
    state: "open",
    createdAt: "2026-07-18T12:00:00Z",
    url: "https://github.com/acme/widgets/issues/42",
    labels: ["bug", "digest"],
  });
  const empty = normalizeIssue("o", "r", {});
  assert.equal(empty.title, "(untitled)");
  assert.equal(empty.body, "");
  assert.deepEqual(empty.labels, []);
});

// ── issueFeedbackId: the dedup key ──────────────────────────────────────────

test("issueFeedbackId is deterministic and slugs owner/repo into a safe filename", () => {
  assert.equal(issueFeedbackId("acme", "widgets", 42), "fb-issue-acme-widgets-42");
  assert.equal(issueFeedbackId("Acme-Corp", "My.Repo", 1), "fb-issue-acme-corp-my-repo-1");
});

// ── pollIssues: the end-to-end acceptance shape ─────────────────────────────
// "seeded open issues on managed repos become deduped feedback artifacts
// (origin: issue#<n>) and the digest carries an issues-reviewed count."

test("pollIssues creates one plan/feedback entry per OPEN issue (excluding closed + PRs), origin: issue#<n>", async () => {
  const root = tmpRoot("rmd-issues-root-");
  const path = ledgerPath();
  const result = await pollIssues(MANAGED, {
    issues: seededGateway(),
    root,
    ledgerPath: path,
    runId: "ISSUES-1",
    now: () => NOW,
  });

  assert.equal(result.summary.reviewedCount, 2); // #42 (widgets) + #7 (gadgets); #43 closed, #44 a PR — both excluded
  assert.equal(result.created.length, 2);
  assert.deepEqual(result.summary.repos, ["acme/widgets", "acme/gadgets"]);

  const entries = listFeedback(root);
  assert.equal(entries.length, 2);
  const byOrigin = Object.fromEntries(entries.map((e) => [e.origin, e]));
  assert.ok(byOrigin["issue#42"]);
  assert.ok(byOrigin["issue#7"]);
  assert.match(byOrigin["issue#42"].raw, /acme\/widgets#42: digest fires twice on DST fallback/);
  assert.match(byOrigin["issue#42"].raw, /https:\/\/github\.com\/acme\/widgets\/issues\/42/);
  assert.equal(byOrigin["issue#42"].status, "new");

  assert.ok(existsSync(feedbackEntryPath(root, "fb-issue-acme-widgets-42")));
  assert.ok(existsSync(feedbackEntryPath(root, "fb-issue-acme-gadgets-7")));
});

test("pollIssues re-poll of the SAME open issues creates NOTHING new (id-keyed dedup)", async () => {
  const root = tmpRoot("rmd-issues-root-");
  const path = ledgerPath();
  const deps = { issues: seededGateway(), root, ledgerPath: path, now: () => NOW };

  const first = await pollIssues(MANAGED, { ...deps, runId: "ISSUES-1" });
  assert.equal(first.created.length, 2);

  const second = await pollIssues(MANAGED, { ...deps, runId: "ISSUES-2" });
  assert.equal(second.created.length, 0, "re-poll must create ZERO new entries");
  assert.equal(second.newIssues.length, 0);
  assert.equal(second.skippedExisting, 2, "both issues already had an entry from the first poll");
  assert.equal(listFeedback(root).length, 2, "no duplicate entries on disk");

  const lines = readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const polled = lines.filter((l) => l.step === "issues.polled");
  assert.equal(polled.length, 2, "one issues.polled ledger line per real poll");
  assert.equal(polled[0].issues.reviewedCount, 2);
  assert.equal(polled[0].issues.createdCount, 2);
  assert.equal(polled[1].issues.createdCount, 0);
});

test("pollIssues --dry-run previews reviewedCount + newIssues but creates nothing and writes no ledger line", async () => {
  const root = tmpRoot("rmd-issues-root-");
  const path = ledgerPath();
  const result = await pollIssues(MANAGED, {
    issues: seededGateway(),
    root,
    ledgerPath: path,
    runId: "ISSUES-DRY",
    now: () => NOW,
    dryRun: true,
  });
  assert.equal(result.summary.reviewedCount, 2);
  assert.equal(result.newIssues.length, 2);
  assert.equal(result.created.length, 0);
  assert.deepEqual(listFeedback(root), []);
  assert.equal(existsSync(path), false, "a dry-run poll must leave no ledger trace");

  // A REAL poll after the dry-run still creates normally (no phantom dedup entry).
  const real = await pollIssues(MANAGED, {
    issues: seededGateway(),
    root,
    ledgerPath: path,
    runId: "ISSUES-REAL",
    now: () => NOW,
  });
  assert.equal(real.created.length, 2);
});

test("pollIssues with an empty managed-repo set reviews nothing and renders a distinct summary", async () => {
  const root = tmpRoot("rmd-issues-root-");
  const result = await pollIssues([], {
    issues: seededGateway(),
    root,
    ledgerPath: ledgerPath(),
    runId: "ISSUES-EMPTY",
    now: () => NOW,
  });
  assert.equal(result.summary.reviewedCount, 0);
  assert.deepEqual(result.summary.repos, []);
  assert.equal(renderIssuesSummary(result.summary), "(no managed repos configured)");
});

test("renderIssuesSummary names the reviewed/new counts across managed repos", () => {
  const s = { polledAt: "2026-07-20T12:00:00.000Z", repos: ["acme/widgets", "acme/gadgets"], reviewedCount: 2, createdCount: 2 };
  assert.equal(renderIssuesSummary(s), "2 open across 2 managed repo(s) (2 new)");
});

// ── digest.ts integration: the issues.polled ledger line surfaces in the digest ──

test("digest.summarize picks up the latest issues.polled snapshot inside its window, renderDigest prints an 'issues reviewed:' line", async () => {
  const root = tmpRoot("rmd-issues-root-");
  const path = ledgerPath();
  await pollIssues(MANAGED, { issues: seededGateway(), root, ledgerPath: path, runId: "ISSUES-1", now: () => NOW });

  const lines = readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const s = summarizeDigest(lines, "2026-07-01T00:00:00.000Z");
  assert.ok(s.issues, "digest summary must carry the issues snapshot");
  assert.equal(s.issues!.reviewedCount, 2);
  const text = renderDigest(s);
  assert.match(text, /issues reviewed: 2 open across 2 managed repo\(s\) \(2 new\)/);
});

test("digest renders '(no poll this window)' for issues when rmd issues never ran inside the window", () => {
  const s = summarizeDigest([], "2026-07-01T00:00:00.000Z");
  assert.equal(s.issues, undefined);
  assert.match(renderDigest(s), /issues reviewed: \(no poll this window\)/);
});
