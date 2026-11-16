import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";
import { boardSnapshotPath, createBoardSnapshotCache, instanceBoardSnapshotCache } from "#src/lib/board-snapshot-cache.js";
import { mapBoardPr } from "#src/lib/open-prs-rest.js";
import { buildBatchedGithub } from "#src/lib/status.js";
import { ghShim, type GhShim, type GhShimRoute } from "#test/helpers/gh-shim.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const OWNER = "craigoley";
const REPO = "remudero";
const savedHome = process.env.HOME;
const savedPath = process.env.PATH;

afterEach(() => {
  process.env.HOME = savedHome;
  process.env.PATH = savedPath;
});

interface Row {
  number: number;
  html_url: string;
  state: "closed";
  merged_at: string;
  title: string;
  body: string;
  head: { ref: string; sha: string };
  updated_at: string;
  created_at: string;
  user: { login: string; type: string };
}

const stamp = (n: number): string => new Date(Date.UTC(2026, 0, 1) + n * 60_000).toISOString();

function row(number: number, minute: number, tag = "a"): Row {
  return {
    number,
    html_url: `https://github.com/${OWNER}/${REPO}/pull/${number}`,
    state: "closed",
    merged_at: stamp(minute),
    title: `pr ${number} ${tag}`,
    body: `Remudero-Task: W1-T${number}`,
    head: { ref: `run-W1-T${number}-${tag}`, sha: `${tag}${number}`.padEnd(40, "0") },
    updated_at: stamp(minute),
    created_at: stamp(0),
    user: { login: "rmd-bot", type: "Bot" },
  };
}

/** Rows 1..count, each updated at its own minute, so GitHub's sort=updated desc is number desc. */
const history = (count: number, tag = "a"): Row[] => Array.from({ length: count }, (_, i) => row(i + 1, i + 1, tag));
const newestFirst = (rows: Row[]): Row[] => [...rows].sort((a, b) => b.updated_at.localeCompare(a.updated_at));

/** GitHub's closed list for `rows`, at both page sizes the walk asks. Pages are listed highest first so a
 *  shorter page number never answers a longer one ("page=1" is a substring of "page=14"). */
function closedRoutes(rows: Row[], deltaPages = Math.min(Math.ceil(rows.length / 30) + 1, 10)): GhShimRoute[] {
  const sorted = newestFirst(rows);
  const routes: GhShimRoute[] = [];
  for (const [perPage, last] of [[100, Math.ceil(sorted.length / 100) + 1], [30, deltaPages]] as const) {
    for (let page = last; page >= 1; page--) {
      routes.push({
        when: `state=closed&sort=updated&direction=desc&per_page=${perPage}&page=${page}`,
        stdout: JSON.stringify(sorted.slice((page - 1) * perPage, page * perPage)),
      });
    }
  }
  return [...routes, { when: "state=open", stdout: "[]" }, { when: "/issues?", stdout: "[]" }];
}

function useShim(rows: Row[], deltaPages?: number): GhShim {
  const shim = ghShim(closedRoutes(rows, deltaPages));
  process.env.PATH = `${shim.dir}:${savedPath ?? ""}`;
  return shim;
}

/** A disposable instance: a HOME whose config names a root that has a state directory. */
function makeInstance(): { home: string; root: string; snapshot: string } {
  const home = mkdtempSync(join(tmpdir(), "rmd-cold-board-"));
  const root = join(home, "Remudero");
  mkdirSync(join(root, "state"), { recursive: true });
  mkdirSync(join(home, ".config", "remudero"), { recursive: true });
  writeFileSync(join(home, ".config", "remudero", "config.json"), JSON.stringify({ root }));
  process.env.HOME = home;
  return { home, root, snapshot: boardSnapshotPath(root, OWNER, REPO) };
}

function seedSnapshot(root: string, rows: Row[]): void {
  assert.equal(createBoardSnapshotCache(root, OWNER, REPO).commitClosed(rows.map(mapBoardPr)), true);
}

