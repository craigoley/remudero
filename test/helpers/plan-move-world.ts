/**
 * W1-T13680: two real Git origins (a public catalog and an ops catalog, each with a working clone), a reservation
 * ref per public record, and a GitHub model the mover reads through its GraphQL port and writes through its
 * pull-request port. A test merges or closes a pull request the way GitHub would: a squash commit of the branch the
 * mover pushed, carrying the pull request's title and body.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { TestContext } from "node:test";
import { movePlanTask, type MovePorts } from "#src/lib/plan-task-move.js";
import { originWithClone, type GitRepo } from "#test/helpers/git-repo.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";

export const PUBLIC = "fixture/remudero";
export const OPS = "fixture/ops";
type Json = Record<string, unknown>;
export type Side = "public" | "ops";
export interface ModelPull {
  repository: Side; number: number; head: string; base: string; title: string; body: string;
  state: "OPEN" | "CLOSED" | "MERGED"; files: string[]; headOid: string;
}
export interface MoveRun { status: number; out: Json; lines: string[] }

/** The exact bytes of a blob (GitRepo.git trims its output), or undefined when the spec names none. */
export function blobAt(dir: string, spec: string): string | undefined {
  try { return execFileSync("git", ["-C", dir, "cat-file", "blob", spec], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }); }
  catch (error) { void error; return undefined; }
}
export const record = (id: string, extra = "") =>
  `- id: ${id}\n  title: Move fixture ${id}\n  repo: remudero\n  type: implement\n  priority: 1\n  status: queued\n  verify: auto\n  risk: low\n  attempts: 0\n  acceptance:\n    - claim: \"the move fixture holds\"\n      proof: \"grep: fixture in test/fixture.test.ts\"\n${extra}`;
export const shard = (id: string) => `plan/tasks.d/${id}.yaml`;

