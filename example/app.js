/* eslint-disable no-console */
import { pathToFileURL } from 'node:url';

import { setupApp } from './index.js';

export const app = setupApp();

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const server = app.listen(process.env.PORT ?? 3000, () => {
    // @ts-ignore
    console.info(`Started server on port ${server.address().port}`);
  });
}
