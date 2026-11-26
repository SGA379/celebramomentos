/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    // The calendar print file (lib/pod/calendar-pdf.ts, lib/pod/pdf-preflight.ts) embeds these fonts and ICC
    // profiles, read from disk at run time. They are listed here so they are deployed with every API function
    // (paid-order hooks, cron, admin) that can make it.
    outputFileTracingIncludes: {
      "/api/**/*": ["./lib/pod/fonts/**/*", "./lib/pod/icc/**/*"],
    },
  },
};

export default nextConfig;
