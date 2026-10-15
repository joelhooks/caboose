import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import type { Candidate, Intent, TrainEvent } from "../src/domain.js";
import type { PersistedTrain } from "../src/host.js";
import { openTrain, readTrain, stateName, stepTrain } from "../src/host.js";
import {
  ciOn,
  input,
  JUDGE,
  MAIN_BEFORE_TRAIN_1,
  minutes,
  numbers,
  TRAIN_1_HEAD,
  TRAIN_1_MERGE,
  TRAIN_1_PR,
  TRAIN_1_SLICES,
  TRAIN_2_HEAD,
  TRAIN_2_PR,
  TRAIN_2_SLICES,
} from "./fixtures.js";
import { jsonSnapshot } from "./json-snapshot.js";
import { required } from "./required.js";

const replay = Effect.fn("replay")(function* replay(
  train: number,
  events: readonly TrainEvent[],
  maxCars?: number
) {
  let persisted: PersistedTrain = yield* openTrain(input(train, maxCars));

  for (const event of events) {
    persisted = jsonSnapshot(yield* stepTrain(persisted, [event]));
  }

  return yield* readTrain(persisted);
});

const intentsOf = <K extends Intent["kind"]>(
  intents: readonly Intent[],
  kind: K
) =>
  intents.filter(
    (intent): intent is Extract<Intent, { kind: K }> => intent.kind === kind
  );

const depart = (
  main: string,
  candidates: readonly Candidate[]
): TrainEvent[] => [
  { at: minutes(0), candidates, main, type: "candidates" },
  { at: minutes(1), type: "depart" },
];

