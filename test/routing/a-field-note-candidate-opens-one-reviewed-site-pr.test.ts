/**
 * W1-T10832 — a field-note candidate opens ONE owner-reviewed site PR.
 *
 * The daily refresh, with the owner's consent file, exports the W1-T10831 candidate and hands it to
 * the SITE's own stage mode (remudero-site scripts/import-model-field-note.mjs --daily-stage, PORTAL-T41)
 * in a fresh checkout of site main. The site repository here is a real local git repository whose stage
 * script is a stub honouring that script's documented contract (exit 0 staged / 3 unchanged / 1 refused,
 * one JSON stdout line, the two data files plus an outside summary); GitHub is an in-memory REST fake.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { buildFieldTrialsFlowSnapshot, fieldTrialsCommand, readFieldTrialsLedger } from "#src/lib/field-trials-flow.js";
import { SITE_IMPORT_BRANCH, SITE_IMPORT_GRANT, syncFieldNoteSiteImport, type FieldNoteExport, type SiteImportDeps } from "#src/lib/field-trials-site-import.js";
import type { ModelFieldNoteBody } from "#src/lib/field-trials-field-note.js";
import type { GhApiFetcher } from "#src/lib/open-prs-rest.js";
import { taskIdFromHeadRef } from "#src/lib/body-repair.js";
import { taskIdFromRunBranch, taskIdFromSlugBranch } from "#src/lib/status.js";
import { isDispatchedRunBranch } from "#src/lib/sweep.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { writeLedger } from "#test/helpers/ledger-fixture.js";

const DAY = (day: number, hour = 0) => new Date(Date.UTC(2026, 8, day, hour)).toISOString();
const BLOB = "b".repeat(40);
// The site's collector-staged key set (remudero-site lib/model-field-note.ts collectorStagedKeys, read 2026-10-28).
const SITE_STAGED_KEYS = ["schema", "releaseId", "status", "publicationScope", "evidence", "publishedAt", "windowStart",
  "windowEnd", "asOf", "sourceDigest", "sourceRepos", "consentRegistryRevision", "rows", "stagedBy", "stagedAt"].sort();
type Mode = "staged" | "unchanged" | "refused" | "no-daily-stage" | "absent" | "outside-data" | "garbled";

function git(cwd: string, ...args: string[]) {
  const result = spawnSync("git", ["-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", ...args], { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}

/** A real site repository on `main` with the history it has released and a stage stub in `mode`. */
function siteRepository(root: string, mode: Mode, released: Record<string, unknown>[] = []) {
  const dir = join(root, `site-origin-${mode}-${released.length}-${Math.random().toString(36).slice(2)}`);
  const seen = join(root, "seen-candidates.ndjson");
  mkdirSync(join(dir, "data"), { recursive: true });
  mkdirSync(join(dir, "scripts"));
  writeFileSync(join(dir, "data", "model-field-note.json"), "null\n");
  writeFileSync(join(dir, "data", "model-field-note-history.json"), JSON.stringify({ schema: "model-field-note-history-v1", releases: released }));
  if (mode === "no-daily-stage") writeFileSync(join(dir, "scripts", "import-model-field-note.mjs"), "// operator import only\n");
  else if (mode !== "absent") writeFileSync(join(dir, "scripts", "import-model-field-note.mjs"), `import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
const [flag, candidatePath, summaryPath] = process.argv.slice(2);
if (flag !== "--daily-stage") process.exit(2);
const note = JSON.parse(readFileSync(candidatePath, "utf8"));
appendFileSync(${JSON.stringify(seen)}, JSON.stringify(note) + "\\n");
const mode = ${JSON.stringify(mode)};
if (mode === "garbled") { console.log("not json"); process.exit(0); }
if (mode === "unchanged") { console.log(JSON.stringify({ outcome: "unchanged", releaseId: note.releaseId })); process.exit(3); }
if (mode === "refused") {
  console.log(JSON.stringify({ outcome: "refused", reason: "model field note refused: cross-release differencing risk; overlaps fn-prior" }));
  process.exit(1);
}
const history = JSON.parse(readFileSync("data/model-field-note-history.json", "utf8"));
history.releases.push({ releaseId: note.releaseId, windowStart: note.windowStart, windowEnd: note.windowEnd,
  sourceRepos: note.sourceRepos, lineageDigest: "fixture", publishedAt: note.publishedAt });
writeFileSync("data/model-field-note-history.json", JSON.stringify(history, null, 2));
writeFileSync("data/model-field-note.json", JSON.stringify(note, null, 2));
if (mode === "outside-data") writeFileSync("README.md", "edited");
writeFileSync(summaryPath, "## Daily field note candidate: " + note.releaseId + "\\n\\n- UTC window: " + note.windowStart + " – "
  + note.windowEnd + " UTC\\n- Review: the owner merge of this PR is the review.\\n");
console.log(JSON.stringify({ outcome: "staged", releaseId: note.releaseId }));
`);
  git(dir, "init", "-q", "-b", "main");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "site main");
  return { url: pathToFileURL(dir).href, seen };
}

