// Keepalive — free-tier hygiene.
//
// Render free web services sleep after 15 min without inbound traffic, and
// Neon's free compute autosuspends after ~5 min idle. A tiny self-ping every
// 10 minutes keeps BOTH the agent and (optionally) the dashboard warm, and
// the `SELECT 1` keeps the database's compute awake. One interval, three
// birds. Swap KEEPALIVE_URL for the dashboard's public URL at deploy time.

import { config } from "./config.js";
import { getStore } from "./store.js";

export function startKeepalive(selfUrl) {
  const intervalMs = 10 * 60 * 1000;
  let n = 0;
  const ping = async () => {
    n += 1;
    try {
      if (selfUrl) await fetch(`${selfUrl.replace(/\/$/, "")}/health`, { signal: AbortSignal.timeout(20000) });
    } catch { /* provider sleep edge — next tick retries */ }
    try {
      if (config.keepaliveUrl) await fetch(config.keepaliveUrl.replace(/\/$/, ""), { signal: AbortSignal.timeout(20000) });
    } catch { /* dashboard sleeping is fine — first visitor wakes it */ }
    try {
      const store = getStore();
      if (store.kind === "pg") await store.ping();
    } catch { /* neon waking up — next tick */ }
    if (n === 1) console.log("  keepalive: self-ping every 10m (free-tier stays warm)");
  };
  setTimeout(ping, 60 * 1000); // first ping after a minute
  return setInterval(ping, intervalMs);
}
