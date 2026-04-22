import { Router } from 'express';
import multer from 'multer';
import pkg from '../package.json' with { type: 'json' };

/**
 * @typedef {object} GetVersionResponse
 * @property {string} version The currently installed package version.
 */

/**
 * @typedef {object} GetStatusResponse
 * @property {boolean} ok Whether the service is healthy.
 */

/**
 * Identity wrapper used to exercise the library's handler-unwrapping — when
 * the registration passes a call expression whose inner argument is the
 * actual handler.
 *
 * @template {(...args: any[]) => any} H
 * @param {H} fn
 * @returns {H}
 */
const wrap = (fn) => fn;

/**
 * Multer middleware
 */
export function multerMiddleware() {
  const basePath = '{*splat}';

  const router = Router({ mergeParams: true });

  let initialized = false;

  router.use((_req, _res, next) => {
    if (initialized) return next();
    initialized = true;
    next();
  });
  router.get(
    basePath + '/version',
    /**
     * Return the current package version.
     * @param {import('express').Request} _req
     * @param {import('express').Response<GetVersionResponse>} res
     */
    (_req, res) => res.send({ version: pkg.version })
  );
  router.post(
    basePath + '/deployment/create',
    multer().any(),
    /** @private */
    (_req, res) => res.send({})
  );

  // Template-literal path + handler wrapped in a call — exercises
  // `resolveStaticString`'s TemplateExpression branch and the
  // `findHandlerFunction` call-expression unwrap.
  router.get(
    `${basePath}/status`,
    wrap(
      /**
       * Returns service health status.
       * @param {import('express').Request} _req
       * @param {import('express').Response<GetStatusResponse>} res
       */
      (_req, res) => res.send({ ok: true })
    )
  );

  return router;
}
