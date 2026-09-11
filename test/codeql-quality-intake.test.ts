import assert from "node:assert/strict";
import { ghStubPath, pathWith } from "./helpers/gh-stub.js";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { FeedbackEntry } from "../src/lib/feedback.js";
import { loadProposalRegistry, pruneRatifiedProposals, type Proposal } from "../src/lib/inbox.js";
import { readCodeScanningAlerts, type RawAlert } from "../src/lib/ops.js";
import {
  codeqlQualityProposalId,
  partitionCodeqlQualityAlerts,
  reconcileCodeqlQualityProposals,
} from "../src/lib/codeql-quality-intake.js";

function alert(id: string, ruleId: string, opts: Partial<RawAlert> = {}): RawAlert {
  return {
    source: "code-scanning",
    id,
    severity: "low",
    state: "open",
    createdAt: "2026-09-10T00:00:00.000Z",
    summary: ruleId,
    url: `https://github.com/acme/app/security/code-scanning/${id}`,
    ruleId,
    toolName: "CodeQL",
    ruleTags: ["quality", "maintainability"],
    ...opts,
  };
}

function rejectedFeedback(alertId: string): FeedbackEntry {
  return {
    id: `fb-${alertId}`,
    ts: "2026-09-10T00:00:00.000Z",
    raw: "operator rejected this alert",
    attachments: [],
    origin: `alert#code-scanning-${alertId}`,
    status: "rejected",
    proposal_pr: null,
  };
}

function countedGhFailure(countPath: string, message: string): string {
  return ghStubPath(
    [
      "#!/bin/sh",
      `count_path=${JSON.stringify(countPath)}`,
      'count=0',
      'if [ -f "$count_path" ]; then count=$(cat "$count_path"); fi',
      'count=$((count + 1))',
      'printf "%s" "$count" > "$count_path"',
      `printf '%s\\n' ${JSON.stringify(message)} >&2`,
      "exit 1",
    ].join("\n"),
  );
}

test("only open CodeQL alerts with both quality tags enter the partition, and every eligible alert has one disposition", () => {
  const unused = alert("17", "js/unused-local-variable");
  const rejected = alert("23", "js/useless-assignment-to-local");
  const excludedMissingTag = alert("31", "js/unused-local-variable", { ruleTags: ["quality"] });
  const excludedScorecard = alert("41", "scorecard/branch-protection", { toolName: "Scorecard" });
  const excludedClosed = alert("47", "js/unused-local-variable", { state: "closed" });
  const proposals: Proposal[] = [
    {
      id: codeqlQualityProposalId("js/unused-local-variable"),
      summary: "existing package",
      evidenceAnchors: [],
    },
  ];

  const partition = partitionCodeqlQualityAlerts(
    [unused, rejected, excludedMissingTag, excludedScorecard, excludedClosed],
    [rejectedFeedback("23")],
    proposals,
  );

  assert.equal(partition.scannedTotal, 5);
  assert.equal(partition.eligible.length, 2, "both tags, CodeQL, and open state are all required");
  assert.equal(partition.excluded.length, 3, "Scorecard and out-of-policy CodeQL alerts do not enter quality debt");
  assert.deepEqual(partition.rejected.map((item) => item.id), ["23"]);
  assert.deepEqual(partition.covered.map((item) => item.id), ["17"]);
  assert.deepEqual(partition.unassigned.map((item) => item.id), []);
  assert.equal(
    partition.eligible.length,
    partition.rejected.length + partition.covered.length + partition.unassigned.length,
    "every eligible alert is rejected, covered by one active package, or unassigned",
  );
  assert.equal(partition.scannedTotal, partition.eligible.length + partition.excluded.length);
});

