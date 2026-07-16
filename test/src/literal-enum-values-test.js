import { collectLiteralEnumValues } from '../../src/index.js';

describe('collectLiteralEnumValues', () => {
  // Minimal stand-in for the `typescript` namespace: only the literal
  // TypeFlags the function reads, using their real bit values.
  const ts = {
    TypeFlags: {
      StringLiteral: 1 << 7,
      NumberLiteral: 1 << 8,
      BooleanLiteral: 1 << 9,
      BigIntLiteral: 1 << 11,
    },
  };

  /** @param {string} value */
  const str = (value) => ({ flags: ts.TypeFlags.StringLiteral, value });
  /** @param {number} value */
  const num = (value) => ({ flags: ts.TypeFlags.NumberLiteral, value });
  const nonLiteral = { flags: 1 << 20 };

  it('returns distinct literal values in first-seen order', () => {
    expect(collectLiteralEnumValues([str('idle'), str('entered'), str('started')], ts)).to.deep.equal(['idle', 'entered', 'started']);
  });

  it('dedupes equal values while preserving first-seen order', () => {
    // The `Enum | `${Enum}`` pattern yields each value twice as distinct union
    // members; JSON Schema enums SHOULD be unique.
    const members = [str('idle'), str('entered'), str('idle'), str('entered')];
    expect(collectLiteralEnumValues(members, ts)).to.deep.equal(['idle', 'entered']);
  });

  it('stringifies numeric literals and dedupes them', () => {
    expect(collectLiteralEnumValues([num(1), num(2), num(1)], ts)).to.deep.equal(['1', '2']);
  });

  it('returns null when any member is a non-literal', () => {
    expect(collectLiteralEnumValues([str('idle'), nonLiteral], ts)).to.equal(null);
  });
});
