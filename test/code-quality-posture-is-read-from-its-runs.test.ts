import assert from "node:assert/strict";
import { existsSync, rmSync } from "node:fs";
import { test } from "node:test";
import { ghShim } from "./helpers/gh-shim.js";

import {
  checkGithubPosture,
  classifyGithubPosture,
  ghPostureGateway,
  readGithubPosture,
  type GithubPostureBaseline,
  type GithubPostureGateway,
} from "../src/lib/github-posture.js";

const OWNER = "craigoley";
const REPO = "remudero";
const SINCE = "2026-09-24T12:00:00.000Z";
const NOW = new Date("2026-09-25T12:00:00.000Z");
const CODE_QUALITY_PATH = ".github/workflows/dynamic/github-code-quality/codeql.yml@main";
const CODE_QUALITY_WORKFLOW_ID = 343193516;

const enabledRepoSettings = {
  security_and_analysis: {
    secret_scanning: { status: "enabled" },
    secret_scanning_push_protection: { status: "enabled" },
    dependabot_security_updates: { status: "enabled" },
    secret_scanning_ai_detection: { status: "enabled" },
    secret_scanning_non_provider_patterns: { status: "enabled" },
    secret_scanning_validity_checks: { status: "enabled" },
    secret_scanning_delegated_alert_dismissal: { status: "enabled" },
    secret_scanning_delegated_bypass: { status: "enabled" },
  },
  squash_merge_commit_message: "COMMIT_MESSAGES",
};

const baselineWithoutCodeQuality: GithubPostureBaseline = {
  checkedAt: SINCE,
  snapshot: {
    secret_scanning: "enabled",
    secret_scanning_push_protection: "enabled",
    dependabot_security_updates: "enabled",
    secret_scanning_ai_detection: "enabled",
    secret_scanning_non_provider_patterns: "enabled",
    secret_scanning_validity_checks: "enabled",
    secret_scanning_delegated_alert_dismissal: "enabled",
    secret_scanning_delegated_bypass: "enabled",
    enforce_admins: "enabled",
    squash_merge_commit_message: "enabled",
  },
};

function gatewayForRuns(runs: unknown): GithubPostureGateway {
  return {
    getRepo: () => enabledRepoSettings,
    getEnforceAdmins: () => ({ enabled: true }),
    getCodeQualityRuns: () => runs,
  };
}

test("W1-T4070: a recent code-quality run beside codeql is reported as duplicate analysis", () => {
  assert.ok(existsSync(new URL("../.github/workflows/codeql.yml", import.meta.url)), "the repository's codeql.yml is present");
  let saved: GithubPostureBaseline | undefined;
  let queriedSince: string | undefined;
  const findings = checkGithubPosture({
    owner: OWNER,
    repo: REPO,
    configRoot: "/unused",
    now: NOW,
    minIntervalMinutes: 0,
    loadBaseline: () => baselineWithoutCodeQuality,
    saveBaseline: (_path, baseline) => {
      saved = baseline;
    },
    gateway: {
      ...gatewayForRuns({
        codeqlWorkflowActive: true,
        workflow_runs: [{ path: CODE_QUALITY_PATH, created_at: "2026-09-25T11:00:00.000Z" }],
      }),
      getCodeQualityRuns: (_owner, _repo, since) => {
        queriedSince = since;
        return {
          codeqlWorkflowActive: true,
          workflow_runs: [{ path: CODE_QUALITY_PATH, created_at: "2026-09-25T11:00:00.000Z" }],
        };
      },
    },
  });

  assert.equal(queriedSince, SINCE, "the query starts at the last posture reading");
  assert.equal(findings.length, 1);
  assert.equal(findings[0].capability, "code_quality");
  assert.equal(findings[0].kind, "paid");
  assert.match(findings[0].cost ?? "", /duplicate.*codeql\.yml/i);
  assert.match(findings[0].cost ?? "", /Settings > Security and quality > Code quality/);
  assert.equal(saved?.snapshot.code_quality, "enabled");
});

