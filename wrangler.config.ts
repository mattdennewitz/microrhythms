import { defineWranglerConfig } from "wrangler/experimental-config";

// The site is buildless: public/ is served as-is.
export default defineWranglerConfig({
  assetsDirectory: "public",
});
