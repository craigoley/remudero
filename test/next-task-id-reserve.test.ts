/**
 * test/next-task-id-reserve.test.ts — W1-T1055: `rmd next-task-id --reserve`.
 *
 * EVERY ARM IS DRIVEN THROUGH AN INJECTED RESERVER, NEVER A REAL REMOTE, and every refusal arm has
 * a paired positive control. That split is why this does not block `diff-coverage`: a refusal
 * reachable only through a real `git push` is a line no test can cover. The one exception is
 * W1-T8915's test, which drives the DEFAULT reserver over a disposable local bare origin.
 *
 * `openPrTexts: NO_OPEN_PRS` (W1-T2324): every `--reserve` call below now ALSO injects a
 * reachable, empty open-PR read. Before W1-T2324, `--reserve` reserved regardless of the mint's
 * `degraded` state, so these tests were unknowingly exercising the REAL `gh` open-PR read (no
 * seam existed to override it) and tolerated whatever it returned (`code === 0 || code === 1`,
 * below). W1-T2324 makes `--reserve` REFUSE when the open-PR surface specifically could not be
 * read at all — correct in production, but it turns an unauthenticated `gh` in a sandboxed test
 * run (measured: CI's `ci` job sets no `GH_TOKEN` for `npm test`, so the real read fails fast
 * with "gh: To use GitHub CLI in a GitHub Actions workflow, set the GH_TOKEN environment
 * variable") into a hard, non-deterministic refusal for tests that are about the RESERVE
 * mechanics, not about the open-PR surface's own reachability. Injecting a deterministic reader
 * — exactly like `reserver`/`holderOf`/`runGit` are already injected two lines below — restores
 * that isolation; it changes no test's assertion, only removes its accidental network dependency.
 * The open-PR-degradation arm itself (refuses / still proceeds on a settled-surface degradation)
 * is proven in test/mint-open-pr-surface-is-rest.test.ts, against `nextTaskIdCommand` directly.
 */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { test } from "node:test";

import {
  classifyReservationAnchor,
  gitRunAdapter,
  describeContestedId,
  describeReservationRefusal,
  nextTaskIdCommand as runNextTaskIdCommand,
  readReservationHolder,
  validateReserveArgs,
} from "#src/run-task.js";
import { type RemoteRefReserver, type RemoteReserveOutcome } from "#src/lib/task-id-reservation.js";
import { gitRepo, GIT_REPO_FIXTURE_IDENTITY } from "#test/helpers/git-repo.js";

const mintRepo = gitRepo({ kind: "reserve-mint-plan" });
mkdirSync(join(mintRepo.dir, "plan"), { recursive: true });
writeFileSync(join(mintRepo.dir, "plan", "tasks.yaml"), "- id: W1-T1055\n  title: seed\n");
mintRepo.git("add", "plan/tasks.yaml");
mintRepo.git("commit", "--quiet", "-m", "fixture plan");

const nextTaskIdCommand = (
  rest: Parameters<typeof runNextTaskIdCommand>[0],
  overlapDeps: Parameters<typeof runNextTaskIdCommand>[1],
  deps: Parameters<typeof runNextTaskIdCommand>[2],
) => runNextTaskIdCommand(rest, overlapDeps, { ...deps, repoRoot: mintRepo.dir });

/** A reserver that rejects the ids in `taken` and creates the first one that is not. */
function stubReserver(taken: Set<string>, unreachableFor?: (id: string) => boolean): RemoteRefReserver & { tried: string[] } {
  const tried: string[] = [];
  return {
    tried,
    mintAnchor: () => "ANCHOR-SHA",
    attempt(taskId: string): RemoteReserveOutcome {
      tried.push(taskId);
      if (unreachableFor?.(taskId)) return "unreachable";
      return taken.has(taskId) ? "taken" : "created";
    },
  };
}

/** A reachable open-PR read that sees nothing — see this file's header for why every `--reserve`
 *  call below injects it. */
const NO_OPEN_PRS = (): string[] => [];

function capture(): { out: string[]; err: string[]; restore: () => void } {
  const out: string[] = [];
  const err: string[] = [];
  const ol = console.log;
  const oe = console.error;
  console.log = (...a: unknown[]) => void out.push(a.join(" "));
  console.error = (...a: unknown[]) => void err.push(a.join(" "));
  return { out, err, restore: () => { console.log = ol; console.error = oe; } };
}

// ── the anchor classifier: both shapes plus the honest unknown ─────────────────────────────────

