// test/sre/incident-template-publication.test.ts — W1-T13131: incident identity and published evidence require a
// source-owned literal template; an untemplated event fails closed with a counted refusal. Each criterion drives the
// production route (buildIncidentEventsRoute over a real service) and the production pass (runSreLanePass writing a real
// temporary plan/feedback directory), never a stand-in for either.
// @census-reads: src/lib/service.ts src/lib/board.ts src/lib/incident-invariants.ts src/lib/fleet-flow-detectors.ts src/lib/operator-interventions.ts — the files each catalog literal is quoted from.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { fixedClock, type Clock } from "#src/lib/clock.js";
import { captureFeedback, feedbackDir, listFeedback } from "#src/lib/feedback.js";
import { buildIncidentEventsRoute, INCIDENT_INGEST_ROUTE_PATH } from "#src/lib/incident-events.js";
import {
  INCIDENT_TEMPLATE_CATALOG,
  incidentTemplateCatalogProblems,
  incidentTemplateFingerprint,
  incidentTemplateFingerprintBasis,
  type IncidentTemplate,
} from "#src/lib/incident-templates.js";
import { createService } from "#src/lib/service.js";
import {
  incidentEventFromLedgerRow,
  incidentFeedbackId,
  incidentFeedbackOrigin,
  runSreLanePass,
  sreLaneOffPath,
  sreLaneStorePath,
  sreLaneTemplateRefusalsPath,
  type IncidentLedgerEvent,
  type SreLaneInput,
} from "#src/lib/sre-lane.js";
import { writeLedger } from "#test/helpers/ledger-fixture.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const NOW = Date.parse("2026-11-20T12:00:00.000Z");
const MIN = 60_000;
const WRITE = "w13131-write-token";
const READ = "w13131-read-token";

function template(id: string): IncidentTemplate {
  const found = INCIDENT_TEMPLATE_CATALOG.find((t) => t.id === id);
  assert.ok(found, `fixture: ${id} is a catalog template`);
  return found;
}

const INTERNAL = template("service.internal-error");
const BOARD = template("board.status-unavailable");

function scratch(t: TestContext, name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `rmd-w13131-${name}-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "state"), { recursive: true });
  return dir;
}

/** The rows a route wrote, parsed. */
function rowsAt(path: string): Array<Record<string, unknown>> {
  return readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** Every file under a directory, as text, so a planted value is searched in all of it — never one field. */
function allText(dir: string): string {
  if (!existsSync(dir)) return "";
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => readFileSync(join(entry.parentPath, entry.name), "utf8"))
    .join("\n");
}

async function withIngest<T>(ledgerPath: string, run: (post: (body: unknown, token?: string) => Promise<Response>) => Promise<T>, opts: { cap?: number; clock?: Clock } = {}): Promise<T> {
  const route = buildIncidentEventsRoute({ ledgerPath }, opts.clock ?? fixedClock(NOW), opts.cap);
  const server = createService({ tokens: { read: READ, write: WRITE }, routes: [route] });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}${INCIDENT_INGEST_ROUTE_PATH}`;
  try {
    return await run((body, token = WRITE) => fetch(url, {
      method: "POST",
      headers: token === "" ? {} : { authorization: `Bearer ${token}` },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }));
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

/** A short secret, a path, a branch and free text — each too short or too plain for any denylist scrub. */
const PLANTED_A = { secret: "k9Zq2x", path: "/home/alice/.ssh/id_rsa", branch: "feat/acme-launch", text: "customer acme overdue" };
const PLANTED_B = { secret: "Qm7w1p", path: "/srv/bob/notes.txt", branch: "fix/globex-merger", text: "globex invoice disputed" };

function plantedValues(p: typeof PLANTED_A): string[] {
  return [p.secret, p.path, p.branch, p.text];
}

function plantedBody(id: string | undefined, p: typeof PLANTED_A, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    source: "gateway", kind: "http_5xx", ...(id === undefined ? {} : { template_id: id }),
    name: `Error ${p.secret}`, message: `${p.text} at ${p.path} on ${p.branch} token ${p.secret}`,
    route: `${p.path}/${p.branch}`, frames: [{ file: p.path, fn: p.branch }], at: new Date(NOW).toISOString(), ...extra,
  };
}

/** A ledger row as a direct (non-HTTP) producer would write it: dynamic values ride in every free-text field. */
function directRow(fingerprint: string, minutesAgo: number, p: typeof PLANTED_A, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    task_id: "INCIDENT", step: "incident.event", fingerprint, kind: "http_5xx", source: "gateway",
    name: `Error ${p.secret}`, message: `${p.text} at ${p.path} on ${p.branch}`, route: p.path, sha: p.branch,
    ts: new Date(NOW - minutesAgo * MIN).toISOString(), ...extra,
  };
}

