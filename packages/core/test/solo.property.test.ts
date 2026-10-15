import { describe, expect, it } from "@effect/vitest";
import { createEffectActor, send, waitFor } from "@xstate/effect";
import { Effect, Schema } from "effect";
import * as Arbitrary from "effect/Arbitrary";

import type { CheckRun, SoloEvent, SoloInput } from "../src/domain.js";
import type { SoloSnapshot } from "../src/solo-host.js";
import { readSolo, stepSolo } from "../src/solo-host.js";
import { soloMachine } from "../src/solo.js";
import { JUDGE, T0 } from "./fixtures.js";
import { jsonSnapshot } from "./json-snapshot.js";
import { Rules } from "./solo-rules.js";

const HEAD = "head-1";

const BASE = "base-1";

const NAMES = [
  "integration shard 1/3",
  "unit shard 4/9",
  "lint and format",
  "checks",
];

const OpeningSchema = Schema.Struct({
  infra: Schema.Int.check(Schema.isBetween({ maximum: 15, minimum: 0 })),
  red: Schema.Int.check(Schema.isBetween({ maximum: 15, minimum: 1 })),
});

const StepSchema = Schema.Struct({
  kind: Schema.Int.check(Schema.isBetween({ maximum: 19, minimum: 0 })),
  mask: Schema.Int.check(Schema.isBetween({ maximum: 255, minimum: 0 })),
  n: Schema.Int.check(Schema.isBetween({ maximum: 99, minimum: 0 })),
  stale: Schema.Boolean,
});

export type Opening = typeof OpeningSchema.Type;

type Step = typeof StepSchema.Type;

const opening = Arbitrary.schema(OpeningSchema);

const steps = Arbitrary.array(Arbitrary.schema(StepSchema), { maxLength: 40 });

const cut = Arbitrary.schema(
  Schema.Int.check(Schema.isBetween({ maximum: 40, minimum: 0 }))
);

const conclusionOf = (n: number): CheckRun["conclusion"] => {
  if (n < 45) {
    return "success";
  }

  if (n < 70) {
    return "failure";
  }

  if (n < 78) {
    return "timed_out";
  }

  if (n < 84) {
    return "cancelled";
  }

  return n < 88 ? "startup_failure" : null;
};

const originalConclusion = (open: Opening, index: number) => {
  if (Math.floor(open.red / 2 ** index) % 2 === 0) {
    return "success";
  }

  return Math.floor(open.infra / 2 ** index) % 2 === 1
    ? "cancelled"
    : "failure";
};

const inputOf = (open: Opening): SoloInput => ({
  aggregateChecks: [],
  at: T0,
  base: BASE,
  checks: NAMES.map((name, index) => ({
    attempt: 1,
    conclusion: originalConclusion(open, index),
    headSha: HEAD,
    id: 100 + index,
    name,
    status: "completed",
  })),
  ciTimeoutMs: 60 * 60_000,
  head: HEAD,
  ignoredChecks: ["branch-current"],
  owner: "contributor/lane",
  pollMs: 90_000,
  pr: 41,
  repo: "example/project",
});

class World {
  now = T0;
  id = 1000;
  readonly attempt = new Map<string, number>();
  readonly opened: SoloInput;

  constructor(opened: SoloInput) {
    this.opened = opened;
  }

  runs(sha: string, step: Step, retry: boolean): CheckRun[] {
    const chosen = NAMES.filter(
      (_, index) => Math.floor(step.mask / 2 ** index) % 2 === 1
    );

    return (chosen.length === 0 ? NAMES : chosen).flatMap((name, index) => {
      if (retry && step.stale) {
        return this.opened.checks.filter((run) => run.name === name);
      }

      const many = retry && step.n % 5 === 0 ? 2 : 1;

      return Array.from({ length: many }, (_, extra) => {
        const attempt = retry ? (this.attempt.get(name) ?? 2) : 1;

        const conclusion = conclusionOf(
          (step.n + index * 23 + extra * 41) % 100
        );

        if (retry) {
          this.attempt.set(name, attempt + 1);
        }

        this.id += 1;

        return {
          attempt,
          conclusion,
          headSha: sha,
          id: this.id,
          name,
          status:
            conclusion === null
              ? ("in_progress" as const)
              : ("completed" as const),
        };
      });
    });
  }

