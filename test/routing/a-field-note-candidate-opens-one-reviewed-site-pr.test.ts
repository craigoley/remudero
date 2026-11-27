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
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { buildFieldTrialsFlowSnapshot, fieldTrialsCommand, readFieldTrialsLedger } from "#src/lib/field-trials-flow.js";
import { appWriteProof, SITE_IMPORT_BRANCH, SITE_IMPORT_GRANT, syncFieldNoteSiteImport, type FieldNoteExport, type SiteWriteProof }
  from "#src/lib/field-trials-site-import.js";
import type { ModelFieldNoteBody } from "#src/lib/field-trials-field-note.js";
import { taskIdFromHeadRef } from "#src/lib/body-repair.js";
import { taskIdFromRunBranch, taskIdFromSlugBranch } from "#src/lib/status.js";
import { buildSweepEffects, deriveDisposition, isDispatchedRunBranch, isOwnerMergeOnlyHead, runSweep, type OpenPrView, type SweepDeps }
  from "#test/helpers/sweep-test.js";
import { appendLedger } from "#src/lib/ledger.js";
import { withLiveWritesAllowed } from "#src/lib/live-write-guard.js";
import type { Config } from "#src/lib/config.js";
import { ghShim } from "#test/helpers/gh-shim.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import type { GhApiFetcher } from "#src/lib/open-prs-rest.js";
import { gitRepo } from "#test/helpers/git-repo.js";
import { writeLedger } from "#test/helpers/ledger-fixture.js";

const DAY = (day: number, hour = 0) => new Date(Date.UTC(2026, 8, day, hour)).toISOString();
const BLOB = "b".repeat(40);
const EXPORT_KEYS = ["schema", "releaseId", "status", "publicationScope", "evidence", "windowStart",
  "windowEnd", "asOf", "sourceDigest", "sourceRepos", "consentRegistryRevision", "rows"].sort();
/** W1-T14984: the site's collector-staged key set (remudero-site lib/model-field-note.ts collectorStagedKeys). */
const SITE_COLLECTOR_STAGED_KEYS = [...EXPORT_KEYS, "publishedAt", "stagedBy", "stagedAt"].sort();
type SiteImportOptions = NonNullable<Parameters<typeof syncFieldNoteSiteImport>[1]>;
type Mode = "staged" | "unchanged" | "refused" | "no-daily-stage" | "absent" | "outside-data" | "garbled" | "usage"
  | "staged-nothing" | "dir-script" | "git-hook" | "git-config-refused";

