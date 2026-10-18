"use client";

import { useState } from "react";
import Link from "next/link.js";
import { useRouter } from "next/navigation.js";
import { api } from "../../components/lib.js";
import { setAuth, routeAfterLogin } from "../../components/auth.js";
import { ProductGate } from "../../components/product/mode.js";
import { Toasts } from "../../components/product/toast.js";

function LoginInner() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const submit = async (e) => {
    e.preventDefault();
    if (busy) return;
    setError(null);
    if (!email.trim() || !password) {
      setError("Enter your email and password.");
      return;
    }
    setBusy(true);
    try {
      const r = await api("/auth/login", {
        method: "POST",
        body: { email: email.trim(), password },
      });
      setAuth(r.token, r.user);
      await routeAfterLogin(router);
    } catch (err) {
      setError(
        err?.status === 429
          ? "Too many attempts. The account is locked for 15 minutes. Try again shortly."
          : err?.status === 401
            ? "Wrong email or password."
            : err?.message || "Login failed."
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-page">
      <Link className="wordmark" href="/">
        <span className="glyph"><img src="/logo-mark.png" alt="" /></span>
        <span className="name">aegis<b className="ai">Ai</b>Wallet</span>
      </Link>
      <div className="card auth-card">
        <h2>Welcome back</h2>
        <p className="lede">Log in to your Aegis wallet.</p>
        <form className="auth-form" onSubmit={submit} noValidate>
          <div className="field">
            <label htmlFor="email">Email</label>
            <input
              id="email" type="email" autoComplete="email" spellCheck={false}
              value={email} onChange={(e) => setEmail(e.target.value)} disabled={busy}
              placeholder="you@example.com"
            />
          </div>
          <div className="field">
            <label htmlFor="password">Password</label>
            <input
              id="password" type="password" autoComplete="current-password"
              value={password} onChange={(e) => setPassword(e.target.value)} disabled={busy}
              placeholder="••••••••"
            />
          </div>
          {error ? <div className="error" role="alert">{error}</div> : null}
          <button className="btn primary" type="submit" disabled={busy}>
            {busy ? "Logging in…" : "Log in"}
          </button>
        </form>
      </div>
      <p className="auth-alt">
        New here? <Link href="/signup">Create an account</Link>
      </p>
      <p className="auth-back"><Link className="link" href="/">← back to the homepage</Link></p>
      <Toasts />
    </div>
  );
}

export default function LoginPage() {
  return (
    <ProductGate>
      <LoginInner />
    </ProductGate>
  );
}