test("W1-T1055: the two reservation anchor shapes are told apart", () => {
  assert.equal(classifyReservationAnchor("rmd-id reservation 800202@eae16667008a 2026-08-18T17:05:18.606Z"), "fleet");
  assert.equal(classifyReservationAnchor("reserve W1-T1064 Remudero-2986-1787240759041672281"), "operator");
  // POSITIVE CONTROL on the fallback: anything else is reported as unknown rather than guessed.
  assert.equal(classifyReservationAnchor("Merge pull request #2286"), "unknown");
  assert.equal(classifyReservationAnchor(""), "unknown");

  // and each shape is NAMED in the operator-facing line, not merely classified
  assert.match(describeContestedId("W1-T9", "fleet"), /HELD BY ANOTHER CALLER/);
  assert.match(describeContestedId("W1-T9", "fleet"), /rmd-id reservation/);
  assert.match(describeContestedId("W1-T9", "operator"), /hand-mint/);
  assert.match(describeContestedId("W1-T9", "unknown"), /unreadable/);
});

// ── criterion 1 — the verb reserves when asked ────────────────────────────────────────────────

test("W1-T1055: --reserve claims the id on the remote", async () => {
  const reserver = stubReserver(new Set());
  const cap = capture();
  let code: number;
  try {
    code = await nextTaskIdCommand(["--offline"].filter(() => false).concat(["--reserve"]), {}, { reserver, holderOf: () => "unknown", openPrTexts: NO_OPEN_PRS });
  } finally {
    cap.restore();
  }
  const text = cap.out.join("\n");
  assert.match(text, /^RESERVED W1-T\d+ on origin \(refs\/rmd-id\/W1-T\d+\) after 1 attempt\(s\)$/m);
  assert.equal(reserver.tried.length, 1, "an uncontested first candidate is claimed in one attempt");
  assert.equal(code, 0, "the fixture plan has no degraded source");
});

// ── criterion 2 — the id actually HELD, never the one first tried ──────────────────────────────

test("W1-T1055: a contested first candidate reports the id actually held", async () => {
  // The falsifier the shard names: refuse the FIRST candidate, accept the SECOND.
  const cap0 = capture();
  let firstId = "";
  try {
    await nextTaskIdCommand(["--reserve"], {}, { reserver: (() => { const r = stubReserver(new Set()); return r; })(), holderOf: () => "unknown", openPrTexts: NO_OPEN_PRS });
  } finally {
    cap0.restore();
  }
  firstId = /RESERVED (W1-T\d+)/.exec(cap0.out.join("\n"))?.[1] ?? "";
  assert.ok(firstId, "control: the uncontested run named an id, so the contested run has something to differ from");

  const reserver = stubReserver(new Set([firstId]));
  const cap = capture();
  try {
    await nextTaskIdCommand(["--reserve"], {}, { reserver, holderOf: () => "fleet", openPrTexts: NO_OPEN_PRS });
  } finally {
    cap.restore();
  }
  const text = cap.out.join("\n");
  const heldId = /RESERVED (W1-T\d+)/.exec(text)?.[1];
  assert.ok(heldId, "the run still reported a held id");
  assert.notEqual(heldId, firstId, "the id printed is the one HELD, never the one first tried");
  assert.equal(reserver.tried[0], firstId, "…and it really did try the contested one first");
  assert.equal(reserver.tried.length, 2, "the existing loop advanced exactly once — it was not rebuilt");

  // THE REJECTION IS SURFACED, not silently skipped — the whole point of the added reporting.
  assert.match(text, /HELD BY ANOTHER CALLER/);
  assert.match(text, /rmd-id reservation/, "and it names WHICH shape holds it");
  assert.match(text, /is the id actually HELD/, "the divergence from the advisory mint is called out");
});

// ── criterion 3 — an unreachable origin refuses loudly ────────────────────────────────────────

test("W1-T1055: an unreachable origin refuses instead of minting optimistically", async () => {
  const reserver = stubReserver(new Set(), () => true);
  const cap = capture();
  let code: number;
  try {
    code = await nextTaskIdCommand(["--reserve"], {}, { reserver, holderOf: () => "unknown", openPrTexts: NO_OPEN_PRS });
  } finally {
    cap.restore();
  }
  assert.equal(code, 2, "fail-closed: a refusal exits non-zero");
  const errText = cap.err.join("\n");
  assert.match(errText, /REFUSED — origin is unreachable/);
  assert.match(errText, /no id was claimed/);
  assert.equal(cap.out.join("\n").includes("RESERVED "), false, "nothing may claim to have been reserved");

  // POSITIVE CONTROL: the SAME stub with no failure injected reaches the ordinary claim, so the
  // refusal comes from the injected condition and not from the wiring always failing.
  const ok = stubReserver(new Set());
  const cap2 = capture();
  try {
    await nextTaskIdCommand(["--reserve"], {}, { reserver: ok, holderOf: () => "unknown", openPrTexts: NO_OPEN_PRS });
  } finally {
    cap2.restore();
  }
  assert.match(cap2.out.join("\n"), /RESERVED W1-T\d+ on origin/);
});

