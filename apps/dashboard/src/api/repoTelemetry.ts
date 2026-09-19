import type { RepoTelemetry } from "../types/repo";

/**
 * Placeholder API paths for the repo surface. The current daemon exposes no repo telemetry
 * routes, so consumers must keep `unavailable` visible until those routes land in the generated
 * api-client and server contract.
 */
const API_VERSION = "/v1";
const repoEndpoint = (...segments: string[]) => [API_VERSION, "repos", ...segments].join("/");
const githubOAuthEndpoint = [API_VERSION, "auth", "github"].join("/");

export const REPO_API_ENDPOINTS = {
  repos: repoEndpoint(),
  telemetry: repoEndpoint(":id", "telemetry"),
  settings: repoEndpoint(":id", "settings"),
  logs: repoEndpoint(":id", "logs"),
  dryRun: repoEndpoint(":id", "test-run"),
  githubOAuth: githubOAuthEndpoint,
} as const;

export interface RepoTelemetryResponse {
  readonly status: "ok" | "unavailable";
  readonly endpoint: string;
  readonly telemetry: RepoTelemetry | null;
  readonly reason?: string;
}

export interface RepoTelemetryClient {
  getRepoTelemetry(repoId: string): Promise<RepoTelemetryResponse>;
}

export const placeholderRepoTelemetryClient: RepoTelemetryClient = {
  async getRepoTelemetry(): Promise<RepoTelemetryResponse> {
    return {
      status: "unavailable",
      endpoint: REPO_API_ENDPOINTS.telemetry,
      telemetry: null,
      reason: "The daemon repo telemetry contract is not available yet.",
    };
  },
};
