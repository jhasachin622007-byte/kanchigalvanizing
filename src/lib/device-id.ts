// Opaque per-browser device handle. The value carries no trust by itself —
// the backend always re-checks `(user_id, device_id)` against `user_devices`.
const KEY = "hdp.device_id";

export function getDeviceId(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const v = localStorage.getItem(KEY);
    return v && /^DVC-[0-9a-f-]{36}$/i.test(v) ? v : null;
  } catch {
    return null;
  }
}

export function setDeviceId(id: string | null | undefined) {
  if (typeof window === "undefined" || !id) return;
  try {
    localStorage.setItem(KEY, id);
  } catch {}
}
