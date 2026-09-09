import { exampleDocument } from '../helpers/example-document.js';
import { follow } from '../helpers/schema.js';

Feature('Schemas derived via Omit/Pick/Partial over an index-signature base', () => {
  Scenario('an interface that Omits a key from an open-record base keeps its named members', () => {
    /** @type {Record<string, any>} */
    let doc;

    Given('the document built from the fixture app', async () => {
      doc = await exampleDocument();
    });

    Then('IdentitySession expands to every AccountSession member except the omitted `identity`', () => {
      const schema = doc.components.schemas.IdentitySession;
      expect(schema, 'IdentitySession schema').to.be.an('object');
      expect(schema.type).to.equal('object');
      expect(schema.properties).to.have.all.keys('id', 'active', 'devices');
      expect(schema.properties).to.not.have.property('identity');
    });

    And('only the non-optional members are required', () => {
      const schema = doc.components.schemas.IdentitySession;
      expect(schema.required ?? []).to.have.members(['id']);
      expect(schema.required ?? []).to.not.include('active');
    });

    And("the base's open-record index signature is honored as additionalProperties: true", () => {
      expect(doc.components.schemas.IdentitySession.additionalProperties).to.equal(true);
    });

    And('the retained `devices` property still $refs SessionDevice', () => {
      const devices = doc.components.schemas.IdentitySession.properties.devices;
      expect(devices).to.deep.equal({
        type: 'array',
        items: { $ref: '#/components/schemas/SessionDevice' },
        description: 'Sessions the account has open across devices.',
      });
      expect(doc.components.schemas).to.have.property('SessionDevice');
    });

    And('Pick over the same base keeps only the picked keys (closed, per TS semantics)', () => {
      const schema = doc.components.schemas.SessionSummary;
      expect(schema.properties).to.have.all.keys('id', 'active');
      expect(schema.required ?? []).to.have.members(['id']);
      // `Pick<T, 'id' | 'active'>` maps over an explicit literal-key union, so
      // it does NOT inherit T's index signature — the result is a closed object.
      expect(schema.additionalProperties).to.equal(false);
    });

    And('Partial over the same base keeps every key and makes them all optional', () => {
      const schema = doc.components.schemas.PartialSession;
      expect(schema.properties).to.have.all.keys('id', 'active', 'devices', 'identity');
      expect(schema.required ?? []).to.deep.equal([]);
      expect(schema.additionalProperties).to.equal(true);
    });

    And('a derived interface adds its own properties on top of the Omit', () => {
      const schema = doc.components.schemas.AnnotatedSession;
      expect(schema.properties).to.have.all.keys('id', 'active', 'devices', 'note');
      expect(schema.properties).to.not.have.property('identity');
      expect(schema.properties.note).to.include({ type: 'string', description: 'Operator-supplied annotation for this session.' });
      expect(schema.required ?? []).to.have.members(['id', 'note']);
    });

    And('Omit over a plain (no index signature) base still works and stays closed', () => {
      const schema = doc.components.schemas.PlainOmit;
      expect(schema.properties).to.have.all.keys('a', 'c');
      expect(schema.properties).to.not.have.property('b');
      expect(schema.required ?? []).to.have.members(['a']);
      expect(schema.additionalProperties).to.equal(false);
    });

    And('a route returning an array of the derived type resolves through the $ref', () => {
      const op = doc.paths['/sessions'].get;
      const responseSchema = op.responses['200'].content['application/json'].schema;
      const resolved = follow(doc, responseSchema);
      const sessions = follow(doc, resolved.properties.sessions);
      expect(sessions.type).to.equal('array');
      expect(sessions.items).to.deep.equal({ $ref: '#/components/schemas/IdentitySession' });
    });
  });
});
