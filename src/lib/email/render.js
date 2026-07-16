// Deliberately simple `{varname}` substitution (not Handlebars/Mustache) —
// matches exactly what the admin panel's variables modal documents, no
// templating-language surface area beyond a flat key/value map.

const PLACEHOLDER_RE = /\{(\w+)\}/g;

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Replaces every `{key}` in `str` with the HTML-escaped value of
 * `context[key]` (a user's own name ends up in HTML output, so it must be
 * escaped). A placeholder with no matching key in `context` is left as
 * literal text rather than silently blanked — a typo'd variable name is
 * then obviously wrong in a preview/test send instead of invisibly missing.
 */
export function renderTemplate(str, context) {
  if (!str) return "";
  return str.replace(PLACEHOLDER_RE, (match, key) => {
    if (!(key in context)) return match;
    return escapeHtml(context[key]);
  });
}