// ── criterion 4 — the unflagged verb is unchanged and reserves nothing ─────────────────────────

test("W1-T3091: the unflagged verb CLAIMS, and --no-reserve is what reserves nothing", async () => {
  // POLARITY REVERSED FROM W1-T1055, DELIBERATELY. That task shipped `--reserve` as an opt-in and
  // this test asserted its other half: "without the flag the verb is byte-identical to before,
  // reserving nothing". W1-T3091 reverses exactly that, and names the evidence -- five id
  // incidents in one session on 2026-09-07, and on 2026-09-15 two shards on main under one id,
  // `loadPlan` throwing, every PR's required `ci` failing until a human renumbered the loser.
  //
  // The SHAPE of the old test is kept, including its positive control, because the control is what
  // made the original assertion trustworthy: a zero that is really an unwired stub proves nothing.
  const reserver = stubReserver(new Set());
  const cap = capture();
  try {
    await nextTaskIdCommand([], {}, { reserver, holderOf: () => "unknown", openPrTexts: NO_OPEN_PRS });
  } finally {
    cap.restore();
  }
  assert.equal(reserver.tried.length, 1, "a BARE mint must claim — exactly one attempt");
  assert.match(cap.out.join("\n"), /RESERVED /, "and must say what it holds");

  // THE OPT-OUT IS THE OTHER HALF, and the same stub carries it: a second call that opts out must
  // add NO further attempt, so the count stays where the bare mint left it.
  const cap2 = capture();
  try {
    await nextTaskIdCommand(["--no-reserve"], {}, { reserver, holderOf: () => "unknown", openPrTexts: NO_OPEN_PRS });
  } finally {
    cap2.restore();
  }
  assert.equal(reserver.tried.length, 1, "--no-reserve must claim NOTHING — the count is unchanged");
  const text = cap2.out.join("\n");
  assert.equal(text.includes("RESERVED "), false);
  assert.equal(text.includes("HELD BY ANOTHER CALLER"), false);
  assert.match(text, /W1-T\d+/, "but it still PRINTS an id — it is a mint either way");
});

// ── the contradiction, refused rather than silently resolved ──────────────────────────────────

test("W1-T1055: --reserve and --offline are refused together", async () => {
  assert.match(validateReserveArgs(["--reserve", "--offline"])!, /contradictory/);
  // POSITIVE CONTROL: either alone is accepted, so the refusal is not a blanket reject.
  assert.equal(validateReserveArgs(["--reserve"]), undefined);
  assert.equal(validateReserveArgs(["--offline"]), undefined);
  assert.equal(validateReserveArgs([]), undefined);

  const reserver = stubReserver(new Set());
  const cap = capture();
  let code: number;
  try {
    code = await nextTaskIdCommand(["--reserve", "--offline"], {}, { reserver });
  } finally {
    cap.restore();
  }
  assert.equal(code, 2);
  assert.equal(reserver.tried.length, 0, "a refused argument pair must claim nothing");
});

// ── the refusal renderer and the holder reader ────────────────────────────────────────────────

test("W1-T1055: refusal text and holder reads degrade honestly", () => {
  assert.match(describeReservationRefusal("unreachable", "boom"), /origin is unreachable/);
  assert.match(describeReservationRefusal("exhausted", "boom"), /already reserved/);
  assert.match(describeReservationRefusal(undefined, "boom"), /REFUSED/);

  // the holder read is best-effort: a failed fetch or a failed log yields "unknown", never a guess
  assert.equal(readReservationHolder("W1-T1", () => ({ status: 1, stdout: "", stderr: "no" })), "unknown");
  assert.equal(
    readReservationHolder("W1-T1", (args) => (args[0] === "fetch" ? { status: 0, stdout: "", stderr: "" } : { status: 1, stdout: "", stderr: "" })),
    "unknown",
  );
  // POSITIVE CONTROL: with both calls succeeding it really does classify, so the unknowns above
  // are genuine failure and not a reader that never works.
  assert.equal(
    readReservationHolder("W1-T1", () => ({ status: 0, stdout: "rmd-id reservation 1@host 2026-01-01T00:00:00Z", stderr: "" })),
    "fleet",
  );
});