test("W1-T4070: an active workflow state with no recent run is not reported", () => {
  const calls: string[][] = [];
  const gateway = ghPostureGateway((args) => {
    calls.push(args);
    const endpoint = args.at(-1) ?? "";
    if (endpoint === `repos/${OWNER}/${REPO}`) return JSON.stringify(enabledRepoSettings);
    if (endpoint.includes("/branches/")) return JSON.stringify({ enabled: true });
    if (endpoint.endsWith("/actions/workflows?per_page=100")) {
      return JSON.stringify([
        {
          total_count: 1,
          workflows: [{ id: 1, path: ".github/workflows/codeql.yml", state: "active" }],
        },
      ]);
    }
    if (endpoint === `repos/${OWNER}/${REPO}/actions/workflows/${CODE_QUALITY_WORKFLOW_ID}`) {
      return JSON.stringify({ id: CODE_QUALITY_WORKFLOW_ID, path: "dynamic/github-code-quality/codeql", state: "disabled_manually" });
    }
    if (endpoint.includes(`/actions/workflows/${CODE_QUALITY_WORKFLOW_ID}/runs`)) {
      return JSON.stringify([{ total_count: 0, workflow_runs: [] }]);
    }
    throw new Error(`unexpected GitHub read: ${args.join(" ")}`);
  });

  const snapshot = readGithubPosture(OWNER, REPO, { gateway, since: SINCE });
  assert.ok(snapshot);
  assert.equal(snapshot.code_quality, undefined, "state=active is not evidence of a run or an enabled setting");
  assert.equal(classifyGithubPosture(snapshot).some((finding) => finding.capability === "code_quality"), false);
  assert.ok(calls.some((args) => args.at(-1)?.includes(`/actions/workflows/${CODE_QUALITY_WORKFLOW_ID}/runs?created=`)));
});

test("W1-T4070: an unreadable listing reads unknown never off", () => {
  let saved: GithubPostureBaseline | undefined;
  const findings = checkGithubPosture({
    owner: OWNER,
    repo: REPO,
    configRoot: "/unused",
    now: NOW,
    minIntervalMinutes: 0,
    loadBaseline: () => ({
      ...baselineWithoutCodeQuality,
      snapshot: { ...baselineWithoutCodeQuality.snapshot, code_quality: "enabled" },
    }),
    saveBaseline: (_path, baseline) => {
      saved = baseline;
    },
    gateway: gatewayForRuns(undefined),
  });

  assert.deepEqual(findings, []);
  assert.equal(saved, undefined, "an unreadable Actions response cannot overwrite the known baseline as off");
});

test("W1-T4070: the posture read issues no write", () => {
  const calls: string[][] = [];
  const gateway = ghPostureGateway((args) => {
    calls.push(args);
    const endpoint = args.at(-1) ?? "";
    if (endpoint === `repos/${OWNER}/${REPO}`) return JSON.stringify(enabledRepoSettings);
    if (endpoint.includes("/branches/")) return JSON.stringify({ enabled: true });
    if (endpoint.endsWith("/actions/workflows?per_page=100")) {
      return JSON.stringify([
        {
          total_count: 1,
          workflows: [{ id: 1, path: ".github/workflows/codeql.yml", state: "active" }],
        },
      ]);
    }
    if (endpoint === `repos/${OWNER}/${REPO}/actions/workflows/${CODE_QUALITY_WORKFLOW_ID}`) {
      return JSON.stringify({ id: CODE_QUALITY_WORKFLOW_ID, path: "dynamic/github-code-quality/codeql", state: "disabled_manually" });
    }
    if (endpoint.includes(`/actions/workflows/${CODE_QUALITY_WORKFLOW_ID}/runs`)) {
      return JSON.stringify([
        {
          total_count: 1,
          workflow_runs: [{ path: CODE_QUALITY_PATH, created_at: "2026-09-25T11:00:00.000Z" }],
        },
      ]);
    }
    throw new Error(`unexpected GitHub read: ${args.join(" ")}`);
  });

  const snapshot = readGithubPosture(OWNER, REPO, { gateway, since: SINCE });
  assert.equal(snapshot?.code_quality, "enabled", "a recent run counts even if workflow state says disabled");
  assert.equal(calls.length, 5, "repo settings, branch protection, workflow inventory, workflow path, and matching runs were read");
  for (const args of calls) {
    assert.equal(args[0], "api");
    for (const forbidden of ["-X", "--method", "-f", "-F", "--input", "PUT", "POST", "PATCH", "DELETE"]) {
      assert.equal(args.includes(forbidden), false, `read path must not use ${forbidden}`);
    }
  }
  assert.ok(calls.some((args) => args.some((arg) => arg.includes("created=%3E%3D2026-09-24T12%3A00%3A00.000Z"))));
});

