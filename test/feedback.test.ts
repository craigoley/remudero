import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parse as parseYaml } from "yaml";
import {
  FEEDBACK_ORIGINS,
  FEEDBACK_STATUSES,
  FeedbackError,
  buildFeedbackExpansionPrompt,
  buildFeedbackExpansionSpawnArgs,
  captureFeedback,
  expandFeedbackDraft,
  feedbackAttachmentsDir,
  feedbackEntryPath,
  findFeedbackBySubmissionKey,
  isValidFeedbackOrigin,
  listFeedback,
  parseFeedbackAddArgs,
  readFeedbackEntry,
  realFeedbackExpander,
  recentFeedbackFewShot,
  resolveFeedbackExpansionMount,
  setFeedbackStatus,
  validateFeedbackExpansion,
  type FeedbackExpanderDeps,
  type FeedbackExpansion,
} from "../src/lib/feedback.js";
import type { Mount, Mounts } from "../src/lib/mounts.js";
import { validateMounts } from "../src/lib/mounts.js";
import type { spawnWorker, WorkerResult } from "../src/lib/worker.js";

function root(): string {
  return mkdtempSync(join(tmpdir(), "rmd-feedback-"));
}

// ── parseFeedbackAddArgs (pure) ──────────────────────────────────────────────

test("parseFeedbackAddArgs: bare text with no flags, default origin cli, no attachments", () => {
  const parsed = parseFeedbackAddArgs(["the", "drain", "loop", "hung"]);
  assert.deepEqual(parsed, { raw: "the drain loop hung", attachments: [], origin: "cli" });
});

test("parseFeedbackAddArgs: --attach is repeatable and order-independent relative to text", () => {
  const parsed = parseFeedbackAddArgs(["broken", "--attach", "shot.png", "ui", "--attach", "https://x.test/log"]);
  assert.deepEqual(parsed, {
    raw: "broken ui",
    attachments: ["shot.png", "https://x.test/log"],
    origin: "cli",
  });
});

test("parseFeedbackAddArgs: --origin accepts every value in the closed enum", () => {
  for (const origin of FEEDBACK_ORIGINS) {
    const parsed = parseFeedbackAddArgs(["x", "--origin", origin]);
    assert.deepEqual(parsed, { raw: "x", attachments: [], origin });
  }
});

test("parseFeedbackAddArgs FAILS LOUD: unrecognized flag returns an error, not a silent guess", () => {
  const parsed = parseFeedbackAddArgs(["hi", "--bogus", "wat"]);
  assert.ok("error" in parsed);
  assert.match((parsed as { error: string }).error, /unrecognized flag '--bogus'/);
});

test("parseFeedbackAddArgs FAILS LOUD: --origin outside the enum is rejected", () => {
  const parsed = parseFeedbackAddArgs(["hi", "--origin", "telepathy"]);
  assert.ok("error" in parsed);
  assert.match((parsed as { error: string }).error, /--origin must be one of/);
});

test("parseFeedbackAddArgs FAILS LOUD: no text at all is rejected", () => {
  const parsed = parseFeedbackAddArgs(["--origin", "cli"]);
  assert.ok("error" in parsed);
  assert.match((parsed as { error: string }).error, /no feedback text given/);
});

test("parseFeedbackAddArgs FAILS LOUD: --attach with no value is rejected", () => {
  const parsed = parseFeedbackAddArgs(["hi", "--attach"]);
  assert.ok("error" in parsed);
  assert.match((parsed as { error: string }).error, /--attach requires a value/);
});

// ── captureFeedback (I/O) ─────────────────────────────────────────────────────

test("captureFeedback writes plan/feedback/<id>.yaml with status new and the §7B schema shape", () => {
  const r = root();
  const entry = captureFeedback(r, { raw: "the digest fired twice" });

  assert.equal(entry.raw, "the digest fired twice");
  assert.equal(entry.status, "new");
  assert.equal(entry.origin, "cli");
  assert.deepEqual(entry.attachments, []);
  assert.equal(entry.proposal_pr, null);
  assert.match(entry.id, /^fb-\d+-[0-9a-f]{6}$/);
  assert.ok(!Number.isNaN(Date.parse(entry.ts)));

  const p = feedbackEntryPath(r, entry.id);
  assert.ok(existsSync(p));
  const onDisk = parseYaml(readFileSync(p, "utf8"));
  assert.deepEqual(onDisk, entry);
});

