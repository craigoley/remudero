import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { backfillPlainMessages, checkPlainMessage, plainInboxMessage, plainSourceFingerprint, plainStorePath, plainTemplate, readPlainStore, TEMPLATED_KINDS, writePlainMessage, type PlainInboxMessage } from "../src/lib/inbox-plain.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const proposal = {
  id: "machine-judge:W1-T5984",
  summary: "W1-T5984 was filed by the ci-friction gardener and the risk judge escalated it, so it stays parked for you:\n  The merge permission is unresolved.\n\nThe checks consumed 731.4 PR-minutes across 3 rounds.",
};
const clean: PlainInboxMessage = {
  headline: "A task is waiting for a risk decision",
  whatHappened: "The fleet spent twelve hours running automatic checks while the task waited.",
  whatWeNeed: "Decide whether the task should go ahead or be closed.",
  ifNothingHappens: "The task stays parked and the build cost continues.",
  options: [
    { label: "Go ahead", consequence: "The fleet can start the task.", intent: "approve" },
    { label: "Drop it", consequence: "The task is closed.", intent: "decline" },
  ],
  source: "writer",
};
const card = (message: PlainInboxMessage) => ({
  headline: message.headline, what_happened: message.whatHappened, decision: message.whatWeNeed,
  if_nothing_happens: message.ifNothingHappens, options: message.options,
});

async function refusedThenReasked(message: PlainInboxMessage, problem: RegExp): Promise<void> {
  assert.equal(checkPlainMessage(clean, proposal).ok, true, "control: a factual fleet message passes");
  const checked = checkPlainMessage(message, proposal);
  assert.equal(checked.ok, false);
  assert.match(checked.problems.join("; "), problem);
  const contexts: string[] = [];
  const result = await writePlainMessage(proposal, { summarize: ({ context }) => {
    contexts.push(context);
    return card(contexts.length === 1 ? message : clean);
  } });
  assert.equal(contexts.length, 2);
  assert.match(contexts[1]!, problem);
  assert.deepEqual(result, clean);
  const fallback = await writePlainMessage(proposal, { summarize: () => card(message) });
  assert.equal(fallback.source, "template");
  assert.equal(checkPlainMessage(fallback, proposal).ok, true);
  const cached = { ...message, sourceFingerprint: plainSourceFingerprint(proposal) };
  assert.equal(plainInboxMessage(proposal, { [proposal.id]: cached }).source, "template");
}

test("W1-T8926: every operator kind seen live has its own template", async () => {
  const cases = [
    { id: "verify-human:W1-T235", summary: "A manual check was requested 49 days ago", detail: /49 days/ },
    { id: "ruling:operator-owned", summary: "operator-owned", detail: /operator ruling/ },
    { ...proposal, detail: /build cost.*reviewer.*filed.*merge permission is unresolved/is },
    { id: "machine-judge:W1-T6170", summary: "A risk decision is requested", detail: /does not verify the reason/ },
    { ...proposal, summary: "A task was filed by the ci-friction gardener and stays parked for you:\n  The gate consumed 12.19 PR-hours; see src/lib/policy.ts and W1-T5984.\n\nReview the risk", detail: /review step consumed 12\.19 fleet CI hours/ },
    { id: "board-review:stale:#7244", summary: "board-review: #7244 has sat open 27.5h, past the 24h depth threshold", detail: /27\.5 hours/ },
    { id: "board-review:escalation:#7245", summary: 'board-review: #7245 — unhandled escalation: "The merge permission needs a decision"', detail: /merge permission needs a decision/ },
    { id: "board-review:escalation:#7246", summary: "board-review: #7246 carries an unhandled escalation whose ask could not be read", detail: /question could not be read/ },
    { id: "guard-retirement:stale-check", summary: "Retire guard 'stale-check': Fired zero times for 6 consecutive retro cycles. Approving this proposal deletes nothing on its own.", detail: /6.*review rounds/ },
    { id: "guard-retirement:unknown-check", summary: "A protective check is proposed for removal", detail: /does not verify its usage/ },
    { id: "craigoley/remudero/standing-debt:1", summary: "The evidence exporter has no reader after 4 cycles of dwell", detail: /evidence exporter has no reader/ },
    { id: "standing-debt:2", summary: "The fleet still cannot check the archived results", detail: /cannot check the archived results/ },
  ];
  for (const item of cases) {
    const kind = item.id.split(":")[0]!.split("/").at(-1)!;
    assert.ok(TEMPLATED_KINDS.includes(kind), kind);
    const message = plainTemplate(item);
    assert.match(message.whatHappened, item.detail);
    assert.equal(checkPlainMessage(message, item).ok, true, JSON.stringify(message));
    assert.doesNotMatch(message.headline, /original record|item.*review|item.*look at/i);
    assert.deepEqual(await writePlainMessage(item, { summarize: () => { throw new Error("writer unavailable"); } }), message);
    for (const headline of ["Review the original record", "The fleet has an item for you to look at", "The item still needs your review"]) {
      assert.equal(checkPlainMessage({ ...clean, headline }, item).ok, false);
    }
  }
  const unknown = { id: "new-kind:1", summary: "No known template" };
  assert.equal(checkPlainMessage(plainTemplate(unknown), unknown).ok, true);
});

