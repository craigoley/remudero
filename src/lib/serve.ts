import express from 'express';
import { adaptLiveAnalyticsMetrics } from './analytics-route';

const app = express();

app.get('/v1/analytics/live', (req, res) => {
  // In a real system this would pull from process-owned metrics; here we emit a placeholder
  const raw = {
    queue: { pending: 0 },
    provider: { remaining: 0 }
  };
  const metrics = adaptLiveAnalyticsMetrics(raw);
  res.json(metrics);
});

export default app;