test("captureFeedback returns instantly (no network/LLM) and never lost — two captures land as two files", () => {
  const r = root();
  const a = captureFeedback(r, { raw: "first" });
  const b = captureFeedback(r, { raw: "second" });
  assert.notEqual(a.id, b.id);
  assert.ok(existsSync(feedbackEntryPath(r, a.id)));
  assert.ok(existsSync(feedbackEntryPath(r, b.id)));
});

test("captureFeedback rejects empty/whitespace-only text — nothing written", () => {
  const r = root();
  assert.throws(() => captureFeedback(r, { raw: "   " }), FeedbackError);
  assert.deepEqual(listFeedback(r), []);
});

test("captureFeedback: an http(s) --attach is a LINK, stored verbatim, nothing copied", () => {
  const r = root();
  const entry = captureFeedback(r, { raw: "see this", attachments: ["https://example.test/screenshot.png"] });
  assert.deepEqual(entry.attachments, ["https://example.test/screenshot.png"]);
});

test("captureFeedback: a local-path --attach is copied into plan/feedback/attachments/<id>/", () => {
  const r = root();
  const src = join(mkdtempSync(join(tmpdir(), "rmd-feedback-src-")), "terminal.log");
  writeFileSync(src, "boom\n");

  const entry = captureFeedback(r, { raw: "crash log attached", attachments: [src] });

  assert.equal(entry.attachments.length, 1);
  assert.equal(entry.attachments[0], `plan/feedback/attachments/${entry.id}/terminal.log`);
  const dest = join(feedbackAttachmentsDir(r, entry.id), "terminal.log");
  assert.equal(readFileSync(dest, "utf8"), "boom\n");
});

test("captureFeedback FAILS LOUD on a missing local attachment — no entry written", () => {
  const r = root();
  assert.throws(() => captureFeedback(r, { raw: "x", attachments: ["/no/such/file.png"] }), FeedbackError);
  assert.deepEqual(listFeedback(r), []);
});

test("captureFeedback rejects an origin outside the closed enum", () => {
  const r = root();
  // @ts-expect-error deliberately invalid at the type level, guarded at runtime too
  assert.throws(() => captureFeedback(r, { raw: "x", origin: "carrier-pigeon" }), FeedbackError);
});

// ── W1-T57: machine-origin `issue#<n>` widening ─────────────────────────────

test("isValidFeedbackOrigin accepts the named enum plus well-formed issue#<n>, rejects everything else", () => {
  for (const origin of FEEDBACK_ORIGINS) assert.equal(isValidFeedbackOrigin(origin), true);
  assert.equal(isValidFeedbackOrigin("issue#42"), true);
  assert.equal(isValidFeedbackOrigin("issue#0"), true);
  assert.equal(isValidFeedbackOrigin("issue#"), false);
  assert.equal(isValidFeedbackOrigin("issue#abc"), false);
  assert.equal(isValidFeedbackOrigin("alert#5"), false);
  assert.equal(isValidFeedbackOrigin("carrier-pigeon"), false);
});

test("captureFeedback accepts a machine-origin issue#<n> origin", () => {
  const r = root();
  const entry = captureFeedback(r, { raw: "owner/repo#42: title\n\nbody", origin: "issue#42" });
  assert.equal(entry.origin, "issue#42");
  assert.equal(readFeedbackEntry(r, entry.id).origin, "issue#42");
});

test("captureFeedback accepts an explicit id (machine-origin idempotent-dedup key), overriding the random default", () => {
  const r = root();
  const entry = captureFeedback(r, { raw: "x", origin: "issue#7", id: "fb-issue-acme-widgets-7" });
  assert.equal(entry.id, "fb-issue-acme-widgets-7");
  assert.ok(existsSync(feedbackEntryPath(r, "fb-issue-acme-widgets-7")));
});

// ── W1-T56: machine-origin `alert#<source>-<id>` widening ───────────────────

test("isValidFeedbackOrigin accepts well-formed alert#<source>-<id>, rejects malformed/unknown-source shapes", () => {
  assert.equal(isValidFeedbackOrigin("alert#code-scanning-5"), true);
  assert.equal(isValidFeedbackOrigin("alert#dependabot-12"), true);
  assert.equal(isValidFeedbackOrigin("alert#secret-scanning-3"), true);
  assert.equal(isValidFeedbackOrigin("alert#5"), false, "bare alert#<n> (no source) is not the W1-T56 shape");
  assert.equal(isValidFeedbackOrigin("alert#"), false);
  assert.equal(isValidFeedbackOrigin("alert#carrier-pigeon-1"), false, "unknown alert source is rejected");
});

