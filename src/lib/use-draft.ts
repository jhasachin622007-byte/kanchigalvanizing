import { useEffect, useRef } from "react";

/**
 * Mirror a controlled value to localStorage so that an OS-level tab freeze
 * (incoming call, screen lock, low-memory eviction on mobile) can't lose
 * in-progress form data. Restores on mount; caller clears via `clearDraft`
 * after a successful submit.
 *
 * Keys are namespaced by user id so a device handoff doesn't mix users.
 *
 * Restore semantics (fix for "entries disappear after typing"):
 *   - Restore runs AT MOST ONCE per (userId, key) per session — even if the
 *     `enabled` flag toggles (e.g. user opens an edit form and cancels).
 *     Previously the effect re-ran on every dep change, re-reading old
 *     localStorage and clobbering fresh keystrokes.
 *   - If the caller has already set a non-default value before we hydrate,
 *     the restore is skipped so we never overwrite live user input.
 */
const PREFIX = "hdp:draft:";
const hydratedKeys = new Set<string>();
const consumedKeys = new Set<string>();

function fullKey(userId: string | null | undefined, key: string) {
  return `${PREFIX}${userId || "anon"}:${key}`;
}

function sessionKey(userId: string | null | undefined, key: string) {
  return `${userId || "anon"}::${key}`;
}

export function useDraft<T>(
  userId: string | null | undefined,
  key: string,
  value: T,
  setValue: (v: T) => void,
  opts: { enabled?: boolean; debounceMs?: number; isEmpty?: (v: T) => boolean } = {},
) {
  const { enabled = true, debounceMs = 300, isEmpty } = opts;
  const initialValueRef = useRef<T>(value);
  const hydrated = useRef(false);
  const lastSaved = useRef<string>("");
  const currentValueRef = useRef<T>(value);
  currentValueRef.current = value;

  // Restore at most once per (userId, key), regardless of `enabled` toggles.
  useEffect(() => {
    if (!enabled || typeof window === "undefined") {
      hydrated.current = true;
      return;
    }
    const sk = sessionKey(userId, key);
    if (hydratedKeys.has(sk)) {
      hydrated.current = true;
      return;
    }
    hydratedKeys.add(sk);
    // Don't overwrite live user input.
    const cur = currentValueRef.current;
    const looksEmpty = isEmpty
      ? isEmpty(cur)
      : JSON.stringify(cur) === JSON.stringify(initialValueRef.current);
    if (!looksEmpty) {
      hydrated.current = true;
      return;
    }
    try {
      const raw = localStorage.getItem(fullKey(userId, key));
      if (raw != null) {
        const parsed = JSON.parse(raw);
        setValue(parsed as T);
        lastSaved.current = raw;
      }
    } catch {}
    hydrated.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, userId, key]);

  // Debounced persist. Skip when the key has been explicitly consumed
  // (cleared after save) to avoid the final debounced tick re-persisting
  // stale form state after `clearDraft`.
  useEffect(() => {
    if (!enabled || !hydrated.current || typeof window === "undefined") return;
    const sk = sessionKey(userId, key);
    const id = setTimeout(() => {
      if (consumedKeys.has(sk)) {
        consumedKeys.delete(sk);
        return;
      }
      try {
        const serial = JSON.stringify(value);
        if (serial === lastSaved.current) return;
        localStorage.setItem(fullKey(userId, key), serial);
        lastSaved.current = serial;
      } catch {}
    }, debounceMs);

    // Flush on pagehide (iOS may freeze before debounce fires).
    const flush = () => {
      if (consumedKeys.has(sk)) return;
      try {
        const serial = JSON.stringify(value);
        localStorage.setItem(fullKey(userId, key), serial);
        lastSaved.current = serial;
      } catch {}
    };
    window.addEventListener("pagehide", flush);

    return () => {
      clearTimeout(id);
      window.removeEventListener("pagehide", flush);
    };
  }, [enabled, userId, key, value, debounceMs]);
}

export function clearDraft(userId: string | null | undefined, key: string) {
  try {
    localStorage.removeItem(fullKey(userId, key));
  } catch {}
  const sk = sessionKey(userId, key);
  // Suppress the trailing debounced persist and allow future re-hydration
  // (in case the same form is used for a new entry in the same session).
  consumedKeys.add(sk);
  hydratedKeys.delete(sk);
}

export function saveDraft<T>(userId: string | null | undefined, key: string, value: T) {
  try {
    localStorage.setItem(fullKey(userId, key), JSON.stringify(value));
  } catch {}
  const sk = sessionKey(userId, key);
  consumedKeys.delete(sk);
  hydratedKeys.delete(sk);
}

// Test-only helper.
export function __resetDraftSessionState() {
  hydratedKeys.clear();
  consumedKeys.clear();
}
