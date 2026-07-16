// Escapes regex metacharacters in user-supplied search text before it's
// used to build a `$regex` query — without this, a crafted search string
// (e.g. nested-quantifier patterns like "(a+)+$") can cause catastrophic
// backtracking, hanging the single-threaded Node process on that one
// request and stalling every other request behind it.
export function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
