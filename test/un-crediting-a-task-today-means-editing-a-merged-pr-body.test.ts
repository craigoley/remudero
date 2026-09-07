// test/un-crediting-a-task-today-means-editing-a-merged-pr-body.test.ts — W1-T2970.
//
// THE TWO CREDIT PATHS BOTH READ HISTORY: the `Remudero-Task:` trailer on a merged pull request
// body, and `findMergedByHeadBranch` matching `run-<taskId>-<digits>` on the head ref. Correcting a
// task that reads merged-but-never-built therefore means EDITING A MERGED PULL REQUEST BODY —
// rewriting a record after the fact, unreviewably, with no field anywhere saying why.
//
// This gives the projection an override record it consults instead. Two properties carry the whole
// design and each has its own falsifier below:
//   SUBTRACT-ONLY — a row that GRANTED credit would let a file assert something shipped when no
//   pull request says so, which is Law 5's laundering shape pointed the other way.
//   FAIL TOWARD THE STATUS QUO — a corrupt or absent file must leave `deriveStatus` answering
//   exactly as it does today. A read failure that silently un-credited would re-dispatch the
//   entire merged backlog.

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  creditOverrideFor,
  defaultCreditOverridePath,
  deriveStatus,
  loadCreditOverrides,
} from "../src/lib/status.js";
import type { CreditStore, GitHub } from "../src/lib/status.js";
import type { Task } from "../src/lib/plan.js";

const task = (id: string): Task =>
  ({ id, title: id, repo: "remudero", type: "implement", depends_on: [], status: "queued" }) as unknown as Task;

const ledgerFile = (): string => {
  const p = join(mkdtempSync(join(tmpdir(), "rmd-t2970-")), "ledger.ndjson");
  writeFileSync(p, "");
  return p;
};

/** A gateway that answers nothing — every credit here comes from the durable store, so no live
 *  read is needed and none may be relied on. */
const silentGateway = (): GitHub =>
  ({ prByRef: () => null, findMergedByTrailer: () => null, headRefName: () => undefined, prBody: () => undefined }) as unknown as GitHub;

/** Durable credit for one task through one path — the shape `derivePrPrecedence` grants `merged` from. */
const creditedBy = (source: "trailer" | "head-branch", pr: number): CreditStore => ({
  "W1-T444": { [source]: { source, prUrl: `https://github.com/craigoley/remudero/pull/${pr}`, prNumber: pr, prState: "MERGED" } },
});

const OVERRIDE_YAML = `- task: W1-T444
  pr: 1657
  action: remove-credit
  reason: "credited only by its own run branch; no build was ever pushed"
  author_class: operator
`;

/** Drive `deriveStatus` with durable credit and an injected override file body. */
function derive(store: CreditStore, overrideYaml?: string) {
  return deriveStatus(task("W1-T444"), {
    ledgerPath: ledgerFile(),
    github: silentGateway(),
    readCreditStore: () => store,
    writeCreditStore: () => {},
    ...(overrideYaml === undefined ? {} : { readCreditOverrideFile: () => overrideYaml }),
  } as never);
}

// ── (1) THE DELIVERABLE: an override subtracts credit, and its reason travels ─────────────────

test("W1-T2970 a task credited by a merged PR reads NOT MERGED once an override names that pairing", () => {
  // CONTROL FIRST — without the override this task really is credited, or the assertion below
  // would pass over a task that was never merged to begin with.
  const credited = derive(creditedBy("trailer", 1657));
  assert.equal(credited.merged, true, "control: the durable trailer credit really does read merged");
  assert.equal(credited.prNumber, 1657);

  const overridden = derive(creditedBy("trailer", 1657), OVERRIDE_YAML);
  assert.equal(overridden.merged, false, "THE CLAIM: the override subtracts the credit");
  assert.notEqual(overridden.status, "merged", "and the status word follows");
  assert.match(
    overridden.creditOverride?.reason ?? "",
    /no build was ever pushed/,
    "and the REASON travels with the answer — a correction nobody can read is the shape this replaces",
  );
});

test("W1-T2970 the override subtracts credit from the HEAD-BRANCH path too, not just the trailer", () => {
  // Both paths read history and both are what this record exists to correct; an override that only
  // caught the trailer would leave the branch-name path uncorrectable.
  const credited = derive(creditedBy("head-branch", 1657));
  assert.equal(credited.merged, true, "control: head-branch credit reads merged");

  const overridden = derive(creditedBy("head-branch", 1657), OVERRIDE_YAML);
  assert.equal(overridden.merged, false, "the same row subtracts head-branch credit");
});

// ── (2) SUBTRACT-ONLY: a grant-credit row is refused BY NAME ──────────────────────────────────

test("W1-T2970 a row that GRANTS credit is refused by name — the record can never assert something shipped", () => {
  const granting = `- task: W1-T999
  pr: 42
  action: grant-credit
  reason: "I am sure it shipped"
  author_class: operator
`;
  const loaded = loadCreditOverrides(() => granting);
  assert.deepEqual(loaded.rows, [], "no grant row is ever applied");
  assert.equal(loaded.refused.length, 1, "and it is REFUSED rather than silently dropped");
  assert.match(loaded.refused[0].reason, /remove-credit/, "named by the only legal action");

  // AND IT CANNOT REACH THE PROJECTION: a grant row must not manufacture credit for an uncredited task.
  const uncredited = deriveStatus(task("W1-T999"), {
    ledgerPath: ledgerFile(),
    github: silentGateway(),
    readCreditStore: () => ({}),
    writeCreditStore: () => {},
    readCreditOverrideFile: () => granting,
  } as never);
  assert.equal(uncredited.merged, false, "a grant row grants nothing — credit still comes only from a PR");
});

