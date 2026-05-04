// dts-buddy bundle entry. Re-exports the runtime function from src/index.js
// plus every type from types/types.d.ts so the bundled types/index.d.ts
// ships each name once under its canonical form.

export { buildSwaggerDocument } from '../src/index.js';
export * from './types.js';