test("W1-T8926: fleet time described as working hours is refused", async () => {
  await refusedThenReasked({ ...clean, whatHappened: "It has cost developers over 12 working hours of lost productivity." }, /people.*time/i);
  for (const wording of ["Engineers lost time.", "Working hours were wasted.", "Productivity fell."]) {
    assert.equal(checkPlainMessage({ ...clean, ifNothingHappens: wording }, proposal).ok, false);
  }
  const people = { ...proposal, summary: "Developers spent twelve working hours checking this change." };
  assert.equal(checkPlainMessage({ ...clean, whatHappened: "Developers spent twelve working hours checking this change." }, people).ok, true);
  assert.equal(checkPlainMessage({ ...clean, whatHappened: "Developers lost twelve working hours." }, { ...proposal, summary: "The productivity check consumed 12 PR-hours of CI time." }).ok, false, "a source mentioning productivity still names no people");
});

test("W1-T8926: deployment framing the source never mentions is refused", async () => {
  await refusedThenReasked({ ...clean, headline: "Deployment Policy Change — Awaiting Approval" }, /deployment.*source/i);
  await refusedThenReasked({ ...clean, whatHappened: "Human review is required before production changes." }, /deployment.*source/i);
  const deployed = { ...proposal, summary: "A production deployment is waiting for approval." };
  assert.equal(checkPlainMessage({ ...clean, headline: "A production deployment awaits review" }, deployed).ok, true);
  assert.equal(checkPlainMessage({ ...clean, options: [{ ...clean.options[0]!, consequence: "Deploy to production." }, clean.options[1]!] }, proposal).ok, false);
});

test("W1-T8926: a headline that picks an option is refused", async () => {
  for (const headline of ["Go ahead with this task", "Approve the change", "Reject this change", "Release the waiting task", "Decline this proposal", "Keep this item", "Do not proceed", "A change is stuck; approve it to release it."]) {
    await refusedThenReasked({ ...clean, headline }, /headline.*option/i);
  }
  const labelled = { ...clean, headline: "Go (carefully) with this task", options: [{ ...clean.options[0]!, label: "Go (carefully)" }, clean.options[1]!] };
  assert.equal(checkPlainMessage(labelled, proposal).ok, false, "option labels are literal text");
  assert.equal(checkPlainMessage({ ...clean, headline: "Approval is waiting for evidence" }, proposal).ok, true);
  assert.equal(checkPlainMessage({ ...clean, headline: "Drop items need clearer evidence" }, proposal).ok, true, "a partial label is not a choice");
});

test("W1-T8926: harness terms in the headline are refused", async () => {
  for (const term of ["lane", "gates", "sweep", "shards", "rung", "ratchets"]) {
    await refusedThenReasked({ ...clean, headline: `The ${term} needs a decision` }, /harness.*headline/i);
    await refusedThenReasked({ ...clean, whatHappened: `The ${term} is blocked.` }, /harness.*what.happened/i);
  }
  assert.equal(checkPlainMessage({ ...clean, headline: "A sweeping change awaits review" }, proposal).ok, true);
});

