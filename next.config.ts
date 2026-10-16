import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  env: {
    // Which deploy this copy of the app came from. A mirror runs for days
    // without a reload, so it compares this with /version and refreshes itself
    // (between visits) when a newer deploy is out. Vercel sets the commit SHA.
    NEXT_PUBLIC_BUILD_ID: process.env.VERCEL_GIT_COMMIT_SHA || "dev",
  },
};

export default nextConfig;
