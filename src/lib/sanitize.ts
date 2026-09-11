/**
 * Shared input sanitization helpers.
 *
 * Use `escapeHtml` whenever user-supplied text is interpolated into an HTML
 * string (e.g. outgoing emails, server-rendered snippets, copy-to-clipboard
 * blobs). React's JSX auto-escapes children — do NOT use these helpers for
 * normal {value} expressions in JSX.
 */

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
  "/": "&#x2F;",
  "`": "&#x60;",
  "=": "&#x3D;",
};

export function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(/[&<>"'`=/]/g, (c) => HTML_ESCAPES[c]!);
}

/**
 * Strip control characters and collapse whitespace.
 * Useful before persisting free-form text fields (notes, names, etc.).
 */
export function sanitizeText(value: unknown, maxLength = 1000): string {
  return String(value ?? "")
    // strip ASCII control + most C1 controls
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "")
    .trim()
    .slice(0, maxLength);
}

/**
 * Validate that a string is a safe relative or http(s) URL.
 * Returns the normalized URL on success, or null on failure.
 */
export function sanitizeUrl(value: unknown): string | null {
  const s = String(value ?? "").trim();
  if (!s) return null;
  // Block dangerous schemes outright
  if (/^\s*(javascript|data|vbscript|file):/i.test(s)) return null;
  try {
    const u = new URL(s, "https://placeholder.invalid");
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return s;
  } catch {
    return null;
  }
}
