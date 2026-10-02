import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { systemClock, type Clock } from "./clock.js";

const text = (value: unknown, limit = 160) => typeof value === "string" ? value.slice(0, limit) : undefined;
const count = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : undefined;
export function readRoutingDailyStatus(stateDir: string | undefined, clock: Clock = systemClock) {
  const unavailable = (reason: string) => ({ version: "routing-daily-v1", state: "unavailable", asOf: null, alerts: [reason], sources: [] });
  if (!stateDir) return unavailable("daily-review-not-configured");
  try {
    const path = join(stateDir, "field-trials", "routing-daily", "latest.json");
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > 256 * 1024) return unavailable("daily-review-size-or-type-invalid");
    const report = JSON.parse(readFileSync(path, "utf8"));
    if (!report || typeof report !== "object") return unavailable("daily-review-metadata-invalid");
    const asOf = Date.parse(report.asOf), next = Date.parse(report.nextScheduledReviewAt);
    if (report.version !== "routing-daily-review-v1" || !Number.isFinite(asOf) || !Number.isFinite(next) ||
      next <= asOf || next > asOf + 26 * 3_600_000 || !["observed", "observed-partial"].includes(report.state) ||
      !Array.isArray(report.sources) || report.sources.length < 1 || report.sources.length > 3 ||
      !report.sources.every((source: { label?: unknown; reasons?: unknown } | null) => source && typeof source.label === "string" && /^[a-z][a-z0-9_-]{0,39}$/.test(source.label) && Array.isArray(source.reasons)))
      return unavailable("daily-review-metadata-invalid");
    const ageMs = clock.now() - asOf;
    if (ageMs < -5 * 60_000) return unavailable("daily-review-timestamp-future");
    const stale = ageMs > 30 * 3_600_000 || clock.now() > next + 2 * 3_600_000;
    return { version: "routing-daily-v1", state: stale ? "stale" : "fresh", asOf: report.asOf,
      nextScheduledReviewAt: report.nextScheduledReviewAt, ageHours: Math.max(0, ageMs / 3_600_000),
      reviewState: report.state, comparativeClaims: "none", alerts: [...(stale ? ["daily-review-overdue"] : []), ...(report.state === "observed-partial" ? ["daily-review-source-incomplete"] : [])],
      sources: report.sources.map((source: Record<string, unknown>) => ({ label: source.label, state: text(source.state),
        reasons: (source.reasons as unknown[]).map(reason => text(reason)).filter(Boolean).slice(0, 10),
        futureRows: count(source.futureRows), malformedRows: count(source.malformedRows),
        reports: Array.isArray(source.reports) ? source.reports.slice(0, 20).flatMap((item: Record<string, unknown> | null) => item && text(item.id) ? [{
          id: text(item.id), reviewState: text(item.reviewState), nextAction: text(item.nextAction), minTasksPerArm: count(item.minTasksPerArm),
          assignments: count(item.assignments), crossoverTasks: count(item.crossoverTasks),
          arms: Array.isArray(item.arms) ? item.arms.slice(0, 10).flatMap((arm: Record<string, unknown> | null) => arm && text(arm.arm) ? [{ arm: text(arm.arm), tasks: count(arm.tasks), merged: count(arm.merged), costMissingAssignments: count(arm.costMissingAssignments) }] : []) : [],
        }] : []) : [] })) };
  } catch (error) {
    const reason = (error as NodeJS.ErrnoException).code === "ENOENT" ? "daily-review-missing" : error instanceof SyntaxError ? "daily-review-json-invalid" : "daily-review-unreadable";
    return unavailable(reason);
  }
}
