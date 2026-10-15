import { createEffectActor, send, waitFor } from "@xstate/effect";
import { Effect, Schema } from "effect";
import type { SnapshotFrom } from "xstate";

import type { SoloEvent, SoloInput } from "./domain.js";
import { NotRed } from "./not-red.js";
import { failingOn, soloKey, soloMachine } from "./solo.js";

export { NotRed } from "./not-red.js";

export type SoloSnapshot = SnapshotFrom<typeof soloMachine>;

export type PersistedSolo = ReturnType<typeof soloMachine.getPersistedSnapshot>;

export class SoloFinished extends Schema.TaggedError<SoloFinished>()(
  "SoloFinished",
  {
    key: Schema.String,
    status: Schema.String,
  }
) {}

const settled = (snapshot: SoloSnapshot, token: number) =>
  snapshot.status !== "active" || snapshot.context.sync >= token;

export const openSolo = Effect.fn("Solo.open")(function* openSolo(
  input: SoloInput
) {
  if (failingOn(input.head, input.checks, input.ignoredChecks).length === 0) {
    return yield* new NotRed({ key: soloKey(input.pr, input.head) });
  }

  const actor = yield* createEffectActor(soloMachine, { input });

  return actor.getPersistedSnapshot();
}, Effect.scoped);

export const stepSolo = Effect.fn("Solo.step")(function* stepSolo(
  persisted: PersistedSolo,
  events: readonly SoloEvent[]
) {
  const actor = yield* createEffectActor(soloMachine, { snapshot: persisted });
  const before = actor.getSnapshot();

  if (before.status !== "active") {
    return yield* new SoloFinished({
      key: soloKey(before.context.pr, before.context.head),
      status: before.status,
    });
  }

  const token = before.context.sync + 1;

  for (const event of events) {
    yield* send(actor, event);
  }

  yield* send(actor, { token, type: "sync" });

  yield* waitFor(actor, (snapshot) => settled(snapshot, token)).pipe(
    Effect.orDie
  );

  return actor.getPersistedSnapshot();
}, Effect.scoped);

export const readSolo = Effect.fn("Solo.read")(function* readSolo(
  persisted: PersistedSolo
) {
  const actor = yield* createEffectActor(soloMachine, { snapshot: persisted });

  return actor.getSnapshot();
}, Effect.scoped);

export const soloAlarmAt = (snapshot: SoloSnapshot): number | undefined => {
  const { deadlineAt, pollAt } = snapshot.context;

  const edges = [pollAt, deadlineAt].filter(
    (edge): edge is number => edge !== undefined
  );

  return snapshot.status === "active" && edges.length > 0
    ? Math.min(...edges)
    : undefined;
};

export const viewSolo = (snapshot: SoloSnapshot) => {
  const { context } = snapshot;

  return {
    alarmAt: soloAlarmAt(snapshot),
    base: context.base,
    baselined: context.baselined,
    checks: context.original.map((run) => run.name),
    facts: context.facts,
    head: context.head,
    intents: context.intents,
    judgment: context.judgment,
    key: soloKey(context.pr, context.head),
    outcome: context.outcome,
    owner: context.owner,
    pr: context.pr,
    rejected: context.rejected,
    repo: context.repo,
    state: snapshot.value,
    status: snapshot.status,
  };
};
