// Global runtime feature flags. Kept in a module-level store so any UI or
// data-selection helper can read it synchronously without prop drilling.
// The Admin panel is the source of truth; AppInner syncs the cloud setting
// `feature65um.enabled` into this store on load and on change.

import { useSyncExternalStore } from "react";

type Flags = { show65: boolean };
let state: Flags = { show65: true };
const listeners = new Set<() => void>();

function emit() { for (const l of listeners) l(); }

export function setShow65(enabled: boolean) {
  const next = !!enabled;
  if (state.show65 === next) return;
  state = { ...state, show65: next };
  emit();
}

export function is65Enabled(): boolean { return state.show65; }

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

export function useShow65(): boolean {
  return useSyncExternalStore(subscribe, () => state.show65, () => state.show65);
}

// Helper to filter a coating array by the flag.
export function filterCoatings<T extends number | { val: number } | string>(arr: readonly T[]): T[] {
  if (state.show65) return [...arr];
  return arr.filter((x) => {
    const v = typeof x === "number" ? x : typeof x === "string" ? Number(x) : (x as any).val;
    return Number(v) !== 65;
  });
}

// Filter beams by the flag (removes coating_required === 65 when disabled).
export function filterBeamsByFlag<T extends { coating_required?: any }>(beams: T[]): T[] {
  if (state.show65) return beams;
  return beams.filter((b) => Number(b?.coating_required) !== 65);
}
