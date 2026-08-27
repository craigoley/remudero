/**
 * test/mint-open-pr-surface-is-rest.test.ts — W1-T2324.
 *
 * THE MINT REISSUED A LIVE ID BECAUSE ITS OPEN-PR SURFACE COST GRAPHQL AND THE GRAPHQL BUDGET
 * WAS GONE. Observed 2026-08-26: `gh pr list --json title,body,headRefName` (GraphQL-billed) was
 * refused on an exhausted bucket, the mint printed "DEGRADED: open-prs (cannot enumerate open
 * PRs: ... GraphQL: API rate limit already exceeded for user ID 4397075)" and reserved anyway —
 * the ceiling came from three surfaces instead of four, and the missing one was precisely the
 * surface holding the id `plan/tasks.d/W1-T2316-the-retro-renders-past-its-own-line-scoped-
 * readers.yaml` had just merged as (#2965). PR #2970 then re-added a second `W1-T2316` shard.
 *
 * THREE PROOFS LIVE HERE, matching the task's own Q1/Q2/Q3(open-vs-open):
 *  (Q1) `openPrMintTexts` reads a core-billed REST page, never `gh pr list --json`, and the REST
 *       rows still yield title, body and head branch for the mention scan.
 *  (Q2) `rmd next-task-id --reserve` refuses ONLY when the open-PR surface itself could not be
 *       read at all — a degraded SETTLED surface (shards/history) still lets the atomic claim
 *       proceed, so a shortfall on an unrelated surface never stops intake.
 *  (Q3, open-vs-open half) `scripts/task-id-existence-check.mjs` refuses an id this PR ADDS when
 *       another still-open PR has already claimed it, cross-referenced over the SAME REST surface
 *       Q1 built — the half `resolveBaseDeclaredIds`'s own doc names as out of ITS reach.
 * Plus: nothing added paces, throttles or sleeps a call (W1-T1066's lockout is why).
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { nextTaskIdCommand, openPrMintTexts } from "../src/run-task.js";
import { openPrsRestArgs, type GhApiFetcher } from "../src/lib/open-prs-rest.js";
import { type RemoteRefReserver, type RemoteReserveOutcome } from "../src/lib/task-id-reservation.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const SCRIPT = join(REPO_ROOT, "scripts", "task-id-existence-check.mjs");

// ── shared plumbing, mirrored from test/next-task-id-reserve.test.ts ───────────────────────────

function stubReserver(taken: Set<string> = new Set()): RemoteRefReserver & { tried: string[] } {
  const tried: string[] = [];
  return {
    tried,
    mintAnchor: () => "ANCHOR-SHA",
    attempt(taskId: string): RemoteReserveOutcome {
      tried.push(taskId);
      return taken.has(taskId) ? "taken" : "created";
    },
  };
}

function capture(): { out: string[]; err: string[]; restore: () => void } {
  const out: string[] = [];
  const err: string[] = [];
  const ol = console.log;
  const oe = console.error;
  console.log = (...a: unknown[]) => void out.push(a.join(" "));
  console.error = (...a: unknown[]) => void err.push(a.join(" "));
  return {
    out,
    err,
    restore: () => {
      console.log = ol;
      console.error = oe;
    },
  };
}

// ══ (Q1) the open-PR surface is core-billed REST, never GraphQL ═══════════════════════════════

test("W1-T2324 (Q1): openPrMintTexts reads REST's /pulls?state=open — never `gh pr list --json`", () => {
  const seenArgs: string[][] = [];
  const fetch: GhApiFetcher = (args) => {
    seenArgs.push(args);
    return [
      { number: 1, html_url: "https://github.com/o/r/pull/1", title: "feat: t1", body: "b1", head: { ref: "branch-1" } },
      { number: 2, html_url: "https://github.com/o/r/pull/2", title: "feat: t2", body: "b2", head: { ref: "branch-2" } },
    ];
  };
  const texts = openPrMintTexts("o", "r", fetch);

  assert.equal(seenArgs.length, 1, "one call, one page — never a per-PR follow-up");
  assert.deepEqual(seenArgs[0], openPrsRestArgs("o", "r"), "the exact REST argv the mint pays for");
  assert.equal(seenArgs[0]![0], "api", "a `gh api` call — REST — never `pr`/`list`");
  assert.ok(!seenArgs[0]!.some((a) => a === "--json"), "`--json` is the GraphQL discriminator this task moves off of");
  assert.match(seenArgs[0]![1]!, /^repos\/o\/r\/pulls\?state=open&per_page=100$/);

  // Criterion 2 — title, body AND head branch all still reach the mention scan.
  assert.equal(texts.length, 2);
  assert.match(texts[0]!, /feat: t1/);
  assert.match(texts[0]!, /\bb1\b/);
  assert.match(texts[0]!, /branch-1/);
  assert.match(texts[1]!, /feat: t2/);
  assert.match(texts[1]!, /\bb2\b/);
  assert.match(texts[1]!, /branch-2/);
});

test("W1-T2324 (Q1): a row missing body/head still yields usable text, never throws", () => {
  const fetch: GhApiFetcher = () => [{ number: 3, html_url: "https://github.com/o/r/pull/3", title: "t" }];
  const texts = openPrMintTexts("o", "r", fetch);
  assert.equal(texts.length, 1);
  assert.match(texts[0]!, /^t\n/);
});

test("W1-T2324 (Q1): a live mention still resolves through the injected surface, undamaged by the transport swap", () => {
  // A real W1-T<n> mention (title) plus noise (body/branch) must both still be readable text —
  // the mint's own `mentionedTaskIds` scan (lib/task-id.ts) runs against exactly this output.
  const fetch: GhApiFetcher = () => [
    { number: 9, html_url: "https://github.com/o/r/pull/9", title: "chore(plan): file W1-T9001", body: "", head: { ref: "run-W1-T9001-1" } },
  ];
  const texts = openPrMintTexts("o", "r", fetch);
  assert.match(texts[0]!, /W1-T9001/);
});

test("W1-T2324 (Q1): defaults to the real ghJson when no fetch is injected — production wiring", () => {
  const src = readFileSync(join(REPO_ROOT, "src", "run-task.ts"), "utf8");
  const from = src.indexOf("export function openPrMintTexts(");
  assert.ok(from >= 0, "openPrMintTexts must still exist under that exact name");
  const region = src.slice(from, src.indexOf("\n}", from));
  assert.match(region, /fetch: GhApiFetcher = ghJson/, "every real caller (self.owner/self.repo) still gets the genuine gh binary");
});

// ══ (Q2) `--reserve` refuses ONLY when the open-PR surface itself is unavailable ═══════════════

test("W1-T2324 (Q2): --reserve REFUSES when the open-PR surface cannot be read at all", async () => {
  const reserver = stubReserver();
  const cap = capture();
  let code: number;
  try {
    code = await nextTaskIdCommand(
      ["--reserve"],
      {},
      {
        reserver,
        holderOf: () => "unknown",
        openPrTexts: () => {
          throw new Error("GraphQL: API rate limit already exceeded for user ID 4397075");
        },
      },
    );
  } finally {
    cap.restore();
  }
  assert.equal(code, 2, "fail-closed: a refusal exits non-zero");
  assert.equal(reserver.tried.length, 0, "nothing was attempted — the caller has spent nothing");
  const errText = cap.err.join("\n");
  assert.match(errText, /REFUSED/);
  assert.match(errText, /open-PR surface is degraded/);
  assert.match(errText, /rate limit/, "names the actual read failure verbatim, not a generic message");
  assert.equal(cap.out.join("\n").includes("RESERVED "), false, "nothing may claim to have been reserved");
});

test("W1-T2324 (Q2) CONTROL: --reserve still claims the id when the open-PR surface reads fine", async () => {
  const reserver = stubReserver();
  const cap = capture();
  let code: number;
  try {
    code = await nextTaskIdCommand(["--reserve"], {}, { reserver, holderOf: () => "unknown", openPrTexts: () => [] });
  } finally {
    cap.restore();
  }
  assert.match(cap.out.join("\n"), /^RESERVED W1-T\d+ on origin \(refs\/rmd-id\/W1-T\d+\) after 1 attempt\(s\)$/m);
  assert.equal(reserver.tried.length, 1);
  assert.ok(code === 0 || code === 1);
});

test("W1-T2324 (Q2): --reserve still proceeds when only a SETTLED surface (shards) is degraded — intake does not stop", async () => {
  const root = mkdtempSync(join(tmpdir(), "t2324-mint-"));
  try {
    writeFileSync(join(root, "tasks.yaml"), "- id: W1-T4\n  title: seed\n");
    const shardDir = join(root, "tasks.d");
    mkdirSync(shardDir, { recursive: true });
    // A shard NAME that is actually a DIRECTORY: readdirSync lists it, then readFileSync(dir)
    // throws EISDIR — a deterministic, permission-independent way to force shardTaskIds' own
    // catch arm (no chmod games, which are unreliable running as root/in a sandbox).
    mkdirSync(join(shardDir, "broken.yaml"));

    const reserver = stubReserver();
    const cap = capture();
    let code: number;
    try {
      code = await nextTaskIdCommand(
        ["--plan", join(root, "tasks.yaml"), "--reserve"],
        {},
        { reserver, holderOf: () => "unknown", openPrTexts: () => [] },
      );
    } finally {
      cap.restore();
    }
    const text = cap.out.join("\n");
    assert.match(text, /DEGRADED: shards/, "sanity: the shard really did degrade the mint");
    assert.match(text, /^RESERVED W1-T\d+ on origin/m, "a degraded SETTLED surface must not stop the atomic claim");
    assert.equal(reserver.tried.length, 1, "the claim was actually attempted, not skipped");
    assert.equal(code, 1, "the mint's own degraded exit code is preserved even though the claim proceeded");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T2324 (Q2): the unflagged verb and the read-fine-but-uncorroborated arm are both unaffected", async () => {
  // The unflagged verb never reaches the gate at all — it reserves nothing regardless.
  const reserver = stubReserver();
  const cap = capture();
  try {
    await nextTaskIdCommand(
      [],
      {},
      {
        reserver,
        openPrTexts: () => {
          throw new Error("boom");
        },
      },
    );
  } finally {
    cap.restore();
  }
  assert.equal(reserver.tried.length, 0);
  assert.equal(cap.out.join("\n").includes("RESERVED "), false);
});

// ══ (Q3, open-vs-open half) an added id another OPEN PR already claims is refused ══════════════
//
// Driven through the real CLI as a subprocess against scratch git repos, exactly like this
// script's existing Q3(main-collision) suite (test/task-id-existence-check.test.ts) — never by
// importing the .mjs, per that file's own established convention.

const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };

function planRepo(shards: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "t2324-openpr-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir, env: GIT_ENV });
  execFileSync("git", ["config", "user.email", "t@example.com"], { cwd: dir, env: GIT_ENV });
  execFileSync("git", ["config", "user.name", "t"], { cwd: dir, env: GIT_ENV });
  mkdirSync(join(dir, "plan", "tasks.d"), { recursive: true });
  writeFileSync(join(dir, "plan", "tasks.yaml"), "[]\n");
  for (const [name, id] of Object.entries(shards)) {
    writeFileSync(join(dir, "plan", "tasks.d", name), `- id: ${id}\n  title: "t"\n`);
  }
  execFileSync("git", ["add", "-A"], { cwd: dir, env: GIT_ENV });
  execFileSync("git", ["commit", "-qm", "base"], { cwd: dir, env: GIT_ENV });
  return dir;
}

/** A fake `gh` on PATH that answers `gh api repos/<owner>/<repo>/pulls?state=open...` with
 *  `rows` and refuses everything else — the REST edge, faked deterministically rather than
 *  reaching the real network (this repo's own gh-authenticated sandbox would otherwise make
 *  this test's outcome depend on whatever PRs happen to be open at run time). */