  judged(step: Step, wrong: boolean): SoloEvent {
    return {
      at: this.now,
      classes: {
        baseRed: step.n % 3 === 0 ? "unknown" : (step.n % 10) / 10,
        flake: ((step.n * 7) % 10) / 10,
        infra: 0.1,
        regression: step.stale ? "unknown" : ((step.n * 3) % 10) / 10,
      },
      evidence:
        step.n % 2 === 0
          ? [{ detail: "co-failed with #40", kind: "coFailure" }]
          : [],
      head: wrong ? "head-x" : HEAD,
      judge: JUDGE,
      type: "judged",
    };
  }

  next(snapshot: SoloSnapshot, step: Step): SoloEvent {
    this.now += 60_000;
    const wrong = Math.floor(step.mask / 2 ** 7) % 2 === 1;

    switch (step.kind) {
      case 11:
      case 12:
      case 13: {
        this.now += (step.n % 4) * 10 * 60_000;

        return { at: this.now, type: "tick" };
      }

      case 14:
      case 15: {
        return this.judged(step, wrong);
      }

      case 16: {
        return step.n % 4 === 0
          ? { at: this.now, head: "head-2", type: "newHead" }
          : { at: this.now, type: "tick" };
      }

      case 17: {
        return step.n % 20 === 0
          ? { at: this.now, reason: "operator dismissed it", type: "dismiss" }
          : {
              at: this.now,
              checks: this.runs(HEAD, step, true),
              head: HEAD,
              type: "checks",
            };
      }

      default: {
        if (step.kind >= 7 && step.kind <= 10) {
          return {
            at: this.now,
            base: wrong ? "base-x" : BASE,
            checks: step.stale
              ? [
                  ...this.runs("base-x", { ...step, n: 0 }, false),
                  ...this.runs(BASE, step, false),
                ]
              : this.runs(wrong ? "base-x" : BASE, step, false),
            type: "baseline",
          };
        }

        return snapshot.value === "baselining" && step.kind % 2 === 0
          ? {
              at: this.now,
              base: BASE,
              checks: this.runs(BASE, step, false),
              type: "baseline",
            }
          : {
              at: this.now,
              checks: this.runs(wrong ? "head-x" : HEAD, step, true),
              head: wrong ? "head-x" : HEAD,
              type: "checks",
            };
      }
    }
  }
}

const deliver = Effect.fn("deliver")(function* deliver(
  actor: Effect.Success<
    ReturnType<typeof createEffectActor<typeof soloMachine>>
  >,
  event: SoloEvent,
  token: number
) {
  yield* send(actor, event);
  yield* send(actor, { token, type: "sync" });

  return yield* waitFor(
    actor,
    (snapshot) =>
      snapshot.status !== "active" || snapshot.context.sync === token
  );
});

const runLive = Effect.fn("runLive")(function* runLive(
  open: Opening,
  generated: readonly Step[]
) {
  const opened = inputOf(open);
  const actor = yield* createEffectActor(soloMachine, { input: opened });
  const world = new World(opened);
  const rules = new Rules(open);
  rules.opened(actor.getSnapshot());
  let token = 0;

  for (const step of generated) {
    const before = actor.getSnapshot();

    if (before.status !== "active") {
      break;
    }

    const event = world.next(before, step);
    token += 1;
    rules.check(before, event, yield* deliver(actor, event, token));
  }

  return { persisted: actor.getPersistedSnapshot(), rules };
}, Effect.scoped);