function laneDeps(root: string, rows: () => Array<Record<string, unknown>>, overrides: Partial<SreLaneInput> = {}): SreLaneInput {
  return {
    stateDir: join(root, "state"), root, clock: fixedClock(NOW), detectors: [], readFlowRows: () => [], writeFlowEvent: () => {},
    readRoutingHistory: async () => [],
    readEvents: () => rows().map((row) => incidentEventFromLedgerRow(row, "core")).filter((e): e is IncidentLedgerEvent => e !== undefined),
    hasOpenTask: () => false, framesFor: () => [], mergedPrsSince: () => [], readLandedEntry: () => null,
    mergedLastDay: () => 10, log: () => {},
    ...overrides,
  };
}

test("W1-T13131 criterion 1: template identity and feedback exclude interpolation values", async (t) => {
  // Ingest: one template, two different sets of planted values, one fingerprint — and a second template is distinct.
  const ingestRoot = scratch(t, "c1-ingest");
  const ledgerPath = writeLedger([], { dir: join(ingestRoot, "state") }).path;
  const answers = await withIngest(ledgerPath, async (post) => {
    const out: Array<{ status: number; fingerprint: string }> = [];
    for (const body of [plantedBody(INTERNAL.id, PLANTED_A), plantedBody(INTERNAL.id, PLANTED_B), plantedBody(BOARD.id, PLANTED_A)]) {
      const res = await post(body);
      out.push({ status: res.status, fingerprint: ((await res.json()) as { fingerprint: string }).fingerprint });
    }
    return out;
  });
  assert.deepEqual(answers.map((a) => a.status), [200, 200, 200], "every event names a resolvable template");
  assert.equal(answers[0].fingerprint, answers[1].fingerprint, "different values of one template share one identity");
  assert.notEqual(answers[0].fingerprint, answers[2].fingerprint, "distinct templates stay distinct with identical values");
  assert.equal(answers[0].fingerprint, incidentTemplateFingerprint(INTERNAL, "http_5xx"), "the identity is the template's");
  const basis = incidentTemplateFingerprintBasis(INTERNAL, "http_5xx");
  for (const value of [...plantedValues(PLANTED_A), ...plantedValues(PLANTED_B)]) {
    assert.ok(!basis.includes(value), `the fingerprint basis holds no interpolation value: ${value}`);
  }
  assert.ok(basis.includes(INTERNAL.literal), "control: the basis does carry the template literal");
  const ledgered = rowsAt(ledgerPath);
  assert.deepEqual(ledgered.map((r) => r.template_id), [INTERNAL.id, INTERNAL.id, BOARD.id], "each row names its resolved template");

  // Publication: the same template's incident filed from rows carrying A's values and from rows carrying B's files the same bytes.
  const fp = incidentTemplateFingerprint(INTERNAL, "http_5xx");
  const filed: Array<{ raw: string; origin: unknown; id: string; files: string }> = [];
  for (const [name, planted] of [["c1-a", PLANTED_A], ["c1-b", PLANTED_B]] as const) {
    const root = scratch(t, name);
    const rows = [directRow(fp, 30, planted, { template_id: INTERNAL.id }), directRow(fp, 10, planted, { template_id: INTERNAL.id })];
    const pass = await runSreLanePass(laneDeps(root, () => rows));
    assert.equal(pass.filed, fp, `${name}: the templated incident is filed`);
    const [entry] = listFeedback(root);
    filed.push({ raw: entry.raw, origin: entry.origin, id: entry.id, files: allText(feedbackDir(root)) });
  }
  assert.equal(filed[0].raw, filed[1].raw, "changing the values changes no published byte");
  assert.deepEqual([filed[0].origin, filed[0].id], [filed[1].origin, filed[1].id], "nor the capture's origin or id");
  assert.ok(filed[0].raw.includes(`Message template: ${INTERNAL.literal}`), "control: the body is built from the literal template");
  for (const [i, planted] of [PLANTED_A, PLANTED_B].entries()) {
    for (const value of plantedValues(planted)) {
      assert.ok(!filed[i].files.includes(value), `no interpolation value reaches the feedback file: ${value}`);
    }
  }
});

