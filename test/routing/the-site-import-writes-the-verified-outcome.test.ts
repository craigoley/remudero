/**
 * W1-T14985 — THE SITE IMPORT WRITES THE VERIFIED OUTCOME.
 *
 * OBSERVED 2026-11-26: remudero-site data/model-verified-outcome.json came only from running the site's
 * scripts/derive-model-verified-outcome.mjs by hand over the host's state/benchmark-cohort-index.json, so the Completion
 * and Cost figures went stale. The daily site import now runs that same site script in its fresh site checkout, with the
 * consent instant taken from the owner's receipts, and the file rides in the one reviewed site PR beside the field note.
 *
 * The site here is a real local git repository. Its stage stub honours the stage contract (exit 0 staged / 3 unchanged,
 * one JSON stdout line, the data file plus an outside summary). Its derive stub keeps the site script's contract: argv
 * `<index> <consent-at> <out>`, a refusal that names a cohort index with no verified outcome join, and an output that
 * depends on every input. GitHub is an in-memory REST fake.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { pathToFileURL } from "node:url";
import {
  consentAtFromReceipts, coreVerifiedOutcomeReceipts, SITE_IMPORT_BRANCH, SITE_VERIFIED_OUTCOME_FILE, SITE_VERIFIED_OUTCOME_SCRIPT, syncFieldNoteSiteImport,
} from "#src/lib/field-trials-site-import.js";
import type { ModelFieldNoteBody } from "#src/lib/field-trials-field-note.js";
import type { GhApiFetcher } from "#src/lib/open-prs-rest.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { gitRepo } from "#test/helpers/git-repo.js";

const NOW = "2026-11-26T15:00:00.000Z";
const RECEIPTS = ["owner-2026-10-27-craig-oley", "owner-2026-10-27-craig-oley", "owner-2026-10-27-craig-oley"];
const CONSENT_AT = "2026-10-27T23:59:59.999Z";

/** A cohort index with a lastGood verified outcome join, as core's cohort pass writes it. */
const JOINED_INDEX = {
  lastGood: {
    asOf: "2026-11-26T14:40:23.363Z",
    verifiedTaskOutcome: { state: "observed-partial", cutoff: "2026-11-26T04:43:01.425Z" },
    cohorts: [
      { dimensions: { model: "claude-sonnet-5-5" }, apiCostUsd: 1.234, subscriptionNotionalUsd: 2,
        verifiedOutcome: { assignments: 10, completed: 6, endedWithoutCompletion: 2, censored: 1, unavailable: 1, reasons: {} } },
      { dimensions: { model: "gpt-6.1-sol" }, apiCostUsd: 0.5, subscriptionNotionalUsd: 0,
        verifiedOutcome: { assignments: 4, completed: 1, endedWithoutCompletion: 3, censored: 0, unavailable: 0, reasons: {} } },
    ],
  },
};

/** The site's derive contract (remudero-site scripts/derive-model-verified-outcome.mjs, PORTAL-T65). */
const DERIVE_STUB = `import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
const [indexPath, consentAt, out] = process.argv.slice(2);
if (!indexPath || !consentAt || !out) { console.error("usage"); process.exit(2); }
const text = readFileSync(indexPath, "utf8");
const snapshot = JSON.parse(text).lastGood;
const verified = snapshot?.verifiedTaskOutcome;
if (!verified || typeof verified !== "object" || typeof verified.cutoff !== "string")
  throw new Error("cohort index has no verified outcome join (" + JSON.stringify(verified) + ")");
const rows = snapshot.cohorts.map((c) => ({ modelId: c.dimensions.model, calls: c.verifiedOutcome.assignments,
  completed: c.verifiedOutcome.completed, apiCostUsd: Math.round(c.apiCostUsd * 100) / 100 }));
writeFileSync(out, JSON.stringify({ schema: "model-verified-outcome-v1", asOf: snapshot.asOf, cutoff: verified.cutoff,
  sourceSha256: createHash("sha256").update(text).digest("hex"), consent: { by: "owner", at: consentAt }, rows }, null, 2) + "\\n");
`;

/** A stage stub: "staged" writes the field note and a summary; "unchanged" exits 3 and writes nothing. */
const stageStub = (mode: "staged" | "unchanged") => `import { readFileSync, writeFileSync } from "node:fs";
const [flag, candidatePath, summaryPath] = process.argv.slice(2);
if (flag !== "--daily-stage") process.exit(2);
const note = JSON.parse(readFileSync(candidatePath, "utf8"));
if (${JSON.stringify(mode)} === "unchanged") { console.log(JSON.stringify({ outcome: "unchanged", releaseId: note.releaseId })); process.exit(3); }
writeFileSync("data/model-field-note.json", JSON.stringify(note, null, 2));
writeFileSync(summaryPath, "## Daily field note candidate: " + note.releaseId + "\\n\\n- Review: the owner merge of this PR is the review.\\n");
console.log(JSON.stringify({ outcome: "staged", releaseId: note.releaseId }));
`;

