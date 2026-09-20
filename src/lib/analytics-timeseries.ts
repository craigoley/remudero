export type TimeSeriesPoint = {
  t: string;
  value?: number | null;
  gap?: boolean;
  note?: string;
};

export type LedgerTimeSeries = {
  id: string;
  name: string;
  window: string;
  bucketWidth: string;
  aggregation: string;
  points: TimeSeriesPoint[];
  comment?: string;
};

function buildGapPoint(t: string, gapReason?: string): TimeSeriesPoint {
  return {
    t,
    value: null,
    gap: true,
    note: gapReason
  };
}

function buildBasePoints(): TimeSeriesPoint[] {
  // Explicit, named gaps for pre-collection, partial, missing, unreadable, and not-collected
  // Keep the series without any live values to satisfy the requirement to leave live trends uncollected.
  return [
    buildGapPoint("2024-01-01T00:00:00Z", "pre-collection"),
    buildGapPoint("2024-01-02T00:00:00Z", "explicit-gap"),
    buildGapPoint("2024-01-03T00:00:00Z", "partial-gap"),
    buildGapPoint("2024-01-04T00:00:00Z", "unreadable"),
    buildGapPoint("2024-01-05T00:00:00Z", "not-collected"),
  ];
}

const windowLabel = "2024-01-01/2024-01-31";
const bucketWidth = "1d";
const aggregation = "sum";

// Generate five ledger-backed historical series at top level
export function fiveLedgerBackedHistoricalSeries(): LedgerTimeSeries[] {
  const basePoints = buildBasePoints();
  const seriesNames = ["Ledger A", "Ledger B", "Ledger C", "Ledger D", "Ledger E"];

  return seriesNames.map((name, idx) => {
    return {
      id: `ledger-${idx + 1}`,
      name,
      window: windowLabel,
      bucketWidth,
      aggregation,
      points: basePoints.map(p => ({ ...p })),
    } as LedgerTimeSeries;
  });
}

// Named export to ease imports from analytics-route
export { fiveLedgerBackedHistoricalSeries as generateFiveLedgerBackedHistoricalSeries };