const closedCalls = (shim: GhShim, perPage?: number): string[] =>
  shim.calls().filter((c) => c.includes("state=closed") && (perPage === undefined || c.includes(`per_page=${perPage}&`)));

function gateway(events: Array<[string, Record<string, unknown> | undefined]> = [], now?: () => number) {
  return buildBatchedGithub(OWNER, REPO, {
    commitTrailerIndex: () => null,
    log: (event, extra) => events.push([event, extra]),
    ...(now ? { now } : {}),
  });
}

function merged(g: ReturnType<typeof gateway>) {
  assert.ok(g.listMergedHeadBranches, "the batched gateway lists merged PRs");
  return g.listMergedHeadBranches();
}

test("W1-T12893 criterion 1: a gateway built with no snapshotCache reads the closed half as a delta from the instance snapshot", () => {
  const { root } = makeInstance();
  const before = history(250);
  seedSnapshot(root, before);
  const shim = useShim([...before, row(251, 900)]);
  const events: Array<[string, Record<string, unknown> | undefined]> = [];
  const refs = merged(gateway(events));
  assert.ok(refs?.some((r) => r.number === 251), "the PR merged after the snapshot is on the board");
  assert.equal(refs?.length, 251);
  assert.equal(closedCalls(shim, 100).length, 0, "no full-size closed page is read");
  assert.equal(closedCalls(shim).length, 1);
  const fetch = events.find(([e, x]) => e === "board_gateway.fetch_bytes" && x?.half === "closed")?.[1];
  assert.equal(fetch?.mode, "delta");
  assert.equal(fetch?.restCalls, 1);
});

test("W1-T12893 criterion 2: the seeded closed half equals a full walk's half for the same GitHub answers", () => {
  const { root } = makeInstance();
  const before = history(250);
  seedSnapshot(root, before);
  // Since the snapshot: PR 100 was edited, and 40 new PRs merged, more than one 30-row delta page.
  const now = [...before.filter((r) => r.number !== 100), row(100, 1000, "edited"),
    ...Array.from({ length: 40 }, (_, i) => row(251 + i, 1001 + i))];
  const shim = useShim(now);
  const seeded = gateway();
  const seededRefs = merged(seeded);

  const bare = mkdtempSync(join(tmpdir(), "rmd-no-instance-"));
  process.env.HOME = bare;
  const fullShim = useShim(now);
  const full = gateway();
  const fullRefs = merged(full);

  assert.ok(closedCalls(fullShim, 100).length >= 3, "the comparison gateway walked every closed page");
  assert.deepEqual(seededRefs, fullRefs);
  assert.equal(seeded.headRefName(row(100, 0).html_url), "run-W1-T100-edited");
  assert.equal(seeded.headRefName(row(100, 0).html_url), full.headRefName(row(100, 0).html_url));
  // Two delta pages: page 1 is all newer rows; page 2 reaches the first unchanged row and stops there.
  assert.equal(closedCalls(shim, 30).length, 2);
  assert.equal(closedCalls(shim, 100).length, 0);
});

test("W1-T12893 criterion 3: a refused snapshot gives the full walk, and the reason is logged once", () => {
  const cases: Array<[string, (path: string) => void, string]> = [
    ["missing", () => {}, "missing"],
    ["unreadable", (path) => writeFileSync(path, "not json\n"), "invalid_json"],
    ["oversized", (path) => { writeFileSync(path, ""); truncateSync(path, 129 * 1024 * 1024); }, "oversized"],
    ["other schema", (path) => writeFileSync(path, snapshotText(`${OWNER}/${REPO}`, 2)), "future_version"],
    ["other repository", (path) => writeFileSync(path, snapshotText("someone/else", 1)), "wrong_repository"],
  ];
  for (const [label, write, reason] of cases) {
    const { snapshot } = makeInstance();
    mkdirSync(dirname(snapshot), { recursive: true });
    write(snapshot);
    const rows = history(120);
    const shim = useShim(rows);
    let clock = 1_000_000;
    const events: Array<[string, Record<string, unknown> | undefined]> = [];
    const g = gateway(events, () => clock);
    assert.equal(merged(g)?.length, 120, label);
    assert.equal(closedCalls(shim, 100).length, 2, `${label}: the full walk ran`);
    clock += 3_600_000;
    assert.equal(merged(g)?.length, 120, label);
    const refusals = events.filter(([e]) => e === "board_snapshot.load_refused");
    assert.equal(refusals.length, 1, `${label}: one refusal row`);
    assert.equal(refusals[0]?.[1]?.reason, reason, label);
  }
});

