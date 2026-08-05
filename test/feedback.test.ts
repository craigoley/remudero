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
  buildFeedbackFewShot,
  captureFeedback,
  expandFeedbackDraft,
  feedbackAttachmentsDir,
  feedbackEntryPath,
  isValidFeedbackOrigin,
  listFeedback,
  parseFeedbackAddArgs,
  readFeedbackEntry,
  realFeedbackExpander,
  resolveFeedbackExpansionMount,
  setFeedbackStatus,
  validateFeedbackExpansion,
  type FeedbackEntry,
  type FeedbackExpansion,
} from "../src/lib/feedback.js";
import { validateMounts, type Mount } from "../src/lib/mounts.js";
import type { WorkerResult, spawnWorker } from "../src/lib/worker.js";

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

  assert.deepEqual(FEEDBACK_STATUSES, ["new", "grilling", "proposed", "accepted", "rejected"]);
});

test("setFeedbackStatus rejects a status outside the closed enum", () => {
  const r = root();
  const entry = captureFeedback(r, { raw: "x" });
  assert.throws(() => setFeedbackStatus(r, entry.id, "vibing" as never), FeedbackError);
});

test("setFeedbackStatus throws on an unknown id", () => {
  assert.throws(() => setFeedbackStatus(root(), "fb-nope", "proposed"), FeedbackError);
});

// ── Feedback expansion (W1-T350): CLAIM / EVIDENCE / RECON / FALSIFYING CHECK ───────────────

function validExpansion(): FeedbackExpansion {
  return {
    claim: "THE DIGEST FIRED TWICE for the same window",
    evidence: "the operator's draft names one duplicate firing",
    recon: "establish whether the digest's own dedup key includes the window boundary",
    falsifying_check: "a single digest run for the window with no duplicate log line retires this",
  };
}

test("validateFeedbackExpansion accepts a well-formed four-section expansion and trims whitespace", () => {
  const raw = {
    claim: "  THE DIGEST FIRED TWICE  ",
    evidence: "  one duplicate log line  ",
    recon: "  establish whether the dedup key covers this  ",
    falsifying_check: "  one clean run retires it  ",
  };
  assert.deepEqual(validateFeedbackExpansion(raw), {
    claim: "THE DIGEST FIRED TWICE",
    evidence: "one duplicate log line",
    recon: "establish whether the dedup key covers this",
    falsifying_check: "one clean run retires it",
  });
});

test("validateFeedbackExpansion FAILS LOUD (returns null) on a missing/empty/oversized section, or a non-object", () => {
  assert.equal(validateFeedbackExpansion(null), null);
  assert.equal(validateFeedbackExpansion("a string"), null);
  assert.equal(validateFeedbackExpansion([]), null);
  const base = validExpansion();
  for (const key of ["claim", "evidence", "recon", "falsifying_check"] as const) {
    assert.equal(validateFeedbackExpansion({ ...base, [key]: undefined }), null, `missing ${key} must fail`);
    assert.equal(validateFeedbackExpansion({ ...base, [key]: "   " }), null, `blank ${key} must fail`);
    assert.equal(validateFeedbackExpansion({ ...base, [key]: "x".repeat(5000) }), null, `oversized ${key} must fail`);
  }
});

test("expandFeedbackDraft is FAIL-OPEN: a throwing expander, a rejected promise, and an invalid-shape response all resolve to null — never propagate", async () => {
  await assert.doesNotReject(async () => {
    const out = await expandFeedbackDraft(
      "the digest fired twice",
      {
        expand: () => {
          throw new Error("mount unavailable");
        },
      },
    );
    assert.equal(out, null);
  });
  assert.equal(
    await expandFeedbackDraft("draft", { expand: () => Promise.reject(new Error("timeout")) }),
    null,
  );
  assert.equal(await expandFeedbackDraft("draft", { expand: () => ({ claim: "only one field" }) }), null);
});

test("expandFeedbackDraft passes through a VALID expander response unchanged, and carries the draft + fewShot into the injected deps", async () => {
  let seen: { draft: string; fewShot: string } | undefined;
  const expansion = validExpansion();
  const out = await expandFeedbackDraft("the digest fired twice", {
    expand: (input) => {
      seen = input;
      return expansion;
    },
  }, "EXAMPLE:\nsome precedent entry");
  assert.deepEqual(out, expansion);
  assert.deepEqual(seen, { draft: "the digest fired twice", fewShot: "EXAMPLE:\nsome precedent entry" });
});

function feedbackEntryWithRaw(raw: string): FeedbackEntry {
  return { id: "fb-1", ts: new Date().toISOString(), raw, attachments: [], origin: "cli", status: "new", proposal_pr: null };
}

test("buildFeedbackFewShot: keeps only entries carrying BOTH the RECON: and Falsifying check: markers, most-recent-first-picked, capped at the limit", () => {
  const withMarkers = feedbackEntryWithRaw("CLAIM: x\nRECON: establish y\nFalsifying check: z");
  const noMarkers = feedbackEntryWithRaw("just a note, no skeleton");
  const reconOnly = feedbackEntryWithRaw("CLAIM: x\nRECON: establish y");
  const fewShot = buildFeedbackFewShot([noMarkers, reconOnly, withMarkers]);
  assert.equal(fewShot, `EXAMPLE:\n${withMarkers.raw}`);
});

test("buildFeedbackFewShot returns an empty string when no precedent entry carries both markers (never a dangling header)", () => {
  assert.equal(buildFeedbackFewShot([feedbackEntryWithRaw("no markers here")]), "");
  assert.equal(buildFeedbackFewShot([]), "");
});

