/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The dashboard is a pure client of the agent API (CORS is open there),
  // so no rewrites/proxies are needed. The agent URL is env-driven:
  //   NEXT_PUBLIC_AGENT_URL  (build/dev time default)
  // and can be overridden at runtime via the in-app settings (localStorage).
};

export default nextConfig;
