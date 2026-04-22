import express from 'express';
import { fileURLToPath } from 'node:url';
import { apiReference } from '@scalar/express-api-reference';

import { buildSwaggerDocument } from '@aller/express-swagger';
import { applyRoutes } from './routes.js';
import { multerMiddleware } from './middleware/multer.js';

const TSCONFIG_PATH = new URL('./tsconfig.json', import.meta.url);
const PUBLIC_DIR = fileURLToPath(new URL('./public/', import.meta.url));

const SECURITY_SCHEMES = {
  bearer: { type: 'http', scheme: 'bearer' },
};

export function setupApp() {
  const app = express();
  app.use(express.json());

  app.use(express.static(PUBLIC_DIR));

  applyRoutes(app);
  app.use('/multer', multerMiddleware());

  app.get('/swagger/live', async (_req, res) => {
    const doc = await buildSwaggerDocument(app, { tsconfig: TSCONFIG_PATH, security: SECURITY_SCHEMES });
    res.json(doc);
  });

  /** @type {import('express').RequestHandler} */
  const docsHandler = (req, res, next) =>
    buildSwaggerDocument(app, { tsconfig: TSCONFIG_PATH, security: SECURITY_SCHEMES })
      .then((doc) =>
        /** @type {import('express').RequestHandler} */ (
          apiReference({
            content: doc,
            layout: 'classic',
            // Disable Scalar's Ask Agent (AI) button.
            mcp: { disabled: true },
          })
        )(req, res, next)
      )
      .catch(next);
  app.use('/docs', docsHandler);

  return app;
}
