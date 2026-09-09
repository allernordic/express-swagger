import request from 'supertest';

import { mountDocs } from '../../example/docs.js';
import { setupApp } from '../../example/index.js';

Feature('Swagger UI mounted on the example app', () => {
  Scenario('GET /docs/ serves a Swagger UI HTML page', () => {
    /** @type {import('express').Express} */
    let app;
    /** @type {import('supertest').Response} */
    let response;

    Given('the fixture app is set up with the docs UI mounted', () => {
      app = mountDocs(setupApp());
    });

    When('a client GETs /docs/', async () => {
      response = await request(app).get('/docs/');
    });

    Then('the response is served with a 200 status', () => {
      expect(response.status).to.equal(200);
    });

    And('the response is HTML', () => {
      expect(response.headers['content-type']).to.match(/text\/html/);
    });

    And('the body references the Scalar API Reference bundle', () => {
      expect(response.text).to.match(/scalar/i);
    });
  });
});
