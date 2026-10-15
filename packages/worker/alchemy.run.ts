import { DEFAULT_CARS } from "@joelhooks/piper/policy";
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import { localState } from "alchemy/State";
import { Config, Effect } from "effect";

export const infrastructure = Effect.gen(function* infrastructure() {
  const worker = yield* Cloudflare.Worker("Piper", {
    compatibility: { date: "2026-10-15" },
    env: {
      AGGREGATE_CHECKS: "",
      API_TOKEN: Config.Redacted("API_TOKEN"),
      DEPOT: Cloudflare.DurableObject("Depot", { className: "Depot" }),
      IGNORED_CHECKS: "",
      MAX_CARS: String(DEFAULT_CARS),
      REQUIRE_READ_AUTH: "false",
      SOLO: Cloudflare.DurableObject("Solo", { className: "Solo" }),
      TRAIN: Cloudflare.DurableObject("Train", { className: "Train" }),
      TRAIN_LABEL: "train",
    },
    main: new URL("src/index.ts", import.meta.url).pathname,
  });

  return { worker };
});

export default Alchemy.Stack(
  "Piper",
  {
    providers: Cloudflare.providers(),
    state: localState(),
  },
  infrastructure
);
