/** @typedef {import('./types/types.js').ValidationErrorBody} ValidationErrorBody */

export class BadRequestError extends Error {
  /**
   * @param {ValidationErrorBody} body
   */
  constructor(body) {
    super('Bad request');
    /** @type {ValidationErrorBody} */
    this.body = body;
    /** @type {400} */
    this.statusCode = 400;
  }
}