// ── the real-path adapter, which no injected-reserver test can reach ──────────────────────────

test("W1-T1055: a signalled git push is a FAILURE, never a silent success", () => {
  // spawnSync reports `status: null` when the child is killed by a signal. classifyPushFailure
  // would read a null as success, so the adapter maps it to 1 — the fail-closed direction.
  const signalled = gitRunAdapter(() => ({ status: null }))(["push"]);
  assert.equal(signalled.status, 1, "a signalled push must not read as created");
  assert.equal(signalled.stdout, "", "absent streams normalise to empty strings, never undefined");
  assert.equal(signalled.stderr, "");

  // POSITIVE CONTROL: a real result passes through untouched, so the mapping above is the null
  // case and not the adapter rewriting every outcome.
  const real = gitRunAdapter(() => ({ status: 0, stdout: "ok", stderr: "warn" }))(["push"]);
  assert.deepEqual(real, { status: 0, stdout: "ok", stderr: "warn" });

  // and the argv reaches the underlying runner unchanged
  const seen: string[][] = [];
  gitRunAdapter((a) => { seen.push(a); return { status: 0 }; })(["push", "origin", "x:y"]);
  assert.deepEqual(seen, [["push", "origin", "x:y"]]);
});

// ── W1-T8915: the DEFAULT reserver, through the CLI, against a real disposable origin ──────────

test("W1-T8915: reservation CLI never reports held after local anchor failure", async () => {
  const origin = gitRepo({ bare: true, kind: "w8915-cli-origin" });
  const work = gitRepo({ cloneFrom: origin.dir, kind: "w8915-cli-work" });
  const identity: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: GIT_REPO_FIXTURE_IDENTITY.name,
    GIT_AUTHOR_EMAIL: GIT_REPO_FIXTURE_IDENTITY.email,
    GIT_COMMITTER_NAME: GIT_REPO_FIXTURE_IDENTITY.name,
    GIT_COMMITTER_EMAIL: GIT_REPO_FIXTURE_IDENTITY.email,
  };
  // A REAL local failure: no git identity anywhere, so the anchor's `commit-tree` exits 128.
  const noIdentity: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "user.useConfigOnly",
    GIT_CONFIG_VALUE_0: "true",
  };
  for (const k of ["GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL", "EMAIL"]) delete noIdentity[k];
  const realGit = (env: NodeJS.ProcessEnv) => {
    const calls: string[][] = [];
    const run = (args: string[]) => {
      calls.push(args);
      const r = spawnSync("git", args, { cwd: work.dir, encoding: "utf8", env });
      return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
    };
    return { run, calls };
  };
  const reserve = async (runGit: (args: string[]) => { status: number | null; stdout: string; stderr: string }) => {
    const cap = capture();
    let code: number;
    try {
      // No `reserver`: the command builds its own DEFAULT git-backed reserver over `runGit`.
      code = await nextTaskIdCommand(["--reserve", "--branch", "run-W1-T8915-cli"], {}, {
        runGit, holderOf: () => "unknown", openPrTexts: NO_OPEN_PRS, policyCurrency: () => ({ status: "current" }),
      });
    } finally {
      cap.restore();
    }
    return { code, out: cap.out.join("\n"), err: cap.err.join("\n") };
  };

  const failing = realGit(noIdentity);
  const refused = await reserve(failing.run);
  assert.equal(refused.code, 2, "a local anchor failure is a refusal, exit 2");
  assert.equal(refused.out.includes("RESERVED "), false, "nothing may claim to be held");
  assert.match(refused.err, /REFUSED/);
  assert.match(refused.err, /cannot create a reservation anchor locally/);
  assert.match(refused.err, /git commit-tree exited 128: no git identity is configured/, "the real local cause is named");
  assert.doesNotMatch(refused.err, /unreachable/i, "never a misleading network diagnosis");
  assert.ok(failing.calls.some((c) => c[0] === "commit-tree"), "the default reserver really ran commit-tree");
  assert.deepEqual(failing.calls.filter((c) => c[0] === "push"), [], "and no push followed it");
  assert.equal(origin.git("for-each-ref", "refs/rmd-id/"), "", "origin holds no reservation");

  // POSITIVE CONTROL: the same clone and command, with an identity, really reserves on origin.
  const healthy = realGit(identity);
  const held = await reserve(healthy.run);
  const id = /^RESERVED (W1-T\d+) on origin/m.exec(held.out)?.[1];
  assert.ok(id, `the healthy run reports a held id:\n${held.out}\n${held.err}`);
  assert.match(origin.git("rev-parse", `refs/rmd-id/${id}`), /^[0-9a-f]{40}$/, "and origin really holds it");
});