test("W1-T13131 criterion 2: unresolved templates are refused and counted once", async (t) => {
  // Ingest: missing, unknown, two malformed and one mismatched template — each refused before fingerprinting.
  const ingestRoot = scratch(t, "c2-ingest");
  const ledgerPath = writeLedger([], { dir: join(ingestRoot, "state") }).path;
  const cases: Array<[Record<string, unknown>, string]> = [
    [plantedBody(undefined, PLANTED_A), "missing"],
    [plantedBody(`no.such-template-${PLANTED_A.secret.toLowerCase()}`, PLANTED_A), "unknown"],
    [plantedBody(undefined, PLANTED_A, { template_id: 42 }), "malformed"],
    [plantedBody(`internal_error {${PLANTED_A.secret}}`, PLANTED_A), "malformed"],
    [plantedBody(INTERNAL.id, PLANTED_A, { kind: "latency" }), "mismatched"],
  ];
  await withIngest(ledgerPath, async (post) => {
    for (const [body, reason] of cases) {
      const res = await post(body);
      const json = (await res.json()) as Record<string, unknown>;
      assert.equal(res.status, 422, `${reason}: refused`);
      assert.deepEqual(json, { error: "template_refused", reason, accepted: false, sampled: false }, `${reason}: the answer names no fingerprint`);
    }
  });
  const rows = rowsAt(ledgerPath);
  assert.deepEqual(rows.map((r) => [r.step, r.reason]), cases.map(([, reason]) => ["incident.refused", reason]), "one counted refusal per refused input");
  assert.ok(rows.every((r) => r.fingerprint === undefined && r.template_id === undefined), "a refused input is never fingerprinted");
  const ledgerText = readFileSync(ledgerPath, "utf8");
  for (const value of plantedValues(PLANTED_A)) assert.ok(!ledgerText.includes(value), `a refusal row is payload-free: ${value}`);

  // Direct ledger publication: rows that bypassed ingest, with no, an unknown and a malformed template, are refused.
  const root = scratch(t, "c2-lane");
  const legacy = "1".repeat(64);
  const direct = [
    directRow(legacy, 50, PLANTED_A),
    directRow(legacy, 40, PLANTED_A, { template_id: "no.such-template" }),
    directRow(legacy, 30, PLANTED_A, { template_id: ["service.internal-error"] }),
  ];
  const logs: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const ran: string[] = [];
  const deps = laneDeps(root, () => direct, {
    log: (step, extra) => logs.push({ step, extra }),
    runbookPass: async (incident) => { ran.push(incident.fingerprint); return { outcome: "no_match", fileFeedback: true }; },
  });
  for (let pass = 0; pass < 3; pass++) assert.equal((await runSreLanePass(deps)).filed, undefined, `pass ${pass}: nothing is filed`);
  assert.equal(listFeedback(root).length, 0, "no refusal creates incident feedback");
  assert.deepEqual(ran, [], "no refusal reaches a runbook");
  const refusals = logs.filter((l) => l.step === "sre_lane.template_refused");
  assert.deepEqual(refusals.map((l) => l.extra), [{ refused: 3, missing: 1, unknown: 1, malformed: 1, mismatched: 0 }],
    "three passes over the same rows count each refused input once");
  const memory = readFileSync(sreLaneTemplateRefusalsPath(join(root, "state")), "utf8");
  assert.equal(Object.keys((JSON.parse(memory) as { counted: object }).counted).length, 3);
  for (const value of [...plantedValues(PLANTED_A), legacy]) assert.ok(!memory.includes(value), `the refusal memory holds no ledgered value: ${value}`);

  // A newly arrived refused row is counted, once, beside the ones already counted.
  direct.push(directRow(legacy, 5, PLANTED_A));
  await runSreLanePass(deps);
  await runSreLanePass(deps);
  assert.deepEqual(logs.filter((l) => l.step === "sre_lane.template_refused").map((l) => l.extra?.refused), [3, 1]);
});

