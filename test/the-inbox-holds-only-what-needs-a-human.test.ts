/**
 * test/the-inbox-holds-only-what-needs-a-human.test.ts — W1-T4086.
 *
 * On 2026-09-22 the live registry held 674 proposals and about 54 needed a person; `GET /v1/inbox`
 * showed all of them as the operator's. The route now splits every lane by who must act:
 * `needsYou` for the operator, `fleet` for the fleet's own findings.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { inboxKind, inboxOwner } from "../src/lib/inbox-owner.js";
import { buildPanelGraphRoutes, type PanelGraphDeps } from "../src/lib/panel-graph.js";
import { createService } from "../src/lib/service.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const READ = "owner-read-token";

// One id per kind seen live on 2026-09-22.
const LIVE_FLEET_IDS = [
  "adoption:field-no-writer:src/lib/plan.ts:context:",
  "followup:W1-T3999:research",
  "proof-debt:W1-T2",
  "skill-draft:implement-clean-single-strike-a4ce515f",
  "codeql-quality:js/unneeded-defensive-code",
  "rule-efficacy:CLAUDE.md#investigation-discipline:bound-fires-on-healthy-condition",
  "verify-human-automate:W1-T216",
  "FD-2026-09-10-fb-repair-conflicted-2957",
];
const LIVE_OPERATOR_IDS = ["verify-human:W1-T235", "ruling:operator-owned"];

function depsFor(root: string): PanelGraphDeps {
  const planPath = join(root, "plan", "tasks.yaml");
  mkdirSync(join(root, "plan"), { recursive: true });
  writeFileSync(planPath, "[]\n");
  return {
    root,
    inboxRoot: root,
    planPath,
    ledgerPath: join(root, "state", "ledger.ndjson"),
    github: { prView: () => null },
    statusGithub: { prByRef: () => null, findMergedByTrailer: () => null, headRefName: () => undefined, prBody: () => undefined },
    ratify: { approve: () => undefined, reframe: () => undefined },
  };
}

async function getInbox(ids: string[]): Promise<Record<string, unknown>> {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1t4086-`));
  mkdirSync(join(root, "state"), { recursive: true });
  writeFileSync(
    join(root, "state", "inbox-proposals.json"),
    JSON.stringify({ proposals: ids.map((id) => ({ id, summary: `summary of ${id}`, evidenceAnchors: [] })) }),
  );
  const server = createService({ tokens: { read: READ, write: "owner-write-token" }, routes: buildPanelGraphRoutes(depsFor(root)) });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/inbox`, {
      headers: { authorization: `Bearer ${READ}` },
    });
    assert.equal(res.status, 200);
    return (await res.json()) as Record<string, unknown>;
  } finally {
    server.close();
  }
}

type Lanes = Record<"ready" | "drafting" | "notReady" | "declined", Array<{ proposalId: string }>>;
const idsIn = (lanes: Lanes) => Object.values(lanes).flat().map((i) => i.proposalId).sort();

test("W1-T4086: the inbox shows the operator only the items that need a person", async () => {
  const body = await getInbox([...LIVE_FLEET_IDS, ...LIVE_OPERATOR_IDS]);
  assert.deepEqual(idsIn(body.needsYou as Lanes), [...LIVE_OPERATOR_IDS].sort());
  // Control: the unsplit lanes still carry every item, so the split is what removed the fleet's.
  assert.equal(idsIn({ ready: body.ready, drafting: body.drafting, notReady: body.notReady, declined: body.declined } as Lanes).length, 10);
});

test("W1-T4086: every fleet finding kind is routed to the fleet lane", async () => {
  for (const id of LIVE_FLEET_IDS) assert.equal(inboxOwner({ id }), "fleet", `${id} (${inboxKind(id)}) is fleet work`);
  for (const id of LIVE_OPERATOR_IDS) assert.equal(inboxOwner({ id }), "operator", `${id} needs a person`);
  const body = await getInbox([...LIVE_FLEET_IDS, ...LIVE_OPERATOR_IDS]);
  const fleet = body.fleet as Array<{ proposalId: string; lane: string }>;
  assert.deepEqual(fleet.map((i) => i.proposalId).sort(), [...LIVE_FLEET_IDS].sort());
  assert.ok(fleet.every((i) => ["ready", "drafting", "notReady", "declined"].includes(i.lane)), "each fleet item names its lane");
});

test("W1-T4086: an unknown kind stays with the operator", async () => {
  assert.equal(inboxOwner({ id: "brand-new-producer:thing" }), "operator");
  assert.equal(inboxOwner({ id: "no-colon-at-all" }), "operator");
  const body = await getInbox(["brand-new-producer:thing"]);
  assert.deepEqual(idsIn(body.needsYou as Lanes), ["brand-new-producer:thing"]);
  assert.deepEqual(body.fleet, []);
});