test("captureFeedback accepts a machine-origin alert#<source>-<id> origin", () => {
  const r = root();
  const entry = captureFeedback(r, { raw: "craigoley/remudero code-scanning alert #5 [critical]: SQL injection", origin: "alert#code-scanning-5" });
  assert.equal(entry.origin, "alert#code-scanning-5");
  assert.equal(readFeedbackEntry(r, entry.id).origin, "alert#code-scanning-5");
});

test("captureFeedback with an explicit alert-derived id round-trips (idempotent-dedup key)", () => {
  const r = root();
  const entry = captureFeedback(r, {
    raw: "x",
    origin: "alert#secret-scanning-3",
    id: "fb-alert-craigoley-remudero-secret-scanning-3",
  });
  assert.equal(entry.id, "fb-alert-craigoley-remudero-secret-scanning-3");
  assert.ok(existsSync(feedbackEntryPath(r, "fb-alert-craigoley-remudero-secret-scanning-3")));
});

// ── read / list / lifecycle ───────────────────────────────────────────────────

test("readFeedbackEntry round-trips what captureFeedback wrote", () => {
  const r = root();
  const written = captureFeedback(r, { raw: "round trip me" });
  assert.deepEqual(readFeedbackEntry(r, written.id), written);
});

test("readFeedbackEntry throws on an unknown id", () => {
  const r = root();
  assert.throws(() => readFeedbackEntry(r, "fb-nope"), FeedbackError);
});

test("listFeedback on an empty/nonexistent inbox returns []", () => {
  assert.deepEqual(listFeedback(root()), []);
});

test("listFeedback returns every captured entry, optionally filtered by status", () => {
  const r = root();
  const a = captureFeedback(r, { raw: "a" });
  const b = captureFeedback(r, { raw: "b" });
  setFeedbackStatus(r, b.id, "proposed");

  const all = listFeedback(r);
  assert.equal(all.length, 2);
  assert.deepEqual(
    all.map((e) => e.id).sort(),
    [a.id, b.id].sort(),
  );

  const proposedOnly = listFeedback(r, { status: "proposed" });
  assert.deepEqual(proposedOnly.map((e) => e.id), [b.id]);
});

test("setFeedbackStatus moves an entry through the §7B lifecycle and can attach a proposal_pr", () => {
  const r = root();
  const entry = captureFeedback(r, { raw: "grill me" });
  assert.equal(entry.status, "new");

  const grilling = setFeedbackStatus(r, entry.id, "grilling");
  assert.equal(grilling.status, "grilling");
  assert.equal(grilling.proposal_pr, null);

  const proposed = setFeedbackStatus(r, entry.id, "proposed", { proposalPr: "https://github.com/x/y/pull/1" });
  assert.equal(proposed.status, "proposed");
  assert.equal(proposed.proposal_pr, "https://github.com/x/y/pull/1");

  const accepted = setFeedbackStatus(r, entry.id, "accepted");
  assert.equal(accepted.status, "accepted");
  // proposal_pr survives a later transition that doesn't pass a new one:
  assert.equal(accepted.proposal_pr, "https://github.com/x/y/pull/1");

  // W1-T2278 adds "answered" -- a `grilling` entry's OTHER exit, taken when a reply lands
  // rather than when triage proposes it (buildSubmitFeedbackRoute, panel-graph.ts).
  assert.deepEqual(FEEDBACK_STATUSES, ["new", "grilling", "proposed", "accepted", "rejected", "answered"]);
});

test("setFeedbackStatus rejects a status outside the closed enum", () => {
  const r = root();
  const entry = captureFeedback(r, { raw: "x" });
  assert.throws(() => setFeedbackStatus(r, entry.id, "vibing" as never), FeedbackError);
});

test("setFeedbackStatus throws on an unknown id", () => {
  assert.throws(() => setFeedbackStatus(root(), "fb-nope", "proposed"), FeedbackError);
});

// ── W1-T350: the feedback interpreter — validateFeedbackExpansion ───────────────────────────

