import type { Express, Request, Response } from 'express';
import type { ApiResponse, NoContentResponse, NotFoundResponse } from '@aller/express-swagger';
import type { Widget, CreateWidget, WidgetError } from './types.ts';

export function applyRoutes(app: Express): void {
  app.get(
    '/widgets',
    /**
     * JSDoc-tagged handler in .ts source — exercises type-name resolution
     * against TS interfaces registered as named schemas.
     * @param {Request<{}, Widget[]>} _req
     * @param {Response<Widget[]>} _res
     */
    (_req: Request<{}, Widget[]>, res: Response<Widget[]>) => {
      res.status(200).json([]);
    }
  );

  app.get(
    '/widgets/:id',
    /**
     * @param {Request<{ id: string }, Widget>} req
     * @param {Response<Widget>} _res
     * @throws {NotFoundResponse<WidgetError>}
     */
    (req: Request<{ id: string }, Widget>, res: Response<Widget>) => {
      res.status(200).json({ id: req.params.id, name: 'demo' });
    }
  );

  // No JSDoc — types come purely from the TS parameter annotations.
  app.post('/widgets', (req: Request<{}, Widget, CreateWidget>, res: ApiResponse<Widget, 201>) => {
    res.status(201).json({ id: 'w_1', name: req.body.name });
  });

  // Bare `NoContentResponse` on `res` — chain-walks to ApiResponse<void, 204>.
  app.delete('/widgets/:id', (req: Request<{ id: string }>, res: NoContentResponse) => {
    void req.params.id;
    res.status(204).end();
  });

  // `Request<P>` carries no ResBody slot — the response shape is read off the
  // `Response<Widget>` parameter annotation alone.
  app.get('/widgets/:id/summary', (req: Request<{ id: string }>, res: Response<Widget>) => {
    res.status(200).json({ id: req.params.id, name: 'summary' });
  });

  // `ApiResponse<Body, Status, MediaType>` on a TS-annotated res — exercises
  // the MediaType slot (3rd generic) being read off the parameter type.
  app.get('/widgets/landing', (_req: Request, res: ApiResponse<string, 200, 'text/html'>) => {
    res.status(200).type('html').send('<h1>widgets</h1>');
  });
}
