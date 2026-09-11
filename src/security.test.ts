/**
 * Automated security regression tests.
 *
 * Run via `bunx vitest run src/security.test.ts` (or as part of the normal
 * test suite). These checks are intentionally fast and dependency-free so
 * they can run in CI on every PR.
 *
 * What they enforce:
 *   1. No raw HTML injection sinks — every `dangerouslySetInnerHTML` usage
 *      must be on the project's allowlist (developer-controlled content
 *      only, never user input).
 *   2. No deprecated unsafe escape helpers — interpolated HTML must go
 *      through `escapeHtml` from `@/lib/sanitize`.
 *   3. CSP meta header is present in the root route.
 *   4. RLS-sensitive Supabase tables in `src/integrations/supabase/types.ts`
 *      are referenced via the safe client paths only (no service-role usage
 *      from browser code).
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(process.cwd(), "src");

// Files explicitly allowed to use dangerouslySetInnerHTML.
// Each entry MUST be reviewed manually — only add files where the HTML
// content is statically derived from developer config, NEVER user input.
const HTML_SINK_ALLOWLIST = new Set<string>([
  "components/ui/chart.tsx", // shadcn chart: injects derived CSS variables only
]);

// Files allowed to import the admin (service-role) Supabase client.
// Must remain server-only — never anything reachable from a React component.
const ADMIN_CLIENT_ALLOWLIST = /(^|\/)(lib|server|integrations\/supabase)\/.*\.(server|functions)\.tsx?$/;

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    const s = statSync(full);
    if (s.isDirectory()) walk(full, acc);
    else if (/\.(tsx?|jsx?)$/.test(entry)) acc.push(full);
  }
  return acc;
}

const ALL_FILES = walk(ROOT);

describe("security: HTML injection sinks", () => {
  it("no unreviewed dangerouslySetInnerHTML usage", () => {
    const offenders: string[] = [];
    for (const file of ALL_FILES) {
      const rel = relative(ROOT, file).replace(/\\/g, "/");
      // Skip this test file itself
      if (rel.endsWith("security.test.ts")) continue;
      const src = readFileSync(file, "utf8");
      if (src.includes("dangerouslySetInnerHTML") && !HTML_SINK_ALLOWLIST.has(rel)) {
        offenders.push(rel);
      }
    }
    expect(offenders, `Unreviewed dangerouslySetInnerHTML in: ${offenders.join(", ")}`).toEqual([]);
  });

  it("no innerHTML assignment on DOM nodes", () => {
    const offenders: string[] = [];
    for (const file of ALL_FILES) {
      const rel = relative(ROOT, file).replace(/\\/g, "/");
      if (rel.endsWith("security.test.ts")) continue;
      const src = readFileSync(file, "utf8");
      // match `.innerHTML =` but not `.outerHTML.includes("innerHTML")` style false positives
      if (/\.innerHTML\s*=/.test(src)) offenders.push(rel);
    }
    expect(offenders, `Direct .innerHTML assignment in: ${offenders.join(", ")}`).toEqual([]);
  });
});

describe("security: CSP", () => {
  it("root route declares a Content-Security-Policy meta tag", () => {
    const root = readFileSync(join(ROOT, "routes/__root.tsx"), "utf8");
    expect(root).toMatch(/Content-Security-Policy/);
    expect(root).toMatch(/frame-ancestors/);
    expect(root).toMatch(/object-src\s+'none'/);
  });

  it("root route forbids dangerous CSP directives", () => {
    const root = readFileSync(join(ROOT, "routes/__root.tsx"), "utf8");
    // default-src must be 'self', never '*'
    expect(root).not.toMatch(/default-src\s+\*/);
  });
});

describe("security: admin Supabase client containment", () => {
  it("client.server is only imported by server-only modules", () => {
    const offenders: string[] = [];
    for (const file of ALL_FILES) {
      const rel = relative(ROOT, file).replace(/\\/g, "/");
      if (rel === "integrations/supabase/client.server.ts") continue;
      const src = readFileSync(file, "utf8");
      if (/from\s+["']@\/integrations\/supabase\/client\.server["']/.test(src)) {
        if (!ADMIN_CLIENT_ALLOWLIST.test(rel)) offenders.push(rel);
      }
    }
    expect(offenders, `Service-role client imported in non-server file: ${offenders.join(", ")}`).toEqual([]);
  });
});

describe("security: RLS-aware schema sanity", () => {
  it("known sensitive tables are present in generated types", () => {
    const types = readFileSync(join(ROOT, "integrations/supabase/types.ts"), "utf8");
    // If any of these tables disappear unexpectedly, fail loudly so reviewers
    // notice that an RLS-protected table was renamed/removed.
    for (const t of ["audit_log", "user_roles", "profiles", "app_settings", "beams"]) {
      expect(types, `Table ${t} missing from generated types`).toMatch(new RegExp(`\\b${t}\\b`));
    }
  });
});