function validExpansionPayload(over: Partial<FeedbackExpansion> = {}): unknown {
  return {
    claim: "the drain retry banner overlaps the status pill",
    evidence: "screenshot attached, 1280x720, banner z-index 5 over pill z-index 4",
    recon: ["establish whether this reproduces at other viewport widths"],
    falsifying_check: "if the overlap does not reproduce on a fresh reload, this is a one-off render glitch",
    ...over,
  };
}

test("validateFeedbackExpansion: a well-formed record round-trips with whitespace trimmed", () => {
  const out = validateFeedbackExpansion(validExpansionPayload({ claim: "  a claim  " }));
  assert.ok(out);
  assert.equal(out.claim, "a claim");
  assert.deepEqual(out.recon, ["establish whether this reproduces at other viewport widths"]);
});

test("validateFeedbackExpansion: an EMPTY evidence string is ACCEPTED — a short note may carry no measured specific at all", () => {
  const out = validateFeedbackExpansion(validExpansionPayload({ evidence: "" }));
  assert.ok(out);
  assert.equal(out.evidence, "");
});

test("validateFeedbackExpansion: an EMPTY recon array is ACCEPTED — nothing was left unverified", () => {
  const out = validateFeedbackExpansion(validExpansionPayload({ recon: [] }));
  assert.ok(out);
  assert.deepEqual(out.recon, []);
});

test("validateFeedbackExpansion: missing claim is rejected", () => {
  assert.equal(validateFeedbackExpansion(validExpansionPayload({ claim: "" })), null);
});

test("validateFeedbackExpansion: missing falsifying_check is rejected", () => {
  assert.equal(validateFeedbackExpansion(validExpansionPayload({ falsifying_check: "" })), null);
});

test("validateFeedbackExpansion: recon must be an array", () => {
  assert.equal(validateFeedbackExpansion(validExpansionPayload({ recon: "establish whether x" as never })), null);
});

test("validateFeedbackExpansion: more than 10 recon directives is rejected", () => {
  const recon = Array.from({ length: 11 }, (_, i) => `establish whether item ${i}`);
  assert.equal(validateFeedbackExpansion(validExpansionPayload({ recon })), null);
});

test("validateFeedbackExpansion: a recon directive over the per-item bound is rejected", () => {
  const recon = ["establish whether " + "x".repeat(300)];
  assert.equal(validateFeedbackExpansion(validExpansionPayload({ recon })), null);
});

test("validateFeedbackExpansion: a bare string (free prose) is rejected — never stored as free prose", () => {
  assert.equal(validateFeedbackExpansion("CLAIM: whatever. RECON: something. Falsifying check: something else."), null);
});

test("validateFeedbackExpansion: null/undefined/non-object input is rejected", () => {
  assert.equal(validateFeedbackExpansion(null), null);
  assert.equal(validateFeedbackExpansion(undefined), null);
  assert.equal(validateFeedbackExpansion(42), null);
});

// ── W1-T350: expandFeedbackDraft — fail-open (throw/reject/invalid -> null, never propagate) ──

function fakeExpanderDeps(behavior: { throw: unknown }): FeedbackExpanderDeps {
  return {
    expand: async () => {
      throw behavior.throw;
    },
  };
}

test("expandFeedbackDraft: a valid expander response validates and is returned, called with {draft, fewShot}", async () => {
  const calls: unknown[] = [];
  const deps: FeedbackExpanderDeps = {
    expand: async (input) => {
      calls.push(input);
      return validExpansionPayload();
    },
  };
  const out = await expandFeedbackDraft("the console doesn't show me when spend is blocked", ["example one"], deps);
  assert.ok(out);
  assert.equal(out.claim, "the drain retry banner overlaps the status pill");
  assert.deepEqual(calls, [{ draft: "the console doesn't show me when spend is blocked", fewShot: ["example one"] }]);
});

test("expandFeedbackDraft: a throw resolves to null, never propagates (this task's stated failure mode)", async () => {
  const deps = fakeExpanderDeps({ throw: new Error("expander unavailable") });
  assert.equal(await expandFeedbackDraft("x", [], deps), null);
});

test("expandFeedbackDraft: a rejected promise resolves to null", async () => {
  const deps: FeedbackExpanderDeps = { expand: async () => Promise.reject(new Error("boom")) };
  assert.equal(await expandFeedbackDraft("x", [], deps), null);
});

