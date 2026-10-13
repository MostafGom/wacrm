// ============================================================
// Browser auth client over /api/auth/*:
//
//   import { getAuthClient } from '@/lib/auth/client'
//   await getAuthClient().signInWithPassword({ email, password })
//
// (Method names and result shapes follow supabase-js so the existing
// pages kept working through the migration.)
//
// The session itself is an HttpOnly cookie the browser can't read;
// this keeps a small in-memory copy of the current user (fetched from
// /api/auth/session) and notifies `onAuthStateChange` listeners —
// including other tabs, via BroadcastChannel — on sign-in / sign-out.
// ============================================================

import type { AuthApi, AuthChangeEvent, AuthError, Session, User } from "./types";

type Listener = (event: AuthChangeEvent, session: Session | null) => void;

const CHANNEL = "wacrm-auth";

async function call<T>(
  method: string,
  url: string,
  body?: unknown,
): Promise<{ data: T | null; error: AuthError | null }> {
  try {
    const res = await fetch(url, {
      method,
      credentials: "same-origin",
      headers: body !== undefined ? { "content-type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      cache: "no-store",
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = (json as { error?: { code?: string; message?: string } | string }).error;
      const message = typeof err === "string" ? err : err?.message ?? res.statusText;
      const code = typeof err === "object" && err?.code ? err.code : "unexpected_failure";
      return { data: null, error: { message, code, status: res.status } };
    }
    return { data: json as T, error: null };
  } catch (e) {
    return {
      data: null,
      error: { message: e instanceof Error ? e.message : "Network error", code: "network_error", status: 0 },
    };
  }
}

export function createAuthClient(): AuthApi {
  const listeners = new Set<Listener>();
  let current: Session | null | undefined; // undefined = not loaded yet
  let inflight: Promise<Session | null> | null = null;
  const bc = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel(CHANNEL) : null;

  const emit = (event: AuthChangeEvent, session: Session | null, broadcast = true) => {
    current = session;
    for (const l of listeners) {
      try {
        l(event, session);
      } catch (e) {
        console.error("[auth] listener failed:", e);
      }
    }
    if (broadcast) bc?.postMessage({ event });
  };

  // Another tab signed in/out: refetch and re-emit locally.
  bc?.addEventListener("message", (msg: MessageEvent<{ event: AuthChangeEvent }>) => {
    current = undefined;
    void loadSession(true).then((s) => emit(msg.data.event, s, false));
  });

  function loadSession(force = false): Promise<Session | null> {
    if (!force && current !== undefined) return Promise.resolve(current);
    inflight ??= call<{ session: Session | null }>("GET", "/api/auth/session")
      .then(({ data }) => {
        current = data?.session ?? null;
        return current;
      })
      .finally(() => {
        inflight = null;
      });
    return inflight;
  }

  return {
    async getSession() {
      const session = await loadSession();
      return { data: { session }, error: null };
    },

    async getUser() {
      // Like supabase-js, getUser() always re-validates with the server.
      const session = await loadSession(true);
      return session
        ? { data: { user: session.user }, error: null }
        : { data: { user: null }, error: { message: "Auth session missing!", code: "session_missing", status: 401 } };
    },

    onAuthStateChange(cb) {
      listeners.add(cb);
      void loadSession().then((s) => {
        if (listeners.has(cb)) cb("INITIAL_SESSION", s);
      });
      return { data: { subscription: { unsubscribe: () => void listeners.delete(cb) } } };
    },

    async signInWithPassword({ email, password }) {
      const { data, error } = await call<{ user: User }>("POST", "/api/auth/login", { email, password });
      if (error || !data) return { data: { user: null, session: null }, error };
      const session = { user: data.user };
      emit("SIGNED_IN", session);
      return { data: { user: data.user, session }, error: null };
    },

    async signUp({ email, password, options }) {
      const invite =
        typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("invite") : null;
      const { data, error } = await call<{ user: User; session: Session | null }>("POST", "/api/auth/signup", {
        email,
        password,
        data: options?.data ?? {},
        redirectTo: options?.emailRedirectTo,
        inviteToken: invite,
      });
      if (error || !data) return { data: { user: null, session: null }, error };
      if (data.session) emit("SIGNED_IN", data.session);
      return { data: { user: data.user, session: data.session }, error: null };
    },

    async signOut(opts) {
      const scope = opts?.scope ?? "local";
      const { error } = await call("POST", "/api/auth/logout", { scope });
      if (!error && scope !== "others") emit("SIGNED_OUT", null);
      return { error };
    },

    async updateUser(attrs) {
      const { data, error } = await call<{ user: User }>("PUT", "/api/auth/user", attrs);
      if (error || !data) return { data: { user: null }, error };
      emit("USER_UPDATED", { user: data.user });
      return { data: { user: data.user }, error: null };
    },

    async resetPasswordForEmail(email, opts) {
      const { data, error } = await call<{ mail_enabled: boolean }>("POST", "/api/auth/recover", {
        email,
        redirectTo: opts?.redirectTo,
      });
      return { data: data ? { mailEnabled: data.mail_enabled } : null, error };
    },
  };
}

let singleton: AuthApi | null = null;

/** One auth client (and one cached session) per browser tab. */
export function getAuthClient(): AuthApi {
  singleton ??= createAuthClient();
  return singleton;
}