test("buildFeedbackFewShot caps at `limit`, keeping the MOST RECENT (last-in-array) matching entries", () => {
  const marked = (n: number) => feedbackEntryWithRaw(`CLAIM: entry ${n}\nRECON: establish\nFalsifying check: check`);
  const entries = [marked(1), marked(2), marked(3), marked(4)];
  const fewShot = buildFeedbackFewShot(entries, 2);
  assert.equal(fewShot, `EXAMPLE:\n${entries[2].raw}\n\nEXAMPLE:\n${entries[3].raw}`);
});

test("captureFeedback: a confirmed submission stores the operator's raw text BYTE-IDENTICAL alongside the validated expansion", () => {
  const r = root();
  const expansion = validExpansion();
  const entry = captureFeedback(r, { raw: "the digest fired twice", expansion });
  assert.equal(entry.raw, "the digest fired twice"); // byte-identical, untouched by the expansion
  assert.deepEqual(entry.expansion, expansion);
  const onDisk = parseYaml(readFileSync(feedbackEntryPath(r, entry.id), "utf8"));
  assert.deepEqual(onDisk, entry);
});

test("captureFeedback: the file-raw escape (no expansion passed) still files, with expansion null — never blocked on a missing preview", () => {
  const r = root();
  const entry = captureFeedback(r, { raw: "raw, unexpanded" });
  assert.equal(entry.raw, "raw, unexpanded");
  assert.equal(entry.expansion, null);
});

test("captureFeedback re-validates a passed expansion defensively — a malformed one is dropped to null, never written half-formed, raw is still filed unchanged", () => {
  const r = root();
  const entry = captureFeedback(r, { raw: "still lands", expansion: { claim: "only a claim" } as unknown as FeedbackExpansion });
  assert.equal(entry.raw, "still lands");
  assert.equal(entry.expansion, null);
});

// ── The real feedback-expansion rung: mirrors test/decision-summary.test.ts's own split exactly
// (buildFeedbackExpansionPrompt/buildFeedbackExpansionSpawnArgs are pure and fully unit-tested;
// realFeedbackExpander is exercised with an INJECTED fake spawn, never a real shell-out, covering
// its success, no-JSON-found, and malformed-JSON branches) ──────────────────────────────────────

function goodMounts() {
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

test("buildFeedbackExpansionPrompt embeds the draft, the honesty constraint, and (when given) the few-shot register", () => {
  const withoutFewShot = buildFeedbackExpansionPrompt({ draft: "the digest fired twice", fewShot: "" });
  assert.match(withoutFewShot, /the digest fired twice/);
  assert.match(withoutFewShot, /ONLY a JSON object/);
  assert.match(withoutFewShot, /claim/);
  assert.match(withoutFewShot, /recon/);
  assert.match(withoutFewShot, /falsifying_check/);
  assert.match(withoutFewShot, /HONESTY CONSTRAINT/);
  assert.doesNotMatch(withoutFewShot, /RECENT PRECEDENT/);

  const withFewShot = buildFeedbackExpansionPrompt({ draft: "x", fewShot: "EXAMPLE:\nsome precedent entry" });
  assert.match(withFewShot, /RECENT PRECEDENT/);
  assert.match(withFewShot, /some precedent entry/);
});

test("buildFeedbackExpansionSpawnArgs carries an EMPTY tool list and the resolved mount's model/effort/maxTurns — the expander cannot write/edit, by construction", () => {
  const mount: Mount = { model: "haiku", effort: "medium", maxTurns: 20, contextBudget: 60000 };
  const input = { draft: "some draft", fewShot: "" };
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
  const responseObject = validExpansion();
  const spawn = (async (args: unknown) => {
    calls.push(args);
    return fakeWorkerResult(`Here is the JSON:\n${JSON.stringify(responseObject)}\nthanks`);
  }) as typeof spawnWorker;

  const expand = realFeedbackExpander({ mount, cwd: "/tmp/x", settingsFile: "/tmp/settings.json", spawn });
  const out = await expand({ draft: "raw text", fewShot: "" });

  assert.equal(calls.length, 1, "calls the injected spawn exactly once");
  assert.deepEqual(
    calls[0],
    buildFeedbackExpansionSpawnArgs({ input: { draft: "raw text", fewShot: "" }, mount, cwd: "/tmp/x", settingsFile: "/tmp/settings.json" }),
  );
  assert.deepEqual(out, responseObject);
});

test("realFeedbackExpander returns null when the worker's response contains no JSON object at all", async () => {
  const mount: Mount = { model: "haiku", effort: "medium", maxTurns: 20, contextBudget: 60000 };
  const spawn = (async () => fakeWorkerResult("sorry, I could not expand this")) as typeof spawnWorker;
  const expand = realFeedbackExpander({ mount, cwd: "/tmp/x", settingsFile: "/tmp/settings.json", spawn });
  assert.equal(await expand({ draft: "raw text", fewShot: "" }), null);
});

test("realFeedbackExpander returns null when the extracted braces are not valid JSON", async () => {
  const mount: Mount = { model: "haiku", effort: "medium", maxTurns: 20, contextBudget: 60000 };
  const spawn = (async () => fakeWorkerResult("{not: valid, json}")) as typeof spawnWorker;
  const expand = realFeedbackExpander({ mount, cwd: "/tmp/x", settingsFile: "/tmp/settings.json", spawn });
  assert.equal(await expand({ draft: "raw text", fewShot: "" }), null);
});

test("resolveFeedbackExpansionMount resolves the CHEAPEST configured tier — reused from risk-judge.ts, never a hard-coded model id", () => {
  const mount = resolveFeedbackExpansionMount(goodMounts());
  assert.equal(mount.model, "haiku");
  assert.deepEqual(mount, { model: "haiku", effort: "medium", maxTurns: 20, contextBudget: 60000 });
});
