/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // the page as static files in out/ (server/pages.ts serves them; docs/rust-portierung.en.md R8.0 item 4)
  output: "export",
  // The dev server serves its scripts and HMR only to known origins; SPACES_MMO_DEV_ORIGINS adds hosts (comma-separated).
  allowedDevOrigins: ["127.0.0.1", ...(process.env.SPACES_MMO_DEV_ORIGINS ?? "").split(",").map((h) => h.trim()).filter(Boolean)],
  turbopack: {
    root: import.meta.dirname,
  },
  typescript: {
    ignoreBuildErrors: false,
  },
};

export default nextConfig;
