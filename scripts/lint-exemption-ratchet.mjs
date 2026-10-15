import { spawnSync } from "node:child_process";

const result = spawnSync(
  "pnpm",
  [
    "exec",
    "oxlint",
    "--config",
    "scripts/oxlint-debt-ledger.config.ts",
    "--format",
    "json",
    "--ignore-pattern",
    "tools/oxlint/anti-slop/**",
    ".",
  ],
  { encoding: "utf-8" }
);

if (result.error || result.status !== 0) {
  process.stderr.write(result.stderr ?? "");
  process.stderr.write(result.stdout ?? "");
  process.stderr.write(
    "Lint-exemption ratchet refused: the baseline is zero directives.\n"
  );
  process.exitCode = 1;
}