// ── (3) FAIL TOWARD THE STATUS QUO — the direction that matters ───────────────────────────────

test("W1-T2970 THE FAIL-SAFE FALSIFIER: a CORRUPT override file leaves credit UNCHANGED", () => {
  // A guard that failed toward un-crediting would re-dispatch every merged task in the plan the
  // first time this file was malformed. That is the expensive direction, so it gets the falsifier.
  const corrupt = derive(creditedBy("trailer", 1657), "- task: [unclosed\n  pr: ");
  assert.equal(corrupt.merged, true, "credit SURVIVES an unparseable override file");
  assert.equal(corrupt.creditOverride, undefined, "and nothing claims an override applied");
});

test("W1-T2970 an ABSENT override file leaves the projection exactly as it is today", () => {
  const absent = deriveStatus(task("W1-T444"), {
    ledgerPath: ledgerFile(),
    github: silentGateway(),
    readCreditStore: () => creditedBy("trailer", 1657),
    writeCreditStore: () => {},
    readCreditOverrideFile: () => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    },
  } as never);
  assert.equal(absent.merged, true, "a missing file is not a ruling");
  assert.equal(absent.creditOverride, undefined);
});

// ── (4) REGRESSION LOCK: a task with NO row grades exactly as before ──────────────────────────

test("W1-T2970 a task with NO override row grades unchanged through BOTH credit paths", () => {
  const other = `- task: W1-T9999
  pr: 1
  action: remove-credit
  reason: "some other task entirely"
  author_class: operator
`;
  for (const source of ["trailer", "head-branch"] as const) {
    const withFile = derive(creditedBy(source, 1657), other);
    const without = derive(creditedBy(source, 1657));
    assert.equal(withFile.merged, without.merged, `${source}: unchanged by a row naming another task`);
    assert.equal(withFile.status, without.status, `${source}: same status word`);
    assert.equal(withFile.prNumber, without.prNumber, `${source}: same PR`);
  }
});

test("W1-T2970 a row matching the task but a DIFFERENT PR does not subtract — the pairing is the key", () => {
  const wrongPr = OVERRIDE_YAML.replace("pr: 1657", "pr: 9999");
  const out = derive(creditedBy("trailer", 1657), wrongPr);
  assert.equal(out.merged, true, "un-crediting is per PAIRING, never per task — a task may be credited by another PR");
});

// ── (5) THE MATCHER AND THE LOADER, DIRECTLY ─────────────────────────────────────────────────

test("W1-T2970 loadCreditOverrides accepts a well-formed remove-credit row and keeps its fields", () => {
  const loaded = loadCreditOverrides(() => OVERRIDE_YAML);
  assert.deepEqual(loaded.refused, [], "nothing refused");
  assert.equal(loaded.rows.length, 1);
  assert.equal(loaded.rows[0].task, "W1-T444");
  assert.equal(loaded.rows[0].pr, 1657);
  assert.equal(loaded.rows[0].author_class, "operator", "every row carries its author class");
  assert.ok(loaded.rows[0].reason.length > 0, "and its reason");
});

test("W1-T2970 a row missing its reason or author class is refused — a ruling with no reason is the shape this replaces", () => {
  const noReason = `- task: W1-T444
  pr: 1657
  action: remove-credit
  author_class: operator
`;
  assert.equal(loadCreditOverrides(() => noReason).rows.length, 0, "no reason, no row");
  assert.match(loadCreditOverrides(() => noReason).refused[0].reason, /reason/);

  const noAuthor = `- task: W1-T444
  pr: 1657
  action: remove-credit
  reason: "x"
`;
  assert.equal(loadCreditOverrides(() => noAuthor).rows.length, 0, "no author class, no row");
});

test("W1-T2970 creditOverrideFor matches on the PAIRING and nothing else", () => {
  const rows = loadCreditOverrides(() => OVERRIDE_YAML).rows;
  assert.ok(creditOverrideFor(rows, "W1-T444", 1657), "exact pairing matches");
  assert.equal(creditOverrideFor(rows, "W1-T444", 9999), undefined, "same task, other PR: no match");
  assert.equal(creditOverrideFor(rows, "W1-T999", 1657), undefined, "same PR, other task: no match");
  assert.equal(creditOverrideFor(rows, "W1-T444", undefined), undefined, "no PR number: no match");
});

// ── (6) REACHABILITY: existing callers consult it without new plumbing ───────────────────────

test("W1-T2970 the default path is derived from the ledger path, so every existing caller consults it", () => {
  // The W1-T2972 lesson: a rung nothing calls is dead code however well tested. `projectPlan`
  // passes `deps` straight through to `deriveStatus`, so deriving the default from `ledgerPath` —
  // the one field every caller already supplies — is what makes this reachable with no new
  // required field and no call-site edits.
  assert.equal(
    defaultCreditOverridePath("/srv/rmd/state/ledger.ndjson"),
    "/srv/rmd/plan/credit-overrides.yaml",
    "a COMMITTED, reviewable file beside the plan — not a state file nobody reviews",
  );
});
