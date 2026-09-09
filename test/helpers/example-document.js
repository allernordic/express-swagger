import { buildDocument, setupApp } from '../../example/index.js';

/** @type {Promise<Record<string, any>> | undefined} */
let cached;

/**
 * The OpenAPI document built from the JS fixture app, built once per mocha
 * process and shared by every spec that only reads it. Specs that exercise
 * the on-demand route or the docs UI still go through the app.
 *
 * @returns {Promise<Record<string, any>>}
 */
export function exampleDocument() {
  cached ??= buildDocument(setupApp());
  return cached;
}