test("W1-T13131 criterion 3: a valid template files safely beside a refused legacy event", async (t) => {
  // Positive control on the catalog itself: every seed is well formed, and each literal's fixed text is in its source.
  // @source-text-subject: each catalog entry claims its literal is quoted from a source file; that quotation IS the subject.
  assert.deepEqual(incidentTemplateCatalogProblems(INCIDENT_TEMPLATE_CATALOG), []);
  for (const entry of INCIDENT_TEMPLATE_CATALOG) {
    const source = readFileSync(join(REPO_ROOT, entry.quotedFrom), "utf8");
    for (const fragment of entry.literal.split(/\{[a-z_]+\}/).map((f) => f.trim()).filter((f) => f.length > 2)) {
      assert.ok(source.includes(fragment), `${entry.id}: "${fragment}" is quoted from ${entry.quotedFrom}`);
    }
  }

  const root = scratch(t, "c3");
  const valid = incidentTemplateFingerprint(INTERNAL, "http_5xx");
  const legacy = "2".repeat(64);
  const forged = "3".repeat(64);
  const rows = [
    // The worse incident: many legacy rows (no template) burning fast.
    ...Array.from({ length: 12 }, (_, i) => directRow(legacy, 12 - i, PLANTED_B)),
    // An arbitrary client string in the template field carries a planted value: refused, never echoed.
    ...Array.from({ length: 6 }, (_, i) => directRow(forged, 6 - i, PLANTED_B, { template_id: `x.${PLANTED_B.secret.toLowerCase()}` })),
    // The valid incident: one row, its free-text fields still full of planted values, and an unsafe deploy sha.
    directRow(valid, 120, PLANTED_A, { template_id: INTERNAL.id, sha: `${PLANTED_A.branch}?token=${PLANTED_A.secret}` }),
    directRow(valid, 60, PLANTED_A, { template_id: INTERNAL.id, sha: "0123abcd" }),
  ];
  const safePr = "https://github.com/o/r/pull/101";
  const unsafePr = `https://evil.example/${PLANTED_A.path}?k=${PLANTED_A.secret}`;
  const pass = await runSreLanePass(laneDeps(root, () => rows, {
    framesFor: () => [{ file: "src/lib/service.ts", fn: "dispatch" }],
    mergedPrsSince: () => [{ url: safePr, files: ["src/lib/service.ts"] }, { url: unsafePr, files: ["src/lib/service.ts"] }],
  }));
  assert.equal(pass.filed, valid, "the refused worse incident hides no valid candidate");
  const entries = listFeedback(root);
  assert.deepEqual(entries.map((e) => [e.id, e.origin]), [[incidentFeedbackId(valid), incidentFeedbackOrigin(valid)]]);
  const files = readdirSync(feedbackDir(root)).filter((f) => f.endsWith(".yaml"));
  assert.equal(files.length, 1, "the filing is a real file in the temporary plan/feedback directory");
  const text = allText(feedbackDir(root));
  assert.ok(text.includes(INTERNAL.literal) && text.includes(INTERNAL.classification), "the body is the resolved template");
  assert.ok(text.includes("Count: 2,") && text.includes("Deploy sha(s): 0123abcd"), "named safe fields ride: count and a validated sha");
  assert.ok(text.includes(safePr), "a suspect PR inside its policy is named");
  for (const value of [...plantedValues(PLANTED_A), ...plantedValues(PLANTED_B), unsafePr, legacy.slice(0, 12), forged.slice(0, 12), "Error "]) {
    assert.ok(!text.includes(value), `nothing unsafe or refused reaches the filing: ${value}`);
  }
});

