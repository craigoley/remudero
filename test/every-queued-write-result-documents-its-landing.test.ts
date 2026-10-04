/**
 * W1-T5626 — EVERY QUEUED CONSOLE WRITE DOCUMENTS ITS LANDING.
 *
 * Since W1-T5460 (#8929) and W1-T5525 (#9049), POST /v1/feedback, /v1/feedback/decision, /v1/skills/run and
 * /v1/escalation/reply stage their records for the daemon's landing sweep and answer `landing: "queued"`. The
 * openapi result schemas never declared that key, so a typed client could not see that a write was pending.
 *
 * Each route is driven with a fake state root; every top-level key of its 200 body must be a property of the
 * result schema openapi/daemon.yaml names for that route's 200, and that schema must declare `landing` with the
 * single enum value `queued`. The generated client mirrors the spec (`npm run api-client:check`).
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { parse } from "yaml";

import * as feedback from "../src/lib/feedback.js";
import { appendThreadMessage } from "../src/lib/inbox-thread.js";
import { withLiveWritesAllowed } from "../src/lib/live-write-guard.js";
import * as panelActions from "../src/lib/panel-actions.js";
import * as panelGraph from "../src/lib/panel-graph.js";
import * as skillRun from "../src/lib/panel-skill-run.js";
import { createService, type Route } from "../src/lib/service.js";
import { skillsDir } from "../src/lib/skill.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

type Schema = { properties?: Record<string, { type?: unknown; enum?: unknown[]; description?: string }> };
type Spec = {
  paths: Record<string, { post?: { responses?: Record<string, { content?: Record<string, { schema?: { $ref?: string } }> }> } }>;
  components: { schemas: Record<string, Schema> };
};

const SPEC = parse(readFileSync(new URL("../openapi/daemon.yaml", import.meta.url), "utf8")) as Spec;

/** The result schema openapi names for a POST route's 200 — resolved from `paths`, never hard-coded. */
function resultSchema(path: string): { name: string; schema: Schema } {
  const ref = SPEC.paths[path]?.post?.responses?.["200"]?.content?.["application/json"]?.schema?.$ref;
  assert.ok(ref, `openapi declares a 200 schema for POST ${path}`);
  const name = ref.replace("#/components/schemas/", "");
  const schema = SPEC.components.schemas[name];
  assert.ok(schema, `${ref} resolves`);
  return { name, schema };
}

function assertBodyDeclared(path: string, body: Record<string, unknown>): void {
  const { name, schema } = resultSchema(path);
  assert.equal(body.landing, "queued", `POST ${path} answered landing: queued`);
  const undeclared = Object.keys(body).filter((key) => !(key in (schema.properties ?? {})));
  assert.deepEqual(undeclared, [], `POST ${path}'s 200 body carries keys ${name} does not declare`);
}

