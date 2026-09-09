import { apiReference } from '@scalar/express-api-reference';

import { buildDocument } from './index.js';

/**
 * Mount the Scalar API Reference UI at `/docs`. Kept out of `index.js` (and
 * excluded from `tsconfig.json`) so the swagger build's TypeScript program
 * doesn't pull in Scalar's declaration tree — it isn't needed to document the
 * routes, and it triples the number of files the compiler has to parse.
 *
 * @param {import('express').Express} app
 */
export function mountDocs(app) {
  /** @type {import('express').RequestHandler} */
  const docsHandler = (req, res, next) =>
    buildDocument(app)
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
