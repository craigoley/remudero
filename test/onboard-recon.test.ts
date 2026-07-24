import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
// The DEFAULT export — see recon.ts's own header comment for why: `t.mock.method` cannot
// intercept ESM named bindings off `node:fs` (non-configurable), so the write-spy test below
// spies on the REAL module the same way test/onboard-inventory.test.ts already does.
import fsDefault from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { isReadOnlyToolset, SPECIALIST_TOOLS, type SpecialistName } from "../src/lib/specialist-panel.js";
import type { Known } from "../src/lib/onboard/inventory.js";
import {
  buildReconSpecialistPrompt,
  buildReconSpecialistSpawnArgs,
  DEFAULT_ADR_DIR_CANDIDATES,
  DEFAULT_LINE_MINER_RULES,
  formatSourceRef,
  mineAdrIntents,
  mineCandidates,
  mineLinePatterns,
  mineLines,
  mineOpenIssues,
  parseReconArgs,
  parseReconFindings,
  parseSourceRefString,
  RECON_LENSES,
  RECON_PHASE,
  realReconFsDeps,
  realReconGhGateway,
  ReconError,
  renderFindings,
  runOnboardRecon,
  spawnReconSpecialist,
  validateCandidate,
  validateCandidates,
  type Candidate,
  type ReconGhGateway,
  type ReconOpenIssue,
} from "../src/lib/onboard/recon.js";
import type { GhExec } from "../src/lib/onboard/inventory.js";
import type { Mount } from "../src/lib/mounts.js";
import type { WorkerResult } from "../src/lib/worker.js";

/** A minimal {@link WorkerResult} — mirrors test/run-task.test.ts's own `result()` helper. */
function fakeWorkerResult(over: Partial<WorkerResult>): WorkerResult {
  return {
    sessionId: "s",
    costUsd: 0,
    numTurns: 1,
    text: "",
    blocks: [],
    stderr: "",
    subtype: "success",
    isError: false,
    apiError: false,
    permissionDenials: [],
    childEnvKeys: [],
    model: "default",
    effort: "default",
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    modelUsage: {},
    compactionEvents: [],
    qualitySuspect: false,
    ...over,
  };
}