const replay = Effect.fn("replay")(function* replay(
  open: Opening,
  events: readonly SoloEvent[],
  at: number
) {
  const split = Math.min(at, events.length);
  const actor = yield* createEffectActor(soloMachine, { input: inputOf(open) });
  let token = 0;

  for (const event of events.slice(0, split)) {
    if (actor.getSnapshot().status !== "active") {
      break;
    }

    token += 1;
    yield* deliver(actor, event, token);
  }

  const saved = jsonSnapshot(actor.getPersistedSnapshot());

  const rest = events.slice(split);

  return rest.length === 0 || saved.status !== "active"
    ? saved
    : yield* stepSolo(saved, rest);
}, Effect.scoped);

const comparable = (snapshot: SoloSnapshot) => {
  const { context, status, value } = snapshot;
  const { sync: _sync, ...rest } = context;

  return { context: rest, status, value };
};

const withoutJudge = (snapshot: SoloSnapshot) => {
  const { context, status, value } = snapshot;

  return {
    facts: context.facts.filter((fact) => fact.kind !== "judged"),
    intents: context.intents.map((intent) =>
      "judgment" in intent ? { ...intent, judgment: undefined } : intent
    ),
    status,
    value,
  };
};

describe("solo triage rules over generated traces", () => {
  it.effect.prop(
    "one re-run, every attempt kept once, the owner told only of a baseline-proven regression, new heads supersede",
    { generated: steps, open: opening },
    ({ generated, open }) =>
      Effect.gen(function* scenario1() {
        yield* runLive(open, generated);
      }),
    { arbitrary: { runs: 400, size: 100 } }
  );

  it.effect.prop(
    "Judge annotates and never decides: dropping or scrambling its calls changes no outcome, run or intent",
    { generated: steps, open: opening },
    ({ generated, open }) =>
      Effect.gen(function* scenario2() {
        const live = yield* runLive(open, generated);
        const { posted } = live.rules;

        const silent = yield* replay(
          open,
          posted.filter((event) => event.type !== "judged"),
          0
        );

        const scrambled = yield* replay(
          open,
          posted.map((event) =>
            event.type === "judged"
              ? {
                  ...event,
                  classes: {
                    baseRed: "unknown" as const,
                    flake: 1,
                    infra: 0,
                    regression: 0,
                  },
                  evidence: [],
                }
              : event
          ),
          0
        );

        expect(withoutJudge(yield* readSolo(silent))).toEqual(
          withoutJudge(yield* readSolo(live.persisted))
        );
        expect(withoutJudge(yield* readSolo(scrambled))).toEqual(
          withoutJudge(yield* readSolo(live.persisted))
        );
      }),
    { arbitrary: { runs: 200, size: 100 } }
  );

  it.effect.prop(
    "a triage restored from JSON at any point ends where the uninterrupted triage ends",
    { at: cut, generated: steps, open: opening },
    ({ at, generated, open }) =>
      Effect.gen(function* scenario3() {
        const live = yield* runLive(open, generated);
        const restored = yield* replay(open, live.rules.posted, at);

        expect(comparable(yield* readSolo(restored))).toEqual(
          comparable(yield* readSolo(live.persisted))
        );
      }),
    { arbitrary: { runs: 200, size: 100 } }
  );

  it.effect("the generator reaches every outcome it claims to check", () =>
    Effect.gen(function* scenario4() {
      const traces = yield* Arbitrary.sampleEffect(
        Arbitrary.all({ generated: steps, open: opening }),
        { count: 400, seed: 11, size: 100 }
      ).pipe(Effect.orDie);

      const reached = new Map<string, number>();

      for (const { generated, open } of traces) {
        const { persisted } = yield* runLive(open, generated);
        const { value } = yield* readSolo(persisted);
        reached.set(value, (reached.get(value) ?? 0) + 1);
      }

      for (const outcome of [
        "flake",
        "infra",
        "regression",
        "baseRed",
        "superseded",
        "unknown",
      ]) {
        expect(
          reached.get(outcome) ?? 0,
          JSON.stringify(Object.fromEntries(reached))
        ).toBeGreaterThan(5);
      }
    })
  );
});
