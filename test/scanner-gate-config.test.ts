import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parse as parseYaml } from "yaml";

// ── W1-T211: "every security scanner is advisory" — the OSV scan must actually gate ─────────
//
// Before this fix, ci-gate.yml's REQUIRED set never named the PR-time OSV scanner's check run
// ("scan-pr / osv-scan", from osv-scanner-pr.yml, the only scanner in the stack configured
// fail-on-vuln: true — CodeQL/Semgrep/Scorecard/dependency-review are advisory SARIF-only by
// design). ci-gate only WAITS FOR and FAILS ON checks it lists in REQUIRED (see ci-gate.yml's
// own aggregation step); an unlisted check races the merge instead of gating it, so a red
// osv-scan could still merge once branch protection requires only ci-gate + remudero-review.
// Compounding it, osv-scanner-pr.yml's scan-pr job carried `if: actor != 'dependabot[bot]'`,
// exempting exactly the PRs that change dependencies from the dependency scanner.
//
// This suite asserts against the REAL workflow YAML on disk (same "parse the real config"
// convention as claims-check.test.ts's plan/claims.yaml assertions), so it fails the moment any
// of the three claims below drifts back out of the actual config — not just out of a comment.

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const WORKFLOWS_DIR = join(REPO_ROOT, ".github", "workflows");

async function loadWorkflow(file: string) {
  const raw = await readFile(join(WORKFLOWS_DIR, file), "utf8");
  return parseYaml(raw) as { jobs: Record<string, any> };
}

async function loadCiGateRequired() {
  const doc = await loadWorkflow("ci-gate.yml");
  const env = doc.jobs["ci-gate"].env as Record<string, string>;
  return {
    required: JSON.parse(env.REQUIRED) as string[],
    ignore: JSON.parse(env.IGNORE) as string[],
  };
}

// ── Claim 1: the PR-time OSV scan is in the AWAITED REQUIRED set, not racing it ─────────────

test("scanner-gate-config: ci-gate REQUIRED lists the PR-time OSV scan's actual check-run name, so a CVE cannot merge by racing an unawaited check", async () => {
  const { required } = await loadCiGateRequired();
  assert.ok(
    required.includes("scan-pr / osv-scan"),
    `ci-gate REQUIRED is ${JSON.stringify(required)} — missing "scan-pr / osv-scan" ` +
      `(osv-scanner-pr.yml's check-run name, verified against a live PR's check-runs API ` +
      `response since a \`uses:\` reusable-workflow call is namespaced "<caller job> / ` +
      `<reusable job>" by GitHub). Without it, ci-gate never waits for or fails on this check, ` +
      `so a real OSV finding can turn it red and still merge.`,
  );
});

test("scanner-gate-config: osv-scanner-pr.yml's scan-pr job keeps fail-on-vuln: true (the check ci-gate now awaits must actually be able to fail)", async () => {
  const doc = await loadWorkflow("osv-scanner-pr.yml");
  const job = doc.jobs["scan-pr"];
  assert.equal(
    job?.with?.["fail-on-vuln"],
    true,
    "scan-pr must be configured fail-on-vuln: true — awaiting a scanner that can never fail on " +
      "a real CVE would make ci-gate's new REQUIRED entry a no-op gate.",
  );
});

// ── Claim 2: a REQUIRED job cannot be continue-on-error (claim and config cannot drift apart) ─

