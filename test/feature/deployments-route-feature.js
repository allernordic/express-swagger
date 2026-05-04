import request from 'supertest';

import { setupApp } from '../../example/index.js';

Feature('POST /deployments multipart route', () => {
  Scenario('multer parses the multipart body and the handler echoes the `name` field', () => {
    /** @type {import('express').Express} */
    let app;
    /** @type {import('supertest').Response} */
    let response;

    Given('the fixture app is set up', () => {
      app = setupApp();
    });

    When('a client POSTs multipart/form-data with `name` and a binary `file` field', async () => {
      response = await request(app)
        .post('/deployments')
        .field('name', 'first-deploy')
        .attach('file', Buffer.from('PK\x03\x04 fake bpmn payload'), 'process.bpmn');
    });

    Then('the response status is 201', () => {
      expect(response.status).to.equal(201);
    });

    And('the response body echoes back the `name` from the multipart form', () => {
      expect(response.body).to.deep.equal({ name: 'first-deploy' });
    });
  });
});
