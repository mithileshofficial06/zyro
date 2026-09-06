/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The console reads two things the browser must never be handed: an RPC URL
  // that may carry a provider key, and nothing else. Both the subgraph query
  // and the eth_call go through route handlers in app/api for that reason.
  experimental: {}
};

export default nextConfig;