/** A real site repository on `main` with the history it has released and a stage stub in `mode`. */
function stageFixture(scope: Pick<TestContext, "after">, root: string, mode: Mode, released: Record<string, unknown>[] = []) {
  const repo = gitRepo({ scope, seedCommit: false, kind: "site-origin" });
  const dir = repo.dir;
  const seen = join(root, "seen-candidates.ndjson");
  const stagedNote = join(root, "site-staged-note.json");
  mkdirSync(join(dir, "data"), { recursive: true });
  mkdirSync(join(dir, "scripts"));
  writeFileSync(join(dir, "data", "model-field-note.json"), "null\n");
  writeFileSync(join(dir, "data", "model-field-note-history.json"), JSON.stringify({ schema: "model-field-note-history-v1", releases: released }));
  if (mode === "no-daily-stage") writeFileSync(join(dir, "scripts", "import-model-field-note.mjs"), "// operator import only\n");
  else if (mode === "dir-script") {
    mkdirSync(join(dir, "scripts", "import-model-field-note.mjs"));
    writeFileSync(join(dir, "scripts", "import-model-field-note.mjs", "keep"), "");
  } else if (mode !== "absent") writeFileSync(join(dir, "scripts", "import-model-field-note.mjs"), `import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
const [flag, candidatePath, summaryPath] = process.argv.slice(2);
if (flag !== "--daily-stage") process.exit(2);
const note = JSON.parse(readFileSync(candidatePath, "utf8"));
appendFileSync(${JSON.stringify(seen)}, JSON.stringify(note) + "\\n");
const mode = ${JSON.stringify(mode)};
// W1-T14984: the site's own admission (remudero-site lib/model-field-note.ts parseModelFieldNote, collector arm): its
// exact key set, the collector's stamp and the date order. The real site stamps nothing; a note failing this is refused.
const KEYS = ${JSON.stringify(SITE_COLLECTOR_STAGED_KEYS)};
const iso = (value) => typeof value === "string" && /^\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\d\\.\\d{3}Z$/.test(value)
  && new Date(value).toISOString() === value;
const dates = [note.windowStart, note.windowEnd, note.asOf, note.stagedAt, note.publishedAt];
const admitted = Object.keys(note).length === KEYS.length && KEYS.every((key) => Object.hasOwn(note, key))
  && note.stagedBy === "field-trials-collector" && dates.every(iso) && dates[0] < dates[1] && dates[1] <= dates[2]
  && dates[2] <= dates[3] && dates[3] <= dates[4] && Date.parse(dates[4]) <= Date.now();
if (!admitted && !["garbled", "usage"].includes(mode)) {
  console.log(JSON.stringify({ outcome: "refused", reason: "model field note refused: invalid schema, rights, coverage or disclosure cell" }));
  process.exit(1);
}
const staged = note;
if (mode === "garbled") { console.log("not json"); process.exit(0); }
if (mode === "usage") { console.error("usage: --daily-stage"); process.exit(2); }
if (mode === "staged-nothing") { console.log(JSON.stringify({ outcome: "staged", releaseId: note.releaseId })); process.exit(0); }
if (mode === "unchanged") { console.log(JSON.stringify({ outcome: "unchanged", releaseId: note.releaseId })); process.exit(3); }
if (mode === "refused") {
  console.log(JSON.stringify({ outcome: "refused", reason: "model field note refused: cross-release differencing risk; overlaps fn-prior" }));
  process.exit(1);
}
const history = JSON.parse(readFileSync("data/model-field-note-history.json", "utf8"));
history.releases.push({ releaseId: note.releaseId, windowStart: note.windowStart, windowEnd: note.windowEnd,
  sourceRepos: note.sourceRepos, lineageDigest: "fixture", publishedAt: staged.publishedAt });
writeFileSync("data/model-field-note-history.json", JSON.stringify(history, null, 2));
const stagedJson = JSON.stringify(staged, null, 2);
writeFileSync("data/model-field-note.json", stagedJson);
writeFileSync(${JSON.stringify(stagedNote)}, stagedJson);
if (mode === "git-hook") {
  writeFileSync(".git/fsmonitor-hook", "#!" + process.execPath + "\\nrequire('node:fs').writeFileSync("
    + ${JSON.stringify(JSON.stringify(join(root, "git-hook-ran")))} + ", 'ran');\\n", { mode: 0o700 });
  appendFileSync(".git/config", "\\n[core]\\nfsmonitor = .git/fsmonitor-hook\\n");
}
if (mode === "git-config-refused") appendFileSync(".git/config", "\\n[core]\\neditor = untrusted-editor\\n");
if (mode === "outside-data") writeFileSync("README.md", "edited");
writeFileSync(summaryPath, "## Daily field note candidate: " + note.releaseId + "\\n\\n- UTC window: " + note.windowStart + " – "
  + note.windowEnd + " UTC\\n- Review: the owner merge of this PR is the review.\\n");
console.log(JSON.stringify({ outcome: "staged", releaseId: note.releaseId }));
`);
  repo.git("add", "-A");
  repo.git("commit", "-q", "-m", "site main");
  return { url: pathToFileURL(dir).href, seen, stagedNote };
}