test("W1-T8926: the writer is told who reads it and what the costs measure", async () => {
  let context = "";
  await writePlainMessage(proposal, { summarize: (input) => { context = input.context; return card(clean); } });
  assert.match(context, /operator of an autonomous software fleet/i);
  assert.match(context, /PR-minutes.*rounds.*hours.*machine.*CI time/i);
  assert.match(context, /never.*people.*time/i);
  assert.match(context, /merge.*arm.*review.*workflow.*deployment.*source/i);
  assert.match(context, /headline.*situation.*option/i);
  for (const [term, plain] of [["lane", "work queue"], ["gate", "review step"], ["sweep", "review pass"], ["shard", "task record"], ["rung", "stage"], ["ratchet", "cost check"]]) {
    assert.ok(context.includes(`${term} = ${plain}`), term);
  }
  assert.ok(context.endsWith(`Item: ${proposal.summary}`));
});

test("W1-T8926: a message stored under the previous contract is written again", async () => {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1-t8926-`));
  try {
    const previous = createHash("sha256").update(JSON.stringify(["inbox-plain-v3", proposal.id, proposal.summary])).digest("hex");
    const path = plainStorePath(dir);
    writeFileSync(path, JSON.stringify({ [proposal.id]: { ...clean, sourceFingerprint: previous } }));
    assert.notEqual(plainSourceFingerprint(proposal), previous);
    let writes = 0;
    const deps = { stateDir: dir, readProposals: () => [proposal], summarize: () => { writes += 1; return card(clean); } };
    assert.equal(await backfillPlainMessages(deps, 1), 1);
    assert.equal(await backfillPlainMessages(deps, 1), 0);
    assert.equal(writes, 1);
    const stored = readPlainStore(path)[proposal.id]!;
    assert.equal(stored.sourceFingerprint, plainSourceFingerprint(proposal));
    assert.equal(plainInboxMessage(proposal, { [proposal.id]: stored }), stored);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const openAge = {
  id: "board-review:stale:#13008",
  summary: "board-review: #13008 has sat open 10.3h, past the 8h depth threshold",
};

test("W1-T10365: open PR age is not a review deadline", async () => {
  for (const hours of ["0", "0.0", "10.3", "27.5"]) {
    const item = { ...openAge, summary: `board-review: #13008 has sat open ${hours}h, past the 8h depth threshold` };
    const message = plainTemplate(item);
    assert.equal(message.headline, "A proposed change is still open");
    assert.match(message.whatHappened, new RegExp(`open for ${hours.replace(".", "\\.")} hours`));
    assert.match(message.whatWeNeed, /age alone does not establish a human decision/);
    assert.doesNotMatch(message.headline, /waiting for review|overdue|deadline/i);
    assert.deepEqual(message.options.map((option) => option.intent), ["reply", "keep"], "wording grants no new action intent");
    assert.equal(checkPlainMessage(message, item).ok, true);
    assert.deepEqual(await writePlainMessage(item), message, "the real no-writer path stays factual");
  }
  for (const age of ["", "NaN", "Infinity", "-1", "1.2.3", "9".repeat(310)]) {
    const item = { ...openAge, summary: `board-review: #13008 has sat open ${age}h, past the 8h depth threshold` };
    const message = plainTemplate(item);
    assert.match(message.whatHappened, /age is unavailable/);
    assert.doesNotMatch(message.whatHappened, /open for 0 hours|NaN|Infinity/);
    assert.equal(checkPlainMessage(message, item).ok, true);
  }
  assert.match(plainTemplate({ ...openAge, summary: "" }).whatHappened, /age is unavailable/);
  const namespaced = { ...openAge, id: "craigoley/remudero/board-review:stale:#13008" };
  assert.equal(plainTemplate(namespaced).headline, "A proposed change is still open");
});