describe("synthetic trains", () => {
  it.effect(
    "train 1: five slices, one CI run, merged on the exact head after GO",
    () =>
      Effect.gen(function* scenario1() {
        const snapshot = yield* replay(1, [
          ...depart(MAIN_BEFORE_TRAIN_1, TRAIN_1_SLICES),
          {
            at: minutes(5),
            buildId: 1,
            conflicted: [],
            head: TRAIN_1_HEAD,
            merged: numbers(TRAIN_1_SLICES),
            type: "built",
          },
          { at: minutes(6), pr: TRAIN_1_PR, type: "prOpened" },
          { at: minutes(5) + 90_000, type: "tick" },
          {
            at: minutes(9),
            checks: ciOn(TRAIN_1_HEAD, "pending"),
            head: TRAIN_1_HEAD,
            type: "checks",
          },
          {
            at: minutes(16),
            checks: ciOn(TRAIN_1_HEAD),
            head: TRAIN_1_HEAD,
            type: "checks",
          },
          { at: minutes(17), by: "operator", head: TRAIN_1_HEAD, type: "go" },
          {
            at: minutes(18),
            head: TRAIN_1_HEAD,
            mergeSha: TRAIN_1_MERGE,
            type: "merged",
          },
        ]);

        const { intents } = snapshot.context;

        expect(stateName(snapshot)).toBe("landed");
        expect(intentsOf(intents, "BuildTrain")).toEqual([
          expect.objectContaining({
            base: MAIN_BEFORE_TRAIN_1,
            branch: "train/1",
            cars: TRAIN_1_SLICES.map(({ headSha, number, owner }) => ({
              headSha,
              number,
              owner,
            })),
            purpose: "train",
          }),
        ]);
        expect(intentsOf(intents, "OpenTrainPr")).toHaveLength(1);
        expect(intentsOf(intents, "PollChecks")).toEqual([
          expect.objectContaining({ head: TRAIN_1_HEAD }),
        ]);
        expect(intentsOf(intents, "Merge")).toEqual([
          expect.objectContaining({ matchHead: TRAIN_1_HEAD, pr: TRAIN_1_PR }),
        ]);
        expect(intentsOf(intents, "RemoveLabels")).toEqual([
          expect.objectContaining({
            label: "train",
            prs: [23, 24, 25, 27, 28, TRAIN_1_PR],
          }),
        ]);
        expect(snapshot.output?.merged?.mergeSha).toBe(TRAIN_1_MERGE);
        expect(new Set(intents.map((intent) => intent.id)).size).toBe(
          intents.length
        );
      })
  );

  it.effect(
    "train 2 went red: the culprit is dropped, its owner gets the excerpt, the rest rebuild",
    () =>
      Effect.gen(function* scenario2() {
        const probeHeads = ["p1", "p2", "p3"];

        const ranks = [
          { p: 0.72, pr: 33 },
          { p: 0.11, pr: 29 },
          { p: 0.08, pr: 30 },
          { p: 0.05, pr: 31 },
          { p: 0.04, pr: 26 },
        ];

        let persisted = yield* stepTrain(yield* openTrain(input(2)), [
          ...depart(TRAIN_1_MERGE, TRAIN_2_SLICES),
          {
            at: minutes(5),
            buildId: 1,
            conflicted: [],
            head: TRAIN_2_HEAD,
            merged: numbers(TRAIN_2_SLICES),
            type: "built",
          },
          { at: minutes(6), pr: TRAIN_2_PR, type: "prOpened" },
          {
            at: minutes(20),
            checks: ciOn(TRAIN_2_HEAD, "red"),
            head: TRAIN_2_HEAD,
            type: "checks",
          },
          {
            at: minutes(21),
            head: TRAIN_2_HEAD,
            judge: JUDGE,
            ranks,
            type: "ranked",
          },
        ]);

        let snapshot = yield* readTrain(persisted);
        expect(stateName(snapshot)).toBe("bisecting.building");
        expect(intentsOf(snapshot.context.intents, "RankSuspects")).toEqual([
          expect.objectContaining({ head: TRAIN_2_HEAD }),
        ]);
        const probes: number[][] = [];

        for (const [index, head] of probeHeads.entries()) {
          snapshot = yield* readTrain(persisted);
          const { build } = snapshot.context;

          if (build?.purpose !== "probe") {
            break;
          }

          const cars = build.cars.map((car) => car.number);
          probes.push(cars);
          persisted = yield* stepTrain(persisted, [
            {
              at: minutes(30 + index * 20),
              buildId: build.id,
              conflicted: [],
              head,
              merged: cars,
              type: "built",
            },
            {
              at: minutes(45 + index * 20),
              checks: ciOn(head, cars.includes(33) ? "red" : "green"),
              head,
              type: "checks",
            },
          ]);
        }

        snapshot = yield* readTrain(persisted);

        expect(probes[0]).toEqual([33, 29, 30]);
        expect(probes.every((probe) => probe.includes(33))).toBe(true);
        expect(stateName(snapshot)).toBe("building");
        expect(snapshot.context.dropped).toMatchObject([
          { car: { number: 33 }, reason: "culprit" },
        ]);

        const notifications = intentsOf(
          snapshot.context.intents,
          "NotifyOwner"
        );

        expect(notifications).toMatchObject([
          { car: { number: 33, owner: "contributor/zeta" }, reason: "culprit" },
        ]);
        expect(notifications[0]?.excerpt).toContain(
          "synthetic assertion: expected blue, got red"
        );
        expect(
          intentsOf(snapshot.context.intents, "BuildTrain").at(-1)?.purpose
        ).toBe("train");
        expect(
          intentsOf(snapshot.context.intents, "BuildTrain")
            .at(-1)
            ?.cars.map((car) => car.number)
        ).toEqual([29, 30, 31, 26]);
        expect(intentsOf(snapshot.context.intents, "Merge")).toEqual([]);
      })
  );

  it.effect(
    "main moves while train 2 is testing: rebuild on the new main, ignore checks for the old head",
    () =>
      Effect.gen(function* scenario3() {
        const snapshot = yield* replay(2, [
          ...depart(TRAIN_1_MERGE, TRAIN_2_SLICES),
          {
            at: minutes(5),
            buildId: 1,
            conflicted: [],
            head: TRAIN_2_HEAD,
            merged: numbers(TRAIN_2_SLICES),
            type: "built",
          },
          { at: minutes(6), pr: TRAIN_2_PR, type: "prOpened" },
          { at: minutes(8), main: "c0ffee", type: "mainMoved" },
          {
            at: minutes(20),
            checks: ciOn(TRAIN_2_HEAD),
            head: TRAIN_2_HEAD,
            type: "checks",
          },
          { at: minutes(21), by: "operator", head: TRAIN_2_HEAD, type: "go" },
        ]);

        const builds = intentsOf(snapshot.context.intents, "BuildTrain");

        expect(stateName(snapshot)).toBe("building");
        expect(builds.map((build) => build.base)).toEqual([
          TRAIN_1_MERGE,
          "c0ffee",
        ]);
        expect(builds[1]?.cars.map((car) => car.number)).toEqual(
          numbers(TRAIN_2_SLICES)
        );
        expect(
          snapshot.context.rejected.map((rejection) => rejection.type)
        ).toEqual(["checks", "go"]);
        expect(intentsOf(snapshot.context.intents, "Merge")).toEqual([]);
      })
  );

  it.effect(
    "a conflicting slice leaves the train and its owner hears why; the rest test",
    () =>
      Effect.gen(function* scenario4() {
        const snapshot = yield* replay(2, [
          ...depart(TRAIN_1_MERGE, TRAIN_2_SLICES),
          {
            at: minutes(5),
            buildId: 1,
            conflicted: [31],
            head: "h-without-31",
            merged: [33, 29, 30, 26],
            type: "built",
          },
        ]);

        expect(stateName(snapshot)).toBe("testing.polling");
        expect(numbers(snapshot.context.cars)).toEqual([33, 29, 30, 26]);
        expect(
          intentsOf(snapshot.context.intents, "NotifyOwner")
        ).toMatchObject([{ car: { number: 31 }, reason: "conflict" }]);
        expect(
          intentsOf(snapshot.context.intents, "OpenTrainPr")[0]?.cars.map(
            (car) => car.number
          )
        ).toEqual([33, 29, 30, 26]);
      })
  );

  it.effect(
    "a timeout Judge doesn't blame gets one re-run; a second timeout bisects",
    () =>
      Effect.gen(function* scenario5() {
        const calm = TRAIN_2_SLICES.map((slice) => ({
          p: 0.05,
          pr: slice.number,
        }));

        const snapshot = yield* replay(2, [
          ...depart(TRAIN_1_MERGE, TRAIN_2_SLICES),
          {
            at: minutes(5),
            buildId: 1,
            conflicted: [],
            head: TRAIN_2_HEAD,
            merged: numbers(TRAIN_2_SLICES),
            type: "built",
          },
          {
            at: minutes(30),
            checks: ciOn(TRAIN_2_HEAD, "timeout"),
            head: TRAIN_2_HEAD,
            type: "checks",
          },
          {
            at: minutes(31),
            head: TRAIN_2_HEAD,
            judge: JUDGE,
            ranks: calm,
            type: "ranked",
          },
          {
            at: minutes(60),
            checks: ciOn(TRAIN_2_HEAD, "timeout"),
            head: TRAIN_2_HEAD,
            type: "checks",
          },
          {
            at: minutes(61),
            head: TRAIN_2_HEAD,
            judge: JUDGE,
            ranks: calm,
            type: "ranked",
          },
        ]);

        expect(intentsOf(snapshot.context.intents, "RerunChecks")).toHaveLength(
          1
        );
        expect(stateName(snapshot)).toBe("bisecting.building");
      })
  );

  it.effect(
    'an "unknown" from Judge is never calm: the timeout bisects in train order',
    () =>
      Effect.gen(function* scenario6() {
        const ranks = TRAIN_2_SLICES.map((slice, index) => ({
          p: index === 2 ? ("unknown" as const) : 0.05,
          pr: slice.number,
        }));

        const snapshot = yield* replay(2, [
          ...depart(TRAIN_1_MERGE, TRAIN_2_SLICES),
          {
            at: minutes(5),
            buildId: 1,
            conflicted: [],
            head: TRAIN_2_HEAD,
            merged: numbers(TRAIN_2_SLICES),
            type: "built",
          },
          {
            at: minutes(30),
            checks: ciOn(TRAIN_2_HEAD, "timeout"),
            head: TRAIN_2_HEAD,
            type: "checks",
          },
          {
            at: minutes(31),
            head: TRAIN_2_HEAD,
            judge: JUDGE,
            ranks,
            type: "ranked",
          },
        ]);

        expect(intentsOf(snapshot.context.intents, "RerunChecks")).toEqual([]);
        expect(stateName(snapshot)).toBe("bisecting.building");

        expect(snapshot.context.bisect?.suspects).toEqual([33, 29, 31, 26, 30]);
      })
  );

  it.effect(
    "the re-run's green outranks the timeout it re-ran, even when both attempts are posted",
    () =>
      Effect.gen(function* scenario7() {
        const calm = TRAIN_2_SLICES.map((slice) => ({
          p: 0.05,
          pr: slice.number,
        }));

        const [timedOut, ...others] = ciOn(TRAIN_2_HEAD, "timeout");

        const snapshot = yield* replay(2, [
          ...depart(TRAIN_1_MERGE, TRAIN_2_SLICES),
          {
            at: minutes(5),
            buildId: 1,
            conflicted: [],
            head: TRAIN_2_HEAD,
            merged: numbers(TRAIN_2_SLICES),
            type: "built",
          },
          { at: minutes(6), pr: TRAIN_2_PR, type: "prOpened" },
          {
            at: minutes(30),
            checks: ciOn(TRAIN_2_HEAD, "timeout"),
            head: TRAIN_2_HEAD,
            type: "checks",
          },
          {
            at: minutes(31),
            head: TRAIN_2_HEAD,
            judge: JUDGE,
            ranks: calm,
            type: "ranked",
          },
          {
            at: minutes(45),
            checks: [
              { ...required(timedOut), attempt: 1, id: 900 },
              {
                ...required(timedOut),
                attempt: 2,
                conclusion: "success",
                id: 901,
              },
              ...others,
            ],
            head: TRAIN_2_HEAD,
            type: "checks",
          },
        ]);

        expect(stateName(snapshot)).toBe("landing.awaitingGo");
        expect(
          snapshot.context.facts.filter((fact) => fact.kind === "judged")
        ).toEqual([
          {
            at: minutes(31),
            failed: undefined,
            head: TRAIN_2_HEAD,
            judge: JUDGE,
            kind: "judged",
            ranks: calm.map((rank) => ({ ...rank, evidence: 0 })),
          },
        ]);
      })
  );

  it.effect(
    "a red Judge blames does not get a re-run, even when it is a timeout",
    () =>
      Effect.gen(function* scenario8() {
        const snapshot = yield* replay(2, [
          ...depart(TRAIN_1_MERGE, TRAIN_2_SLICES),
          {
            at: minutes(5),
            buildId: 1,
            conflicted: [],
            head: TRAIN_2_HEAD,
            merged: numbers(TRAIN_2_SLICES),
            type: "built",
          },
          {
            at: minutes(30),
            checks: ciOn(TRAIN_2_HEAD, "timeout"),
            head: TRAIN_2_HEAD,
            type: "checks",
          },
          {
            at: minutes(31),
            head: TRAIN_2_HEAD,
            judge: JUDGE,
            ranks: [{ p: 0.4, pr: 30 }],
            type: "ranked",
          },
        ]);

        expect(intentsOf(snapshot.context.intents, "RerunChecks")).toEqual([]);
        expect(stateName(snapshot)).toBe("bisecting.building");
        expect(snapshot.context.bisect?.probe[0]).toBe(30);
        expect(numbers(snapshot.context.build?.cars ?? [])).toContain(30);
      })
  );

  describe("the train takes the first eligible slices in the operator's order, up to its cap", () => {
    const a = required(TRAIN_2_SLICES[0]);
    const b = required(TRAIN_2_SLICES[1]);
    const c = required(TRAIN_2_SLICES[2]);
    const d = required(TRAIN_2_SLICES[3]);
    const e = required(TRAIN_2_SLICES[4]);

    const pool: Candidate[] = [
      { ...a, labels: [], number: 35 },
      { ...b, number: 36, operatorReviewed: false },
      { ...c, number: 37, upToDate: false },
      { ...d, checks: ciOn(d.headSha, "red"), number: 38 },
      { ...e, checks: ciOn("someone-else", "green"), number: 39 },
      ...TRAIN_1_SLICES,
      ...TRAIN_2_SLICES,
    ];

    const eligible = [...numbers(TRAIN_1_SLICES), ...numbers(TRAIN_2_SLICES)];

    it.effect("eight cars by default", () =>
      Effect.gen(function* scenario9() {
        const snapshot = yield* replay(3, depart(TRAIN_1_MERGE, pool));

        expect(numbers(snapshot.context.cars)).toEqual(eligible.slice(0, 8));
      })
    );

    it.effect("five when the operator opens a train with maxCars 5", () =>
      Effect.gen(function* scenario10() {
        const snapshot = yield* replay(3, depart(TRAIN_1_MERGE, pool), 5);

        expect(numbers(snapshot.context.cars)).toEqual(numbers(TRAIN_1_SLICES));
      })
    );
  });

  it.effect("no slice is eligible: the train stays collecting", () =>
    Effect.gen(function* scenario11() {
      const snapshot = yield* replay(
        3,
        depart(TRAIN_1_MERGE, [{ ...required(TRAIN_1_SLICES[0]), labels: [] }])
      );

      expect(stateName(snapshot)).toBe("collecting");
      expect(snapshot.context.intents).toEqual([]);
    })
  );
});
