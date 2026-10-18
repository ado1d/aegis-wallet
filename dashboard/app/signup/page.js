"use client";

import { useState } from "react";
import Link from "next/link.js";
import { useRouter } from "next/navigation.js";
import { api } from "../../components/lib.js";
import { setAuth } from "../../components/auth.js";
import { ProductGate } from "../../components/product/mode.js";
import { Toasts } from "../../components/product/toast.js";

function SignupInner() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const submit = async (e) => {
    e.preventDefault();
    if (busy) return;
    setError(null);
    if (!email.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      setError("Enter a valid email address.");
      return;
    }
    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }
    setBusy(true);
    try {
      const r = await api("/auth/signup", {
        method: "POST",
        body: { email: email.trim(), password, name: name.trim() || undefined },
      });
      setAuth(r.token, r.user);
      router.push("/start"); // watch your vault being provisioned
    } catch (err) {
      setError(
        err?.status === 409
          ? "That email is already registered, log in instead."
          : err?.status === 400
            ? err?.message || "Please check your details."
            : err?.message || "Sign-up failed."
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
        <h2>Create your account</h2>
        <p className="lede">
          We&apos;ll generate your keys and deploy your personal vault on Sepolia.
          It takes a minute or two.
        </p>
        <form className="auth-form" onSubmit={submit} noValidate>
          <div className="field">
            <label htmlFor="name">Name <span style={{ textTransform: "none" }}>(optional)</span></label>
            <input
              id="name" autoComplete="name" value={name}
              onChange={(e) => setName(e.target.value)} disabled={busy}
              placeholder="Alex"
            />
          </div>
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
              id="password" type="password" autoComplete="new-password"
              value={password} onChange={(e) => setPassword(e.target.value)} disabled={busy}
              placeholder="at least 8 characters"
            />
            <span className="hint">8 characters minimum. Used to encrypt your keys.</span>
          </div>
          {error ? <div className="error" role="alert">{error}</div> : null}
          <button className="btn primary" type="submit" disabled={busy}>
            {busy ? "Creating your vault…" : "Create account"}
          </button>
        </form>
      </div>
      <p className="auth-alt">
        Already have an account? <Link href="/login">Log in</Link>
      </p>
      <p className="auth-back"><Link className="link" href="/">← back to the homepage</Link></p>
      <Toasts />
    </div>
  );
}

export default function SignupPage() {
  return (
    <ProductGate>
      <SignupInner />
    </ProductGate>
  );
}