test("W1-T13131 criterion 4: eligible controls and historical evidence remain intact", async (t) => {
  // Ingest controls for an eligible templated event: authorization, the body bound and per-fingerprint sampling.
  const ingestRoot = scratch(t, "c4-ingest");
  const ledgerPath = writeLedger([], { dir: join(ingestRoot, "state") }).path;
  await withIngest(ledgerPath, async (post) => {
    const eligible = plantedBody(INTERNAL.id, PLANTED_A);
    const unauthenticated = await post(eligible, "");
    await unauthenticated.arrayBuffer();
    assert.equal(unauthenticated.status, 401, "no bearer is still refused");
    const readOnly = await post(eligible, READ);
    await readOnly.arrayBuffer();
    assert.equal(readOnly.status, 403, "a read bearer is still refused on the write route");
    const huge = await post(plantedBody(INTERNAL.id, PLANTED_A, { message: "x".repeat(20 * 1024) }));
    await huge.arrayBuffer();
    assert.equal(huge.status, 413, "the body bound still applies");
    const sampled: boolean[] = [];
    for (let i = 0; i < 4; i++) sampled.push(((await (await post(eligible)).json()) as { sampled: boolean }).sampled);
    assert.deepEqual(sampled, [false, false, true, true], "sampling still caps the fingerprint per minute");
  }, { cap: 2 });
  assert.deepEqual(rowsAt(ledgerPath).map((r) => r.step), ["incident.event", "incident.event", "incident.sampled"]);

  // SRE controls for an eligible incident: pause, pacing, open feedback, open task and a landed open entry each hold it.
  const fp = incidentTemplateFingerprint(INTERNAL, "http_5xx");
  const eligibleRows = () => [directRow(fp, 20, PLANTED_A, { template_id: INTERNAL.id })];
  const held = async (name: string, overrides: Partial<SreLaneInput>, before?: (root: string) => void) => {
    const root = scratch(t, `c4-${name}`);
    before?.(root);
    const pass = await runSreLanePass(laneDeps(root, eligibleRows, overrides));
    assert.equal(pass.filed, undefined, `${name} still holds an eligible incident`);
  };
  await held("paused", {}, (root) => writeFileSync(sreLaneOffPath(join(root, "state")), ""));
  await held("paced", { mergedLastDay: () => 0 });
  await held("open-task", { hasOpenTask: () => true });
  await held("landed", {
    readLandedEntry: (id) => ({
      id, ts: new Date(NOW).toISOString(), raw: "landed", attachments: [], origin: incidentFeedbackOrigin(fp), status: "new",
      reply_to: null, proposal_pr: null, summary: null, expansion: null, submission_key: null, thread_id: null,
    }),
  });
  const openRoot = scratch(t, "c4-open");
  assert.equal((await runSreLanePass(laneDeps(openRoot, eligibleRows))).filed, fp, "control: with no hold the incident files");
  assert.equal((await runSreLanePass(laneDeps(openRoot, eligibleRows))).filed, undefined, "its own open feedback holds a second filing");

  // History: a legacy fingerprint's landed feedback and decision record are never rewritten by its refusal.
  const root = scratch(t, "c4-history");
  const legacy = "4".repeat(64);
  captureFeedback(root, { id: incidentFeedbackId(legacy), raw: "Incident 444444444444: exception TypeError (legacy)", origin: incidentFeedbackOrigin(legacy) });
  const storePath = sreLaneStorePath(join(root, "state"));
  writeFileSync(storePath, JSON.stringify({ [legacy]: { ts: "2026-11-01T00:00:00.000Z", count: 3 } }) + "\n");
  const before = { feedback: allText(feedbackDir(root)), store: readFileSync(storePath, "utf8") };
  const ran: string[] = [];
  const pass = await runSreLanePass(laneDeps(root, () => [directRow(legacy, 5, PLANTED_A), directRow(legacy, 1, PLANTED_A)], {
    runbookPass: async (incident) => { ran.push(incident.fingerprint); return { outcome: "no_match", fileFeedback: true }; },
  }));
  assert.equal(pass.filed, undefined);
  assert.deepEqual(ran, [], "a refusal never initiates a fix");
  assert.equal(allText(feedbackDir(root)), before.feedback, "already-landed feedback is unchanged");
  assert.equal(readFileSync(storePath, "utf8"), before.store, "the legacy fingerprint's decision record is unchanged");
});
