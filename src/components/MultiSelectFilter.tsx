// @ts-nocheck
/* eslint-disable */
// Compact popover-based multi-select filter. Themed via `T` prop so it drops
// into the HDP dashboards and reports that use inline dark-theme styling.
// Empty `value` array = "All" (no filter applied downstream).
import { useEffect, useMemo, useRef, useState } from "react";

export type MultiOption = { value: string; label: string };

export function MultiSelectFilter({
  label,
  options,
  value,
  onChange,
  T,
  width = 160,
  allLabel = "All",
  searchable = true,
}: {
  label?: string;
  options: (MultiOption | string)[];
  value: string[];
  onChange: (next: string[]) => void;
  T: any;
  width?: number | string;
  allLabel?: string;
  searchable?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);

  const opts = useMemo<MultiOption[]>(
    () => options.map((o) => (typeof o === "string" ? { value: o, label: o } : o)),
    [options],
  );
  const filtered = useMemo(
    () => (q.trim() ? opts.filter((o) => o.label.toLowerCase().includes(q.trim().toLowerCase())) : opts),
    [opts, q],
  );

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const set = new Set(value);
  const toggle = (v: string) => {
    const s = new Set(set);
    if (s.has(v)) s.delete(v); else s.add(v);
    onChange(Array.from(s));
  };
  const selectAll = () => onChange(opts.map((o) => o.value));
  const clear = () => onChange([]);

  const chip = value.length === 0 ? allLabel : value.length === 1
    ? (opts.find((o) => o.value === value[0])?.label ?? value[0])
    : `${value.length} selected`;

  return (
    <div ref={rootRef} style={{ position: "relative", display: "inline-block", width }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        style={{
          width: "100%", background: T.bg, color: T.text, border: `1px solid ${T.border}`,
          borderRadius: 6, padding: "5px 8px", fontSize: 12, cursor: "pointer",
          textAlign: "left", display: "flex", alignItems: "center", gap: 6,
        }}
      >
        {label && <span style={{ color: T.muted, fontWeight: 700, fontSize: 10, textTransform: "uppercase", letterSpacing: ".06em" }}>{label}</span>}
        <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{chip}</span>
        <span style={{ color: T.muted, fontSize: 10 }}>▾</span>
      </button>
      {open && (
        <div
          style={{
            position: "absolute", top: "calc(100% + 4px)", left: 0, zIndex: 1000,
            minWidth: "100%", maxWidth: 320, background: T.card, border: `1px solid ${T.border}`,
            borderRadius: 8, boxShadow: "0 10px 30px rgba(0,0,0,.35)", padding: 8,
          }}
        >
          {searchable && opts.length > 6 && (
            <input
              autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search…"
              style={{
                width: "100%", background: T.bg, color: T.text, border: `1px solid ${T.border}`,
                borderRadius: 6, padding: "5px 8px", fontSize: 12, marginBottom: 6, boxSizing: "border-box",
              }}
            />
          )}
          <div style={{ display: "flex", gap: 6, marginBottom: 6 }}>
            <button type="button" onClick={selectAll}
              style={{ flex: 1, padding: "4px 6px", fontSize: 10, fontWeight: 700, background: T.bg, color: T.text, border: `1px solid ${T.border}`, borderRadius: 4, cursor: "pointer" }}>
              Select all
            </button>
            <button type="button" onClick={clear}
              style={{ flex: 1, padding: "4px 6px", fontSize: 10, fontWeight: 700, background: T.bg, color: T.muted, border: `1px solid ${T.border}`, borderRadius: 4, cursor: "pointer" }}>
              Clear
            </button>
          </div>
          <div style={{ maxHeight: 240, overflowY: "auto", display: "flex", flexDirection: "column", gap: 2 }}>
            {filtered.length === 0 && (
              <div style={{ padding: 8, fontSize: 11, color: T.dim, textAlign: "center" }}>No options</div>
            )}
            {filtered.map((o) => {
              const checked = set.has(o.value);
              return (
                <label key={o.value}
                  style={{
                    display: "flex", alignItems: "center", gap: 8, padding: "5px 6px", fontSize: 12,
                    color: T.text, cursor: "pointer", borderRadius: 4,
                    background: checked ? "#3D7EA615" : "transparent",
                  }}
                  onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = checked ? "#3D7EA625" : T.bg; }}
                  onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = checked ? "#3D7EA615" : "transparent"; }}
                >
                  <input type="checkbox" checked={checked} onChange={() => toggle(o.value)} />
                  <span style={{ flex: 1 }}>{o.label}</span>
                </label>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// Predicate helper used by callers: empty array = pass everything.
export const inSel = (arr: string[], v: any) =>
  arr.length === 0 || arr.includes(String(v));