test("W1-T10365: cached age-only cards cannot invent a human review", () => {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}open-age-cache-`));
  try {
    const factual = plainTemplate(openAge);
    for (const wrong of [
      { headline: "A board review has remained open beyond its time limit" },
      { whatHappened: "The proposed change has been waiting for review for 10.3 hours." },
      { whatWeNeed: "Finish the overdue human review." },
      { ifNothingHappens: "The human review deadline will be missed." },
      { whatHappened: "The proposed change has been open for 100 hours." },
      { options: [{ ...factual.options[0]!, consequence: "Finish the overdue review." }, factual.options[1]!] },
    ]) {
      const cached: PlainInboxMessage = { ...factual, ...wrong, source: "writer", sourceFingerprint: plainSourceFingerprint(openAge) };
      const path = plainStorePath(dir);
      writeFileSync(path, JSON.stringify({ [openAge.id]: cached }));
      const bytes = readFileSync(path);
      const store = readPlainStore(path), before = JSON.stringify(store);
      assert.equal(checkPlainMessage(cached, openAge).ok, false, JSON.stringify(wrong));
      assert.deepEqual(plainInboxMessage(openAge, store), factual);
      assert.deepEqual(readFileSync(path), bytes, "reading the bad cache never rewrites history");
      assert.equal(JSON.stringify(store), before);
    }
    const truthful: PlainInboxMessage = { ...factual, source: "writer", sourceFingerprint: plainSourceFingerprint(openAge) };
    assert.equal(checkPlainMessage(truthful, openAge).ok, true, "positive control: source-faithful cached card remains readable");
    assert.equal(plainInboxMessage(openAge, { [openAge.id]: truthful }), truthful);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W1-T10365: explicit review escalations retain their questions", async () => {
  for (const ask of ["The merge permission needs a decision", "The change has sat open 10.3h; the merge permission still needs a decision"]) {
    const item = { id: "board-review:escalation:#13008", summary: `board-review: #13008 — unhandled escalation: "${ask}"` };
    const message = plainTemplate(item);
    assert.match(message.whatHappened, /merge permission.*needs a decision/);
    assert.equal(message.headline, "A proposed change has an unanswered decision");
    assert.equal(checkPlainMessage(message, item).ok, true);
    let attempts = 0;
    const answer = await writePlainMessage(item, { summarize: () => { attempts += 1; return card({ ...message, source: "writer" }); } });
    assert.equal(attempts, 1, "explicit asks keep their existing writer path");
    assert.equal(answer.source, "writer");
    assert.equal(answer.whatHappened, message.whatHappened);
  }
  const conflicting = { ...openAge, summary: 'board-review: #13008 — unhandled escalation: "The merge permission needs a decision"' };
  assert.match(plainTemplate(conflicting).whatHappened, /merge permission needs a decision/, "an explicit ask is not suppressed by an age id");
  const reframed = { ...openAge, summary: "The operator asks whether this change may merge." };
  assert.doesNotMatch(plainTemplate(reframed).headline, /still open/, "an age id does not turn an edited question into age-only information");
  let reframedCalls = 0;
  const reframedMessage = plainTemplate(reframed);
  assert.equal((await writePlainMessage(reframed, { summarize: () => { reframedCalls += 1; return card(reframedMessage); } })).source, "writer");
  assert.equal(reframedCalls, 1, "non-producer wording keeps the existing writer path");
  for (const item of [
    { id: "board-review:escalation:#13008", summary: "board-review: #13008 carries an unhandled escalation whose ask could not be read" },
    { id: "board-review:future:#13008", summary: "The source is not understood" },
    { id: "new-kind:13008", summary: "The source is not understood" },
  ]) {
    const message = plainTemplate(item);
    assert.doesNotMatch(message.headline, /still open/);
    let attempts = 0;
    assert.deepEqual(await writePlainMessage(item, { summarize: () => { attempts += 1; throw new Error("writer unavailable"); } }), message);
    assert.equal(attempts, 2, "other kinds and unreadable asks keep their existing bounded retry");
  }
});

test("W1-T10365: age-only cache maintenance adds no model calls", async () => {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}open-age-backfill-`));
  try {
    const cached = { ...plainTemplate(openAge), headline: "A board review is overdue", sourceFingerprint: plainSourceFingerprint(openAge) };
    const path = plainStorePath(dir);
    writeFileSync(path, JSON.stringify({ [openAge.id]: cached }));
    let calls = 0;
    const deps = { stateDir: dir, readProposals: () => [openAge], summarize: () => { calls += 1; return card(clean); } };
    const written = await backfillPlainMessages(deps, 1);
    assert.equal(calls, 0, "rejecting a misleading current cache must not add provider work through the existing backfill");
    assert.equal(written, 1);
    assert.equal(await backfillPlainMessages(deps, 1), 0, "the ordinary bounded maintenance converges");
    const stored = readPlainStore(path)[openAge.id]!;
    assert.equal(stored.sourceFingerprint, plainSourceFingerprint(openAge), "no global fingerprint bump");
    assert.equal(stored.source, "template");
    assert.equal(stored.headline, "A proposed change is still open");
    await writePlainMessage(openAge, { summarize: deps.summarize });
    assert.equal(calls, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
