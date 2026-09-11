/**
 * Plant timezone handling.
 *
 * Every timestamp is stored as UTC ISO in the database, but the plant floor,
 * reports, dashboards and exports must always read the SAME wall-clock time
 * regardless of the device/browser timezone. All formatting and all
 * datetime-local parsing therefore go through the fixed plant timezone.
 */

export const APP_TZ = "Asia/Kolkata";
export const APP_TZ_LABEL = "IST";

const partsFmt = new Intl.DateTimeFormat("en-GB", {
  timeZone: APP_TZ,
  year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit",
  hour12: false,
});

function tzParts(d: Date) {
  const p: Record<string, string> = {};
  for (const { type, value } of partsFmt.formatToParts(d)) p[type] = value;
  return {
    y: +p.year, mo: +p.month, d: +p.day,
    h: p.hour === "24" ? 0 : +p.hour, mi: +p.minute, s: +p.second,
  };
}

/** Offset (ms) of APP_TZ at the given instant. */
function tzOffsetMs(date: Date): number {
  const p = tzParts(date);
  const asUTC = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s);
  return asUTC - Math.floor(date.getTime() / 1000) * 1000;
}

/**
 * Parse a `datetime-local` string ("2026-08-06T13:55:00") as plant-local wall
 * clock time and return the corresponding UTC ISO string.
 */
export function parseTzLocal(v?: string | null): string | null {
  if (!v) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/.exec(v.trim());
  if (!m) {
    const t = new Date(v).getTime();
    return Number.isFinite(t) ? new Date(t).toISOString() : null;
  }
  const [, y, mo, d, h, mi, s] = m;
  const naive = Date.UTC(+y, +mo - 1, +d, +h, +mi, +(s || 0));
  // Two-pass to settle DST-ish offsets (IST has none, but keep it correct).
  let guess = naive - tzOffsetMs(new Date(naive));
  guess = naive - tzOffsetMs(new Date(guess));
  return new Date(guess).toISOString();
}

/** ISO → `datetime-local` input value in plant time, with seconds. */
export function toTzInputValue(iso?: string | null): string {
  if (!iso) return "";
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "";
  const p = tzParts(new Date(t));
  const z = (n: number) => String(n).padStart(2, "0");
  return `${p.y}-${z(p.mo)}-${z(p.d)}T${z(p.h)}:${z(p.mi)}:${z(p.s)}`;
}

/** "01:34:33 pm" — always plant time, always with seconds. */
export function fmtTimeTz(iso?: string | null): string {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "—";
  const p = tzParts(new Date(t));
  const ampm = p.h >= 12 ? "pm" : "am";
  const h12 = p.h % 12 === 0 ? 12 : p.h % 12;
  const z = (n: number) => String(n).padStart(2, "0");
  return `${z(h12)}:${z(p.mi)}:${z(p.s)} ${ampm}`;
}

/** "06 Aug 2026" in plant time. */
export function fmtDateTz(iso?: string | null): string {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "—";
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: APP_TZ, day: "2-digit", month: "short", year: "numeric",
  }).format(new Date(t));
}

/** "06 Aug 2026  01:34:33 pm" in plant time. */
export function fmtDateTimeTz(iso?: string | null): string {
  if (!iso) return "—";
  const d = fmtDateTz(iso);
  return d === "—" ? "—" : `${d}  ${fmtTimeTz(iso)}`;
}

/** "06 Aug" bucket key in plant time. */
export function dateKeyTz(iso?: string | null): string {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "—";
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: APP_TZ, day: "2-digit", month: "short",
  }).format(new Date(t));
}

/** "YYYY-MM-DD" day key in plant time (stable for grouping/filters). */
export function dayIdTz(iso?: string | null): string {
  if (!iso) return "";
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "";
  const p = tzParts(new Date(t));
  const z = (n: number) => String(n).padStart(2, "0");
  return `${p.y}-${z(p.mo)}-${z(p.d)}`;
}

/** Plant-time calendar/clock fields, used for shift + txn-id derivation. */
export function tzFields(iso?: string | null) {
  const t = new Date(iso || Date.now()).getTime();
  const p = tzParts(new Date(Number.isFinite(t) ? t : Date.now()));
  return { year: p.y, month: p.mo, day: p.d, hour: p.h, minute: p.mi, second: p.s };
}
