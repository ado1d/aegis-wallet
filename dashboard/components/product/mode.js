"use client";

// Build-time product-mode flag shared by every product route, plus a gate
// that keeps auth/app routes inert in judge-mode deployments (they redirect
// to /, which is the judge dashboard there).

import { useEffect } from "react";
import { useRouter } from "next/navigation.js";

export const PRODUCT = process.env.NEXT_PUBLIC_AEGIS_MODE === "product";

export function ProductGate({ children }) {
  const router = useRouter();
  useEffect(() => {
    if (!PRODUCT) router.replace("/");
  }, [router]);
  if (!PRODUCT) return null;
  return children;
}
