import express from 'express';
import type { Express } from 'express';

import { applyRoutes } from './routes.ts';

export function setupApp(): Express {
  const app = express();
  app.use(express.json());
  applyRoutes(app);
  return app;
}
