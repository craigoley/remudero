import computeLiveMetrics, { LiveMetrics } from './analytics-live-metrics';

export function adaptLiveAnalyticsMetrics(raw: any): LiveMetrics {
  const state = {
    queue: raw?.queue ?? {},
    provider: raw?.provider ?? {},
    asOf: raw?.asOf
  };
  return computeLiveMetrics(state as any);
}

export default adaptLiveAnalyticsMetrics;