function tmpRoot(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

const FIXTURES_DIR = fileURLToPath(new URL("./fixtures/onboard-recon/", import.meta.url));
const FIXTURE_REPO_DIR = join(FIXTURES_DIR, "repo");
const FIXTURE_ISSUES_PATH = join(FIXTURES_DIR, "gh", "issues.json");

/** A ReconGhGateway built straight from the committed fixture issues.json — mirrors
 *  onboard-inventory.test.ts's `fixtureGhGateway`, filtering PRs/closed the same way the
 *  real gateway does. */
function fixtureReconGhGateway(): ReconGhGateway {
  const issuesJson = JSON.parse(readFileSync(FIXTURE_ISSUES_PATH, "utf8")) as Array<{
    number: number;
    title: string;
    state: string;
    pull_request?: unknown;
  }>;
  return {
    listOpenIssues: (): Known<ReconOpenIssue[]> => ({
      known: true,
      value: issuesJson.filter((i) => i.state === "open" && i.pull_request === undefined).map((i) => ({ number: i.number, title: i.title })),
    }),
  };
}

function darkReconGhGateway(): ReconGhGateway {
  return { listOpenIssues: () => ({ known: false }) };
}

const MOUNT: Mount = { model: "sonnet", effort: "medium", maxTurns: 30, contextBudget: 150_000 };

// ── acceptance 1: every mined candidate cites its source verbatim; source refs RESOLVE ──

test("acceptance 1: mineLinePatterns over the fixture ROADMAP/TODO yields candidates whose source refs resolve verbatim", () => {
  const candidates = mineLinePatterns(FIXTURE_REPO_DIR, realReconFsDeps, DEFAULT_LINE_MINER_RULES);
  assert.ok(candidates.length >= 4, `expected at least 4 mined candidates, got ${candidates.length}`);
  for (const c of candidates) {
    assert.equal(c.confidence, "mined");
    assert.equal(c.source.kind, "file");
    if (c.source.kind !== "file") continue;
    const fileLines = readFileSync(join(FIXTURE_REPO_DIR, c.source.path), "utf8").split("\n");
    const resolvedLine = fileLines[c.source.line - 1];
    assert.ok(resolvedLine !== undefined, `source ref ${formatSourceRef(c.source)} must resolve to a real line`);
    assert.ok(resolvedLine!.includes(c.text), `resolved line "${resolvedLine}" must contain candidate text "${c.text}"`);
  }
  const texts = candidates.map((c) => c.text);
  assert.ok(texts.some((t) => t.includes("widget catalog search")));
  assert.ok(texts.some((t) => t.includes("wire up the widget cache")));
});

test("acceptance 1: mineAdrIntents cites the ADR file+heading-line verbatim", () => {
  const candidates = mineAdrIntents(FIXTURE_REPO_DIR, realReconFsDeps, DEFAULT_ADR_DIR_CANDIDATES);
  assert.equal(candidates.length, 1);
  const [c] = candidates;
  assert.equal(c!.confidence, "mined");
  assert.deepEqual(c!.source, { kind: "file", path: "docs/adr/0001-use-postgres.md", line: 1 });
  assert.equal(c!.text, "Use Postgres for the catalog store");
});

test("acceptance 1: mineOpenIssues cites #<issue-number>, filtering closed issues and pull requests (fixture issue set)", () => {
  const candidates = mineOpenIssues("acme-corp", "widget-fixture", fixtureReconGhGateway());
  assert.deepEqual(
    candidates.map((c) => c.source),
    [
      { kind: "issue", number: 1 },
      { kind: "issue", number: 2 },
    ],
  );
  assert.equal(candidates[0]!.text, "widget catalog missing SKUs");
  assert.equal(candidates[0]!.confidence, "mined");
});

test("acceptance 1: mineOpenIssues mines nothing when owner/repo is unresolved or the gh read is unresolved (never guessed)", () => {
  assert.deepEqual(mineOpenIssues(undefined, undefined, fixtureReconGhGateway()), []);
  assert.deepEqual(mineOpenIssues("acme-corp", "widget-fixture", darkReconGhGateway()), []);
});

test("acceptance 1: mineCandidates folds ROADMAP+TODO+ADR+issues into one validated list, every candidate's source ref resolvable", () => {
  const candidates = mineCandidates(FIXTURE_REPO_DIR, { owner: "acme-corp", repo: "widget-fixture" }, { fs: realReconFsDeps, gh: fixtureReconGhGateway() });
  assert.ok(candidates.every((c) => c.confidence === "mined"));
  assert.ok(candidates.some((c) => c.source.kind === "file"));
  assert.ok(candidates.some((c) => c.source.kind === "issue"));
  // validateCandidates (called internally) must not have thrown — the very fact this
  // returned proves every candidate had a resolvable source.
  assert.doesNotThrow(() => validateCandidates(candidates));
});

test("acceptance 1: a candidate without a source ref fails validation", () => {
  const bad = { text: "no source", source: undefined, confidence: "mined" } as unknown as Candidate;
  assert.throws(() => validateCandidate(bad), ReconError);
  assert.throws(() => validateCandidates([bad]), ReconError);
});

test("acceptance 1: a candidate with a malformed file source (line 0) or empty text fails validation", () => {
  assert.throws(
    () => validateCandidate({ text: "x", source: { kind: "file", path: "a.md", line: 0 }, confidence: "mined" }),
    ReconError,
  );
  assert.throws(
    () => validateCandidate({ text: "   ", source: { kind: "file", path: "a.md", line: 1 }, confidence: "mined" }),
    ReconError,
  );
  assert.throws(
    () => validateCandidate({ text: "x", source: { kind: "issue", number: 0 }, confidence: "mined" }),
    ReconError,
  );
});

test("acceptance 1: confidence/specialist labeling is enforced by validation — mined never carries a specialist, inferred always does", () => {
  assert.throws(
    () =>
      validateCandidate({
        text: "x",
        source: { kind: "file", path: "a.md", line: 1 },
        confidence: "mined",
        specialist: "security",
      }),
    ReconError,
  );
  assert.throws(
    () =>
      validateCandidate({
        text: "x",
        source: { kind: "file", path: "a.md", line: 1 },
        confidence: "inferred",
      }),
    ReconError,
  );
});

test("formatSourceRef / parseSourceRefString round-trip both source kinds", () => {
  assert.equal(formatSourceRef({ kind: "file", path: "src/x.ts", line: 42 }), "src/x.ts:42");
  assert.equal(formatSourceRef({ kind: "issue", number: 7 }), "#7");
  assert.deepEqual(parseSourceRefString("src/x.ts:42"), { kind: "file", path: "src/x.ts", line: 42 });
  assert.deepEqual(parseSourceRefString("#7"), { kind: "issue", number: 7 });
  assert.equal(parseSourceRefString("not a ref"), undefined);
  assert.equal(parseSourceRefString("src/x.ts:0"), undefined, "line 0 is not a valid 1-based line");
});

// ── acceptance 2: recon workers are read-only via the specialist path (W2-T1 reused) ────

test("acceptance 2: buildReconSpecialistSpawnArgs excludes every write tool, for all four lenses — the W2-T1 assertion reused verbatim", () => {
  for (const specialist of RECON_LENSES) {
    const args = buildReconSpecialistSpawnArgs({
      input: { specialist, targetDir: "/some/target-repo", owner: "acme-corp", repo: "widget-fixture" },
      mount: MOUNT,
      settingsFile: "/some/settings.json",
    });
    assert.deepEqual(args.tools, SPECIALIST_TOOLS, `${specialist}'s tool list must be the SAME SPECIALIST_TOOLS W2-T1 already established`);
    assert.ok(isReadOnlyToolset(args.tools!), `${specialist}'s spawn args must pass W2-T1's own isReadOnlyToolset predicate`);
    assert.equal(args.cwd, "/some/target-repo");
    assert.equal(args.permissionMode, "bypassPermissions");
  }
});

test("acceptance 2: spawnReconSpecialist delegates buildReconSpecialistSpawnArgs's OWN output to the injected spawn fn and returns its result verbatim", async () => {
  let capturedArgs: unknown;
  const canned = fakeWorkerResult({ text: "RECON_FINDING: x (source: a.ts:1)" });
  const args = {
    input: { specialist: "security" as SpecialistName, targetDir: "/some/target-repo", owner: "acme-corp", repo: "widget-fixture" },
    mount: MOUNT,
    settingsFile: "/some/settings.json",
  };
  const result = await spawnReconSpecialist({
    ...args,
    spawn: async (spawnArgs) => {
      capturedArgs = spawnArgs;
      return canned;
    },
  });
  assert.equal(result, canned);
  assert.deepEqual(capturedArgs, buildReconSpecialistSpawnArgs(args));
});

test("RECON_LENSES is exactly the four W2-T1 specialist names, in a fixed order", () => {
  assert.deepEqual(RECON_LENSES, ["security", "testing", "design", "containment"] as SpecialistName[]);
});

test("buildReconSpecialistPrompt names the lens, the target repo, and the machine-readable RECON_FINDING contract", () => {
  const prompt = buildReconSpecialistPrompt({ specialist: "security", targetDir: "/tmp/target", owner: "acme-corp", repo: "widget-fixture" });
  assert.match(prompt, /SECURITY SPECIALIST/);
  assert.match(prompt, /\/tmp\/target/);
  assert.match(prompt, /acme-corp\/widget-fixture/);
  assert.match(prompt, /RECON_FINDING:/);
  assert.match(prompt, /READ-ONLY/);
});

test("acceptance 2: runOnboardRecon's injected fs write-spy on the REAL fs module records zero writes outside plan/onboarding/", async (t) => {
  const targetDir = tmpRoot("rmd-onboard-recon-write-spy-");
  cpSync(FIXTURE_REPO_DIR, targetDir, { recursive: true });
  const allowedPrefix = join(targetDir, "plan", "onboarding");

  const writeSpy = t.mock.method(fsDefault, "writeFileSync");
  const renameSpy = t.mock.method(fsDefault, "renameSync");
  const mkdirSpy = t.mock.method(fsDefault, "mkdirSync");

  await runOnboardRecon(
    targetDir,
    { owner: "acme-corp", repo: "widget-fixture" },
    { fs: realReconFsDeps, gh: fixtureReconGhGateway(), runLens: async () => "" },
  );

  assert.ok(writeSpy.mock.calls.length > 0, "sanity: the phase must actually write the two artifacts");
  for (const call of writeSpy.mock.calls) {
    const target = call.arguments[0] as string;
    assert.ok(target.startsWith(allowedPrefix), `writeFileSync target "${target}" must live under plan/onboarding/`);
  }
  for (const call of renameSpy.mock.calls) {
    const [from, to] = call.arguments as [string, string];
    assert.ok(from.startsWith(allowedPrefix));
    assert.ok(to.startsWith(allowedPrefix));
  }
  for (const call of mkdirSpy.mock.calls) {
    const target = call.arguments[0] as string;
    assert.ok(target.startsWith(allowedPrefix));
  }
});

test("runOnboardRecon refuses (throws ReconError) when the target directory does not exist — never silently mkdir -p's a fresh tree", async (t) => {
  const parentDir = tmpRoot("rmd-onboard-recon-missing-");
  const missingTargetDir = join(parentDir, "does-not-exist");
  const mkdirSpy = t.mock.method(fsDefault, "mkdirSync");
  const writeSpy = t.mock.method(fsDefault, "writeFileSync");

  await assert.rejects(
    () => runOnboardRecon(missingTargetDir, { owner: "acme-corp", repo: "widget-fixture" }, { fs: realReconFsDeps, gh: fixtureReconGhGateway(), runLens: async () => "" }),
    (e: unknown) => e instanceof ReconError && /does not exist/.test((e as Error).message),
  );
  assert.equal(mkdirSpy.mock.calls.length, 0);
  assert.equal(writeSpy.mock.calls.length, 0);
});

// ── acceptance 3: mined vs inferred is a labeled distinction, preserved by the renderer ──

test("parseReconFindings parses RECON_FINDING lines into inferred candidates naming the specialist, dropping unsourced lines", () => {
  const text = [
    "some prose the specialist wrote first",
    "RECON_FINDING: no test coverage for src/lib/x.ts (source: src/lib/x.ts:42)",
    "RECON_FINDING: vague unsourced claim (source: somewhere vague)",
    "RECON_FINDING: open issue worth revisiting (source: #9)",
  ].join("\n");
  const candidates = parseReconFindings("testing", text);
  assert.equal(candidates.length, 2, "the unsourced line must be DROPPED, never surfaced as a candidate");
  assert.deepEqual(candidates[0], { text: "no test coverage for src/lib/x.ts", source: { kind: "file", path: "src/lib/x.ts", line: 42 }, confidence: "inferred", specialist: "testing" });
  assert.deepEqual(candidates[1], { text: "open issue worth revisiting", source: { kind: "issue", number: 9 }, confidence: "inferred", specialist: "testing" });
});

test("parseReconFindings returns [] for a lens that found nothing (empty or finding-free text) — advisory, never a hard failure", () => {
  assert.deepEqual(parseReconFindings("design", ""), []);
  assert.deepEqual(parseReconFindings("design", "Read the whole repo; nothing in my rubric's scope stood out."), []);
});

test("acceptance 3: renderFindings preserves the mined/inferred labels in separate sections, inferred entries naming their specialist", () => {
  const candidates: Candidate[] = [
    { text: "Ship the widget.", source: { kind: "file", path: "ROADMAP.md", line: 3 }, confidence: "mined" },
    { text: "no test coverage for src/lib/x.ts", source: { kind: "file", path: "src/lib/x.ts", line: 42 }, confidence: "inferred", specialist: "testing" },
  ];
  const rendered = renderFindings(candidates);
  assert.match(rendered, /## Mined candidates \(1\)/);
  assert.match(rendered, /## Inferred candidates \(1\)/);
  assert.match(rendered, /- Ship the widget\. \(source: ROADMAP\.md:3\)/);
  assert.match(rendered, /- \[testing\] no test coverage for src\/lib\/x\.ts \(source: src\/lib\/x\.ts:42\)/);
  // The mined line must appear strictly before the inferred section header, proving the
  // sections are actually separate, not interleaved.
  assert.ok(rendered.indexOf("Ship the widget") < rendered.indexOf("## Inferred candidates"));
});

test("renderFindings prints '(none)' for an empty mined or inferred set rather than an empty/blank section", () => {
  const rendered = renderFindings([{ text: "x", source: { kind: "issue", number: 1 }, confidence: "mined" }]);
  assert.match(rendered, /## Inferred candidates \(0\)[\s\S]*\(none\)/);
});

test("acceptance 3: runOnboardRecon's candidates.json and findings.md both carry mined AND inferred candidates with preserved labels, from one lens's canned RECON_FINDING output", async () => {
  const targetDir = tmpRoot("rmd-onboard-recon-mixed-");
  cpSync(FIXTURE_REPO_DIR, targetDir, { recursive: true });

  const runLens = async (specialist: SpecialistName): Promise<string> => {
    if (specialist === "security") {
      return "RECON_FINDING: no allowedDomains configured (source: docs/adr/0001-use-postgres.md:1)";
    }
    return "";
  };

  const { candidates, findingsPath, candidatesPath } = await runOnboardRecon(
    targetDir,
    { owner: "acme-corp", repo: "widget-fixture" },
    { fs: realReconFsDeps, gh: fixtureReconGhGateway(), runLens },
  );

  const mined = candidates.filter((c) => c.confidence === "mined");
  const inferred = candidates.filter((c) => c.confidence === "inferred");
  assert.ok(mined.length > 0);
  assert.equal(inferred.length, 1);
  assert.equal(inferred[0]!.specialist, "security");
  assert.ok(mined.every((c) => c.specialist === undefined));

  const candidatesOnDisk = JSON.parse(readFileSync(candidatesPath, "utf8")) as Candidate[];
  assert.deepEqual(candidatesOnDisk, candidates);
  assert.ok(candidatesOnDisk.some((c) => c.confidence === "mined"));
  assert.ok(candidatesOnDisk.some((c) => c.confidence === "inferred" && c.specialist === "security"));

  const findingsOnDisk = readFileSync(findingsPath, "utf8");
  assert.match(findingsOnDisk, /## Mined candidates/);
  assert.match(findingsOnDisk, /## Inferred candidates \(1\)/);
  assert.match(findingsOnDisk, /\[security\] no allowedDomains configured/);
});

test("runOnboardRecon calls runLens for every one of the four RECON_LENSES, even when most return nothing", async () => {
  const targetDir = tmpRoot("rmd-onboard-recon-all-lenses-");
  cpSync(FIXTURE_REPO_DIR, targetDir, { recursive: true });
  const seen: SpecialistName[] = [];

  await runOnboardRecon(
    targetDir,
    {},
    {
      fs: realReconFsDeps,
      gh: darkReconGhGateway(),
      runLens: async (specialist) => {
        seen.push(specialist);
        return "";
      },
    },
  );

  assert.deepEqual(seen.sort(), [...RECON_LENSES].sort());
});

// ── realReconGhGateway — the REAL `gh api` gateway, via its injectable exec seam ────────

function throwingExec(stderr: string): GhExec {
  return () => {
    throw { stderr };
  };
}

test("realReconGhGateway.listOpenIssues: filters pull requests and non-open issues, same contract as inventory.ts", () => {
  const exec: GhExec = () =>
    JSON.stringify([
      { number: 1, title: "a" },
      { number: 2, title: "b", pull_request: {} },
      { number: 3, title: "c" },
    ]);
  const gateway = realReconGhGateway({ exec });
  assert.deepEqual(gateway.listOpenIssues("acme-corp", "widget"), {
    known: true,
    value: [
      { number: 1, title: "a" },
      { number: 3, title: "c" },
    ],
  });
});

test("realReconGhGateway.listOpenIssues: an unresolved read (auth/network) resolves known:false, never guessed", () => {
  const gateway = realReconGhGateway({ exec: throwingExec("gh: authentication required") });
  assert.deepEqual(gateway.listOpenIssues("acme-corp", "widget"), { known: false });
});

test("realReconGhGateway with no opts.exec still returns a usable gateway shape", () => {
  const gateway = realReconGhGateway();
  assert.equal(typeof gateway.listOpenIssues, "function");
});

// ── CLI arg parsing (pure): fail loud, before any work — independent of inventory.ts's ──
// own parseOnboardArgs, which keeps rejecting "recon" exactly as W1-T82 committed it.

test("parseReconArgs requires <target-dir> as the first positional argument", () => {
  const result = parseReconArgs(["--phase", "recon"]);
  assert.equal(result.ok, false);
});

test("parseReconArgs requires --phase to be exactly \"recon\"", () => {
  const missing = parseReconArgs(["/some/dir"]);
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.match(missing.error, /--phase must be "recon"/);

  const wrong = parseReconArgs(["/some/dir", "--phase", "inventory"]);
  assert.equal(wrong.ok, false);
  if (!wrong.ok) assert.match(wrong.error, /--phase must be "recon"/);
});

test("parseReconArgs rejects an unrecognized flag", () => {
  const result = parseReconArgs(["/some/dir", "--phase", "recon", "--bogus"]);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /unrecognized argument/);
});

test("parseReconArgs accepts --owner/--repo overrides", () => {
  const result = parseReconArgs(["/some/dir", "--phase", "recon", "--owner", "acme-corp", "--repo", "widget-fixture"]);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(result.args, { targetDir: "/some/dir", owner: "acme-corp", repo: "widget-fixture" });
  }
  assert.equal(RECON_PHASE, "recon");
});

test("ReconError carries the standard Error name", () => {
  const e = new ReconError("x");
  assert.equal(e.name, "ReconError");
  assert.ok(e instanceof Error);
});

// ── mineLines engine is generic — a caller's own extra rule mines with zero engine change ──

test("mineLines/mineLinePatterns is a generic engine — a caller's own extra rule mines a seeded file with zero engine changes", () => {
  const targetDir = tmpRoot("rmd-onboard-recon-extra-rule-");
  writeFileSync(join(targetDir, "NOTES.md"), "- a seeded note line\n");
  const extraRule = { id: "notes", candidates: ["NOTES.md"], lineRegex: /^[-*]\s+(.+)$/ } as const;
  const withoutRule = mineLinePatterns(targetDir, realReconFsDeps);
  assert.deepEqual(withoutRule, []);
  const withRule = mineLinePatterns(targetDir, realReconFsDeps, [extraRule]);
  assert.equal(withRule.length, 1);
  assert.equal(withRule[0]!.text, "a seeded note line");
});

test("mineLines returns [] when none of a rule's candidate files exist", () => {
  const targetDir = tmpRoot("rmd-onboard-recon-no-file-");
  assert.deepEqual(mineLines(targetDir, realReconFsDeps, DEFAULT_LINE_MINER_RULES[0]!), []);
});

test("mineAdrIntents returns [] when no ADR directory exists", () => {
  const targetDir = tmpRoot("rmd-onboard-recon-no-adr-");
  assert.deepEqual(mineAdrIntents(targetDir, realReconFsDeps), []);
});
