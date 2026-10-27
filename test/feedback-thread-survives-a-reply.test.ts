import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { createService } from "../src/lib/service.js";
import { buildPanelGraphRoutes, buildSubmitFeedbackRoute, captureFeedbackReply, type PanelGraphDeps, type RatifyCliGateway } from "#src/lib/panel-graph.js";
import { captureFeedback, listFeedback, readFeedbackEntry, setFeedbackStatus, type FeedbackEntry, type CanonicalGrillContinuation } from "#src/lib/feedback.js";
import { queueFeedbackRecord, readQueuedFeedbackRecords } from "#src/lib/feedback-landing.js";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { TraceGithub, TracePrView } from "../src/lib/trace.js";
import type { GitHub } from "../src/lib/status.js";
import { landQueuedFeedback } from "./helpers/land-queued-feedback.js";

// ── W1-T2278: a reply is a new item, and the link back to what it answers must be a durable ────
// field, not only prose inside the reply's own text ─────────────────────────────────────────
//
// The route already validates `replyTo` against a real `grilling` entry and refuses loudly when
// it does not resolve, or resolves to something not parked `grilling` -- that part of the console
// already worked and this task does not touch it. What this task fixes: the edge that validation
// proves it KNOWS about was being thrown away the moment the write happened -- the answer landed
// as a fresh entry whose ONLY record of what it answers was a human-readable prefix folded into
// `raw`, the target entry was left exactly as it was (still `grilling`, so it could be "answered"
// any number of times), and the relationship was structured nowhere any reader could walk.
//
// Acceptance criteria (plan/tasks.d/W1-T2278-...yaml), each proven by name below:
//   1. the record of an answer carries the identifier of what it answers as a FIELD
//   2. a thread is enumerable from the ANSWERED end, not only the answering end
//   3. answering advances the answered record out of the state that means awaiting an answer
//   4. a second answer to an already-answered record is refused, naming the state it is in
//   5. a reply naming no known record is still refused exactly as it is refused today
//   6. a submission carrying no reply reference behaves identically to today (record + status)
//   7. the reply route keeps the tier it already carries rather than gaining a new one
//   8. no code path advances a record to a closed state without an operator message causing it
//   9. no route added by this change files work, merges, closes a PR, or rejects on the operator's
//      behalf

const READ_TOKEN = "thread-read-token";
const WRITE_TOKEN = "thread-write-token";

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "rmd-feedback-thread-"));
}

function emptyPlanPath(root: string): string {
  const planPath = join(root, "plan", "tasks.yaml");
  mkdirSync(join(root, "plan"), { recursive: true });
  writeFileSync(planPath, "[]\n", { flag: "wx" });
  return planPath;
}

function fakeGithub(byRef: Record<string, TracePrView> = {}): TraceGithub {
  return { prView: (ref) => byRef[String(ref)] ?? null };
}

function fakeStatusGithub(): GitHub {
  return {
    prByRef: () => null,
    findMergedByTrailer: () => null,
    headRefName: () => undefined,
    prBody: () => undefined,
  };
}

function fakeRatifyGateway(): RatifyCliGateway {
  return {
    approve() {},
    reframe() {},
  };
}

function depsFor(root: string, planPath: string): PanelGraphDeps {
  return {
    root,
    inboxRoot: root,
    planPath,
    ledgerPath: join(root, "state", "ledger.ndjson"),
    github: fakeGithub(),
    statusGithub: fakeStatusGithub(),
    ratify: fakeRatifyGateway(),
  };
}

