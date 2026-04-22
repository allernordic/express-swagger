/**
 * Resolve a `$ref` chain pointing at `#/components/schemas/<Name>` by
 * walking referenced schemas until a non-`$ref` shape is reached (or the
 * chain bottoms out). Non-ref nodes are returned as-is.
 *
 * @param {Record<string, any>} doc
 * @param {unknown} node
 * @returns {any}
 */
export function follow(doc, node) {
  const seen = new Set();
  let current = node;
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    const record = /** @type {Record<string, unknown>} */ (current);
    if (typeof record.$ref !== 'string') return current;
    const match = /^#\/components\/schemas\/(.+)$/.exec(record.$ref);
    if (!match) return current;
    const target = doc.components?.schemas?.[match[1]];
    if (target === undefined) return current;
    current = target;
  }
  return current;
}