/** In-memory GitHub REST for craigoley/remudero-site: git data, refs, and pulls. Records every call. */
function fakeGithub(opts: { failWrites?: boolean } = {}) {
  const calls: string[][] = [];
  const state = { branch: false, head: "", trees: [] as { base_tree: string; tree: { path: string; content: string }[] }[],
    commits: [] as { parents: string[]; tree: string }[],
    prs: [] as { number: number; html_url: string; title: string; body: string; head: string; base: string; open: boolean; draft: boolean }[] };
  const field = (args: string[], name: string) => args.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1);
  const fetch: GhApiFetcher = (args) => {
    calls.push(args);
    const method = args[1] === "--method" ? args[2]! : "GET";
    const path = method === "GET" ? args[1]! : args[3]!;
    const input = args.includes("--input") ? JSON.parse(readFileSync(args[args.indexOf("--input") + 1]!, "utf8")) : undefined;
    if (opts.failWrites && method !== "GET") throw new Error("gh: Resource not accessible by integration (HTTP 403)");
    if (method === "POST" && path.endsWith("/git/trees")) { state.trees.push(input); return { sha: `tree-${state.trees.length}` }; }
    if (method === "POST" && path.endsWith("/git/commits")) { state.commits.push(input); return { sha: `commit-${state.commits.length}` }; }
    if (method === "PATCH" && path.endsWith(`/git/refs/heads/${SITE_IMPORT_BRANCH}`)) {
      if (!state.branch) throw new Error("gh: Reference does not exist (HTTP 422)");
      state.head = field(args, "sha")!; return {};
    }
    if (method === "POST" && path.endsWith("/git/refs")) { state.branch = true; state.head = field(args, "sha")!; return {}; }
    if (method === "GET" && path.includes("/pulls?head=craigoley:")) {
      return state.prs.filter((pr) => pr.open && `craigoley:${pr.head}` === /head=([^&]+)/.exec(path)![1]);
    }
    if (method === "POST" && path.endsWith("/pulls")) {
      const pr = { number: 300 + state.prs.length, html_url: `https://github.com/craigoley/remudero-site/pull/${300 + state.prs.length}`,
        title: field(args, "title")!, body: field(args, "body")!, head: field(args, "head")!, base: field(args, "base")!, open: true,
        draft: field(args, "draft") === "true" };
      state.prs.push(pr); return pr;
    }
    const update = /\/pulls\/(\d+)$/.exec(path);
    if (method === "PATCH" && update) {
      const pr = state.prs.find((candidate) => candidate.number === Number(update[1]))!;
      pr.title = field(args, "title")!; pr.body = field(args, "body")!; return pr;
    }
    throw new Error(`unexpected GitHub call: ${args.join(" ")}`);
  };
  return { fetch, calls, state };
}