function snapshotText(repository: string, schema: number): string {
  const header = { type: "board-snapshot", schema, repository,
    channels: { closed: { complete: true, count: 0 }, issues: { complete: false, count: 0 } } };
  const footer = { type: "complete", schema, repository, counts: { closed: 0, issues: 0 } };
  return `${JSON.stringify(header)}\n${JSON.stringify(footer)}\n`;
}

const CHILD = `
import { buildBatchedGithub } from "#src/lib/status.js";
for (let i = 0; i < 4; i++) {
  const refs = buildBatchedGithub("${OWNER}", "${REPO}", { commitTrailerIndex: () => null }).listMergedHeadBranches();
  if (!refs || refs.length !== 150) { console.error("bad read", refs?.length); process.exit(2); }
}
`;

function runChild(env: NodeJS.ProcessEnv): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", CHILD], { cwd: REPO_ROOT, env, stdio: ["ignore", "ignore", "inherit"] });
    child.on("error", reject);
    child.on("exit", (code) => resolve(code ?? -1));
  });
}

test("W1-T12893 criterion 4: two run children that commit at once leave a snapshot a third process reads as valid", async () => {
  const { home, snapshot } = makeInstance();
  const shimA = ghShim(closedRoutes(history(150, "a")));
  const shimB = ghShim(closedRoutes(newestFirst(history(150, "b")).map((r) => ({ ...r, updated_at: stamp(5000 + r.number) }))));
  const env = (shim: GhShim): NodeJS.ProcessEnv => ({ ...process.env, HOME: home, PATH: `${shim.dir}:${savedPath ?? ""}` });
  const codes = await Promise.all([runChild(env(shimA)), runChild(env(shimB))]);
  assert.deepEqual(codes, [0, 0]);
  assert.ok(closedCalls(shimA).length > 0 && closedCalls(shimB).length > 0, "both children read GitHub");

  const events: Array<[string, Record<string, unknown> | undefined]> = [];
  const third = instanceBoardSnapshotCache(OWNER, REPO, process.env, { log: (e, x) => events.push([e, x]) });
  assert.ok(events.some(([e]) => e === "board_snapshot.loaded"), JSON.stringify(events));
  const seed = third?.closedSeed();
  assert.equal(seed?.size, 150);
  const tags = new Set([...seed!.values()].map((r) => r.headRefName.split("-").pop()));
  assert.equal(tags.size, 1, "every row comes from one writer's commit");
  assert.equal(readdirSync(dirname(snapshot)).filter((f) => f.includes(".tmp-")).length, 0);
});

test("W1-T12893 criterion 5: a cold gateway beside an earlier gateway's snapshot reads at most 2 of 140 closed pages", () => {
  makeInstance();
  const repoHistory = history(13_953);
  const first = useShim(repoHistory);
  assert.equal(merged(gateway())?.length, 13_953);
  assert.equal(closedCalls(first, 100).length, 140, "the first cold gateway walks every closed page");

  const second = useShim([...repoHistory, row(13_954, 20_000)]);
  const refs = merged(gateway());
  assert.equal(refs?.length, 13_954);
  assert.ok(closedCalls(second).length <= 2, `closed pages read: ${closedCalls(second).length}`);
  assert.equal(closedCalls(second, 100).length, 0);
});
