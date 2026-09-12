import { render, screen, within } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";

import type { StatusProjection, StatusSnapshot } from "@remudero/api-client/client";

import { App, STATUS_BAR_BUDGETS, statusBarBudgetFor } from "./App";
import type { FleetState } from "./useFleet";

const fleet = vi.hoisted<{ state: FleetState }>(() => ({
  state: {
    snapshot: null,
    projections: new Map(),
    changes: [],
    error: null,
  },
}));

vi.mock("./useFleet", () => ({
  useFleet: () => fleet.state,
}));

const generatedAt = "2026-09-12T10:00:00.000Z";

function projection(taskId: string, status: StatusProjection["status"], extra: Partial<StatusProjection> = {}): StatusProjection {
  return {
    taskId,
    status,
    merged: status === "merged" || status === "done",
    source: "ledger",
    ...extra,
  };
}

function setFleet(tasks: StatusProjection[], overrides: Partial<FleetState> = {}): void {
  const snapshot: StatusSnapshot = { generated_at: generatedAt, tasks };
  fleet.state = {
    snapshot,
    projections: new Map(tasks.map((p) => [p.taskId, p])),
    changes: [],
    error: null,
    ...overrides,
  };
}

function renderApp(): ReturnType<typeof render> {
  return render(<App client={{} as never} nowMs={() => Date.UTC(2026, 8, 12, 10, 0, 0)} />);
}

describe("the console status bar", () => {
  test("fits the measured laptop, tablet and phone budgets", () => {
    expect(STATUS_BAR_BUDGETS).toEqual([
      { name: "laptop", viewportWidth: 1440, viewportHeight: 900, maxHeight: 96 },
      { name: "tablet", viewportWidth: 834, viewportHeight: 1112, maxHeight: 112 },
      { name: "phone", viewportWidth: 390, viewportHeight: 844, maxHeight: 132 },
    ]);
    for (const budget of STATUS_BAR_BUDGETS) {
      expect(statusBarBudgetFor(budget.viewportWidth)).toBe(budget);
      expect(budget.maxHeight / budget.viewportHeight).toBeLessThanOrEqual(0.16);
    }
  });

  test("keeps the banner thin while the seven glance counters live in Overview", () => {
    setFleet([
      projection("W1-T1", "running"),
      projection("W1-T2", "blocked"),
      projection("W1-T3", "queued"),
      projection("W1-T4", "merged"),
    ]);
    renderApp();

    const banner = screen.getByRole("banner");
    expect(within(banner).getByRole("heading", { name: "Remudero" })).toBeDefined();
    expect(within(banner).queryByRole("region", { name: "Overview" })).toBeNull();
    expect(within(banner).queryByTestId("overview-counter-running")).toBeNull();

    const overview = screen.getByRole("region", { name: "Overview" });
    for (const key of ["running", "needs-me", "blocked", "queued", "merged-today", "spend-today", "spend-week"]) {
      const counter = within(overview).getByTestId(`overview-counter-${key}`);
      expect(within(counter).getByText(/source:/i)).toBeDefined();
    }
  });

  test("pins the anomaly banner only when attention is needed", () => {
    setFleet([projection("W1-T1", "blocked"), projection("W1-T2", "queued")]);
    const first = renderApp();
    const banner = screen.getByRole("banner");
    expect(within(banner).getByRole("alert").textContent).toContain("1 item needs operator attention");
    first.unmount();

    setFleet([projection("W1-T3", "running"), projection("W1-T4", "queued")]);
    renderApp();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  test("keeps write state beside the controls it explains", () => {
    setFleet([projection("W1-T1", "running")]);
    renderApp();

    const controls = screen.getByRole("group", { name: "Fleet controls" });
    const badge = within(controls).getByTestId("write-state-badge");
    expect(badge.textContent).toContain("Write actions use the configured token");
    for (const label of ["Pause", "Resume", "STOP"]) {
      expect(within(controls).getByRole("button", { name: label })).toBeDefined();
    }
  });
});

describe("the work rows", () => {
  test.each([
    ["laptop", 1440],
    ["tablet", 834],
  ])("put the first actionable row above the fold at %s width", (_name, width) => {
    setFleet([
      projection("W1-T9", "queued"),
      projection("W1-T1", "blocked"),
      projection("W1-T2", "running"),
    ]);
    renderApp();

    const row = screen.getByTestId("work-row-W1-T1");
    expect(row.getAttribute("data-first-actionable")).toBe("true");
    expect(Number(row.getAttribute("data-before-scroll-y"))).toBeLessThan(statusBarBudgetFor(width).viewportHeight);
  });
});
