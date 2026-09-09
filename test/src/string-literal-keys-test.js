import ts from 'typescript';

import { collectStringLiteralKeys } from '../../src/index.js';

describe('collectStringLiteralKeys', () => {
  /**
   * Parse `type T = Omit<Base, <keys>>` and return the second type argument
   * node, as the heritage walker hands it to `collectStringLiteralKeys`.
   *
   * @param {string} keys
   * @returns {any}
   */
  function keysNodeOf(keys) {
    const source = ts.createSourceFile('t.ts', `type T = Omit<Base, ${keys}>;`, ts.ScriptTarget.Latest, true);
    const alias = /** @type {any} */ (source.statements[0]);
    return alias.type.typeArguments[1];
  }

  it('collects a lone string literal key', () => {
    expect(collectStringLiteralKeys(keysNodeOf("'identity'"), ts)).to.deep.equal(new Set(['identity']));
  });

  it('collects every member of a string-literal union', () => {
    expect(collectStringLiteralKeys(keysNodeOf("'id' | 'active'"), ts)).to.deep.equal(new Set(['id', 'active']));
  });

  it('returns null for an aliased key type (not resolvable from the node alone)', () => {
    expect(collectStringLiteralKeys(keysNodeOf('SessionKeys'), ts)).to.equal(null);
  });

  it('returns null when any union member is not a string literal', () => {
    expect(collectStringLiteralKeys(keysNodeOf("'id' | keyof Other"), ts)).to.equal(null);
  });

  it('returns null when there is no key argument', () => {
    expect(collectStringLiteralKeys(null, ts)).to.equal(null);
  });
});