test("expandFeedbackDraft: a response that fails FeedbackExpansion validation resolves to null", async () => {
  const deps: FeedbackExpanderDeps = { expand: async () => ({ claim: "" }) };
  assert.equal(await expandFeedbackDraft("x", [], deps), null);
});

// ── W1-T350: recentFeedbackFewShot — only entries carrying BOTH precedent markers ───────────

test("recentFeedbackFewShot: only entries with BOTH 'RECON:' and 'Falsifying check:' markers qualify, most recent last, capped at limit", () => {
  const r = root();
  captureFeedback(r, { raw: "no markers here at all" });
  captureFeedback(r, { raw: "RECON: only, no falsifying marker" });
  const c = captureFeedback(r, { raw: "FIRST MARKED ENTRY. RECON: establish x. Falsifying check: if y." });
  const d = captureFeedback(r, { raw: "SECOND MARKED ENTRY. RECON: establish z. Falsifying check: if w." });

  const fewShot = recentFeedbackFewShot(r, 5);
  assert.deepEqual(fewShot, [c.raw, d.raw]);
});

test("recentFeedbackFewShot: caps at `limit`, keeping the MOST RECENT entries", () => {
  const r = root();
  const marked = (n: number) => captureFeedback(r, { raw: `entry ${n}. RECON: x. Falsifying check: y.` });
  const entries = [1, 2, 3].map(marked);
  const fewShot = recentFeedbackFewShot(r, 2);
  assert.deepEqual(fewShot, [entries[1].raw, entries[2].raw]);
});

test("recentFeedbackFewShot: an empty/unmarked inbox returns []", () => {
  const r = root();
  captureFeedback(r, { raw: "nothing marked" });
  assert.deepEqual(recentFeedbackFewShot(r), []);
});

// ── W1-T350: buildFeedbackExpansionPrompt (pure) ────────────────────────────────────────────

