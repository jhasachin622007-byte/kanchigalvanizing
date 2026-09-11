# ZincCore / HDP Galvanizing — rebuild here with a new look

Bring the uploaded app into this project, recreate its database on this project's
cloud database, refresh the visual design, and give it a friendlier sign-in screen.
All existing features stay.

## What you get

- Every module from the upload, working end to end: loading, dipping, QC / coating
  on job, hourly and daily reports, material offer, Six Sigma dashboard, data
  management, admin tools, and all five AI prediction engines (MLR, XGBoost,
  LightGBM, CatBoost, ZincCore deep learning).
- Device security kept as-is: new devices need admin approval, and one account can
  only be active on one device at a time.
- Sign-in accepts either a username or an email, with the password. Password reset
  by email still works for accounts that have a real email.
- A refreshed look across the whole app, applied consistently.

## Important: data

The cloud database attached to this project is currently empty. The tables, rules
and permissions are recreated exactly as in the upload (same structure, same field
types), but records from the old system do not come with the file. You'll start
with a clean database and create the first admin account on the new sign-in screen.

## Design step (before building)

1. Three quick visual preference picks: colour palette, typography, layout density.
2. Three full rendered design directions built on those picks, shown side by side.
3. You choose one; that direction is then applied across the entire app — sign-in,
   navigation, module screens, tables, charts and reports.

## Cleanup

Removed only what is genuinely unused: the old project's stale plan archive, the
old environment file pointing at the previous database, sitemap/robots entries tied
to the old domain, and any interface pieces no screen references. No working feature,
table, or calculation is removed.

## Build order

1. Copy the app source into this project and install its packages.
2. Recreate the full database structure (tables, roles, security rules, permissions,
   helper functions) on this project's cloud database.
3. Turn on email/password sign-in and point the app at this project's database.
4. Design picks and directions, then apply the chosen direction.
5. Rebuild the sign-in screen: clear username-or-email field, visible errors,
   password reset link, first-admin setup.
6. Walk the app end to end in the browser — sign up, sign in, device approval, a
   loading entry, a dipping cycle, a QC reading, a report — and fix what breaks.

## Technical notes

- Stack matches this project already: TanStack Start, React 19, Tailwind v4,
  Supabase. The upload's `package.json` adds recharts, xlsx, qrcode, ai-sdk, zod,
  date-fns — these get installed.
- The 65 migration files from the upload are replayed in order through the
  migration tool against project ref `rdfrkmfpygcsbnvubkdt`, preserving table
  shapes, enums, RLS policies, grants, triggers and the `has_role` /
  `next_beam_shard` functions, so `src/integrations/supabase/types.ts` stays valid.
- Server logic stays in the existing `createServerFn` modules (admin, auth lookup,
  device security, email report, six sigma, AI gateway). No edge functions.
- `.env` is not copied; this project's own Supabase values are used. Any secrets
  the old app relied on (e.g. email sending) are re-added via the secret tool and
  I'll tell you if one needs a value from you.
- `HdpApp.tsx` is ~8,000 lines. Restyling goes through design tokens in
  `src/styles.css` plus the shared UI components, so behaviour is untouched.