function siteFixture(t: TestContext, mode: "staged" | "unchanged") {
  const repo = gitRepo({ scope: t, seedCommit: false, kind: "w1-t14985-site" });
  mkdirSync(join(repo.dir, "data"), { recursive: true });
  mkdirSync(join(repo.dir, "scripts"));
  writeFileSync(join(repo.dir, "data", "model-field-note.json"), "null\n");
  writeFileSync(join(repo.dir, "data", "model-field-note-history.json"), JSON.stringify({ releases: [] }));
  writeFileSync(join(repo.dir, SITE_VERIFIED_OUTCOME_FILE), JSON.stringify({ unpublished: true }) + "\n");
  writeFileSync(join(repo.dir, "scripts", "import-model-field-note.mjs"), stageStub(mode));
  writeFileSync(join(repo.dir, SITE_VERIFIED_OUTCOME_SCRIPT), DERIVE_STUB);
  repo.git("add", "-A");
  repo.git("commit", "-q", "-m", "site main");
  return { url: pathToFileURL(repo.dir).href, dir: repo.dir };
}

/** In-memory GitHub REST for the site: git data, refs and pulls. */
function siteRest() {
  const state = { trees: [] as { tree: { path: string; content: string }[] }[], prs: [] as { number: number; body: string }[] };
  const fetch: GhApiFetcher = (args) => {
    const method = args[1] === "--method" ? args[2]! : "GET";
    const path = method === "GET" ? args[1]! : args[3]!;
    const field = (name: string) => args.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1);
    const input = args.includes("--input") ? JSON.parse(readFileSync(args[args.indexOf("--input") + 1]!, "utf8")) : undefined;
    if (method === "POST" && path.endsWith("/git/trees")) { state.trees.push(input); return { sha: `tree-${state.trees.length}` }; }
    if (method === "POST" && path.endsWith("/git/commits")) return { sha: "commit-1" };
    if (method === "PATCH" && path.endsWith(`/git/refs/heads/${SITE_IMPORT_BRANCH}`)) throw new Error("gh: Reference does not exist (HTTP 422)");
    if (method === "POST" && path.endsWith("/git/refs")) return {};
    if (method === "GET" && path.includes("/pulls?head=")) return [];
    if (method === "POST" && path.endsWith("/pulls")) {
      const pr = { number: 400 + state.prs.length, html_url: `https://github.com/craigoley/remudero-site/pull/${400 + state.prs.length}`,
        body: field("body")! };
      state.prs.push(pr);
      return pr;
    }
    throw new Error(`unexpected GitHub call: ${args.join(" ")}`);
  };
  return { fetch, state };
}

const NOTE = { releaseId: "fn-2026-11-25-2026-11-26-abc", asOf: "2026-11-26T12:00:00.000Z" } as unknown as ModelFieldNoteBody;

async function importPass(t: TestContext, index: unknown, mode: "staged" | "unchanged" = "staged", receipts: readonly string[] = RECEIPTS) {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1-t14985-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const site = siteFixture(t, mode);
  const cohortIndexPath = join(root, "benchmark-cohort-index.json");
  writeFileSync(cohortIndexPath, JSON.stringify(index));
  const rest = siteRest();
  const outcome = await syncFieldNoteSiteImport({ workRoot: join(root, "work"), nowIso: NOW,
    exportCandidate: () => ({ state: "candidate", note: NOTE }), verifiedOutcome: { cohortIndexPath, receipts } },
  { siteUrl: site.url, fetch: rest.fetch, writeProof: async () => ({ ok: true }) });
  const pushed = new Map((rest.state.trees.at(-1)?.tree ?? []).map((entry) => [entry.path, entry.content]));
  return { outcome, pushed, rest, site, cohortIndexPath, root };
}

test("W1-T14985 criterion 1: the site import writes the verified outcome the site script derives", async (t) => {
  const { outcome, pushed, rest, site, cohortIndexPath, root } = await importPass(t, JOINED_INDEX);
  assert.equal(outcome.state, "staged", JSON.stringify(outcome));
  assert.deepEqual(pushed.has("data/model-field-note.json"), true, "the field note still rides in the PR");
  // The same site script run by hand over the same inputs is the expected file, byte for byte.
  const by = join(root, "by-hand.json");
  const hand = spawnSync(process.execPath, [join(site.dir, SITE_VERIFIED_OUTCOME_SCRIPT), cohortIndexPath, CONSENT_AT, by], { encoding: "utf8" });
  assert.equal(hand.status, 0, hand.stderr);
  assert.equal(pushed.get(SITE_VERIFIED_OUTCOME_FILE), readFileSync(by, "utf8"), "the PR carries the site script's own output");
  const written = JSON.parse(pushed.get(SITE_VERIFIED_OUTCOME_FILE)!);
  assert.deepEqual(written.consent, { by: "owner", at: CONSENT_AT }, "consent is the end of the receipt's UTC day");
  assert.deepEqual(written.rows.map((row: { modelId: string }) => row.modelId), ["claude-sonnet-5-5", "gpt-6.1-sol"]);
  assert.ok("verifiedOutcome" in outcome && outcome.verifiedOutcome?.state === "written");
  assert.match(rest.state.prs[0]!.body, /Verified outcome: data\/model-verified-outcome\.json derived by scripts\/derive-model-verified-outcome\.mjs \(consent at 2026-10-27T23:59:59\.999Z\)/);
});

