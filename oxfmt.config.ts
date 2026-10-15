import { defineConfig } from "oxfmt";
import ultracite from "ultracite/oxfmt";

export default defineConfig({
  ...ultracite,
  ignorePatterns: [
    ".brain/**",
    ".pi/**",
    "BRAIN.md",
    "node_modules/**",
    "tools/oxlint/anti-slop/**",
  ],
});
