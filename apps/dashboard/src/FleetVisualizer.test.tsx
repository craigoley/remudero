import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, test } from "vitest";

import type { StatusProjection } from "@remudero/api-client/client";

import { FleetVisualizer, fleetNodes, fleetWorkers, formatDuration } from "./FleetVisualizer";

function projection(taskId: string, status: StatusProjection["status"], extra: Partial<StatusProjection> = {}): StatusProjection {
  return { taskId, status, merged: status === "merged" || status === "done", source: "ledger", ...extra };
}

describe("fleet worker projection", () => {
  test("keeps the map task-backed and excludes queued, merged, and done rows", () => {
    const workers = fleetWorkers(new Map([
      ["W1-T1", projection("W1-T1", "running", { phase: "implement", elapsedMs: 91_000 })],
      ["W1-T2", projection("W1-T2", "blocked", { needsHuman: true })],
      ["W1-T3", projection("W1-T3", "queued")],
      ["W1-T4", projection("W1-T4", "merged")],
    ]));

    expect(workers.map((worker) => worker.projection.taskId)).toEqual(["W1-T2", "W1-T1"]);
    expect(workers[0]?.kind).toBe("attention");
    expect(workers[1]?.detail).toBe("implement phase");
  });

  test("places nodes deterministically and switches to compact identity for dense fleets", () => {
    const workers = Array.from({ length: 13 }, (_, i) => ({
      projection: projection(`W1-T${i + 1}`, "running", { phase: "recon" }),
      kind: "active" as const,
      label: "working",
      detail: "recon phase",
    }));
    const first = fleetNodes(workers);
    const second = fleetNodes(workers);

    expect(first.map(({ x, y }) => [x, y])).toEqual(second.map(({ x, y }) => [x, y]));
    expect(first.every((node) => node.compact)).toBe(true);
    expect(new Set(first.map(({ x, y }) => `${x}:${y}`)).size).toBe(13);
  });

  test.each([
    [undefined, "age unknown"],
    [0, "0s"],
    [61_000, "1m 1s"],
    [3_661_000, "1h 1m"],
  ])("formats %s as %s", (milliseconds, expected) => {
    expect(formatDuration(milliseconds)).toBe(expected);
  });
});

describe("fleet visualizer", () => {
  test("renders the selected worker detail and a keyboard-friendly worker index", () => {
    const projections = new Map([
      ["W1-T7", projection("W1-T7", "running", { phase: "implement", workerState: "tool-executing", elapsedMs: 125_000, liveTurns: 8, liveSpendUsd: 1.25 })],
      ["W1-T8", projection("W1-T8", "blocked", { needsHuman: true })],
      ["W1-T9", projection("W1-T9", "queued")],
    ]);
    render(<FleetVisualizer projections={projections} generatedAt="2026-09-20T14:00:00.000Z" />);

    expect(screen.getByRole("heading", { name: "Fleet visualizer" })).toBeDefined();
    expect(screen.getByRole("img", { name: /Current Remudero worker topology/ })).toBeDefined();
    expect(screen.getByTestId("fleet-detail").textContent).toContain("W1-T8");
    expect(screen.getByText("1 queued outside map")).toBeDefined();

    const workerButton = screen.getAllByRole("button", { name: /W1-T7/ }).at(-1);
    if (workerButton === undefined) throw new Error("worker index button was not rendered");
    fireEvent.click(workerButton);
    const detail = screen.getByTestId("fleet-detail");
    expect(detail.textContent).toContain("tool-executing");
    expect(detail.textContent).toContain("$1.25");
    expect(within(screen.getByTestId("fleet-visualizer")).getByText("Worker index")).toBeDefined();
  });

  test("renders an honest quiet-fleet state when no live signal is observable", () => {
    render(<FleetVisualizer projections={new Map([["W1-T1", projection("W1-T1", "queued")]])} generatedAt={null} />);

    expect(screen.getByRole("status").textContent).toContain("Quiet fleet");
    expect(screen.getByText(/stream-only/)).toBeDefined();
  });
});
