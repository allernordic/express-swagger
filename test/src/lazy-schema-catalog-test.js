import { createLazySchemaCatalog } from '../../src/index.js';

describe('createLazySchemaCatalog', () => {
  /**
   * @param {Array<{ name: string, node: any }>} declarations
   * @returns {{ catalog: Record<string, any>, converted: string[] }}
   */
  function build(declarations) {
    /** @type {string[]} */
    const converted = [];
    const catalog = createLazySchemaCatalog(declarations, (node) => {
      converted.push(node.id);
      return { from: node.id };
    });
    return { catalog, converted };
  }

  it('does not convert anything at construction time', () => {
    const { converted } = build([{ name: 'A', node: { id: 'a' } }]);
    expect(converted).to.deep.equal([]);
  });

  it('converts a declaration on first read and returns the converted schema', () => {
    const { catalog, converted } = build([{ name: 'A', node: { id: 'a' } }]);
    expect(catalog.A).to.deep.equal({ from: 'a' });
    expect(converted).to.deep.equal(['a']);
  });

  it('memoizes: repeated reads convert once and return a stable reference', () => {
    const { catalog, converted } = build([{ name: 'A', node: { id: 'a' } }]);
    const first = catalog.A;
    const second = catalog.A;
    expect(second).to.equal(first);
    expect(converted).to.deep.equal(['a']);
  });

  it('never converts a name that is not read', () => {
    const { catalog, converted } = build([
      { name: 'Used', node: { id: 'used' } },
      { name: 'Unused', node: { id: 'unused' } },
    ]);
    void catalog.Used;
    expect(converted).to.deep.equal(['used']);
  });

  it('is non-enumerable: spreading the catalog forces no conversion', () => {
    const { catalog, converted } = build([{ name: 'Heavy', node: { id: 'heavy' } }]);
    expect({ ...catalog }).to.deep.equal({});
    expect(converted).to.deep.equal([]);
    // ...but the entry is still readable by explicit key.
    expect(catalog.Heavy).to.deep.equal({ from: 'heavy' });
    expect(converted).to.deep.equal(['heavy']);
  });
});
