import type { RepoTelemetry } from "../types/repo";

/**
 * Placeholder API paths for the repo surface. The current daemon exposes no repo telemetry
 * routes, so consumers must keep `unavailable` visible until those routes land in the generated
 * api-client and server contract.
 */
export const REPO_API_ENDPOINTS = {
  repos: "/v1/repos",
  telemetry: "/v1/repos/:id/telemetry",
  settings: "/v1/repos/:id/settings",
  logs: "/v1/repos/:id/logs",
  dryRun: "/v1/repos/:id/test-run",
  githubOAuth: "/v1/auth/github",
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