test("scanner-gate-config: no job ci-gate REQUIRED depends on is configured continue-on-error: true anywhere in its steps", async () => {
  const { required } = await loadCiGateRequired();
  const files = (await readdir(WORKFLOWS_DIR)).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"));

  const offenders: string[] = [];
  for (const file of files) {
    const doc = await loadWorkflow(file);
    for (const [jobId, job] of Object.entries<any>(doc.jobs ?? {})) {
      const jobName: string = job?.name ?? jobId;
      // A required check-run name is either a bare job id/name (a native job in this repo) or
      // GitHub's synthesized "<caller job> / <reusable job>" form for a `uses:` call — match
      // both shapes so this generalizes to every current AND future REQUIRED entry, not just
      // today's osv-scan addition.
      const matched = required.filter(
        (r) => r === jobId || r === jobName || r.startsWith(`${jobId} / `) || r.startsWith(`${jobName} / `),
      );
      if (matched.length === 0) continue;

      const jobLevelCoE = job?.["continue-on-error"] === true;
      const steps: any[] = Array.isArray(job?.steps) ? job.steps : [];
      const stepLevelCoE = steps.some((s) => s && s["continue-on-error"] === true);

      if (jobLevelCoE || stepLevelCoE) {
        offenders.push(`${file}:${jobId} (required via ${JSON.stringify(matched)})`);
      }
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `job(s) named in ci-gate REQUIRED are configured continue-on-error: true, so they can never ` +
      `produce a "failure" conclusion for ci-gate to detect — the REQUIRED claim and the actual ` +
      `config have drifted apart: ${offenders.join("; ") || "(none)"}`,
  );
});

test("scanner-gate-config: the advisory (continue-on-error) scanners stay OUT of ci-gate REQUIRED — dependency-review's Review job and semgrep.yml's Scan job are not silently promoted to gates by this fix", async () => {
  const { required } = await loadCiGateRequired();
  const depReview = await loadWorkflow("dependency-review.yml");
  const semgrep = await loadWorkflow("semgrep.yml");

  const depReviewJob = depReview.jobs["dependency-review"];
  const semgrepJobEntry = Object.entries<any>(semgrep.jobs).find(([, j]) =>
    (Array.isArray(j.steps) ? j.steps : []).some((s: any) => s && s["continue-on-error"] === true),
  );

  assert.ok(
    (depReviewJob?.steps ?? []).some((s: any) => s && s["continue-on-error"] === true),
    "fixture assumption broke: dependency-review.yml's Review job is expected to still carry " +
      "continue-on-error: true (it's an intentionally advisory scanner, not this fix's target)",
  );
  assert.ok(semgrepJobEntry, "fixture assumption broke: semgrep.yml is expected to still carry a continue-on-error step");

  const depReviewName: string = depReviewJob?.name ?? "dependency-review";
  const semgrepName: string = semgrepJobEntry?.[1]?.name ?? semgrepJobEntry?.[0];
  assert.ok(!required.includes(depReviewName), `${depReviewName} must not be in ci-gate REQUIRED while continue-on-error: true`);
  assert.ok(!required.includes(semgrepName), `${semgrepName} must not be in ci-gate REQUIRED while continue-on-error: true`);
});

// ── Claim 3: a Dependabot PR is NOT exempt from the dependency scanner ──────────────────────

test("scanner-gate-config: osv-scanner-pr.yml's scan-pr job has no actor exemption for dependabot[bot] — the PRs that change dependencies are the ones the scanner runs on", async () => {
  const doc = await loadWorkflow("osv-scanner-pr.yml");
  const job = doc.jobs["scan-pr"];
  const ifCondition = job?.if;

  assert.ok(
    ifCondition === undefined || !/dependabot/i.test(String(ifCondition)),
    `scan-pr carries if: ${JSON.stringify(ifCondition)} — a dependabot[bot] actor exemption skips ` +
      `the dependency scanner on exactly the PRs that bump dependencies (the highest-risk case ` +
      `for a newly-introduced CVE). It would also have deadlocked those PRs forever once ` +
      `ci-gate started requiring this check's name: a skipped \`uses:\` reusable-workflow call ` +
      `registers no check run under that nested name at all (ci-gate.yml's own header documents ` +
      `this failure class).`,
  );
});

test("scanner-gate-config: no other pull_request-triggered workflow re-introduces a dependabot[bot] actor exemption on the job ci-gate REQUIRED names", async () => {
  const { required } = await loadCiGateRequired();
  const files = (await readdir(WORKFLOWS_DIR)).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"));

  const offenders: string[] = [];
  for (const file of files) {
    const doc = await loadWorkflow(file);
    for (const [jobId, job] of Object.entries<any>(doc.jobs ?? {})) {
      const jobName: string = job?.name ?? jobId;
      const matched = required.some(
        (r) => r === jobId || r === jobName || r.startsWith(`${jobId} / `) || r.startsWith(`${jobName} / `),
      );
      if (!matched) continue;
      if (job?.if !== undefined && /dependabot/i.test(String(job.if))) {
        offenders.push(`${file}:${jobId} if: ${JSON.stringify(job.if)}`);
      }
    }
  }

  assert.deepEqual(offenders, [], `required job(s) skip dependabot[bot]: ${offenders.join("; ") || "(none)"}`);
});