test("buildFeedbackExpansionPrompt embeds the draft, the four named JSON fields, and the honesty constraint", () => {
  const prompt = buildFeedbackExpansionPrompt({ draft: "the console doesn't show me when spend is blocked", fewShot: [] });
  assert.match(prompt, /the console doesn't show me when spend is blocked/);
  assert.match(prompt, /ONLY a JSON object/);
  assert.match(prompt, /"claim"/);
  assert.match(prompt, /"evidence"/);
  assert.match(prompt, /"recon"/);
  assert.match(prompt, /"falsifying_check"/);
  assert.match(prompt, /NEVER invent one/);
  assert.doesNotMatch(prompt, /RECENT EXAMPLES/);
});

test("buildFeedbackExpansionPrompt renders a few-shot block only when fewShot is non-empty", () => {
  const prompt = buildFeedbackExpansionPrompt({ draft: "x", fewShot: ["EXAMPLE ENTRY ONE"] });
  assert.match(prompt, /RECENT EXAMPLES/);
  assert.match(prompt, /EXAMPLE ENTRY ONE/);
  assert.match(prompt, /tone\/calibration ONLY/);
});

// ── W1-T350: buildFeedbackExpansionSpawnArgs / realFeedbackExpander / resolveFeedbackExpansionMount ──

function goodMounts(): Mounts {
  return validateMounts({
    tiers: { haiku: 1, sonnet: 2, opus: 3 },
    efforts: { low: 1, medium: 2, high: 3 },
    architect: { model: "opus", effort: "high", max_turns: 60, context_budget: 180000 },
    judge: { model: "opus", effort: "high", max_turns: 60, context_budget: 150000 },
    routes: {
      implement: {
        low: { src: { model: "sonnet", effort: "medium", max_turns: 30, context_budget: 120000 } },
        high: { src: { model: "sonnet", effort: "high", max_turns: 50, context_budget: 180000 } },
      },
      recon: {
        low: { src: { model: "haiku", effort: "medium", max_turns: 20, context_budget: 60000 } },
      },
    },
  });
}

function fakeWorkerResult(text: string): WorkerResult {
  return {
    sessionId: "s-feedback-expansion",
    costUsd: 0.001,
    numTurns: 1,
    text,
    blocks: [text],
    stderr: "",
    subtype: "success",
    isError: false,
    apiError: false,
    permissionDenials: [],
    childEnvKeys: [],
    model: "haiku",
    effort: "medium",
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    modelUsage: {},
    compactionEvents: [],
    qualitySuspect: false,
  };
}

test("buildFeedbackExpansionSpawnArgs carries an EMPTY tool list and the resolved mount's model/effort/maxTurns — the rung cannot write/edit, by construction", () => {
  const mount: Mount = { model: "haiku", effort: "medium", maxTurns: 20, contextBudget: 60000 };
  const input = { draft: "some draft", fewShot: [] };
  const args = buildFeedbackExpansionSpawnArgs({ input, mount, cwd: "/tmp/x", settingsFile: "/tmp/settings.json" });

  assert.deepEqual(args.tools, []);
  assert.equal(args.model, "haiku");
  assert.equal(args.effort, "medium");
  assert.equal(args.maxTurns, 20);
  assert.equal(args.cwd, "/tmp/x");
  assert.equal(args.settingsFile, "/tmp/settings.json");
  assert.equal(args.permissionMode, "bypassPermissions");
  assert.equal(args.prompt, buildFeedbackExpansionPrompt(input));
});

test("realFeedbackExpander parses a JSON object out of the worker's response text and returns it", async () => {
  const mount: Mount = { model: "haiku", effort: "medium", maxTurns: 20, contextBudget: 60000 };
  const calls: unknown[] = [];
  const responseObject = validExpansionPayload();
  const spawn = (async (args: unknown) => {
    calls.push(args);
    return fakeWorkerResult(`Here is the JSON:\n${JSON.stringify(responseObject)}\nthanks`);
  }) as typeof spawnWorker;

  const expand = realFeedbackExpander({ mount, cwd: "/tmp/x", settingsFile: "/tmp/settings.json", spawn });
  const out = await expand({ draft: "raw text", fewShot: [] });

  assert.equal(calls.length, 1, "calls the injected spawn exactly once");
  assert.deepEqual(
    calls[0],
    buildFeedbackExpansionSpawnArgs({ input: { draft: "raw text", fewShot: [] }, mount, cwd: "/tmp/x", settingsFile: "/tmp/settings.json" }),
  );
  assert.deepEqual(out, responseObject);
});

test("realFeedbackExpander returns null when the worker's response contains no JSON object at all", async () => {
  const mount: Mount = { model: "haiku", effort: "medium", maxTurns: 20, contextBudget: 60000 };
  const spawn = (async () => fakeWorkerResult("sorry, I could not expand this")) as typeof spawnWorker;
  const expand = realFeedbackExpander({ mount, cwd: "/tmp/x", settingsFile: "/tmp/settings.json", spawn });
  assert.equal(await expand({ draft: "raw text", fewShot: [] }), null);
});

test("realFeedbackExpander returns null when the extracted braces are not valid JSON", async () => {
  const mount: Mount = { model: "haiku", effort: "medium", maxTurns: 20, contextBudget: 60000 };
  const spawn = (async () => fakeWorkerResult("{not: valid, json}")) as typeof spawnWorker;
  const expand = realFeedbackExpander({ mount, cwd: "/tmp/x", settingsFile: "/tmp/settings.json", spawn });
  assert.equal(await expand({ draft: "raw text", fewShot: [] }), null);
});

test("resolveFeedbackExpansionMount resolves the CHEAPEST configured tier — reused from risk-judge.ts, never a hard-coded model id", () => {
  const mount = resolveFeedbackExpansionMount(goodMounts());
  assert.equal(mount.model, "haiku");
  assert.deepEqual(mount, { model: "haiku", effort: "medium", maxTurns: 20, contextBudget: 60000 });
});

// ── W1-T350 acceptance criterion 2: captureFeedback stores raw byte-identical alongside the ──
// expansion, and the file-raw escape (no expansion given) still files unchanged ──────────────

test("captureFeedback: an entry captured WITH an expansion stores it alongside raw, byte-identical", () => {
  const r = root();
  const expansion = validateFeedbackExpansion(validExpansionPayload())!;
  const entry = captureFeedback(r, { raw: "the drain retry banner overlaps the status pill", expansion });
  assert.equal(entry.raw, "the drain retry banner overlaps the status pill");
  assert.deepEqual(entry.expansion, expansion);

  // the literal proof artifact: plan/feedback/<id>.yaml carries BOTH fields on disk.
  const onDisk = readFeedbackEntry(r, entry.id);
  assert.equal(onDisk.raw, "the drain retry banner overlaps the status pill");
  assert.deepEqual(onDisk.expansion, expansion);
});

test("captureFeedback: the file-raw escape (no expansion given) captures exactly as before this task — expansion is null", () => {
  const r = root();
  const entry = captureFeedback(r, { raw: "just file this as-is" });
  assert.equal(entry.raw, "just file this as-is");
  assert.equal(entry.expansion, null);
});

test("captureFeedback: an explicit null expansion (a confirm whose preview never produced one) files with expansion null, never throws", () => {
  const r = root();
  const entry = captureFeedback(r, { raw: "x", expansion: null });
  assert.equal(entry.expansion, null);
});

// ── W1-T2302: submissionKey — the console-minted per-submission key that lets a repeat POST
// /v1/feedback be RECOGNISED, never re-derived from raw text (fb-1785969338913-dc3d0f: two
// byte-identical entries, five seconds apart, from one operator's clicks). ─────────────────────

test("captureFeedback: an entry captured WITH a submissionKey stores it durably as submission_key; findFeedbackBySubmissionKey finds it", () => {
  const r = root();
  const entry = captureFeedback(r, { raw: "the drain retry banner overlaps the status pill", submissionKey: "sk-abc123" });
  assert.equal(entry.submission_key, "sk-abc123");
  assert.deepEqual(findFeedbackBySubmissionKey(r, "sk-abc123"), entry);
  assert.deepEqual(readFeedbackEntry(r, entry.id), entry, "the field is durable -- present on disk, not just the in-memory return");
});

test("captureFeedback: the file-raw escape (no submissionKey given) leaves submission_key null, exactly today's shape plus this one added field", () => {
  const r = root();
  const entry = captureFeedback(r, { raw: "just file this as-is" });
  assert.equal(entry.submission_key, null);
});

test("findFeedbackBySubmissionKey: no entry carries the given key -> null (a genuinely new submission, or a caller that never sent one)", () => {
  const r = root();
  captureFeedback(r, { raw: "x", submissionKey: "sk-one" });
  assert.equal(findFeedbackBySubmissionKey(r, "sk-does-not-exist"), null);
  assert.equal(findFeedbackBySubmissionKey(r, "sk-one-typo"), null);
});

test("captureFeedback: a repeat call carrying the SAME submissionKey never rewrites the existing entry -- a status/edge already recorded against it survives untouched, this call is a pure READ (acceptance 2)", () => {
  const r = root();
  const first = captureFeedback(r, { raw: "[answer to feedback#fb-parked] a config default, please", submissionKey: "sk-repeat-1", replyTo: "fb-parked" });
  // Simulate exactly the trap this task's rationale names by NAME: something has already moved
  // this entry on since it was captured -- the reply-target edge (W1-T2278's answered_by lives
  // on the OTHER entry in the real flow, but the SAME never-clobber property must hold for any
  // status/field already recorded against THIS entry, e.g. rmd triage moving it to `grilling`).
  const moved = setFeedbackStatus(r, first.id, "grilling");
  assert.equal(moved.status, "grilling");

  const repeat = captureFeedback(r, {
    raw: "[answer to feedback#fb-parked] a config default, please",
    submissionKey: "sk-repeat-1",
    replyTo: "fb-parked",
  });
  assert.equal(repeat.id, first.id, "the repeat resolves to the SAME entry, not a fresh id");
  assert.equal(repeat.status, "grilling", "the status already recorded against it survives -- never reset to 'new'");
  assert.equal(repeat.reply_to, "fb-parked", "the reply edge already recorded survives too");

  // The literal proof this was a READ, not a second write: the on-disk entry is still exactly
  // what setFeedbackStatus left it as, and only ONE entry file exists.
  assert.deepEqual(readFeedbackEntry(r, first.id), moved);
  assert.equal(listFeedback(r).length, 1, "no second entry, no second write");
});

test("captureFeedback: two DELIBERATELY separate submissions carrying identical text but DIFFERENT submissionKeys each file their own entry (design iv)", () => {
  const r = root();
  const a = captureFeedback(r, { raw: "the same observation, filed on purpose, twice", submissionKey: "sk-a" });
  const b = captureFeedback(r, { raw: "the same observation, filed on purpose, twice", submissionKey: "sk-b" });
  assert.notEqual(a.id, b.id);
  assert.equal(listFeedback(r).length, 2, "identical text is never itself the dedup key -- only the submission identity is");
});