export function moveWorld(t: TestContext, publicRecords: Record<string, string>, opsRecords: Record<string, string> = {}) {
  const root = ownedFixtureDir(t, "plan-move").dir;
  const seed = (records: Record<string, string>) =>
    ({ "plan/tasks.yaml": "[]\n", ...Object.fromEntries(Object.entries(records).map(([id, text]) => [shard(id), text])) });
  const pub = originWithClone(join(root, "public"), { scope: t, seed: seed(publicRecords) });
  const ops = originWithClone(join(root, "ops"), { scope: t, seed: seed(opsRecords) });
  const sides: Record<Side, { origin: GitRepo; clone: GitRepo; name: string }> = {
    public: { ...pub, name: PUBLIC }, ops: { ...ops, name: OPS },
  };
  const seeded = pub.origin.git("rev-parse", "main");
  for (const id of Object.keys(publicRecords)) pub.origin.git("update-ref", `refs/rmd-id/${id}`, seeded);
  const pulls: ModelPull[] = [];
  const ledger: Json[] = [];
  const preflights: Array<{ repoDir: string; commit: string; title: string }> = [];
  let clock = 1_800_000_000_000;
  let createFailure: Error | undefined;

  const main = (side: Side) => sides[side].origin.git("rev-parse", "main");
  const bytes = (side: Side, path: string): string | undefined => {
    return blobAt(sides[side].origin.dir, `main:${path}`);
  };
  /** Commit straight to an origin's main, as another writer would. */
  const commitTo = (side: Side, files: Record<string, string | null>, message: string): string => {
    const { clone } = sides[side];
    clone.git("fetch", "--quiet", "origin");
    clone.git("checkout", "--quiet", "-B", "main", "origin/main");
    for (const [rel, text] of Object.entries(files)) {
      if (text === null) clone.git("rm", "--quiet", rel);
      else { mkdirSync(dirname(join(clone.dir, rel)), { recursive: true }); writeFileSync(join(clone.dir, rel), text); clone.git("add", rel); }
    }
    clone.git("commit", "--quiet", "-m", message);
    clone.git("push", "--quiet", "origin", "main");
    return main(side);
  };
  /** GitHub's squash merge of a pull request's branch. */
  const merge = (pr: ModelPull): string => {
    const { clone } = sides[pr.repository];
    clone.git("fetch", "--quiet", "origin");
    clone.git("checkout", "--quiet", "-B", "main", "origin/main");
    clone.git("merge", "--squash", "--quiet", `origin/${pr.head}`);
    clone.git("commit", "--quiet", "-m", `${pr.title} (#${pr.number})\n\n${pr.body}`);
    clone.git("push", "--quiet", "origin", "main");
    pr.state = "MERGED";
    return main(pr.repository);
  };
  const close = (pr: ModelPull) => { pr.state = "CLOSED"; };
  const openPull = (side: Side, pr: Partial<ModelPull> & { head: string }): ModelPull => {
    const row: ModelPull = { repository: side, number: pulls.length + 100, base: "main", title: "fixture", body: "", state: "OPEN", files: [], headOid: "e".repeat(40), ...pr };
    pulls.push(row);
    return row;
  };

  const page = (nodes: unknown[]) => ({ totalCount: nodes.length, pageInfo: { hasNextPage: false, endCursor: null }, nodes });
  const search = (nodes: unknown[]) => ({ issueCount: nodes.length, pageInfo: { hasNextPage: false }, nodes });
  const identity = (side: Side) => ({ databaseId: side === "public" ? 42 : 43, nameWithOwner: sides[side].name });
  const control = { number: 1, state: "MERGED", body: "Remudero-Task: W1-T999", headRefName: "run-W1-T999-1", mergeCommit: { oid: "d".repeat(40) }, repository: identity("public") };
  const moverNode = (pr: ModelPull) => ({ number: pr.number, state: pr.state, headRefName: pr.head, body: pr.body, repository: identity(pr.repository) });
  /** One answer holding every alias either reader may ask for; each reader reads only its own. */
  const answer = (query: string): Json => {
    const repo = (side: Side) => ({ ...identity(side), defaultBranchRef: { name: "main", target: { oid: main(side) } } });
    const open = pulls.filter(pr => pr.repository === "public" && pr.state === "OPEN").map(pr => ({ number: pr.number, state: "OPEN", headRefName: pr.head,
      headRefOid: pr.headOid, body: pr.body, files: { totalCount: pr.files.length, pageInfo: { hasNextPage: false }, nodes: pr.files.map(path => ({ path })) } }));
    const candidate = /head:plan-move-([A-Za-z0-9-]+?)-"/.exec(query)?.[1];
    const movers = (side: Side, states: string[]) => search(pulls.filter(pr => pr.repository === side && states.includes(pr.state) && pr.head.startsWith("plan-move-")).map(moverNode));
    return { data: {
      public: { ...repo("public"), open: page(open), merged: page([control]) }, ops: repo("ops"),
      byTrailer: search([]), byBranch: search([]), control: search([control]),
      // GitHub's search answers the candidate's own branches; a fixed answer file (no query) holds them all.
      refusedMoves: search(pulls.filter(pr => pr.repository === "ops" && pr.state !== "OPEN" && pr.head.startsWith(`plan-move-${candidate ?? ""}`)).map(moverNode)),
      publicMoves: movers("public", ["OPEN"]), opsMoves: movers("ops", ["OPEN"]),
    } };
  };
  const env = {
    GIT_ALLOW_PROTOCOL: "file", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: `url.${pub.origin.dir}.insteadOf`, GIT_CONFIG_VALUE_0: `https://github.com/${PUBLIC}.git`,
    GIT_CONFIG_KEY_1: `url.${ops.origin.dir}.insteadOf`, GIT_CONFIG_VALUE_1: `https://github.com/${OPS}.git`,
  };
  /** Run the verb against both current mains, in process, with this model behind its GitHub ports. */
  const run = async (apply = true, overrides: Partial<MovePorts> = {}): Promise<MoveRun> => {
    for (const side of ["public", "ops"] as const) sides[side].clone.git("fetch", "--quiet", "origin");
    const args = ["--public-root", pub.clone.dir, "--public-commit", main("public"), "--public-repo", PUBLIC,
      "--ops-root", ops.clone.dir, "--ops-commit", main("ops"), "--ops-repo", OPS, ...(apply ? ["--apply"] : [])];
    const lines: string[] = [];
    const previous = new Map(Object.keys(env).map(key => [key, process.env[key]]));
    Object.assign(process.env, env);
    let status: number;
    try {
      status = await movePlanTask(args, {
        ledger: row => { ledger.push(row); },
        graphql: async query => answer(query),
        createPull: async (repository, pr) => {
          if (createFailure) throw createFailure;
          const side: Side = repository === PUBLIC ? "public" : "ops";
          const files = sides[side].origin.git("diff", "--name-only", `main...${pr.head}`).split("\n").filter(Boolean);
          const row = openPull(side, { ...pr, files, headOid: sides[side].origin.git("rev-parse", pr.head) });
          return { number: row.number, url: `https://github.com/${repository}/pull/${row.number}` };
        },
        preflight: async (repoDir, commit, pr) => { preflights.push({ repoDir, commit, title: pr.title }); return { ok: true, failures: [], unreadable: [] }; },
        clock: { now: () => ++clock, date: () => new Date(clock), iso: () => new Date(clock).toISOString() },
        print: line => { lines.push(line); },
        ...overrides,
      });
    } finally {
      for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    }
    return { status, out: JSON.parse(lines.at(-1) ?? "{}") as Json, lines };
  };
  const reservations = () => pub.origin.git("for-each-ref", "--format=%(refname) %(objectname)", "refs/rmd-id/");
  const failCreate = (error: Error | undefined) => { createFailure = error; };
  const holds = (side: Side, id: string) => bytes(side, shard(id)) !== undefined;
  const cleanup = () => rmSync(root, { recursive: true, force: true });
  return { root, pub, ops, sides, pulls, ledger, preflights, main, bytes, holds, commitTo, merge, close, openPull, run, reservations, failCreate, answer, env, cleanup };
}
export type MoveWorld = ReturnType<typeof moveWorld>;