test("W1-T4070: an unexpected primary CodeQL workflow state reads unknown", () => {
  const gateway = ghPostureGateway((args) => {
    const endpoint = args.at(-1) ?? "";
    if (endpoint.endsWith("/actions/workflows?per_page=100")) {
      return JSON.stringify([
        {
          total_count: 1,
          workflows: [{ id: 1, path: ".github/workflows/codeql.yml", state: "unexpected" }],
        },
      ]);
    }
    throw new Error(`unexpected GitHub read: ${args.join(" ")}`);
  });

  assert.equal(gateway.getCodeQualityRuns?.(OWNER, REPO, SINCE), undefined);
});

test("W1-T4070: a Code Quality run with an invalid creation time reads unknown", () => {
  const gateway = ghPostureGateway((args) => {
    const endpoint = args.at(-1) ?? "";
    if (endpoint.endsWith("/actions/workflows?per_page=100")) {
      return JSON.stringify([
        {
          total_count: 1,
          workflows: [{ id: 1, path: ".github/workflows/codeql.yml", state: "active" }],
        },
      ]);
    }
    if (endpoint === `repos/${OWNER}/${REPO}/actions/workflows/${CODE_QUALITY_WORKFLOW_ID}`) {
      return JSON.stringify({ id: CODE_QUALITY_WORKFLOW_ID, path: "dynamic/github-code-quality/codeql" });
    }
    if (endpoint.includes(`/actions/workflows/${CODE_QUALITY_WORKFLOW_ID}/runs`)) {
      return JSON.stringify([
        {
          total_count: 1,
          workflow_runs: [{ path: CODE_QUALITY_PATH, created_at: "not-a-date" }],
        },
      ]);
    }
    throw new Error(`unexpected GitHub read: ${args.join(" ")}`);
  });

  assert.equal(gateway.getCodeQualityRuns?.(OWNER, REPO, SINCE), undefined);
});

test("W1-T4070: a throwing Code Quality read leaves the posture baseline untouched", () => {
  let saved: GithubPostureBaseline | undefined;
  const findings = checkGithubPosture({
    owner: OWNER,
    repo: REPO,
    configRoot: "/unused",
    now: NOW,
    minIntervalMinutes: 0,
    loadBaseline: () => baselineWithoutCodeQuality,
    saveBaseline: (_path, baseline) => {
      saved = baseline;
    },
    gateway: {
      getRepo: () => enabledRepoSettings,
      getEnforceAdmins: () => ({ enabled: true }),
      getCodeQualityRuns: () => {
        throw new Error("Actions API unavailable");
      },
    },
  });

  assert.deepEqual(findings, []);
  assert.equal(saved, undefined);
});

test("W1-T4070: the default Code Quality gateway really shells out through gh", () => {
  const shim = ghShim([
    { when: `actions/workflows/${CODE_QUALITY_WORKFLOW_ID}/runs?created=`, stdout: '[{"total_count":0,"workflow_runs":[]}]' },
    { when: `actions/workflows/${CODE_QUALITY_WORKFLOW_ID}`, stdout: JSON.stringify({ id: CODE_QUALITY_WORKFLOW_ID, path: "dynamic/github-code-quality/codeql" }) },
    { when: "actions/workflows?per_page=100", stdout: '[{"total_count":1,"workflows":[{"id":1,"path":".github/workflows/codeql.yml","state":"active"}]}]' },
  ]);
  const previousPath = process.env.PATH;
  process.env.PATH = `${shim.dir}:${previousPath ?? ""}`;
  try {
    const activity = ghPostureGateway().getCodeQualityRuns?.(OWNER, REPO, SINCE);
    assert.deepEqual(activity, { codeqlWorkflowActive: true, workflow_runs: [] });
    assert.equal(shim.calls().length, 3);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    rmSync(shim.dir, { recursive: true, force: true });
  }
});