test("a CodeQL rule gets one active proposal that is refreshed in place and retired once no actionable alert remains", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-codeql-quality-"));
  const registryPath = join(root, "state", "inbox-proposals.json");
  const ruleId = "js/unused-local-variable";
  const firstAlert = alert("17", ruleId);
  try {
    const first = reconcileCodeqlQualityProposals(registryPath, [firstAlert], []);
    const proposalId = codeqlQualityProposalId(ruleId);
    assert.equal(first.createdProposalId, proposalId, "the first rule package has a deterministic id");
    let active = loadProposalRegistry(registryPath);
    assert.equal(active.length, 1);
    assert.deepEqual(active[0].evidenceAnchors, [], "an external alert is not misrepresented as a repository grep proof");
    assert.equal(active[0].retainAfterRatification, true, "a ratification cannot reopen the same rule as a duplicate package");
    const retained = pruneRatifiedProposals(active, [{ proposalId, state: "ratified", reasons: [] }]);
    assert.equal(retained.proposals, active, "the source reconciler, not generic ratification pruning, owns package retirement");
    assert.deepEqual(retained.prunedIds, []);

    const repeated = reconcileCodeqlQualityProposals(registryPath, [firstAlert], []);
    assert.equal(repeated.createdProposalId, undefined, "the same rule never creates a duplicate active proposal");
    assert.deepEqual(repeated.updatedProposalIds, []);

    const refreshed = reconcileCodeqlQualityProposals(registryPath, [firstAlert, alert("81", ruleId)], []);
    assert.deepEqual(refreshed.updatedProposalIds, [proposalId], "a new alert for the active rule updates its package");
    active = loadProposalRegistry(registryPath);
    assert.match(active[0].summary, /#17, #81/, "the refreshed package carries the current alert set");

    const retired = reconcileCodeqlQualityProposals(
      registryPath,
      [firstAlert, alert("81", ruleId)],
      [rejectedFeedback("17"), rejectedFeedback("81")],
    );
    assert.deepEqual(retired.retiredProposalIds, [proposalId], "a package with no actionable alert is removed rather than masking future debt");
    assert.deepEqual(loadProposalRegistry(registryPath), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("readCodeScanningAlerts returns normalized alerts from every paginated response page, carrying the tool and rule tags the filter needs", () => {
  // The refusal path (a 403) is covered separately; this drives the success return.
  // It also pins the two fields RawAlert gained for this feature: without `toolName`/`ruleTags`
  // surviving normalization, every alert would fall out of the filter as ineligible.
  const firstPage = JSON.stringify([
    {
      number: 7,
      state: "open",
      created_at: "2026-09-10T00:00:00Z",
      html_url: "https://github.com/o/r/security/code-scanning/7",
      rule: { id: "js/unused-local-variable", description: "Unused variable", severity: "note", tags: ["quality", "maintainability"] },
      tool: { name: "CodeQL" },
    },
  ]);
  const secondPage = JSON.stringify([
    {
      number: 8,
      state: "open",
      created_at: "2026-09-10T00:00:00Z",
      html_url: "https://github.com/o/r/security/code-scanning/8",
      rule: { id: "js/unused-local-variable", description: "Unused variable", severity: "note", tags: ["quality", "maintainability"] },
      tool: { name: "CodeQL" },
    },
  ]);
  const bin = ghStubPath(`#!/bin/sh\ncat <<'JSON'\n${firstPage}${secondPage}\nJSON\n`);
  const saved = process.env.PATH;
  process.env.PATH = pathWith(bin);
  try {
    const read = readCodeScanningAlerts("o", "r");
    assert.equal(read.ok, true, "a readable JSON array is a success, not a refusal");
    assert.ok(read.ok && read.alerts.length === 2, "both bare --paginate pages are normalized");
    const [alert, secondAlert] = read.ok ? read.alerts : [];
    assert.equal(alert?.id, "7");
    assert.equal(alert?.source, "code-scanning");
    assert.equal(alert?.toolName, "CodeQL", "the tool survives normalization — the filter keys on it");
    assert.deepEqual(alert?.ruleTags, ["quality", "maintainability"], "and so do the rule tags");
    assert.equal(alert?.ruleId, "js/unused-local-variable");
    assert.equal(secondAlert?.id, "8", "the second JSON page is not dropped or read as a failure");
  } finally {
    process.env.PATH = saved;
  }
});

test("readCodeScanningAlerts preserves the GitHub CLI's compact refusal evidence", () => {
  const bin = ghStubPath(`#!/bin/sh\nprintf '%s\\n' 'HTTP 403: secondary rate limit' >&2\nexit 1\n`);
  const saved = process.env.PATH;
  process.env.PATH = pathWith(bin);
  try {
    const read = readCodeScanningAlerts("o", "r");
    assert.equal(read.ok, false, "a failed gh command must refuse rather than become an empty alert list");
    if (!read.ok) {
      assert.match(read.error, /Command failed: gh api repos\/o\/r\/code-scanning\/alerts --paginate/);
      assert.match(read.error, /HTTP 403: secondary rate limit/, "the ledger can distinguish a rate limit from a bare command failure");
    }
  } finally {
    process.env.PATH = saved;
  }
});

test("readCodeScanningAlerts retries one rate-limited response and returns the first readable page", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-codeql-rate-retry-"));
  const countPath = join(root, "calls");
  const bin = ghStubPath(
    [
      "#!/bin/sh",
      `count_path=${JSON.stringify(countPath)}`,
      'count=0',
      'if [ -f "$count_path" ]; then count=$(cat "$count_path"); fi',
      'count=$((count + 1))',
      'printf "%s" "$count" > "$count_path"',
      'if [ "$count" -eq 1 ]; then',
      "  printf '%s\\n' 'HTTP 403: secondary rate limit' >&2",
      "  exit 1",
      "fi",
      "printf '%s\\n' '[]'",
    ].join("\n"),
  );
  const saved = process.env.PATH;
  process.env.PATH = pathWith(bin);
  try {
    const read = readCodeScanningAlerts("o", "r");
    assert.equal(read.ok, true, "the first readable page ends the bounded retry");
    assert.equal(readFileSync(countPath, "utf8"), "2", "one rate-limited read is followed by one retry");
  } finally {
    process.env.PATH = saved;
    rmSync(root, { recursive: true, force: true });
  }
});

test("readCodeScanningAlerts stops after the bounded rate-limit attempts", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-codeql-rate-exhausted-"));
  const countPath = join(root, "calls");
  const bin = countedGhFailure(countPath, "HTTP 403: secondary rate limit");
  const saved = process.env.PATH;
  process.env.PATH = pathWith(bin);
  try {
    const read = readCodeScanningAlerts("o", "r");
    assert.equal(read.ok, false, "an exhausted rate limit remains a visible refusal");
    assert.equal(readFileSync(countPath, "utf8"), "4", "the existing four-attempt cap bounds the reader");
    if (!read.ok) assert.match(read.error, /secondary rate limit/);
  } finally {
    process.env.PATH = saved;
    rmSync(root, { recursive: true, force: true });
  }
});

test("readCodeScanningAlerts does not retry authentication or not-found refusals", () => {
  for (const [name, message] of [
    ["authentication", "HTTP 401: authentication required"],
    ["not-found", "HTTP 404: Not Found"],
  ]) {
    const root = mkdtempSync(join(tmpdir(), `rmd-codeql-${name}-`));
    const countPath = join(root, "calls");
    const bin = countedGhFailure(countPath, message);
    const saved = process.env.PATH;
    process.env.PATH = pathWith(bin);
    try {
      const read = readCodeScanningAlerts("o", "r");
      assert.equal(read.ok, false, `${name} is a refusal, not a successful empty scan`);
      assert.equal(readFileSync(countPath, "utf8"), "1", `${name} does not spend a retry`);
    } finally {
      process.env.PATH = saved;
      rmSync(root, { recursive: true, force: true });
    }
  }
});
