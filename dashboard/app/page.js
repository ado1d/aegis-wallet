"use client";

import JudgeDashboard from "../components/JudgeDashboard.js";
import Landing from "../components/Landing.js";

// Build-time mode switch (zero-regression requirement):
//   unset / "judge"  -> / renders the CP3 six-tab judge dashboard, exactly as before
//   "product"        -> / renders the product marketing landing page
// The judge dashboard is ALWAYS available at /judge in either mode.
const PRODUCT = process.env.NEXT_PUBLIC_AEGIS_MODE === "product";

export default function Page() {
  return PRODUCT ? <Landing /> : <JudgeDashboard />;
}
