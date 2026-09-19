import { adaptLiveAnalyticsMetrics } from '../src/lib/analytics-route';

describe('adaptLiveAnalyticsMetrics', () => {
  it('returns zero metrics when raw is empty', () => {
    const metrics = adaptLiveAnalyticsMetrics({});
    expect(metrics).toBeDefined();
    expect(metrics.queuePending).toBe(0);
    expect(metrics.providerRemaining).toBe(0);
  });
});