function tmpDir(label: string): string {
  return mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w5626-${label}-`));
}

/** A checkout-shaped root, a separate state root, and the console's panel deps; any GitHub call fails. */
function panelFixture(label: string) {
  const root = tmpDir(`${label}-root`);
  const stateRoot = tmpDir(`${label}-state`);
  const refuse = (kind: string) => (): string => {
    throw new Error(`the request path reached ${kind}`);
  };
  const deps = {
    root,
    inboxRoot: stateRoot,
    planPath: join(root, "plan", "tasks.yaml"),
    ledgerPath: join(tmpDir(`${label}-ledger`), "ledger.ndjson"),
    github: { prView: () => null },
    statusGithub: { prByRef: () => null, findMergedByTrailer: () => null, headRefName: () => undefined, prBody: () => undefined },
    ratify: { approve: () => undefined, reframe: () => undefined },
    feedbackLand: { git: refuse("git"), gh: refuse("gh"), planPrPreflight: () => ({ ok: true, failures: [], unreadable: [] }) },
  };
  return { root, stateRoot, deps };
}

async function post(routes: Route[], path: string, body: unknown): Promise<Record<string, unknown>> {
  const server = createService({ tokens: { read: "r-token", write: "w-token" }, routes });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const res = await withLiveWritesAllowed(() =>
      fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}${path}`, {
        method: "POST",
        headers: { authorization: "Bearer w-token", "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
    const text = await res.text();
    assert.equal(res.status, 200, text);
    return JSON.parse(text) as Record<string, unknown>;
  } finally {
    server.close();
  }
}

test("POST /v1/feedback answers only keys SubmitFeedbackResult declares, landing included", async () => {
  const fx = panelFixture("submit");
  const body = await post([panelGraph.buildSubmitFeedbackRoute(fx.deps)], "/v1/feedback", { text: "the board is slow" });
  assertBodyDeclared("/v1/feedback", body);
});

test("POST /v1/feedback/decision answers only keys ProposalDecisionResult declares, landing included", async () => {
  const fx = panelFixture("decision");
  const entry = feedback.captureFeedback(fx.root, { raw: "a proposal", origin: "ui" });
  feedback.setFeedbackStatus(fx.root, entry.id, "proposed", { proposalPr: "https://github.com/o/r/pull/7" });
  const body = await post([panelGraph.buildProposalDecisionRoute(fx.deps)], "/v1/feedback/decision", { id: entry.id, decision: "accept" });
  assertBodyDeclared("/v1/feedback/decision", body);
});

test("POST /v1/skills/run answers only keys RunSkillResult declares, landing included", async () => {
  const fx = panelFixture("skill");
  mkdirSync(skillsDir(fx.root), { recursive: true });
  writeFileSync(join(skillsDir(fx.root), "plan.yaml"), "tools:\n  - Read\npermission_profile: implement\noutput_contract: a PR\ngrounding_sources:\n  - plan/tasks.yaml\ngate: ci\ntier: G-17\n");
  const task = { id: "W9-T1", title: "Example task", repo: "remudero", depends_on: [], type: "implement", verify: "auto", risk: "medium", status: "queued", attempts: 0, origin: "architect", acceptance: [{ claim: "does it", proof: "unit test: does it" }] };
  mkdirSync(dirname(fx.deps.planPath), { recursive: true });
  writeFileSync(fx.deps.planPath, JSON.stringify([task]));
  const body = await post(skillRun.buildPanelSkillRunRoutes(fx.deps), "/v1/skills/run", { skill: "plan", mode: "clarify", taskId: "W9-T1" });
  assertBodyDeclared("/v1/skills/run", body);
});

test("POST /v1/escalation/reply answers only keys EscalationReplyResult declares, landing included", async () => {
  const stateRoot = tmpDir("reply");
  const threadStorePath = join(stateRoot, "state", "inbox-threads.jsonl");
  appendThreadMessage({ taskId: "W9-T2", class: "BLOCKED" }, "escalation", "the retry still failed CI", { threadStorePath });
  const deps = { root: stateRoot, ledgerPath: join(stateRoot, "ledger.ndjson"), issues: { close: () => undefined }, threadStorePath };
  const body = await post([panelActions.buildEscalationReplyRoute(deps)], "/v1/escalation/reply", { taskId: "W9-T2", class: "BLOCKED", text: "retry once more" });
  assertBodyDeclared("/v1/escalation/reply", body);
});

test("each queued write's result schema declares landing as an optional string with enum queued", () => {
  for (const path of ["/v1/feedback", "/v1/feedback/decision", "/v1/skills/run", "/v1/escalation/reply"]) {
    const { name, schema } = resultSchema(path);
    const landing = schema.properties?.landing;
    assert.ok(landing, `${name} declares landing`);
    assert.equal(landing.type, "string", `${name}.landing is a string`);
    assert.deepEqual(landing.enum, ["queued"], `${name}.landing's only value is queued`);
    assert.match(landing.description ?? "", /W1-T5460/, `${name}.landing names the landing sweep it waits on`);
    const required = (schema as { required?: string[] }).required ?? [];
    assert.equal(required.includes("landing"), false, `${name}.landing is optional: a failed staging omits it`);
  }
});

test("the generated api-client types landing as an optional queued on all four results", () => {
  const client = readFileSync(new URL("../packages/api-client/src/schema.d.ts", import.meta.url), "utf8");
  for (const name of ["SubmitFeedbackResult", "ProposalDecisionResult", "RunSkillResult", "EscalationReplyResult"]) {
    const block = client.match(new RegExp(`\\n    ${name}: \\{\\n([\\s\\S]*?)\\n    \\};`))?.[1];
    assert.ok(block, `schema.d.ts declares ${name}`);
    assert.match(block, /^ {6}landing\?: "queued";$/m, `${name} types landing?: "queued"`);
  }
});
