/**
 * Read-only inventory of repositories visible to the daemon's CURRENT GitHub token. This is an
 * onboarding candidate list, not an assertion that a repository passed readiness or is managed.
 * The installation endpoint is authoritative for a Fleet App token; /user/repos is used only when
 * the daemon is on a user-token fallback. GitHub pagination is followed by gh, then checked against
 * total_count for installation tokens so a partial response never masquerades as the full set.
 */
import type { Route } from "./service.js";
import { systemClock, type Clock } from "./clock.js";
import { ghTextAsync } from "./github-transport.js";
import { parseInstallationRepositoryListing, parseUserRepositoryListing } from "./onboarding-repository-listing.js";
import { sendJson } from "./panel-actions.js";

export const ONBOARDING_INVENTORY_CACHE_MS = 60_000;

export type OnboardingRepositoryInventory = {
  state: "verified";
  source: "fleet-app-installation" | "daemon-user-token";
  observed_at: string;
  repositories: string[];
  total_count: number;
};

export type OnboardingInventoryResult = OnboardingRepositoryInventory | {
  state: "unavailable";
  reason: "github_read_failed" | "incomplete_or_invalid_listing";
};

export type OnboardingInventoryRead = (args: string[]) => Promise<string>;
export type OnboardingInventoryRouteOptions = { read?: OnboardingInventoryRead; clock?: Clock };

const defaultRead: OnboardingInventoryRead = (args) => ghTextAsync(args, { maxBuffer: 2 * 1024 * 1024, timeout: 15_000 });

export async function readOnboardingRepositoryInventory(
  read: OnboardingInventoryRead = defaultRead,
  clock: Clock = systemClock,
): Promise<OnboardingInventoryResult> {
  try {
    const raw = await read(["api", "installation/repositories?per_page=100", "--paginate", "--jq", ".total_count, .repositories[].full_name"]);
    const repositories = parseInstallationRepositoryListing(raw);
    return repositories
      ? { state: "verified", source: "fleet-app-installation", observed_at: clock.iso(), repositories, total_count: repositories.length }
      : { state: "unavailable", reason: "incomplete_or_invalid_listing" };
  } catch {
    // A user/PAT fallback cannot call the installation endpoint. It is still a useful candidate
    // inventory, but the console must not label it Fleet App verified or allow activation from it.
  }
  try {
    const raw = await read(["api", "user/repos?affiliation=owner,collaborator,organization_member&per_page=100", "--paginate", "--jq", ".[].full_name"]);
    const repositories = parseUserRepositoryListing(raw);
    return repositories
      ? { state: "verified", source: "daemon-user-token", observed_at: clock.iso(), repositories, total_count: repositories.length }
      : { state: "unavailable", reason: "incomplete_or_invalid_listing" };
  } catch {
    return { state: "unavailable", reason: "github_read_failed" };
  }
}

/** A bounded warm result avoids a GitHub round-trip on every console visit. Failures are NOT cached. */
export function buildOnboardingRepositoryInventoryRoute(deps: OnboardingInventoryRouteOptions = {}): Route {
  const clock = deps.clock ?? systemClock;
  let cached: { atMs: number; result: OnboardingRepositoryInventory } | undefined;
  let inflight: Promise<OnboardingInventoryResult> | undefined;
  return {
    method: "GET",
    path: "/v1/onboarding/repositories",
    scope: "read",
    handler: async (_req, res) => {
      const nowMs = clock.now();
      if (cached && nowMs - cached.atMs < ONBOARDING_INVENTORY_CACHE_MS) {
        sendJson(res, 200, cached.result);
        return;
      }
      const request = inflight ?? readOnboardingRepositoryInventory(deps.read, clock);
      inflight = request;
      let result: OnboardingInventoryResult;
      try {
        result = await request;
      } finally {
        if (inflight === request) inflight = undefined;
      }
      if (result.state === "verified") cached = { atMs: clock.now(), result };
      sendJson(res, result.state === "verified" ? 200 : 503, result);
    },
  };
}
