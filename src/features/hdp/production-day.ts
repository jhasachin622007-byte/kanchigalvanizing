// Production-day helpers: a production day runs 06:00 → 06:00 (next day)
// in the plant timezone (see src/lib/tz.ts).
import { tzFields, parseTzLocal } from "@/lib/tz";

const z = (n: number) => String(n).padStart(2, "0");

/** Plant-time production-day id ("YYYY-MM-DD") for an ISO timestamp. */
export function productionDayIdTz(iso?: string | null): string {
  if (!iso) return "";
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "";
  const f = tzFields(iso);
  // Before 06:00 → belongs to the previous calendar date.
  const d = new Date(Date.UTC(f.year, f.month - 1, f.day));
  if (f.hour < 6) d.setUTCDate(d.getUTCDate() - 1);
  return `${d.getUTCFullYear()}-${z(d.getUTCMonth() + 1)}-${z(d.getUTCDate())}`;
}

/** 0..23 bucket index within the production day (0 = 06:00–07:00). */
export function productionHourIndex(iso?: string | null): number {
  if (!iso) return -1;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return -1;
  const h = tzFields(iso).hour;
  return (h - 6 + 24) % 24;
}

/** Clock hour (0..23) for a bucket index. */
export const bucketHour = (idx: number): number => (idx + 6) % 24;

/** Label "06:00 – 07:00" for a bucket index. */
export const bucketLabel = (idx: number): string =>
  `${z(bucketHour(idx))}:00 – ${z((bucketHour(idx) + 1) % 24)}:00`;

/** True when a bucket falls after midnight (next calendar date). */
export const bucketIsNextDay = (idx: number): boolean => bucketHour(idx) < 6;

/** UTC ISO window [start, end) for the production day of "YYYY-MM-DD". */
export function productionWindow(dateStr: string): { start: string; end: string } {
  const [y, m, d] = dateStr.split("-").map(Number);
  const next = new Date(Date.UTC(y, m - 1, d));
  next.setUTCDate(next.getUTCDate() + 1);
  const nextStr = `${next.getUTCFullYear()}-${z(next.getUTCMonth() + 1)}-${z(next.getUTCDate())}`;
  return {
    start: parseTzLocal(`${dateStr}T06:00:00`) || "",
    end: parseTzLocal(`${nextStr}T06:00:00`) || "",
  };
}

/**
 * UTC ISO window [start, end) covering the production days fromDate..toDate
 * inclusive: fromDate 06:00 → (toDate + 1 day) 06:00, plant time.
 */
export function productionRange(fromDate: string, toDate: string): { start: string; end: string } {
  return {
    start: productionWindow(fromDate).start,
    end: productionWindow(toDate).end,
  };
}

/** True when an ISO timestamp falls in the production-day range fromDate..toDate. */
export function inProductionRange(iso: string | null | undefined, fromDate: string, toDate: string): boolean {
  if (!iso) return false;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return false;
  const { start, end } = productionRange(fromDate, toDate);
  const s = new Date(start).getTime();
  const e = new Date(end).getTime();
  return t >= s && t < e;
}

/** Shift letter from plant-time hour: A 06–14, B 14–22, C 22–06. */
export function productionShift(iso?: string | null): "A" | "B" | "C" | "" {
  if (!iso) return "";
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "";
  const h = tzFields(iso).hour;
  if (h >= 6 && h < 14) return "A";
  if (h >= 14 && h < 22) return "B";
  return "C";
}

/** Human label for a production-day range, e.g. "08 Aug 06:00 → 11 Aug 06:00". */
export function productionRangeLabel(fromDate: string, toDate: string): string {
  return `${fromDate} 06:00 → ${nextDateStr(toDate)} 06:00`;
}

/** Next calendar date string for labelling post-midnight buckets. */
export function nextDateStr(dateStr: string): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const n = new Date(Date.UTC(y, m - 1, d));
  n.setUTCDate(n.getUTCDate() + 1);
  return `${n.getUTCFullYear()}-${z(n.getUTCMonth() + 1)}-${z(n.getUTCDate())}`;
}
