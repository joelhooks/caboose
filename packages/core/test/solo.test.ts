import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import type {
  CheckRun,
  SoloEvent,
  SoloFact,
  SoloInput,
  SoloIntent,
} from "../src/domain.js";
import type { PersistedSolo } from "../src/solo-host.js";
import { openSolo, readSolo, stepSolo } from "../src/solo-host.js";
import { JUDGE, minutes } from "./fixtures.js";
import { jsonSnapshot } from "./json-snapshot.js";
import { required } from "./required.js";

const PR = 41;

const HEAD = "synthetic-revision-30";

const EARLIER_HEAD = "synthetic-revision-23";

const BASE = "synthetic-revision-200077";

const OWNER = "contributor/alpha";

const SEED_ERROR = "FixtureSetupError: synthetic fixture setup failed";

const RED_RUN = 1018;

const run = (
  name: string,
  headSha: string,
  conclusion: CheckRun["conclusion"],
  id: number,
  attempt = 1
): CheckRun => {
  const check: CheckRun = {
    attempt,
    conclusion,
    headSha,
    id,
    name,
    status: "completed",
  };

  const withRun = headSha === HEAD ? { ...check, runId: RED_RUN } : check;

  return conclusion === "failure"
    ? { ...withRun, excerpt: SEED_ERROR }
    : withRun;
};

const SHARDS = [
  "integration shard 1/3",
  "integration shard 2/3",
  "integration shard 3/3",
];

const RED_IDS = [1009, 1007, 1006];

const BASE_IDS = [1004, 1003, 1005];

const AGGREGATE = run("checks", HEAD, "failure", 1012);

const redOnHead: readonly CheckRun[] = [
  ...SHARDS.map((name, index) =>
    run(name, HEAD, "failure", required(RED_IDS[index]))
  ),
  AGGREGATE,
  run("lint and format", HEAD, "success", 1010),
  run("unit shard 1/9", HEAD, "success", 1008),
  run("branch-current", HEAD, "failure", 1011),
  run("advisory status", HEAD, "neutral", 1013),
];

const retry = (
  conclusion: CheckRun["conclusion"],
  names = SHARDS
): readonly CheckRun[] =>
  names.map((name, index) => run(name, HEAD, conclusion, 1014 + index, 2));

const onBase = (
  conclusion: CheckRun["conclusion"],
  names = SHARDS
): readonly CheckRun[] =>
  names.map((name) =>
    run(name, BASE, conclusion, required(BASE_IDS[SHARDS.indexOf(name)]))
  );

const input = (
  checks: readonly CheckRun[] = redOnHead,
  head = HEAD
): SoloInput => ({
  aggregateChecks: ["checks"],
  at: minutes(0),
  base: BASE,
  checks,
  ciTimeoutMs: 60 * 60_000,
  head,
  ignoredChecks: ["branch-current"],
  owner: OWNER,
  pollMs: 90_000,
  pr: PR,
  repo: "example/project",
});

const triage = Effect.fn("triage")(function* triage(
  events: readonly SoloEvent[],
  opened: SoloInput = input()
) {
  let persisted: PersistedSolo = yield* openSolo(opened);

  for (const event of events) {
    const snapshot = yield* readSolo(persisted);

    if (snapshot.status !== "active") {
      break;
    }

    persisted = jsonSnapshot(yield* stepSolo(persisted, [event]));
  }

  return yield* readSolo(persisted);
});

const kinds = (intents: readonly SoloIntent[]) =>
  intents.map((intent) => intent.kind);

const attempts = (facts: readonly SoloFact[]) =>
  facts.flatMap((fact) =>
    fact.kind === "attempt"
      ? [`${fact.role} ${fact.check} ${fact.conclusion}`]
      : []
  );

