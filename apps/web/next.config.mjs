/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ["@turtle/core", "@turtle/db"],
  // standalone tracing needs symlinks — enable only in Docker builds (Windows dev lacks the privilege)
  output: process.env.NEXT_STANDALONE === "1" ? "standalone" : undefined,
  webpack: (config) => {
    // workspace packages use ESM ".js" specifiers pointing at ".ts" sources
    config.resolve.extensionAlias = {
      ".js": [".ts", ".tsx", ".js"],
    };
    config.externals.push("better-sqlite3");
    return config;
  },
};

export default nextConfig;
