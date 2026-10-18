// Vercel entry — ONE Node function serves every agent route.
//
// vercel.json rewrites /(.*) -> /api, and Vercel rewrites preserve the
// original request path in req.url, so the agent's canonical routes
// (/health, /auth/signup, /me/command, ...) work unchanged:
//
//   https://<this-deployment>/health          -> GET  /health
//   https://<this-deployment>/auth/signup     -> POST /auth/signup
//   https://<this-deployment>/me/command      -> POST /me/command
//
// maxDuration 300s (Hobby + Fluid compute maximum) covers the worst-case
// live-chain vault provisioning (~180s bound) that continues after the
// signup response via waitUntil — see bg()/bootForServerless() in server.js.

import { handleAegisRequest, bootForServerless } from "../src/server.js";

export default async function handler(req, res) {
  await bootForServerless();
  return handleAegisRequest(req, res);
}