// ── W1-T9683: --count N, through the command — ONE open-PR read for the whole block ─────────────

async function countRun(rest: string[], reserver: RemoteRefReserver): Promise<{ code: number; out: string; err: string; openPrReads: number }> {
  let openPrReads = 0;
  const cap = capture();
  let code: number;
  try {
    code = await nextTaskIdCommand(rest, {}, { reserver, holderOf: () => "fleet", openPrTexts: () => (openPrReads++, []) });
  } finally {
    cap.restore();
  }
  return { code, out: cap.out.join("\n"), err: cap.err.join("\n"), openPrReads };
}

test("W1-T9683: next-task-id --count 3 reserves three ids with one open-PR read", async () => {
  const first = /RESERVED (W1-T\d+)/.exec((await countRun([], stubReserver(new Set()))).out)?.[1] ?? "";
  assert.ok(first, "control: an uncontested single mint names the first id");
  const n = Number(first.slice("W1-T".length));
  const contested = `W1-T${n + 1}`;
  const reserver = stubReserver(new Set([contested]));
  const r = await countRun(["--count", "3", "--branch", "plan-file-w9683"], reserver);
  assert.equal(r.code, 0, r.err);
  const ids = [...r.out.matchAll(/^RESERVED (W1-T\d+) on origin/gm)].map((m) => m[1]);
  assert.deepEqual(ids, [first, `W1-T${n + 2}`, `W1-T${n + 3}`], "three ids held, the contested one skipped");
  assert.equal(r.openPrReads, 1, "ONE open-PR read for all three");
  assert.deepEqual(reserver.tried, [first, contested, `W1-T${n + 2}`, `W1-T${n + 3}`], "one push per candidate");
  assert.match(r.out, new RegExp(`^\\(${contested}: HELD BY ANOTHER CALLER`, "m"), "the contested id is reported");
  assert.ok(r.out.indexOf(contested) < r.out.indexOf(`RESERVED W1-T${n + 2}`), "beside the id it displaced");
  assert.match(r.out, new RegExp(`^HELD 3 of 3: ${ids.join(" ")}$`, "m"), "the final line lists every id held");
  // POSITIVE CONTROL: without --count, exactly one id and no HELD line — today's output.
  const one = await countRun([], stubReserver(new Set()));
  assert.equal([...one.out.matchAll(/^RESERVED /gm)].length, 1);
  assert.doesNotMatch(one.out, /^HELD /m);
});

test("W1-T9683: next-task-id --count is refused beside --offline, --no-reserve, --audit and --prefix", async () => {
  for (const flags of [["--offline"], ["--no-reserve"], ["--audit"], ["--prefix", "CONSOLE", "--repo", "o/r"], ["0"]]) {
    const reserver = stubReserver(new Set());
    const r = await countRun(flags[0] === "0" ? ["--count", "0"] : ["--count", "2", ...flags], reserver);
    assert.equal(r.code, 2, `refused: ${flags.join(" ")}`);
    assert.match(r.err, flags[0] === "0" ? /--count needs a positive whole number/ : new RegExp(`--count and ${flags[0]} are contradictory`));
    assert.deepEqual(reserver.tried, [], "and nothing was pushed");
  }
});

test("W1-T9683: a partial next-task-id --count prints only the ids it holds and exits 2", async () => {
  let pushes = 0;
  const reserver = stubReserver(new Set(), () => ++pushes === 3);
  const r = await countRun(["--count", "3"], reserver);
  assert.equal(r.code, 2, "a short block exits non-zero");
  const ids = [...r.out.matchAll(/^RESERVED (W1-T\d+) on origin/gm)].map((m) => m[1]);
  assert.equal(ids.length, 2, r.out);
  assert.equal(r.out.includes(reserver.tried[2]), false, "the unheld id never reaches stdout");
  assert.match(r.out, new RegExp(`^HELD 2 of 3: ${ids.join(" ")}$`, "m"));
  assert.match(r.err, /PARTIAL — holds 2 of 3; could not reserve the other 1/);
  assert.match(r.err, /REFUSED — origin is unreachable/, "fail-closed on the id it could not reach");
});