test("W1-T14985 criterion 1: an unchanged field note still ships a new verified outcome in its own PR", async (t) => {
  const { outcome, pushed } = await importPass(t, JOINED_INDEX, "unchanged");
  assert.equal(outcome.state, "staged", JSON.stringify(outcome));
  assert.deepEqual([...pushed.keys()], [SITE_VERIFIED_OUTCOME_FILE]);
});

test("W1-T14985 criterion 1: the consent instant comes from the receipts, never before the consent", () => {
  assert.deepEqual(consentAtFromReceipts(RECEIPTS, NOW), { at: CONSENT_AT });
  assert.deepEqual(consentAtFromReceipts(["owner-2026-11-26-craig-oley"], NOW), { at: NOW }, "a receipt from today is clamped to now");
  assert.deepEqual(consentAtFromReceipts([], NOW), { reason: "no-consent-receipt" });
  assert.deepEqual(consentAtFromReceipts(["owner-2026-11-27-craig-oley"], NOW),
    { reason: "consent-receipt-after-pass: owner-2026-11-27-craig-oley" }, "a receipt dated after the pass is never clamped back");
  assert.deepEqual(consentAtFromReceipts(["owner-2026-10-27-a", "owner-2026-10-28-b"], NOW),
    { reason: "consent-receipts-disagree: 2026-10-27, 2026-10-28" });
  assert.deepEqual(consentAtFromReceipts(["owner-craig-oley"], NOW), { reason: "consent-receipt-has-no-date: owner-craig-oley" });
  assert.deepEqual(consentAtFromReceipts(["owner-2026-02-30-x"], NOW), { reason: "consent-receipt-has-no-date: owner-2026-02-30-x" });
});

test("W1-T14985 criterion 1: only core's own live aggregate grant authorises publishing core's cohort index", async (t) => {
  const consoleGrant = { repo: "craigoley/remudero-console", rights: "aggregate-opt-in", receipt: "owner-2026-10-27-console" };
  const core = { repo: "craigoley/remudero", rights: "aggregate-opt-in", receipt: "owner-2026-10-27-core" };
  assert.deepEqual(coreVerifiedOutcomeReceipts([consoleGrant, core]), ["owner-2026-10-27-core"], "another repository's receipt never counts");
  assert.deepEqual(coreVerifiedOutcomeReceipts([consoleGrant]), [], "core absent");
  assert.deepEqual(coreVerifiedOutcomeReceipts([consoleGrant, { ...core, revoked: true }]), [], "core revoked");
  assert.deepEqual(coreVerifiedOutcomeReceipts([consoleGrant, { ...core, rights: "private" }]), [], "core private");
  // With no core grant the pass writes no verified outcome, names why, and the field note still ships.
  const { outcome, pushed, rest } = await importPass(t, JOINED_INDEX, "staged", coreVerifiedOutcomeReceipts([consoleGrant]));
  assert.equal(outcome.state, "staged", JSON.stringify(outcome));
  assert.equal(pushed.has(SITE_VERIFIED_OUTCOME_FILE), false, "core's data never reaches the site PR");
  assert.deepEqual("verifiedOutcome" in outcome ? outcome.verifiedOutcome : undefined,
    { state: "not-written", reason: "no-core-aggregate-consent" });
  assert.match(rest.state.prs[0]!.body, /Verified outcome: not written \(no-core-aggregate-consent\)/);
});

test("W1-T14985 criterion 2: a cohort index with no verified outcome writes no file and says why", async (t) => {
  const index = { lastGood: { ...JOINED_INDEX.lastGood, verifiedTaskOutcome: "unavailable-no-github-verification-join" } };
  const { outcome, pushed, rest } = await importPass(t, index);
  assert.equal(outcome.state, "staged", "the field note is still staged");
  assert.equal(pushed.has(SITE_VERIFIED_OUTCOME_FILE), false, "no verified outcome file rides in the PR");
  assert.ok("verifiedOutcome" in outcome && outcome.verifiedOutcome?.state === "not-written", JSON.stringify(outcome));
  assert.match((outcome.verifiedOutcome as { reason: string }).reason,
    /^site-derive-exit-1: cohort index has no verified outcome join \("unavailable-no-github-verification-join"\)$/);
  assert.match(rest.state.prs[0]!.body, /Verified outcome: not written \(site-derive-exit-1: cohort index has no verified outcome join/);
});

test("W1-T14985 criterion 2: with an unchanged field note and no verified outcome, nothing is published", async (t) => {
  const index = { lastGood: { ...JOINED_INDEX.lastGood, verifiedTaskOutcome: "unavailable-no-github-verification-join" } };
  const { outcome, rest } = await importPass(t, index, "unchanged");
  assert.equal(outcome.state, "unchanged");
  assert.ok("verifiedOutcome" in outcome && outcome.verifiedOutcome?.state === "not-written");
  assert.equal(rest.state.prs.length, 0);
});