/** The ledger rows of one day: 20 served assignments of one model on each given day. */
function rowsFor(days: number[]): Record<string, unknown>[] {
  return days.flatMap((day) => Array.from({ length: 20 }, (_, i) => {
    const id = `asg-${day}-${i}`;
    const base = { host: "host-alpha-private", actor: "daemon", task_id: `task-${id}`, run_id: `run-${id}` };
    return [{ ...base, ts: DAY(day, 2), step: "worker.assignment",
      worker_assignment: { id, requested: { model: "gpt-6.1-sol" }, selected: { provider: "p", model: "gpt-6.1-sol" } },
      benchmark_run: { work: { taskClass: { state: "observed", value: "implement" } } } },
    { ...base, ts: DAY(day, 3), step: "worker.attempt", selection_assignment_id: id, served_model: "gpt-6.1-sol", success: true }];
  }).flat());
}

/** One full daily `rmd field-trials` refresh pass, online against fakes, with the owner's consent file. */
async function dailyPass(root: string, nowIso: string, days: number[], siteImport: SiteImportDeps) {
  const stateDir = join(root, "state"), outDir = join(stateDir, "field-trials");
  mkdirSync(outDir, { recursive: true });
  const consent = join(root, "consent.json");
  writeFileSync(consent, JSON.stringify({ version: "field-trials-consent-v1",
    repos: [{ repo: "craigoley/remudero", rights: "aggregate-opt-in", receipt: "owner-2026-10-27-test" }] }));
  const lines: string[] = [];
  const code = await fieldTrialsCommand(["--source", "core=craigoley/remudero", "--ledger", `core=${stateDir}`, "--out-dir", outDir,
    "--consent", consent, "--refresh-step", "routing-review=0", "--refresh-step", "case-files=0", "--refresh-script-blob", BLOB],
  buildFieldTrialsFlowSnapshot, { nowIso, print: (line) => lines.push(line), printError: () => {},
    resolveConfig: () => ({ root }), fetch: async () => ({ ok: true, items: [] }),
    refreshIssues: { create: () => { throw new Error("no alert expected"); }, listOpen: () => [] },
    readLedger: async () => {
      const fixture = writeLedger(rowsFor(days));
      try { return await readFieldTrialsLedger(fixture.dir, Date.parse(nowIso)); }
      finally { rmSync(fixture.dir, { recursive: true, force: true }); }
    }, siteImport });
  const ledger = readFileSync(join(stateDir, "ledger.ndjson"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  return { code, lines, outDir, row: ledger.filter((row) => row.step === "field-trials.site-import").at(-1),
    refreshRows: ledger.filter((row) => row.step === "field-trials.refresh").length };
}

const seenCandidates = (seen: string) => existsSync(seen)
  ? readFileSync(seen, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>) : [];
const tempRoot = (name: string) => mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}site-import-${name}-`));
const MERGE_SHAPED = /merge|auto_merge|automerge|enablePullRequestAutoMerge|\/reviews|graphql|draft=true|ready_for_review/i;
const ALLOWED_ENDPOINT = new RegExp("^(POST repos/craigoley/remudero-site/git/(trees|commits|refs)"
  + `|PATCH repos/craigoley/remudero-site/git/refs/heads/${SITE_IMPORT_BRANCH}`
  + "|GET repos/craigoley/remudero-site/pulls\\?head=craigoley:[^&]+&state=open"
  + "|POST repos/craigoley/remudero-site/pulls|PATCH repos/craigoley/remudero-site/pulls/\\d+)$");

test("W1-T10832: a field-note candidate keeps exactly one site import PR open", async () => {
  const root = tempRoot("one-pr");
  try {
    const site = siteRepository(root, "staged");
    const github = fakeGithub();
    const first = await dailyPass(root, DAY(4, 7), [1, 2, 3], { fetch: github.fetch, siteUrl: site.url });
    assert.equal(first.code, 0, first.lines.join("\n"));
    assert.equal(first.row.state, "staged", JSON.stringify(first.row));
    assert.equal(first.row.pr, "opened");
    assert.equal(first.refreshRows, 1, "the pass still records its refresh row");
    assert.equal(github.state.prs.length, 1);
    const [pr] = github.state.prs;
    assert.deepEqual([pr!.head, pr!.base, pr!.draft, pr!.open], [SITE_IMPORT_BRANCH, "main", false, true], "one READY PR from the import branch");
    assert.ok(github.calls.some((call) => call.includes("repos/craigoley/remudero-site/pulls") && call.includes("POST")),
      "opened through createPlanPrRest's REST argv");
    assert.equal(first.row.prUrl, pr!.html_url);
    assert.match(pr!.body, /^## Daily field note candidate: fn-2026-09-01-2026-09-04-/, "the body is the stage mode's own summary");
    assert.doesNotMatch(pr!.body, /Remudero-Task:/, "no task trailer: no fleet lane may credit or review it");
    assert.deepEqual(github.state.trees[0]!.tree.map((entry) => entry.path),
      ["data/model-field-note-history.json", "data/model-field-note.json"], "the PR carries only the data files the stage changed");
    assert.equal(github.state.commits[0]!.tree, "tree-1");
    assert.equal(github.state.head, "commit-1", "the branch points at the staged commit");
    // The branch is outside every fleet shape, so no sweep can resolve a task for it and arm it.
    assert.equal(taskIdFromRunBranch(SITE_IMPORT_BRANCH), undefined);
    assert.equal(taskIdFromHeadRef(SITE_IMPORT_BRANCH), undefined);
    assert.equal(taskIdFromSlugBranch(SITE_IMPORT_BRANCH, ["PORTAL-T41", "PORTAL-T37", "W1-T10832"]), undefined);
    assert.equal(isDispatchedRunBranch(SITE_IMPORT_BRANCH), false);
    assert.doesNotMatch(SITE_IMPORT_BRANCH, /^(run-|plan-file-|codex\/|claude\/|dependabot\/)/);

    // Day two, the PR still unmerged: the replacement covers ONE window from the last RELEASED end
    // (none yet), and the open PR is updated in place — never a second one.
    const second = await dailyPass(root, DAY(5, 7), [1, 2, 3, 4], { fetch: github.fetch, siteUrl: site.url });
    assert.equal(second.row.state, "staged", JSON.stringify(second.row));
    assert.equal(second.row.pr, "updated");
    assert.equal(github.state.prs.length, 1, "exactly one site import PR exists");
    assert.equal(github.calls.filter((call) => call[2] === "POST" && call[3]!.endsWith("/pulls")).length, 1);
    const replaced = seenCandidates(site.seen).at(-1)!;
    assert.deepEqual([replaced.windowStart, replaced.windowEnd], [DAY(1), DAY(5)], "the unmerged window is replaced, not stacked");
    assert.match(github.state.prs[0]!.body, /fn-2026-09-01-2026-09-05-/, "the open PR now carries the newer candidate");
    assert.deepEqual(github.state.commits[1]!.parents, github.state.commits[0]!.parents, "both rebuilt on site main");

    // The owner merged day two's release: the next candidate starts at its end and opens a fresh PR.
    github.state.prs[0]!.open = false;
    const merged = siteRepository(root, "staged", [{ releaseId: String(replaced.releaseId), windowStart: DAY(1), windowEnd: DAY(5),
      sourceRepos: ["remudero"], lineageDigest: "fixture", publishedAt: String(replaced.publishedAt) }]);
    const third = await dailyPass(root, DAY(6, 7), [1, 2, 3, 4, 5], { fetch: github.fetch, siteUrl: merged.url });
    assert.equal(third.row.pr, "opened", JSON.stringify(third.row));
    const next = seenCandidates(merged.seen).at(-1)!;
    assert.deepEqual([next.windowStart, next.windowEnd], [DAY(5), DAY(6)], "a window from the last RELEASED windowEnd");
    assert.equal(github.state.prs.filter((candidate) => candidate.open).length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T10832: core stamps no review fields and nothing merges the site PR", async () => {
  const root = tempRoot("no-stamp");
  try {
    const site = siteRepository(root, "staged");
    const github = fakeGithub();
    const pass = await dailyPass(root, DAY(4, 7), [1, 2, 3], { fetch: github.fetch, siteUrl: site.url });
    assert.equal(pass.row.state, "staged", JSON.stringify(pass.row));
    const [staged] = seenCandidates(site.seen);
    assert.deepEqual(Object.keys(staged!).sort(), SITE_STAGED_KEYS, "exactly the site's collector-staged shape");
    for (const field of ["reviewedBy", "reviewedAt"]) assert.equal(Object.hasOwn(staged!, field), false, `core never writes ${field}`);
    assert.equal(staged!.stagedBy, "field-trials-collector");
    assert.equal(staged!.stagedAt, DAY(4, 7));
    const candidate = JSON.parse(readFileSync(join(pass.outDir, "field-note-candidate-latest.json"), "utf8"));
    assert.equal(candidate.state, "candidate-unreviewed", "core's own candidate stays unreviewed");
    for (const field of ["reviewedBy", "reviewedAt", "publishedAt", "stagedBy", "stagedAt"]) {
      assert.equal(Object.hasOwn(candidate.note, field), false, `the private candidate carries no ${field}`);
    }
    // What core pushes is byte-for-byte what the site's stage mode wrote: core never edits the staged note.
    const pushed = github.state.trees[0]!.tree.find((entry) => entry.path === "data/model-field-note.json")!;
    assert.deepEqual(JSON.parse(pushed.content), staged);
    assert.ok(github.calls.length > 0);
    for (const call of github.calls) {
      const endpoint = `${call[1] === "--method" ? call[2] : "GET"} ${call.find((arg) => arg.startsWith("repos/"))}`;
      assert.match(endpoint, ALLOWED_ENDPOINT, `only git data, the branch ref and the PR's own text: ${endpoint}`);
      assert.doesNotMatch(endpoint, MERGE_SHAPED, `no arm, enqueue, approve or merge: ${endpoint}`);
      assert.ok(!call.some((arg) => /^(draft|auto_merge|merge_method|event)=/.test(arg)), `no draft, arm or review field: ${call.join(" ")}`);
    }
    assert.ok(github.calls.every((call) => call[0] === "api"), "REST only");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T10832: a refused or unchanged stage opens no PR", async () => {
  const root = tempRoot("refused");
  try {
    const refusedSite = siteRepository(root, "refused");
    const github = fakeGithub();
    const refused = await dailyPass(root, DAY(4, 7), [1, 2, 3], { fetch: github.fetch, siteUrl: refusedSite.url });
    assert.equal(refused.code, 0, "a site refusal never fails the refresh's other steps");
    assert.deepEqual({ state: refused.row.state, by: refused.row.by, reason: refused.row.reason },
      { state: "refused", by: "site", reason: "model field note refused: cross-release differencing risk; overlaps fn-prior" },
      "the site validator's own reason is in the pass's ledger outcome");
    assert.equal(refused.row.scriptBlob, BLOB);
    assert.equal(seenCandidates(refusedSite.seen).length, 1, "the site, not core, decided");
    assert.deepEqual(github.calls, [], "a refusal opens no PR and writes nothing to the site");
    assert.match(refused.lines.join("\n"), /site import: refused \(model field note refused/);

    const unchangedSite = siteRepository(root, "unchanged");
    const unchanged = await dailyPass(root, DAY(5, 7), [1, 2, 3, 4], { fetch: github.fetch, siteUrl: unchangedSite.url });
    assert.equal(unchanged.row.state, "unchanged", JSON.stringify(unchanged.row));
    assert.deepEqual(github.calls, [], "unchanged is never treated as staged: no branch, no PR");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T10832: every unhealthy site-import arm is a recorded outcome, never a throw or a PR", () => {
  const root = tempRoot("arms");
  try {
    const note = { schema: "model-field-note-v1", releaseId: "fn-2026-09-01-2026-09-04-abcdefabcdef", status: "published",
      publicationScope: "public-opt-in", evidence: "observational", windowStart: DAY(1), windowEnd: DAY(4), asOf: DAY(4, 6),
      sourceDigest: "a".repeat(64), sourceRepos: ["remudero"], consentRegistryRevision: "owner-2026-09-25-v1",
      rows: [] } as ModelFieldNoteBody;
    const candidate = (): FieldNoteExport => ({ state: "candidate", note });
    const sync = (mode: Mode | null, deps: SiteImportDeps = {}, exportCandidate = candidate) => {
      const github = fakeGithub();
      const outcome = syncFieldNoteSiteImport({ workRoot: join(root, "work"), nowIso: DAY(4, 7), exportCandidate },
        { fetch: github.fetch, ...(mode ? { siteUrl: siteRepository(root, mode).url } : {}), ...deps });
      return { outcome, calls: github.calls };
    };
    const missing = sync(null, { siteUrl: pathToFileURL(join(root, "no-such-site")).href });
    assert.equal(missing.outcome.state, "site-checkout-failed");
    assert.match((missing.outcome as { reason: string }).reason, /^git-clone-exit-/);
    assert.deepEqual(sync("staged", {}, () => ({ state: "withheld", reason: "no-new-whole-utc-day" })).outcome,
      { state: "withheld", reason: "no-new-whole-utc-day" });
    assert.deepEqual(sync("staged", {}, () => ({ state: "refused", reason: "private-join-key-in-candidate" })).outcome,
      { state: "refused", by: "exporter", reason: "private-join-key-in-candidate" });
    for (const mode of ["absent", "no-daily-stage"] as const) {
      assert.deepEqual(sync(mode).outcome, { state: "site-stage-mode-unavailable", releaseId: note.releaseId },
        `${mode}: until PORTAL-T41 is on site main the pass stops after the candidate`);
    }
    assert.match(JSON.stringify(sync("garbled").outcome), /"state":"stage-failed".*stage-output-not-json/);
    const outside = sync("outside-data");
    assert.match(JSON.stringify(outside.outcome), /"state":"stage-failed".*stage-wrote-outside-data: \?\? README\.md/);
    assert.deepEqual(outside.calls, []);
    const grantless = fakeGithub({ failWrites: true });
    const denied = syncFieldNoteSiteImport({ workRoot: join(root, "work"), nowIso: DAY(4, 7), exportCandidate: candidate },
      { fetch: grantless.fetch, siteUrl: siteRepository(root, "staged").url });
    assert.equal(denied.state, "publish-failed");
    assert.equal((denied as { grant: string }).grant, SITE_IMPORT_GRANT, "the outcome names the exact grant the operator must add");
    assert.match((denied as { reason: string }).reason, /Resource not accessible by integration/);
    assert.ok(grantless.state.prs.length === 0, "no PR without the grant");
    const unreadable = siteRepository(root, "staged");
    const historyless = join(root, "historyless");
    git(root, "clone", "-q", unreadable.url, historyless);
    rmSync(join(historyless, "data", "model-field-note-history.json"));
    git(historyless, "commit", "-qam", "drop history");
    const noHistory = sync(null, { siteUrl: pathToFileURL(historyless).href });
    assert.match(JSON.stringify(noHistory.outcome), /"state":"site-checkout-failed".*site-history-unreadable: ENOENT/);
    assert.deepEqual(readdirSync(join(root, "work")), [], "every pass removes its own scratch checkout");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
