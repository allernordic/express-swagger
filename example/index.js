import express from 'express';
import { fileURLToPath } from 'node:url';

import { buildSwaggerDocument } from '@aller/express-swagger';
import { applyRoutes } from './routes.js';
import { multerMiddleware } from './middleware/multer.js';

const TSCONFIG_PATH = new URL('./tsconfig.json', import.meta.url);
const PUBLIC_DIR = fileURLToPath(new URL('./public/', import.meta.url));

const SECURITY_SCHEMES = {
  bearer: { type: 'http', scheme: 'bearer' },
};

/**
 * Build the OpenAPI document for this app with the fixture's tsconfig and
 * security schemes.
 *
 * @param {import('express').Express} app
 */
export function buildDocument(app) {
  return buildSwaggerDocument(app, { tsconfig: TSCONFIG_PATH, security: SECURITY_SCHEMES });
}

export function setupApp() {
  const app = express();
  app.use(express.json());

  app.use(express.static(PUBLIC_DIR));

  applyRoutes(app);
  app.use('/multer', multerMiddleware());

  app.get('/swagger/live', async (_req, res) => {
    res.json(await buildDocument(app));
  });

  return app;
}
