#!/usr/bin/env node
// Custom dts-buddy invocation. The default CLI infers the entry from
// `package.json#exports.import` (./src/index.js), which means dts-buddy bundles
// our JSDoc `@typedef` redirects in src/index.js alongside the underlying
// interfaces in types/types.d.ts — two declarations with the same name, so the
// interfaces get renamed to `Foo_1`. Pointing the bundler at a hand-written
// entry .d.ts that re-exports types via `export * from './types.js'` keeps
// each name single-declared and the bundled output free of `_1` suffixes.

import { createBundle } from 'dts-buddy';

await createBundle({
  output: 'types/index.d.ts',
  modules: {
    '@aller/express-swagger': 'types/bundle.d.ts',
  },
});
