/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  turbopack: {
    root: import.meta.dirname,
  },
  typescript: {
    ignoreBuildErrors: false,
  },
};

export default nextConfig;
