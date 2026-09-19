import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";

import { placeholderRepoTelemetryClient, REPO_API_ENDPOINTS } from "../api/repoTelemetry";
import { RepoCard } from "../components/RepoCard";
import { OnboardingPage } from "../pages/OnboardingPage";
import { createRepoStore, reduceRepoStore, selectRepos } from "../store/repos";
import { makeRepo } from "../types/repo";

const healthy = makeRepo({ id: "healthy", reponame: "acme/healthy", repourl: "https://github.com/acme/healthy", active: true });
const broken = makeRepo({
  id: "broken",
  reponame: "acme/broken",
  repourl: "https://github.com/acme/broken",
  health: {
    ...healthy.health,
    status: "error",
    queuedtasks: 4,
    alerts: [{ id: "alert-1", severity: "error", message: "Last run failed", created_at: "2026-09-19T00:00:00.000Z" }],
  },
});

afterEach(() => {
  window.history.pushState({}, "", "/console/");
});

describe("repo state", () => {
  test("lists, filters, selects, and updates repo records without mutating the prior state", () => {
    const initial = createRepoStore([healthy, broken]).getState();
    const filtered = reduceRepoStore(initial, { type: "filter", filter: "error", search: "broken" });
    const selected = reduceRepoStore(filtered, { type: "select", repoId: "broken" });
    const updated = reduceRepoStore(selected, { type: "update", repoId: "broken", patch: { active: true, settings: { workerpoolsize: 4 } } });

    expect(selectRepos(initial).map((repo) => repo.id)).toEqual(["broken", "healthy"]);
    expect(selectRepos(updated).map((repo) => repo.id)).toEqual(["broken"]);
    expect(updated.selectedRepoId).toBe("broken");
    expect(updated.repos.find((repo) => repo.id === "broken")?.active).toBe(true);
    expect(updated.repos.find((repo) => repo.id === "broken")?.settings.workerpoolsize).toBe(4);
    expect(initial.repos.find((repo) => repo.id === "broken")?.active).toBe(false);
  });

  test("uses explicit nulls for telemetry that the placeholder endpoint cannot provide", async () => {
    const result = await placeholderRepoTelemetryClient.getRepoTelemetry("healthy");
    expect(result).toEqual({
      status: "unavailable",
      endpoint: REPO_API_ENDPOINTS.telemetry,
      telemetry: null,
      reason: "The daemon repo telemetry contract is not available yet.",
    });
  });
});

describe("repo card and onboarding", () => {
  test("surfaces health, alerts, and quick actions on a repo card", () => {
    const actions: string[] = [];
    render(<RepoCard repo={broken} onSelect={() => actions.push("select")} onToggle={() => actions.push("toggle")} onAction={(_, action) => actions.push(action)} />);
    expect(screen.getByRole("status").textContent).toContain("Error");
    expect(screen.getByText("Last run failed")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "acme/broken" }));
    fireEvent.click(screen.getByRole("button", { name: "Turn on" }));
    fireEvent.click(screen.getByRole("button", { name: "Test run" }));
    expect(actions).toEqual(["select", "toggle", "test_run"]);
  });

  test("validates the six-step onboarding flow and creates a local active repo at confirmation", () => {
    render(<OnboardingPage />);
    fireEvent.click(screen.getByRole("button", { name: /continue/i }));
    expect(screen.getByRole("alert").textContent).toContain("Connect GitHub");
    fireEvent.click(screen.getByRole("button", { name: /connect github/i }));
    fireEvent.click(screen.getByRole("button", { name: /continue/i }));
    fireEvent.change(screen.getByLabelText("Repository name"), { target: { value: "acme/new-repo" } });
    fireEvent.change(screen.getByLabelText("Repository URL"), { target: { value: "https://github.com/acme/new-repo" } });
    fireEvent.click(screen.getByLabelText(/select this repository/i));
    fireEvent.click(screen.getByRole("button", { name: /continue/i }));
    fireEvent.click(screen.getByRole("button", { name: /continue/i }));
    fireEvent.click(screen.getByRole("button", { name: /continue/i }));
    fireEvent.click(screen.getByRole("button", { name: /run dry-run/i }));
    fireEvent.click(screen.getByRole("button", { name: /continue/i }));
    fireEvent.click(screen.getByRole("button", { name: /confirm and go live/i }));
    expect(window.location.pathname).toBe("/console/repos/acme-new-repo");
  });
});