async function withService<T>(deps: PanelGraphDeps, fn: (baseUrl: string) => Promise<T>): Promise<T> {
  const server = createService({ tokens: { read: READ_TOKEN, write: WRITE_TOKEN }, routes: buildPanelGraphRoutes(deps) });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function post(base: string, path: string, token: string, body: unknown) {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Parks a fresh entry at `grilling`, the precondition every `replyTo` test needs. */
function grillingEntry(root: string, raw: string): FeedbackEntry {
  const entry = captureFeedback(root, { raw, origin: "cli" });
  return setFeedbackStatus(root, entry.id, "grilling");
}

/** Protocol fixture for the internal writer's captured evidence. The actual constructor is
 * exercised through the real Git reader in the companion suite; this tests the writer boundary
 * without importing a new runtime export that would prevent the unchanged base from executing. */
function capturedCanonicalParent(t: TestContext) {
  const dir = tmpRoot(), root = join(dir, "root"), stateRoot = join(dir, "pending");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(root, "plan", "feedback"), { recursive: true }); mkdirSync(stateRoot);
  const id = "w10789-captured-parent", rel = `plan/feedback/${id}.yaml`, path = join(root, rel);
  const pending = { id, ts: "2026-10-27T00:00:00.000Z", raw: "Preserve this captured lineage", attachments: ["proof.txt"],
    origin: "cli", status: "new", proposal_pr: null, summary: null, reply_to: "earlier-parent", thread_id: "earlier-thread",
    submission_key: "original-capture", source_lineage: { repository: "fixture/repo", sequence: 7 } };
  writeFileSync(path, stringifyYaml(pending)); queueFeedbackRecord(root, rel, stateRoot);
  writeFileSync(path, stringifyYaml({ ...pending, status: "grilling", answered_by: null,
    proposal_pr: "https://github.com/fixture/repo/pull/7", summary: { headline: "Original decision card" } }));
  const canonical = parseYaml(readFileSync(path, "utf8")) as FeedbackEntry;
  const digest = (r: unknown) => createHash("sha256").update(JSON.stringify(r)).digest("hex");
  const continuation: CanonicalGrillContinuation = { root, inboxRoot: stateRoot, canonical,
    pendingFingerprint: digest(readQueuedFeedbackRecords(stateRoot).get(rel)), canonicalFingerprint: digest(canonical) };
  const deps = { root, inboxRoot: stateRoot, feedbackLand: {} };
  const input = { text: "Use the existing verification owner", replyTo: id, submissionKey: "issue#7:comment:9", origin: "issue" as const };
  const snapshot = () => {
    const out: Record<string, string> = {};
    const walk = (p: string): void => { if (!existsSync(p)) return;
      for (const e of readdirSync(p, { withFileTypes: true })) {
        const path = join(p, e.name); if (e.isDirectory()) walk(path); else out[path] = readFileSync(path, "utf8");
      }
    }; walk(dir); return out;
  };
  const rewritePending = (change: (r: Record<string, unknown>) => void) => {
    const original = readFileSync(path, "utf8"), p = parseYaml(stringifyYaml(pending)) as Record<string, unknown>;
    change(p); writeFileSync(path, stringifyYaml(p));
    try { queueFeedbackRecord(root, rel, stateRoot); } finally { writeFileSync(path, original); }
  };
  return { root, stateRoot, id, rel, path, canonical, continuation, deps, input, snapshot, rewritePending };
}

test("W1-T10789: continuation retains the canonical proposal and source metadata", t => {
  const f = capturedCanonicalParent(t), canonicalBytes = readFileSync(f.path, "utf8");
  const { entry, landingError } = captureFeedbackReply(f.deps, f.input, f.continuation);
  assert.equal(landingError, undefined);
  assert.equal(entry.reply_to, f.id); assert.equal(entry.submission_key, f.input.submissionKey);
  assert.deepEqual(readQueuedFeedbackRecords(f.stateRoot).get(f.rel), { ...f.canonical, status: "answered", answered_by: entry.id });
  assert.equal(readFileSync(f.path, "utf8"), canonicalBytes, "the canonical checkout and source history stay untouched");
});

test("W1-T10789: current queued decisions and legacy reply callers keep their guards", async t => {
  const cases: Array<[string, (f: ReturnType<typeof capturedCanonicalParent>) => void]> = [
    ["pending identity changed", f => f.rewritePending(r => { r.answered_by = null; })],
    ["pending direction changed", f => f.rewritePending(r => { r.raw = "New direction"; })],
    ["pending decision advanced", f => f.rewritePending(r => { r.status = "rejected"; })],
    ["canonical metadata changed after capture", f => { f.continuation.canonical.proposal_pr = "https://github.com/fixture/repo/pull/8"; }],
    ["foreign checkout", f => { f.continuation.root = join(f.root, "other"); }],
    ["foreign pending scope", f => { f.continuation.inboxRoot = join(f.stateRoot, "other"); }],
    ["competing answer", f => { captureFeedback(f.root, { raw: "Another accepted answer", origin: "ui", replyTo: f.id, land: { stateRoot: f.stateRoot } }); }],
  ];
  for (const [label, change] of cases) await t.test(label, t => {
    const f = capturedCanonicalParent(t); change(f); const before = f.snapshot();
    assert.throws(() => captureFeedbackReply(f.deps, f.input, f.continuation), /canonical grill continuation/);
    assert.deepEqual(f.snapshot(), before, "refusal happens before creating any new reply or changing pending work");
  });
  await t.test("missing stable intent or landing bridge refuses before capture", t => {
    const f = capturedCanonicalParent(t), before = f.snapshot();
    assert.throws(() => captureFeedbackReply(f.deps, { ...f.input, submissionKey: undefined }, f.continuation), /canonical grill/);
    assert.throws(() => captureFeedbackReply({ ...f.deps, feedbackLand: undefined }, f.input, f.continuation), /canonical grill/);
    assert.deepEqual(f.snapshot(), before);
  });
  await t.test("canonical base cannot be reused for a different transition", t => {
    const f = capturedCanonicalParent(t), before = f.snapshot();
    assert.throws(() => setFeedbackStatus(f.root, f.id, "rejected", { canonicalBase: f.canonical, land: { stateRoot: f.stateRoot } }), /canonical reply parent/);
    assert.throws(() => setFeedbackStatus(f.root, f.id, "answered", { canonicalBase: f.canonical }), /canonical reply parent/);
    assert.deepEqual(f.snapshot(), before);
  });
  await t.test("ordinary HTTP caller cannot replace a rejected source with client-supplied evidence", async t => {
    const f = capturedCanonicalParent(t);
    writeFileSync(f.path, stringifyYaml({ ...f.canonical, status: "rejected" }));
    const before = f.snapshot();
    await withService({ ...depsFor(f.root, join(f.root, "plan", "tasks.yaml")), ...f.deps }, async base => {
      const response = await post(base, "/v1/feedback", WRITE_TOKEN, { ...f.input,
        continuation: f.continuation, canonicalBase: f.canonical });
      assert.equal(response.ok, false); await response.text();
    });
    assert.deepEqual(f.snapshot(), before);
  });
});

// ── 1, 2, 3: the edge lands on BOTH ends, and answering closes the question ─────────────────

test("a reply carries reply_to as a field, and the answered entry carries answered_by back -- a thread walks both ways", async () => {
  const root = tmpRoot();
  const planPath = emptyPlanPath(root);
  const parked = grillingEntry(root, "does this want a CLI flag or a config default?");

  let replyId = "";
  await withService(depsFor(root, planPath), async (base) => {
    const res = await post(base, "/v1/feedback", WRITE_TOKEN, { text: "a config default, please", replyTo: parked.id });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { entry: FeedbackEntry };
    // Criterion 1: the FIELD, not merely the prefix already folded into `raw`.
    assert.equal(body.entry.reply_to, parked.id);
    replyId = body.entry.id;
  });

  // Criterion 2: enumerable from the ANSWERED end -- read the target back and find the reply
  // without parsing any entry's `raw` text.
  const target = readFeedbackEntry(root, parked.id);
  assert.equal(target.answered_by, replyId);

  // Criterion 3: answering ADVANCES the target out of "awaiting an answer" -- it is no longer
  // `grilling` (the pre-existing bug: it used to stay `grilling` forever).
  assert.equal(target.status, "answered");
  assert.notEqual(target.status, "grilling");

  // A thread is enumerable end to end via listFeedback too, once the sweep lands the reply (W1-T5628).
  landQueuedFeedback(root, root);
  const all = listFeedback(root);
  const reply = all.find((e) => e.id === replyId)!;
  const question = all.find((e) => e.id === parked.id)!;
  assert.equal(reply.reply_to, question.id);
  assert.equal(question.answered_by, reply.id);
});

// ── 4: a second answer to an already-answered record is refused, naming the state ───────────

test("a second replyTo at an already-answered entry is refused, naming 'answered' -- not silently accepted or misfiled", async () => {
  const root = tmpRoot();
  const planPath = emptyPlanPath(root);
  const parked = grillingEntry(root, "one question, only one answer");

  await withService(depsFor(root, planPath), async (base) => {
    const first = await post(base, "/v1/feedback", WRITE_TOKEN, { text: "first answer", replyTo: parked.id });
    assert.equal(first.status, 200);

    const second = await post(base, "/v1/feedback", WRITE_TOKEN, { text: "second answer", replyTo: parked.id });
    assert.equal(second.status, 400);
    const body = (await second.json()) as { detail: string };
    assert.match(body.detail, /status: answered/);
    assert.match(body.detail, /nothing to answer/);
  });

  // The second attempt must not have filed anything or re-parented the target.
  landQueuedFeedback(root, root);
  const target = readFeedbackEntry(root, parked.id);
  const all = listFeedback(root);
  const answers = all.filter((e) => e.reply_to === parked.id);
  assert.equal(answers.length, 1, "only the first reply should ever be linked to this target");
  assert.equal(target.answered_by, answers[0].id);
});

// ── 5: a reply naming no known record is still refused exactly as it is refused today ───────

test("replyTo naming an unknown entry -> 400, exactly today's refusal, files nothing", async () => {
  const root = tmpRoot();
  const planPath = emptyPlanPath(root);
  await withService(depsFor(root, planPath), async (base) => {
    const res = await post(base, "/v1/feedback", WRITE_TOKEN, { text: "x", replyTo: "fb-does-not-exist" });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { detail: string };
    assert.match(body.detail, /names no known feedback entry/);
  });
  assert.deepEqual(listFeedback(root), []);
});

test("replyTo naming a non-grilling entry -> 400, nothing to answer", async () => {
  const root = tmpRoot();
  const planPath = emptyPlanPath(root);
  const notGrilling = captureFeedback(root, { raw: "already new", origin: "cli" });
  await withService(depsFor(root, planPath), async (base) => {
    const res = await post(base, "/v1/feedback", WRITE_TOKEN, { text: "x", replyTo: notGrilling.id });
    assert.equal(res.status, 400);
  });
});

// ── 6: no reply reference -> identical to today, in record and in status ───────────────────

test("a submission with no replyTo behaves identically to today: reply_to null, status new, no other entry touched", async () => {
  const root = tmpRoot();
  const planPath = emptyPlanPath(root);
  const bystander = grillingEntry(root, "an unrelated grilling entry that must not move");

  await withService(depsFor(root, planPath), async (base) => {
    const res = await post(base, "/v1/feedback", WRITE_TOKEN, { text: "the drain retry banner overlaps the status pill" });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { entry: FeedbackEntry };
    assert.equal(body.entry.status, "new");
    assert.equal(body.entry.raw, "the drain retry banner overlaps the status pill");
    assert.equal(body.entry.reply_to, null);
    assert.equal(body.entry.answered_by, undefined);
  });

  // Nothing else in the inbox was disturbed by a plain, non-reply submission.
  const unrelated = readFeedbackEntry(root, bystander.id);
  assert.equal(unrelated.status, "grilling");
  assert.equal(unrelated.answered_by ?? null, null);
});

// ── 7: the reply route keeps the tier it already carries ───────────────────────────────────

test("POST /v1/feedback stays write-scoped, tier low -- no new tier introduced for the reply gesture", () => {
  const root = tmpRoot();
  const planPath = emptyPlanPath(root);
  const route = buildSubmitFeedbackRoute(depsFor(root, planPath));
  assert.equal(route.scope, "write");
  assert.equal(route.tier, "low");
});

// ── 8, 9: architectural invariants -- static proof over the actual source, not just behavior ──
//
// "no code path advances a record to a closed state without an operator message causing it" and
// "no route added by this change files work, merges, closes a pull request, or rejects on the
// operator's behalf" are properties of the WHOLE tree, not just of one request/response pair --
// proven here by scanning the real source rather than trusting a single exercised path.

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");

function readSrc(relPath: string): string {
  return readFileSync(join(REPO_ROOT, "src", relPath), "utf8");
}

test("setFeedbackStatus(..., \"answered\", ...) is written from exactly ONE call site in the whole tree", () => {
  const files = ["lib/panel-graph.ts", "lib/ops.ts", "lib/panel-skill-run.ts", "run-task.ts", "lib/triage.ts", "lib/sweep.ts"];
  const callSitePattern = /setFeedbackStatus\([^)]*?"answered"/gs;
  let totalCalls = 0;
  let panelGraphCalls = 0;
  for (const rel of files) {
    let src: string;
    try {
      src = readSrc(rel);
    } catch {
      continue; // a listed file that doesn't exist in this checkout just contributes zero matches
    }
    const matches = src.match(callSitePattern) ?? [];
    totalCalls += matches.length;
    if (rel === "lib/panel-graph.ts") panelGraphCalls = matches.length;
  }
  assert.equal(totalCalls, 1, "exactly one call site in the tree may ever write status: \"answered\"");
  assert.equal(panelGraphCalls, 1, "that one call site must be in panel-graph.ts -- the console route the operator's own reply hits");
});

test("the reply-handling branch of buildSubmitFeedbackRoute names no merge, no PR-close, no reject-on-operator's-behalf action", () => {
  const src = readSrc("lib/panel-graph.ts");
  const fnMatch = /export function buildSubmitFeedbackRoute\(deps: PanelGraphDeps\): Route \{[\s\S]*?\n\}/.exec(src);
  assert.ok(fnMatch, "buildSubmitFeedbackRoute must exist");
  // W1-T8511: the reply half moved into captureFeedbackReply, which the route (and the GitHub-reply reader) calls.
  const writerMatch = /export function captureFeedbackReply\([^)]*\)[^{]*\{[\s\S]*?\n\}/.exec(src);
  assert.ok(writerMatch, "captureFeedbackReply must exist");
  assert.match(fnMatch[0], /captureFeedbackReply\(deps,/, "the route writes its reply through captureFeedbackReply");
  const body = `${fnMatch[0]}\n${writerMatch[0]}`;
  assert.doesNotMatch(body, /gh\s+pr\s+(merge|close)/i);
  assert.doesNotMatch(body, /["']merged["']|["']rejected_by_fleet["']/);
  // The only status this route ever writes explicitly is the reply-close state itself.
  const statusWrites = [...body.matchAll(/setFeedbackStatus\([^,]+,\s*[^,]+,\s*"([a-z]+)"/g)].map((m) => m[1]);
  assert.deepEqual(new Set(statusWrites), new Set(["answered"]));
});