/** In-memory GitHub REST for craigoley/remudero-site: git data, refs, and pulls. Records every call. */
function siteRest(opts: { failWrites?: boolean; failRefCreation?: boolean; noSha?: "tree" | "commit" } = {}) {
  const state = { branch: false, head: "", trees: [] as { base_tree: string; tree: { path: string; content: string }[] }[],
    commits: [] as { parents: string[]; tree: string }[],
    prs: [] as { number: number; html_url: string; title: string; body: string; head: string; base: string; open: boolean; draft: boolean }[] };
  const field = (args: string[], name: string) => args.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1);
  const calls: string[][] = [];
  const fetch: GhApiFetcher = (args) => {
    calls.push([...args]);
    const method = args[1] === "--method" ? args[2]! : "GET";
    const path = method === "GET" ? args[1]! : args[3]!;
    const input = args.includes("--input") ? JSON.parse(readFileSync(args[args.indexOf("--input") + 1]!, "utf8")) : undefined;
    if (opts.failWrites && method !== "GET") throw new Error("gh: Resource not accessible by integration (HTTP 403)");
    if (method === "POST" && path.endsWith("/git/trees")) {
      state.trees.push(input); return opts.noSha === "tree" ? {} : { sha: `tree-${state.trees.length}` };
    }
    if (method === "POST" && path.endsWith("/git/commits")) {
      state.commits.push(input); return opts.noSha === "commit" ? {} : { sha: `commit-${state.commits.length}` };
    }
    if (method === "PATCH" && path.endsWith(`/git/refs/heads/${SITE_IMPORT_BRANCH}`)) {
      if (!state.branch) throw new Error("gh: Reference does not exist (HTTP 422)");
      state.head = field(args, "sha")!; return {};
    }
    if (method === "POST" && path.endsWith("/git/refs")) {
      if (opts.failRefCreation) throw new Error("gh: Cannot create site branch (HTTP 403)");
      state.branch = true; state.head = field(args, "sha")!; return {};
    }
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

/** The SERVICE App installation proved it can write the site (a fake of the scoped-token proof). */
const granted: SiteWriteProof = async () => ({ ok: true });

/** One full daily `rmd field-trials` refresh pass, online against fakes, with the owner's consent file. */
async function dailyPass(root: string, nowIso: string, days: number[], siteImport: SiteImportOptions) {
  const stateDir = join(root, "state"), outDir = join(stateDir, "field-trials");
  mkdirSync(outDir, { recursive: true });
  const consent = join(root, "consent.json");
  writeFileSync(consent, JSON.stringify({ version: "field-trials-consent-v1",
    repos: [{ repo: "craigoley/remudero", rights: "aggregate-opt-in", receipt: "owner-2026-08-27-test" }] }));
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
    }, siteImport: { writeProof: granted, ...siteImport } });
  const ledger = readFileSync(join(stateDir, "ledger.ndjson"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  return { code, lines, outDir, row: ledger.filter((row) => row.step === "field-trials.refresh").at(-1)?.siteImport,
    refreshRow: ledger.filter((row) => row.step === "field-trials.refresh").at(-1),
    refreshRows: ledger.filter((row) => row.step === "field-trials.refresh").length };
}

/** An offline pass, or one without a valid consent file, withholds without touching the site at all. */
async function withheldPass(root: string, consent: string | null, offline: boolean) {
  const stateDir = join(root, `state-${String(consent !== null)}-${String(offline)}`), outDir = join(stateDir, "field-trials");
  mkdirSync(outDir, { recursive: true });
  const consentPath = join(root, "consent-variant.json");
  if (consent !== null) writeFileSync(consentPath, consent);
  const code = await fieldTrialsCommand(["--source", "core=craigoley/remudero", "--ledger", `core=${stateDir}`, "--out-dir", outDir,
    ...(consent !== null ? ["--consent", consentPath] : []), ...(offline ? ["--offline"] : []),
    "--refresh-step", "routing-review=0", "--refresh-step", "case-files=0", "--refresh-script-blob", BLOB],
  buildFieldTrialsFlowSnapshot, { nowIso: DAY(4, 7), print: () => {}, printError: () => {}, resolveConfig: () => ({ root }),
    fetch: async () => ({ ok: true, items: [] }), refreshIssues: { create: () => { throw new Error("no alert expected"); }, listOpen: () => [] },
    readLedger: async () => {
      const fixture = writeLedger(rowsFor([1]));
      try { return await readFieldTrialsLedger(fixture.dir, Date.parse(DAY(4, 7))); }
      finally { rmSync(fixture.dir, { recursive: true, force: true }); }
    },
    siteImport: { spawn: () => { throw new Error("no site stage expected"); } } });
  const rows = readFileSync(join(stateDir, "ledger.ndjson"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  return { code, row: rows.find((row) => row.step === "field-trials.refresh")?.siteImport,
    refreshRow: rows.find((row) => row.step === "field-trials.refresh") };
}

/**
 * The SITE instance's own sweep, built from the shipped effects with `armSessionPrs` ON (the live policy value):
 * a trailer-less PR then arms as `PR-<n>`. Every `gh` call lands in a recording shim; `arm` records which PRs the
 * sweep handed to the arm effect, delegating to the real one for the import PR and standing in for the control.
 */
async function siteSweep(t: TestContext, importPr: OpenPrView, controlPr: OpenPrView) {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}site-sweep-`));
  const ledgerPath = join(root, "state", "ledger.ndjson");
  const shim = ghShim([], { kind: "site-sweep-gh" });
  const previousPath = process.env.PATH;
  process.env.PATH = `${shim.dir}:${previousPath}`;
  t.after(() => { process.env.PATH = previousPath; rmSync(root, { recursive: true, force: true }); rmSync(shim.dir, { recursive: true, force: true }); });
  for (const pr of [importPr, controlPr]) {
    appendLedger(ledgerPath, { step: "review.posted", run_id: "review", task_id: `PR-${pr.prNumber}`, pr_url: pr.prUrl,
      head_sha: pr.headSha, state: "success", capped: false, plan_only: false, proof_exec: ["executed_pass"] });
  }
  const logs: Record<string, unknown>[] = [];
  const effects = buildSweepEffects({ owner: "craigoley", repo: "remudero-site", config: { root, claudeBin: "/bin/true" } as Config,
    ledgerPath, runId: "site-sweep", plan: { tasks: [], byId: new Map() },
    log: (step, fields = {}) => { logs.push({ step, ...fields }); },
    armSessionPrsOverride: true, spawnWallClockBoundMsOverride: 1 });
  const armed: number[] = [];
  const deps: SweepDeps = {
    arm: (pr, mode) => { armed.push(pr.prNumber); return pr.prNumber === importPr.prNumber ? effects.arm(pr, mode) : "armed"; },
    close: () => { throw new Error("nothing may close the import PR"); }, dispatchFix: () => {}, escalate: () => {},
    ledgerPath, runId: "site-sweep" };
  const summary = await withLiveWritesAllowed(() => runSweep([importPr, controlPr], deps));
  const direct = await withLiveWritesAllowed(() => effects.arm(importPr));
  return { armed, summary, direct, ghCalls: shim.calls(), logs };
}

const seenCandidates = (seen: string) => existsSync(seen)
  ? readFileSync(seen, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>) : [];
const tempRoot = (name: string) => mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}site-import-${name}-`));
const MERGE_SHAPED = /merge|auto_merge|automerge|enablePullRequestAutoMerge|\/reviews|graphql|draft=true|ready_for_review/i;
const ALLOWED_ENDPOINT = new RegExp("^(POST repos/craigoley/remudero-site/git/(trees|commits|refs)"
  + `|PATCH repos/craigoley/remudero-site/git/refs/heads/${SITE_IMPORT_BRANCH}`
  + "|GET repos/craigoley/remudero-site/pulls\\?head=craigoley:[^&]+&state=open"
  + "|POST repos/craigoley/remudero-site/pulls|PATCH repos/craigoley/remudero-site/pulls/\\d+)$");

test("W1-T10832: a field-note candidate keeps exactly one site import PR open", async (t) => {
  const root = tempRoot("one-pr");
  try {
    const site = stageFixture(t, root, "staged");
    const github = siteRest();
    const first = await dailyPass(root, DAY(4, 7), [1, 2, 3], { fetch: github.fetch, siteUrl: site.url });
    assert.equal(first.code, 0, first.lines.join("\n"));
    assert.equal(first.row.state, "staged", JSON.stringify(first.row));
    assert.equal(first.row.pr, "opened");
    assert.equal(first.refreshRows, 1, "the pass still records its refresh row");
    assert.deepEqual(first.refreshRow.siteImport, {
      state: "staged", releaseId: first.row.releaseId, pr: "opened", prUrl: first.row.prUrl,
      prNumber: first.row.prNumber, files: first.row.files,
      // W1-T14985: this fixture site has no verified-outcome script, and the row says so.
      verifiedOutcome: { state: "not-written", reason: "site-derive-script-unreadable: ENOENT" } }, "the refresh row records the opened PR");
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
    assert.equal(second.refreshRow.siteImport.pr, "updated", "the refresh row records the update");
    assert.equal(github.state.prs.length, 1, "exactly one site import PR exists");
    assert.equal(github.calls.filter((call) => call[2] === "POST" && call[3]!.endsWith("/pulls")).length, 1);
    const replaced = seenCandidates(site.seen).at(-1)!;
    assert.deepEqual([replaced.windowStart, replaced.windowEnd], [DAY(1), DAY(5)], "the unmerged window is replaced, not stacked");
    assert.match(github.state.prs[0]!.body, /fn-2026-09-01-2026-09-05-/, "the open PR now carries the newer candidate");
    assert.deepEqual(github.state.commits[1]!.parents, github.state.commits[0]!.parents, "both rebuilt on site main");

    // The owner merged day two's release: the next candidate starts at its end and opens a fresh PR.
    github.state.prs[0]!.open = false;
    const merged = stageFixture(t, root, "staged", [{ releaseId: String(replaced.releaseId), windowStart: DAY(1), windowEnd: DAY(5),
      sourceRepos: ["remudero"], lineageDigest: "fixture", publishedAt: DAY(5, 7) }]);
    const third = await dailyPass(root, DAY(6, 7), [1, 2, 3, 4, 5], { fetch: github.fetch, siteUrl: merged.url });
    assert.equal(third.row.pr, "opened", JSON.stringify(third.row));
    const next = seenCandidates(merged.seen).at(-1)!;
    assert.deepEqual([next.windowStart, next.windowEnd], [DAY(5), DAY(6)], "a window from the last RELEASED windowEnd");
    assert.equal(github.state.prs.filter((candidate) => candidate.open).length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T14984 criterion 1: a staged field note carries the collector's stamps the site requires", async (t) => {
  const root = tempRoot("collector-stamps");
  try {
    const site = stageFixture(t, root, "staged");
    const github = siteRest();
    const pass = await dailyPass(root, DAY(4, 7), [1, 2, 3], { fetch: github.fetch, siteUrl: site.url });
    assert.equal(pass.row.state, "staged", `the site's stage mode admits the stamped note: ${JSON.stringify(pass.row)}`);
    const [siteInput] = seenCandidates(site.seen);
    assert.deepEqual(Object.keys(siteInput!).sort(), SITE_COLLECTOR_STAGED_KEYS, "exactly the site's collector-staged keys");
    assert.equal(siteInput!.stagedBy, "field-trials-collector");
    const order = [siteInput!.asOf, siteInput!.stagedAt, siteInput!.publishedAt] as string[];
    assert.ok(order[0]! <= order[1]! && order[1]! <= order[2]! && Date.parse(order[2]!) <= Date.now(),
      `asOf <= stagedAt <= publishedAt <= now: ${order.join(" ")}`);
    // The fake is the site's gate, not a stamp of its own: the exporter's bare note, as core sent it before, is refused.
    const bare = Object.fromEntries(Object.entries(siteInput!).filter(([key]) => !["stagedBy", "stagedAt", "publishedAt"].includes(key)));
    mkdirSync(join(root, "bare"), { recursive: true });
    const bareSite = stageFixture(t, join(root, "bare"), "staged");
    const bareRoot = join(root, "bare-pass");
    mkdirSync(bareRoot, { recursive: true });
    const refusedBare = await syncFieldNoteSiteImport({ workRoot: bareRoot, nowIso: DAY(4, 7),
      exportCandidate: () => ({ state: "candidate", note: bare as unknown as ModelFieldNoteBody }) },
      { siteUrl: bareSite.url, fetch: siteRest().fetch, writeProof: granted });
    assert.equal(refusedBare.state, "staged", "core stamps even a note handed to it bare");
    for (const drop of ["stagedBy", "stagedAt", "publishedAt"]) {
      const unstamped = Object.fromEntries(Object.entries(siteInput!).filter(([key]) => key !== drop));
      mkdirSync(join(root, `drop-${drop}`), { recursive: true });
      const dropped = stageFixture(t, join(root, `drop-${drop}`), "staged");
      const candidate = join(root, `drop-${drop}.json`);
      writeFileSync(candidate, JSON.stringify(unstamped));
      const run = spawnSync(process.execPath, [join(fileURLToPath(dropped.url), "scripts", "import-model-field-note.mjs"), "--daily-stage", candidate,
        join(root, `drop-${drop}.md`)], { cwd: fileURLToPath(dropped.url), encoding: "utf8" });
      assert.equal(run.status, 1, `the site fake refuses a note missing ${drop}`);
      assert.match(run.stdout, /invalid schema, rights, coverage or disclosure cell/);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T10832: core stamps no review fields and nothing merges the site PR", async (t) => {
  const root = tempRoot("no-stamp");
  try {
    const site = stageFixture(t, root, "staged");
    const github = siteRest();
    const pass = await dailyPass(root, DAY(4, 7), [1, 2, 3], { fetch: github.fetch, siteUrl: site.url });
    assert.equal(pass.row.state, "staged", JSON.stringify(pass.row));
    const [siteInput] = seenCandidates(site.seen);
    // W1-T14984: core adds only the collector stamps the site's stage mode requires; never a review field.
    assert.deepEqual(Object.keys(siteInput!).sort(), SITE_COLLECTOR_STAGED_KEYS, "core passes the exporter's note with the collector stamps");
    for (const field of ["reviewedBy", "reviewedAt"]) {
      assert.equal(Object.hasOwn(siteInput!, field), false, `core never writes ${field} into the importer input`);
    }
    const candidate = JSON.parse(readFileSync(join(pass.outDir, "field-note-candidate-latest.json"), "utf8"));
    assert.equal(candidate.state, "candidate-unreviewed", "core's own candidate stays unreviewed");
    for (const field of ["reviewedBy", "reviewedAt", "publishedAt", "stagedBy", "stagedAt"]) {
      assert.equal(Object.hasOwn(candidate.note, field), false, `the private candidate carries no ${field}`);
    }
    // What core pushes is byte-for-byte what the site's stage mode wrote: core never edits the staged note.
    const pushed = github.state.trees[0]!.tree.find((entry) => entry.path === "data/model-field-note.json")!;
    const staged = JSON.parse(pushed.content);
    assert.equal(pushed.content, readFileSync(site.stagedNote, "utf8"), "core sends exactly the site's staged note");
    assert.equal(staged.publishedAt, DAY(4, 7), "the collector stamps the publication at the pass's time");
    assert.equal(staged.stagedBy, "field-trials-collector");
    assert.equal(staged.stagedAt, DAY(4, 7));
    assert.equal(Object.hasOwn(staged, "reviewedBy"), false);
    assert.equal(Object.hasOwn(staged, "reviewedAt"), false);
    assert.ok(github.calls.length > 0);
    for (const call of github.calls) {
      const endpoint = `${call[1] === "--method" ? call[2] : "GET"} ${call.find((arg) => arg.startsWith("repos/"))}`;
      assert.match(endpoint, ALLOWED_ENDPOINT, `only git data, the branch ref and the PR's own text: ${endpoint}`);
      assert.doesNotMatch(endpoint, MERGE_SHAPED, `no arm, enqueue, approve or merge: ${endpoint}`);
      assert.ok(!call.some((arg) => /^(draft|auto_merge|merge_method|event)=/.test(arg)), `no draft, arm or review field: ${call.join(" ")}`);
    }
    assert.ok(github.calls.every((call) => call[0] === "api"), "REST only");

    // The site instance's shipped sweep, armSessionPrs ON: the green, review-passed import PR is held for its owner.
    const view = (prNumber: number, headRefName: string): OpenPrView => ({ prNumber, headRefName, headSha: `${prNumber}`.repeat(40).slice(0, 40),
      prUrl: `https://github.com/craigoley/remudero-site/pull/${prNumber}`, autoMergeArmed: false, reviewState: "success",
      checksState: "green", unmetCriteria: [], priorStrikes: 0, lastActivityAt: new Date().toISOString(),
      createdAt: new Date(Date.now() - 86_400_000).toISOString(), body: github.state.prs[0]!.body });
    const importPr = view(pass.row.prNumber, SITE_IMPORT_BRANCH);
    const controlPr = view(pass.row.prNumber + 1, "run-unfiled-1795467848601");
    assert.equal(isOwnerMergeOnlyHead(SITE_IMPORT_BRANCH), true, "the import branch is the shape the sweep holds");
    const stale = Date.now() + 90 * 86_400_000;
    assert.deepEqual(deriveDisposition(importPr, undefined, stale).disposition, "wait", "held, never closed as stale");
    assert.equal(deriveDisposition(importPr).blocker, "operator-hold");
    const sweep = await siteSweep(t, importPr, controlPr);
    assert.deepEqual(sweep.armed, [controlPr.prNumber], `armSessionPrs arms the control and never the import PR: ${
      JSON.stringify(sweep.summary.actions)}`);
    assert.equal(sweep.direct, "hold-refused", "the shipped arm effect itself refuses the owner-merge-only head");
    assert.deepEqual(sweep.ghCalls.filter((call) => /merge|--auto|reviews/.test(call)), [], "no gh merge, arm or approve call");
    assert.ok(sweep.logs.some((row) => row.step === "automerge.arm_skipped" && row.head_ref === SITE_IMPORT_BRANCH
      && row.outcome === "hold-refused"), "the refusal is recorded with the head it held");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T10832: a site release unknown to the private window record bounds the next candidate", async (t) => {
  const root = tempRoot("site-only-release");
  try {
    const released = { releaseId: "fn-site-only", windowStart: DAY(1), windowEnd: DAY(3),
      sourceRepos: ["remudero"], lineageDigest: "fixture", publishedAt: DAY(3) };
    const site = stageFixture(t, root, "staged", [released]);
    const github = siteRest();
    const pass = await dailyPass(root, DAY(5, 7), [1, 2, 3, 4], { fetch: github.fetch, siteUrl: site.url });
    assert.equal(pass.row.state, "staged", JSON.stringify(pass.row));
    const [staged] = seenCandidates(site.seen);
    assert.deepEqual([staged!.windowStart, staged!.windowEnd], [DAY(3), DAY(5)],
      "the released site history wins when the private window record has no matching release");
    assert.equal(github.state.prs.length, 1);
    assert.equal(JSON.parse(github.state.trees[0]!.tree.find((entry) => entry.path === "data/model-field-note.json")!.content).windowStart,
      DAY(3), "the staged note carries that same bounded window");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T10832: the SERVICE App installation proves it can write the site before any write", async (t) => {
  const root = tempRoot("grant");
  try {
    const asked: string[] = [];
    const mint = (permissions: Record<string, string>, repositories = ["remudero-site"]) =>
      (async (repo: string) => { asked.push(repo); return { ok: true, token: "t", permissions, repositories }; }) as never;
    const env = { GH_APP_ID: "1", GH_APP_INSTALLATION_ID: "2", GH_APP_PRIVATE_KEY_PATH: "/k" };
    const cases = [
      { proof: appWriteProof(env, mint({ contents: "write" })), missing: ["pull_requests"] },
      { proof: appWriteProof(env, mint({ contents: "write", pull_requests: "write" }, ["remudero", "remudero-site"])), missing: ["repositories"] },
      // The real default mint, with no App identity: it fails before any network read.
      { proof: appWriteProof({}), missing: ["token"] },
    ];
    for (const { proof, missing } of cases) {
      const github = siteRest();
      const day = await dailyPass(root, DAY(4, 7), [1, 2, 3], { fetch: github.fetch, siteUrl: stageFixture(t, root, "staged").url, writeProof: proof });
      assert.equal(day.row.state, "site-grant-missing", JSON.stringify(day.row));
      assert.deepEqual(day.row.missing, missing);
      assert.equal(day.row.grant, SITE_IMPORT_GRANT, "the outcome names the exact grant the operator must add");
      assert.equal(day.refreshRow.siteImport.state, "site-grant-missing", "the field-trials.refresh row says so");
      assert.deepEqual(github.calls, [], "no branch, commit or PR write without the proven grant");
      rmSync(join(root, "state"), { recursive: true, force: true });
    }
    assert.deepEqual(asked, ["craigoley/remudero-site", "craigoley/remudero-site"], "the token is scoped to the site alone");
    const github = siteRest();
    const proven = await dailyPass(root, DAY(4, 7), [1, 2, 3], { fetch: github.fetch, siteUrl: stageFixture(t, root, "staged").url,
      writeProof: appWriteProof(env, mint({ contents: "write", pull_requests: "write" })) });
    assert.deepEqual([proven.row.state, proven.row.pr], ["staged", "opened"], JSON.stringify(proven.row));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T10832: a refused or unchanged stage opens no PR", async (t) => {
  const root = tempRoot("refused");
  try {
    const refusedSite = stageFixture(t, root, "refused");
    const github = siteRest();
    const refused = await dailyPass(root, DAY(4, 7), [1, 2, 3], { fetch: github.fetch, siteUrl: refusedSite.url });
    assert.equal(refused.code, 0, "a site refusal never fails the refresh's other steps");
    assert.deepEqual({ state: refused.row.state, by: refused.row.by, reason: refused.row.reason },
      { state: "refused", by: "site", reason: "model field note refused: cross-release differencing risk; overlaps fn-prior" },
      "the site validator's own reason is in the pass's ledger outcome");
    assert.equal(refused.refreshRow.scriptBlob, BLOB);
    assert.deepEqual(refused.refreshRow.siteImport, { state: "refused", by: "site", releaseId: refused.row.releaseId,
      reason: "model field note refused: cross-release differencing risk; overlaps fn-prior" },
    "the field-trials.refresh row carries the site's refusal reason");
    assert.equal(seenCandidates(refusedSite.seen).length, 1, "the site, not core, decided");
    assert.deepEqual(github.calls, [], "a refusal opens no PR and writes nothing to the site");
    assert.match(refused.lines.join("\n"), /site import: refused \(model field note refused/);

    const unchangedSite = stageFixture(t, root, "unchanged");
    const unchanged = await dailyPass(root, DAY(5, 7), [1, 2, 3, 4], { fetch: github.fetch, siteUrl: unchangedSite.url });
    assert.equal(unchanged.row.state, "unchanged", JSON.stringify(unchanged.row));
    assert.deepEqual(unchanged.refreshRow.siteImport, { state: "unchanged", releaseId: unchanged.row.releaseId,
      verifiedOutcome: { state: "not-written", reason: "site-derive-script-unreadable: ENOENT" } },
      "the field-trials.refresh row records unchanged without a PR");
    assert.deepEqual(github.calls, [], "unchanged is never treated as staged: no branch, no PR");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T10832: git reads cannot execute a hook written by the site's stage script", async (t) => {
  const root = tempRoot("git-hook");
  try {
    const site = stageFixture(t, root, "git-hook");
    const github = siteRest();
    const pass = await dailyPass(root, DAY(4, 7), [1, 2, 3], { fetch: github.fetch, siteUrl: site.url });
    assert.equal(pass.row.state, "staged", JSON.stringify(pass.row));
    assert.equal(github.state.prs.length, 1, "the hardened reads still publish the staged data");
    assert.equal(existsSync(join(root, "git-hook-ran")), false, "stage-written fsmonitor code never executes");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T10832: every unhealthy site-import arm is a recorded outcome, never a throw or a PR", async (t) => {
  const root = tempRoot("arms");
  try {
    const note = { schema: "model-field-note-v1", releaseId: "fn-2026-09-01-2026-09-04-abcdefabcdef", status: "published",
      publicationScope: "public-opt-in", evidence: "observational", windowStart: DAY(1), windowEnd: DAY(4), asOf: DAY(4, 6),
      sourceDigest: "a".repeat(64), sourceRepos: ["remudero"], consentRegistryRevision: "owner-2026-09-25-v1",
      rows: [] } as ModelFieldNoteBody;
    const candidate = (): FieldNoteExport => ({ state: "candidate", note });
    const sync = async (mode: Mode | null, deps: SiteImportOptions = {}, exportCandidate = candidate) => {
      const github = siteRest();
      const outcome = await syncFieldNoteSiteImport({ workRoot: join(root, "work"), nowIso: DAY(4, 7), exportCandidate },
        { fetch: github.fetch, writeProof: granted, ...(mode ? { siteUrl: stageFixture(t, root, mode).url } : {}), ...deps });
      return { outcome, calls: github.calls };
    };
    const valid = JSON.stringify({ version: "field-trials-consent-v1",
      repos: [{ repo: "craigoley/remudero", rights: "aggregate-opt-in", receipt: "owner-2026-10-27-test" }] });
    for (const [consent, offline, reason] of [[null, false, "no-consent-receipt"], ['{"version":"x"}', false, "consent-invalid"],
      [valid, true, "offline-pass"]] as const) {
      const pass = await withheldPass(root, consent, offline);
      assert.deepEqual([pass.code, pass.row?.state, pass.row?.reason], [0, "withheld", reason], `${reason}: withheld before any site read`);
      assert.deepEqual(pass.refreshRow?.siteImport, { state: "withheld", reason },
        `${reason}: the refresh row records the withheld reason`);
    }
    const missing = await sync(null, { siteUrl: pathToFileURL(join(root, "no-such-site")).href });
    assert.equal(missing.outcome.state, "site-checkout-failed");
    assert.match((missing.outcome as { reason: string }).reason, /^git-clone-exit-/);
    assert.deepEqual((await sync("staged", {}, () => ({ state: "withheld", reason: "no-new-whole-utc-day" }))).outcome,
      { state: "withheld", reason: "no-new-whole-utc-day" });
    assert.deepEqual((await sync("staged", {}, () => ({ state: "refused", reason: "private-join-key-in-candidate" }))).outcome,
      { state: "refused", by: "exporter", reason: "private-join-key-in-candidate" });
    for (const mode of ["absent", "no-daily-stage"] as const) {
      assert.deepEqual((await sync(mode)).outcome, { state: "site-stage-mode-unavailable", releaseId: note.releaseId },
        `${mode}: until PORTAL-T41 is on site main the pass stops after the candidate`);
    }
    assert.match(JSON.stringify((await sync("garbled")).outcome), /"state":"stage-failed".*stage-output-not-json/);
    const outside = await sync("outside-data");
    assert.match(JSON.stringify(outside.outcome), /"state":"stage-failed".*stage-wrote-outside-data: \?\? README\.md/);
    assert.deepEqual(outside.calls, []);
    const configRefused = await sync("git-config-refused");
    assert.match(JSON.stringify(configRefused.outcome), /"state":"stage-failed".*git-status-failed:.*core.editor/);
    assert.deepEqual(configRefused.calls, [], "a pinned-config refusal never reaches the REST writer");
    const grantless = siteRest({ failWrites: true });
    const denied = await syncFieldNoteSiteImport({ workRoot: join(root, "work"), nowIso: DAY(4, 7), exportCandidate: candidate },
      { fetch: grantless.fetch, writeProof: granted, siteUrl: stageFixture(t, root, "staged").url });
    assert.equal(denied.state, "publish-failed");
    assert.equal((denied as { grant: string }).grant, SITE_IMPORT_GRANT, "the outcome names the exact grant the operator must add");
    assert.match((denied as { reason: string }).reason, /Resource not accessible by integration/);
    assert.ok(grantless.state.prs.length === 0, "no PR without the grant");
    const blockedRef = siteRest({ failRefCreation: true });
    const deniedRef = await syncFieldNoteSiteImport({ workRoot: join(root, "work"), nowIso: DAY(4, 7), exportCandidate: candidate },
      { fetch: blockedRef.fetch, writeProof: granted, siteUrl: stageFixture(t, root, "staged").url });
    assert.equal(deniedRef.state, "publish-failed");
    assert.match((deniedRef as { reason: string }).reason,
      /ref-update-failed:.*Reference does not exist.*ref-create-failed:.*Cannot create site branch/,
      "both branch-write failures are visible in the outcome");
    assert.equal((deniedRef as { grant: string }).grant, SITE_IMPORT_GRANT);
    assert.equal(blockedRef.state.prs.length, 0, "a branch write failure never opens a PR");
    const unreadable = stageFixture(t, root, "staged");
    const historyless = gitRepo({ scope: t, cloneFrom: unreadable.url });
    rmSync(join(historyless.dir, "data", "model-field-note-history.json"));
    historyless.git("commit", "-qam", "drop history");
    const noHistory = await sync(null, { siteUrl: pathToFileURL(historyless.dir).href });
    assert.match(JSON.stringify(noHistory.outcome), /"state":"site-checkout-failed".*site-history-unreadable: ENOENT/);
    historyless.git("checkout", "-q", "HEAD~1", "--", "data/model-field-note-history.json");
    writeFileSync(join(historyless.dir, "data", "model-field-note-history.json"), JSON.stringify({ releases: "none" }));
    historyless.git("add", "-A");
    historyless.git("commit", "-qm", "malformed history");
    const malformed = await sync(null, { siteUrl: pathToFileURL(historyless.dir).href });
    assert.deepEqual(malformed.outcome, { state: "site-checkout-failed", reason: "site-history-malformed" });
    for (const [noSha, reason] of [["tree", "git-tree-write-returned-no-sha"], ["commit", "git-commit-write-returned-no-sha"]] as const) {
      const shaless = siteRest({ noSha });
      const outcome = await syncFieldNoteSiteImport({ workRoot: join(root, "work"), nowIso: DAY(4, 7), exportCandidate: candidate },
        { fetch: shaless.fetch, writeProof: granted, siteUrl: stageFixture(t, root, "staged").url });
      assert.deepEqual(outcome, { state: "publish-failed", releaseId: note.releaseId, reason, grant: SITE_IMPORT_GRANT });
      assert.equal(shaless.state.prs.length, 0, `${noSha}: a write GitHub did not acknowledge opens no PR`);
    }
    assert.match(JSON.stringify((await sync("usage")).outcome), /"state":"stage-failed".*stage-exit-2: usage: --daily-stage/);
    assert.match(JSON.stringify((await sync("staged-nothing")).outcome), /stage-reported-staged-but-changed-nothing/);
    assert.match(JSON.stringify((await sync("dir-script")).outcome), /"state":"stage-failed".*stage-script-unreadable: EISDIR/);
    assert.deepEqual(readdirSync(join(root, "work")), [], "every pass removes its own scratch checkout");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
