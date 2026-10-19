/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The dev server blocks its own resources (scripts, HMR) for other origins than localhost: opened as 127.0.0.1 or a
  // LAN address the page stays server-rendered HTML without React. CODEMODE_DEV_ORIGINS adds hosts (comma-separated).
  allowedDevOrigins: ["127.0.0.1", ...(process.env.CODEMODE_DEV_ORIGINS ?? "").split(",").map((h) => h.trim()).filter(Boolean)],
  turbopack: {
    root: import.meta.dirname,
  },
  typescript: {
    ignoreBuildErrors: false,
  },
};

export default nextConfig;
