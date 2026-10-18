"use client";

// Product-mode auth: token/user persistence, authenticated API wrapper with
// 401 handling, the /me poller, and the route guard. Judge mode never imports
// this module — it is additive product infrastructure.

import { useEffect, useState } from "react";
import { api, usePoll } from "./lib.js";

const T_KEY = "aegis:token";
const U_KEY = "aegis:user";

export function getToken() {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(T_KEY);
  } catch {
    return null;
  }
}

export function getUser() {
  if (typeof window === "undefined") return null;
  try {
    return JSON.parse(window.localStorage.getItem(U_KEY) || "null");
  } catch {
    return null;
  }
}

export function setAuth(token, user) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(T_KEY, token);
    window.localStorage.setItem(U_KEY, JSON.stringify(user || {}));
  } catch {
    /* private mode etc. — session just won't survive a reload */
  }
}

export function clearAuth() {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(T_KEY);
    window.localStorage.removeItem(U_KEY);
  } catch {
    /* ignore */
  }
}

/** api() with the Bearer header; a 401 wipes the stale session and bounces
 *  to /login (only when we aren't already there). */
export async function apiAuth(path, opts = {}) {
  const token = getToken();
  try {
    return await api(path, {
      ...opts,
      headers: { ...(opts.headers || {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    });
  } catch (e) {
    if (e?.status === 401 && typeof window !== "undefined") {
      clearAuth();
      if (window.location.pathname !== "/login") {
        window.location.href = "/login";
      }
    }
    throw e;
  }
}

/** Polls GET /me every 5s (pauses in hidden tabs — see usePoll). */
export function useMe() {
  return usePoll(() => apiAuth("/me"), 5000);
}

/** Route guard for auth-required pages: ready flips after the first
 *  client-side check; authed is false when no token exists (caller should
 *  render nothing while the redirect to /login is in flight). */
export function useRequireAuth() {
  const [state, setState] = useState({ ready: false, authed: false });
  useEffect(() => {
    const authed = !!getToken();
    setState({ ready: true, authed });
    if (!authed && typeof window !== "undefined") {
      window.location.href = "/login";
    }
  }, []);
  return state;
}

/** Where to go after a successful login: /app when the vault is ready,
 *  /start to watch provisioning otherwise. */
export async function routeAfterLogin(router) {
  try {
    const me = await apiAuth("/me");
    const done = me?.vault?.state === "done";
    router.push(done ? "/app" : "/start");
  } catch {
    // /me hiccup (network etc.) — onboarding will re-check and bounce if needed
    router.push("/start");
  }
}

/** POST /auth/logout (best effort) + local wipe. */
export async function logout() {
  try {
    await apiAuth("/auth/logout", { method: "POST" });
  } catch {
    /* server may be down — local session is cleared regardless */
  }
  clearAuth();
}
