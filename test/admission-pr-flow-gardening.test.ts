import assert from "node:assert/strict";
import test from "node:test";
import * as flow from "../src/lib/flow-gardener.js";
import * as remedy from "../src/lib/flow-remedy-gardener.js";
import { feedbackContentDigest, type AdmissionSettings } from "../src/lib/contributor-admission.js";

const now = Date.parse("2026-10-11T12:00:00Z");
const settings: AdmissionSettings = { mode: "shadow", disposition: "shadow", repositoryId: 111,
  organizations: [], policy: { version: "test-v1", ownerIds: [7], organizationIds: [], services: [], maxEvidenceAgeMs: 5_000 } };
const input = { owner: "operator", repo: "core", settings };
const repository = { databaseId: 111, nameWithOwner: "operator/core", isPrivate: false };
const pull = (number: number, actor: number) => ({ number, fullDatabaseId: String(1000 + number), state: "OPEN",
  createdAt: new Date(now - 7_200_000).toISOString(),
  headRefOid: "a".repeat(40), author: { __typename: "User", databaseId: actor },
  repository, headRepository: { databaseId: 222, nameWithOwner: "actor/fork", isPrivate: false } });
const corpus = () => ({ data: { repository: { ...repository, pullRequests: { totalCount: 2,
  pageInfo: { hasNextPage: false }, nodes: [pull(1, 7), pull(2, 8)] } } } });
const report = (body: unknown = corpus(), ledger: flow.FlowLedgerRead = { ok: true, rows: [], unread: [] }) =>
  flow.admissionFlowReport(input, ledger, { ok: true, body, observedAtMs: now, policyDigest: feedbackContentDigest(settings) }, now);

test("W1-T7756: admission gardening distinguishes missing evidence from healthy flow", () => {
  const measured = report();
  assert.equal(measured.coverage, "measured");
  assert.equal(measured.trusted.length, 1);
  assert.equal(measured.affected.length, 1);
  assert.equal(measured.affected[0].evidence, "missing-disposition");
  assert.equal(measured.healthy, false);
  assert.equal(report(undefined, { ok: false, rows: [], unread: ["ledger"] }).coverage, "unknown");
  const truncated = corpus(); truncated.data.repository.pullRequests.pageInfo.hasNextPage = true;
  assert.equal(report(truncated).coverage, "unknown");
});

test("W1-T7756: admission recovery deduplicates persistent causes across PR heads", () => {
  const first = report();
  const changed = corpus(); changed.data.repository.pullRequests.nodes[1]!.headRefOid = "b".repeat(40);
  const second = report(changed);
  assert.equal(first.affected[0].causeKey, second.affected[0].causeKey);
  const one = remedy.admissionFlowInventory(first, [], [], now);
  assert.equal(one.candidates.length, 1);
  assert.equal(one.next!.admissionShadow, true);
});

test("W1-T7756: admission gardening cannot widen trust or bypass required checks", () => {
  const measured = report();
  assert.equal(measured.permission, "not-granted");
  assert.equal(measured.mode, "shadow");
  assert.equal(measured.trusted[0].next, "required-current-head-checks");
  const missingActor = corpus(); missingActor.data.repository.pullRequests.nodes[1]!.author.databaseId = 0;
  assert.equal(report(missingActor).coverage, "unknown");
});
