import { defineConfig } from "cf/config";

export default defineConfig({
  // Personal account that owns the dennewitz.computer zone.
  accountId: "8cae5de6960fc2df1b9e9c1d95528edc",
  worker: {
    name: "microrhythms",
    compatibilityDate: "2026-09-21",
    domains: ["microrhythms.dennewitz.computer"],
    observability: { enabled: true },
  },
});
