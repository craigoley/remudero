// A child-entry bundle (scripts/build-child-entries.mjs) runs from dist/child-entries/, so an import() whose specifier
// is computed is left for runtime and resolved against the BUNDLE's directory. src/lib/review.ts loaded status.ts and
// escalate.ts that way (a computed specifier dodged a module cycle), and from 2026-11-03 the daemon's bundled review
// children failed every decision replay with ERR_MODULE_NOT_FOUND .../dist/child-entries/status.js, withholding
// verdicts. The two modules' functions are now injected by the callers that already import them.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import * as review from "#src/lib/review.js";
import { appendLedger } from "#src/lib/ledger.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const requireFromHere = createRequire(import.meta.url);
const build = requireFromHere(join(REPO_ROOT, "scripts", "build-child-entries.mjs")) as {
  CHILD_ENTRIES: readonly { name: string; source: string }[];
};
const esbuild = requireFromHere("esbuild") as typeof import("esbuild");

/** Each `import(<identifier>)` in a bundle whose identifier is assigned a relative string literal in that bundle. */
function computedRelativeImports(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(/\bimport\(\s*([A-Za-z_$][\w$]*)\s*\)/g)) {
    const name = match[1]!;
    const bound = new RegExp(`\\b${name.replace(/\$/g, "\\$")}\\s*=\\s*["'](\\.\\.?/[^"']*)["']`).exec(text);
    if (bound) found.push(`${name} = "${bound[1]}"`);
  }
  return found;
}

test("no child-entry bundle loads a module by a computed relative specifier", async () => {
  // Positive control: the detector sees the defect's own shape and passes an absolute, runtime-built URL.
  assert.deepEqual(computedRelativeImports('const statusModule = "./status.js";\nawait import(statusModule);'),
    ['statusModule = "./status.js"']);
  assert.deepEqual(computedRelativeImports("const scriptUrl = pathToFileURL(p).href;\nawait import(scriptUrl);"), []);
  assert.ok(build.CHILD_ENTRIES.length > 0, "the build script names its child entries");
  const outdir = mkdtempSync(join(tmpdir(), "rmd-bundle-specifiers-"));
  try {
    for (const entry of build.CHILD_ENTRIES) {
      const result = await esbuild.build({
        entryPoints: [join(REPO_ROOT, entry.source)], bundle: true, platform: "node", format: "esm",
        packages: "external", write: false, logLevel: "silent", outdir,
      });
      const text = result.outputFiles.map((file) => file.text).join("\n");
      assert.ok(text.length > 0, `${entry.name} bundled`);
      assert.deepEqual(computedRelativeImports(text), [],
        `${entry.name}'s bundle resolves these relative to dist/child-entries/ at runtime, where no such module exists`);
    }
  } finally {
    rmSync(outdir, { recursive: true, force: true });
  }
});

test("a decision replay reads the required publisher through the reader its caller injects", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-replay-reader-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const head = "1234567890abcdef1234567890abcdef12345678";
  const prUrl = "https://github.com/acme/portal/pull/8";
  const input = review.reviewInputDigest(head, "## Acceptance\n- works — grep: x in src/app.ts\n");
  const ledgerPath = join(dir, "ledger.ndjson");
  appendLedger(ledgerPath, {
    run_id: "original", task_id: "PR-8", step: "review.posted", pr_url: prUrl, head_sha: head,
    review_input_digest: input, review_decision_digest: "v2:decision", state: "success", proof_exec: ["executed_pass"],
    decision_verdict: {
      state: "success", headSha: head, reviewerOutcome: "reviewer_completed", keywordOnly: false,
      criteria: [{ claim: "works", proof: "grep: x in src/app.ts", met: true, reason: "executed", proof_exec: "executed_pass" }],
      testTheater: false, summary: "immutable verdict", floorDegraded: false, capped: false, planOnly: false,
      decisionDisposition: "replayed", reviewDecisionDigest: "v2:decision",
    },
  });
  const branches: string[] = [];
  const binding = { contexts: [review.REVIEW_CONTEXT], checks: [{ context: review.REVIEW_CONTEXT, app_id: null }] };
  const result = await review.postReviewStatusGuarded({
    owner: "acme", repo: "portal", sha: head, state: "success", taskId: "PR-8", evidence: "executed",
    ledgerPath, runId: "replay", prUrl, reviewInputDigest: input, reviewDecisionDigest: "v2:decision",
    fetchLifecycle: () => ({ merged: false, closed: false, reviewInputDigest: input, baseRef: "main" }),
    fetchCurrentStatus: () => ({ state: "success", posterLogin: "human", posterType: "User" }) as review.ReviewStatusEntry,
    fetchPublisher: () => binding,
    readRequiredContexts: async (owner, repo, branch, readText) => {
      branches.push(`${owner}/${repo}@${branch}`);
      await readText(["api", `repos/${owner}/${repo}/branches/${branch}/protection/required_status_checks`]);
      return { kind: "read" };
    },
    post: () => {},
  });
  assert.deepEqual(branches, ["acme/portal@main"], "the replay used the injected reader, not a module it loads itself");
  assert.equal(result.replayed, true, String(result.reason));
});
