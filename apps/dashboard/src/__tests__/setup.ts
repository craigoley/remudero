// Vitest setup for the dashboard suite.
//
// TWO THINGS jsdom + `globals: false` make our responsibility.
//
// 1. CLEANUP IS NOT AUTOMATIC HERE. @testing-library/react registers its own `afterEach(cleanup)`
//    only when a GLOBAL afterEach exists, and this config sets `globals: false` deliberately (an
//    implicit global test API is how a suite ends up depending on ambient state). Without this,
//    every render accumulates in document.body and a later `getByTestId` fails with "found multiple
//    elements" — a failure that reads like a component bug and is not one.
// 2. RESIZEOBSERVER DOES NOT EXIST in jsdom. Recharts measures its container, so a
//    ResponsiveContainer would render nothing and an assertion on the plot would pass or fail for
//    the wrong reason — which is why the components under test take explicit width/height and this
//    only supplies the missing global.
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

afterEach(cleanup);

class NoopResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver ??= NoopResizeObserver;