describe("solo triage", () => {
  it.effect(
    "#41: red again on re-run, green on its base without the patch: the owner hears it's theirs",
    () =>
      Effect.gen(function* scenario1() {
        const snapshot = yield* triage([
          {
            at: minutes(12),
            checks: [...redOnHead, ...retry("failure")],
            head: HEAD,
            type: "checks",
          },
          {
            at: minutes(13),
            base: BASE,
            checks: onBase("success"),
            type: "baseline",
          },
        ]);

        expect(snapshot.value).toBe("regression");
        expect(kinds(snapshot.context.intents)).toEqual([
          "RerunFailed",
          "RunBaseline",
          "NotifyOwner",
        ]);

        const [rerun, baseline, notify] = snapshot.context.intents;
        expect(rerun).toMatchObject({
          checkRunIds: RED_IDS,
          checks: SHARDS,
          head: HEAD,
          workflowRunIds: [RED_RUN],
        });
        expect(baseline).toMatchObject({ base: BASE, checks: SHARDS });
        expect(notify).toMatchObject({
          owner: OWNER,
          pr: PR,
          reason: "regression",
        });
        expect(notify?.kind === "NotifyOwner" && notify.excerpt).toContain(
          "FixtureSetupError"
        );

        expect(attempts(snapshot.context.facts)).toEqual([
          ...SHARDS.map((name) => `original ${name} failure`),
          ...SHARDS.map((name) => `rerun ${name} failure`),
          ...SHARDS.map((name) => `baseline ${name} success`),
        ]);
      })
  );

  it.effect(
    "green on the same-context re-run is a flake: kept in the ledger, nobody paged",
    () =>
      Effect.gen(function* scenario2() {
        const snapshot = yield* triage([
          {
            at: minutes(12),
            checks: [...redOnHead, ...retry("success")],
            head: HEAD,
            type: "checks",
          },
        ]);

        expect(snapshot.value).toBe("flake");
        expect(kinds(snapshot.context.intents)).toEqual(["RerunFailed"]);
        expect(attempts(snapshot.context.facts)).toEqual([
          ...SHARDS.map((name) => `original ${name} failure`),
          ...SHARDS.map((name) => `rerun ${name} success`),
        ]);
      })
  );

  it.effect(
    "red on the base too: the operator hears the base is broken, the owner isn't blamed",
    () =>
      Effect.gen(function* scenario3() {
        const snapshot = yield* triage([
          {
            at: minutes(12),
            checks: retry("failure"),
            head: HEAD,
            type: "checks",
          },
          {
            at: minutes(13),
            base: BASE,
            checks: [
              ...onBase("success", SHARDS.slice(0, 2)),
              ...onBase("failure", SHARDS.slice(2)),
            ],
            type: "baseline",
          },
        ]);

        expect(snapshot.value).toBe("baseRed");
        expect(kinds(snapshot.context.intents)).toEqual([
          "RerunFailed",
          "RunBaseline",
          "NotifyOperator",
        ]);
        expect(snapshot.context.intents.at(-1)).toMatchObject({
          outcome: "baseRed",
          pr: PR,
        });
      })
  );

  it.effect("a runner failure that heals on re-run is infra, and quiet", () =>
    Effect.gen(function* scenario4() {
      const cancelled = [
        run("integration shard 2/3", HEAD, "cancelled", required(RED_IDS[1])),
      ];

      const snapshot = yield* triage(
        [
          {
            at: minutes(12),
            checks: retry("success", ["integration shard 2/3"]),
            head: HEAD,
            type: "checks",
          },
        ],
        input(cancelled)
      );

      expect(snapshot.value).toBe("infra");
      expect(kinds(snapshot.context.intents)).toEqual(["RerunFailed"]);
    })
  );

  it.effect(
    "a re-run that fails on the runner again is infra, and the operator hears it; no baseline",
    () =>
      Effect.gen(function* scenario5() {
        const snapshot = yield* triage([
          {
            at: minutes(12),
            checks: retry("startup_failure"),
            head: HEAD,
            type: "checks",
          },
        ]);

        expect(snapshot.value).toBe("infra");
        expect(kinds(snapshot.context.intents)).toEqual([
          "RerunFailed",
          "NotifyOperator",
        ]);
      })
  );

  it.effect(
    "a re-run that times out is a real red: it goes to the baseline, not to infra",
    () =>
      Effect.gen(function* scenario6() {
        const snapshot = yield* triage([
          {
            at: minutes(70),
            checks: retry("timed_out"),
            head: HEAD,
            type: "checks",
          },
        ]);

        expect(snapshot.value).toBe("baselining");
      })
  );

  it.effect(
    "only the checks still red after the re-run go to the baseline",
    () =>
      Effect.gen(function* scenario7() {
        const snapshot = yield* triage([
          {
            at: minutes(12),
            checks: [
              ...retry("success", SHARDS.slice(0, 2)),
              ...retry("failure", SHARDS.slice(2)),
            ],
            head: HEAD,
            type: "checks",
          },
        ]);

        expect(snapshot.value).toBe("baselining");
        expect(snapshot.context.intents.at(-1)).toMatchObject({
          checks: ["integration shard 3/3"],
          kind: "RunBaseline",
        });
      })
  );

  it.effect(
    "the original run re-posted, or a re-run still in progress, is not a verdict",
    () =>
      Effect.gen(function* scenario8() {
        const snapshot = yield* triage([
          { at: minutes(5), checks: redOnHead, head: HEAD, type: "checks" },
          {
            at: minutes(8),
            checks: retry("failure").map((later) => ({
              ...later,
              conclusion: null,
              status: "in_progress" as const,
            })),
            head: HEAD,
            type: "checks",
          },
        ]);

        expect(snapshot.value).toBe("retrying");
        expect(attempts(snapshot.context.facts)).toHaveLength(SHARDS.length);
      })
  );

  it.effect("re-run results may arrive across several posts", () =>
    Effect.gen(function* scenario9() {
      const later = retry("success");

      const snapshot = yield* triage([
        {
          at: minutes(10),
          checks: later.slice(0, 2),
          head: HEAD,
          type: "checks",
        },
        { at: minutes(12), checks: later.slice(2), head: HEAD, type: "checks" },
      ]);

      expect(snapshot.value).toBe("flake");
    })
  );

  it.effect(
    "#41's earlier head: a new push supersedes its triage, quietly",
    () =>
      Effect.gen(function* scenario10() {
        const earlier = SHARDS.map((name, index) =>
          run(name, EARLIER_HEAD, "failure", 1002 + index)
        );

        const snapshot = yield* triage(
          [{ at: minutes(21), head: HEAD, type: "newHead" }],
          input(earlier, EARLIER_HEAD)
        );

        expect(snapshot.value).toBe("superseded");
        expect(kinds(snapshot.context.intents)).toEqual(["RerunFailed"]);
      })
  );

  it.effect("no result by the CI deadline is unknown; polls until then", () =>
    Effect.gen(function* scenario11() {
      const snapshot = yield* triage([
        { at: minutes(2), type: "tick" },
        { at: minutes(30), type: "tick" },
        { at: minutes(61), type: "tick" },
      ]);

      expect(snapshot.value).toBe("unknown");
      expect(kinds(snapshot.context.intents)).toEqual([
        "RerunFailed",
        "PollChecks",
        "PollChecks",
        "NotifyOperator",
      ]);
    })
  );

  it.effect(
    "Judge's call rides along with the notification but doesn't change the outcome",
    () =>
      Effect.gen(function* scenario12() {
        const flakyJudge = {
          at: minutes(11),
          classes: {
            baseRed: 0.01,
            flake: 0.9,
            infra: 0.05,
            regression: "unknown" as const,
          },
          evidence: [
            {
              detail: "synthetic co-failure evidence",
              kind: "coFailure" as const,
            },
          ],
          head: HEAD,
          judge: JUDGE,
          type: "judged" as const,
        };

        const snapshot = yield* triage([
          { ...flakyJudge, at: minutes(11) },
          { ...flakyJudge, at: minutes(11), head: "some-other-head" },
          {
            at: minutes(12),
            checks: retry("failure"),
            head: HEAD,
            type: "checks",
          },
          {
            at: minutes(13),
            base: BASE,
            checks: onBase("success"),
            type: "baseline",
          },
        ]);

        expect(snapshot.value).toBe("regression");
        expect(snapshot.context.intents.at(-1)).toMatchObject({
          judgment: { classes: flakyJudge.classes, judge: JUDGE },
          kind: "NotifyOwner",
        });
        expect(
          snapshot.context.facts.filter((fact) => fact.kind === "judged")
        ).toHaveLength(1);
        expect(
          snapshot.context.rejected.map((rejection) => rejection.type)
        ).toEqual(["judged"]);
      })
  );

  it.effect(
    "an aggregate check is derived beside a real red, and triaged when it is the only red",
    () =>
      Effect.gen(function* scenario13() {
        const beside = yield* triage([]);

        const alone = yield* triage(
          [],
          input(
            redOnHead.map((check) =>
              SHARDS.includes(check.name)
                ? { ...check, conclusion: "success" as const }
                : check
            )
          )
        );

        expect(beside.context.original.map((check) => check.name)).toEqual(
          SHARDS
        );
        expect(alone.context.original.map((check) => check.name)).toEqual([
          "checks",
        ]);
      })
  );

  it.effect(
    "a head with nothing red but branch-current has nothing to triage",
    () =>
      Effect.gen(function* scenario14() {
        const green = redOnHead.map((check) =>
          check.name === "branch-current"
            ? check
            : { ...check, conclusion: "success" as const }
        );

        const refused = yield* openSolo(input(green)).pipe(Effect.flip);

        expect(refused._tag).toBe("NotRed");
      })
  );
});