function fakeGh(rows: unknown[]): { bin: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "t2324-fakegh-"));
  const script = join(dir, "gh");
  writeFileSync(
    script,
    `#!/bin/sh\nif [ "$1" = "api" ]; then\n  cat <<'JSON'\n${JSON.stringify(rows)}\nJSON\n  exit 0\nfi\nexit 1\n`,
  );
  chmodSync(script, 0o755);
  return { bin: dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function runCheckWithOpenPrs(cwd: string, base: string, headRef: string, ghBin: string) {
  return spawnSync(
    process.execPath,
    [
      SCRIPT,
      "--cwd",
      cwd,
      "--base",
      base,
      "--dir",
      "src",
      "--owner",
      "o",
      "--repo",
      "r",
      "--head-ref",
      headRef,
      "--baseline",
      join(REPO_ROOT, "scripts", "task-id-existence-baseline.json"),
    ],
    { cwd, encoding: "utf8", env: { ...GIT_ENV, PATH: `${ghBin}:${process.env.PATH}` } },
  );
}

test("W1-T2324 (Q3, open-vs-open): an added id already claimed by ANOTHER open PR is refused", () => {
  const dir = planRepo({});
  const gh = fakeGh([
    { number: 42, html_url: "https://github.com/o/r/pull/42", head: { ref: "other-branch" }, title: "feat: also files W1-T950", body: "" },
  ]);
  try {
    writeFileSync(join(dir, "plan", "tasks.d", "W1-T950-new.yaml"), '- id: W1-T950\n  title: "t"\n');
    const r = runCheckWithOpenPrs(dir, "main", "this-branch", gh.bin);
    assert.equal(r.status, 1, `expected a refusal, got ${r.status}: ${r.stderr}`);
    assert.match(r.stderr, /ALREADY CLAIMED by another OPEN PR/);
    assert.match(r.stderr, /W1-T950/);
    assert.match(r.stderr, /pull\/42/, "names the claiming PR");
  } finally {
    gh.cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W1-T2324 (Q3, open-vs-open) CONTROL: the only mention is this PR's OWN row — SILENT", () => {
  const dir = planRepo({});
  // The SAME PR (same head ref) as the one carrying the mention — must be excluded, or every
  // filing PR would trivially collide with its own title/body.
  const gh = fakeGh([{ number: 7, html_url: "https://github.com/o/r/pull/7", head: { ref: "this-branch" }, title: "files W1-T951", body: "" }]);
  try {
    writeFileSync(join(dir, "plan", "tasks.d", "W1-T951-new.yaml"), '- id: W1-T951\n  title: "t"\n');
    const r = runCheckWithOpenPrs(dir, "main", "this-branch", gh.bin);
    assert.equal(r.status, 0, `an id only this PR's own row mentions must not collide: ${r.stderr}`);
    assert.doesNotMatch(r.stderr, /ALREADY CLAIMED/);
  } finally {
    gh.cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W1-T2324 (Q3, open-vs-open) CONTROL: no open PR mentions the added id — SILENT", () => {
  const dir = planRepo({});
  const gh = fakeGh([{ number: 8, html_url: "https://github.com/o/r/pull/8", head: { ref: "unrelated" }, title: "does not mention it", body: "" }]);
  try {
    writeFileSync(join(dir, "plan", "tasks.d", "W1-T952-new.yaml"), '- id: W1-T952\n  title: "t"\n');
    const r = runCheckWithOpenPrs(dir, "main", "this-branch", gh.bin);
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stderr, /ALREADY CLAIMED/);
  } finally {
    gh.cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W1-T2324 (Q3, open-vs-open): an UNREACHABLE gh SKIPS this half rather than failing the whole gate", () => {
  const dir = planRepo({});
  const brokenGhDir = mkdtempSync(join(tmpdir(), "t2324-brokengh-"));
  const brokenGh = join(brokenGhDir, "gh");
  writeFileSync(brokenGh, `#!/bin/sh\necho "gh: no credentials" >&2\nexit 4\n`);
  chmodSync(brokenGh, 0o755);
  try {
    writeFileSync(join(dir, "plan", "tasks.d", "W1-T953-new.yaml"), '- id: W1-T953\n  title: "t"\n');
    const r = runCheckWithOpenPrs(dir, "main", "this-branch", brokenGhDir);
    assert.equal(r.status, 0, `an unreachable gh must not fail the gate closed: ${r.stderr}`);
    assert.match(r.stdout, /open-PR collision check SKIPPED/);
    assert.doesNotMatch(r.stderr, /ALREADY CLAIMED/);
  } finally {
    rmSync(brokenGhDir, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W1-T2324 (Q3, open-vs-open): the main-collision half still fires beside this one, independently", () => {
  // POSITIVE CONTROL that the two halves of Q3 coexist: an id colliding with MAIN is still
  // refused (the pre-existing #2999 mechanism), even when the open-PR half finds nothing.
  const dir = planRepo({ "W1-T960-original.yaml": "W1-T960" });
  const gh = fakeGh([]);
  try {
    rmSync(join(dir, "plan", "tasks.d", "W1-T960-original.yaml"));
    writeFileSync(join(dir, "plan", "tasks.d", "W1-T960-reissued.yaml"), '- id: W1-T960\n  title: "t"\n');
    const r = runCheckWithOpenPrs(dir, "main", "this-branch", gh.bin);
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /ALREADY DECLARED/, "the main-collision half's own message, unchanged by this task");
  } finally {
    gh.cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ══ nothing added paces, throttles or sleeps a call (W1-T1066's lockout is why) ════════════════

test("W1-T2324: nothing added to run-task.ts's openPrMintTexts paces, throttles or sleeps", () => {
  const src = readFileSync(join(REPO_ROOT, "src", "run-task.ts"), "utf8");
  const from = src.indexOf("export function openPrMintTexts(");
  const region = src.slice(from, src.indexOf("\n}", from));
  for (const banned of ["setTimeout", "setInterval", "sleepSync(", "await new Promise", "Atomics.wait"]) {
    assert.ok(!region.includes(banned), `openPrMintTexts must not ${banned}`);
  }
});

test("W1-T2324: nothing added to task-id-existence-check.mjs's open-PR half paces, throttles or sleeps", () => {
  const src = readFileSync(SCRIPT, "utf8");
  const from = src.indexOf("export function resolveOwnerRepoFromGit(");
  const to = src.indexOf("\n/**\n * Ids the working tree declares MORE THAN ONCE", from);
  assert.ok(from >= 0 && to > from, "located the W1-T2324 open-vs-open region");
  const region = src.slice(from, to);
  for (const banned of ["setTimeout", "setInterval", "sleepSync(", "await new Promise", "Atomics.wait"]) {
    assert.ok(!region.includes(banned), `the open-vs-open region must not ${banned}`);
  }
});
