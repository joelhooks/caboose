import { describe, expect, it } from "@effect/vitest";
import { Effect, Result, Schema } from "effect";

import { PostedEventSchema, toTrainEvent } from "../src/domain.js";
import {
  openTrain,
  readTrain,
  stateName,
  stepTrain,
  viewTrain,
} from "../src/host.js";
import { PlanSchema } from "../src/plan.js";
import { input, T0, TRAIN_1_SLICES } from "./fixtures.js";
import { jsonSnapshot } from "./json-snapshot.js";

const postedPlan = Schema.TaggedStruct("plan", {
  at: Schema.Int,
  landed: Schema.Array(Schema.String),
  plan: PlanSchema,
});

const plan = PlanSchema.make({
  edges: [{ after: "remove", before: "install" }],
  nodes: [{ id: "install" }, { id: "remove", pr: 23 }],
});

const decodePosted = Schema.decodeUnknownEffect(
  Schema.fromJsonString(PostedEventSchema)
);

describe("posting a plan to the train", () => {
  it("rejects malformed or cyclic plan JSON and unknown landed IDs at the posted boundary", () => {
    const decode = Schema.decodeUnknownResult(
      Schema.fromJsonString(PostedEventSchema)
    );

    for (const text of [
      '{"_tag":"plan","at":0,"landed":[],"plan":{"nodes":[{"id":"one"}],"edges":[{"before":"one","after":"one"}]}}',
      '{"_tag":"plan","at":0,"landed":[],"plan":{"nodes":[{"id":"one"}],"edges":[{"before":"missing","after":"one"}]}}',
      '{"_tag":"plan","at":0,"landed":[],"plan":{"nodes":[{"id":"one"},{"id":"one"}],"edges":[]}}',
      '{"_tag":"plan","at":0,"landed":["missing"],"plan":{"nodes":[],"edges":[]}}',
      '{"_tag":"plan","at":0,"landed":[],"plan":{"nodes":[{"id":"one","priority":0.5}],"edges":[]}}',
    ]) {
      expect(Result.isFailure(decode(text))).toBe(true);
    }
  });

  it.effect(
    "replaces the plan and landing facts before departure without inferring main from the pool",
    () =>
      Effect.gen(function* replacePlan() {
        const posted = yield* decodePosted(
          JSON.stringify(postedPlan.make({ at: T0, landed: [], plan }))
        );

        const fresh = yield* openTrain(input(1));

        const waiting = yield* stepTrain(fresh, [
          toTrainEvent(posted),
          {
            at: T0,
            candidates: TRAIN_1_SLICES.slice(0, 1),
            main: "main-one",
            type: "candidates",
          },
          { at: T0, type: "depart" },
        ]);

        const held = yield* readTrain(waiting);

        expect(stateName(held)).toBe("collecting");
        expect(held.context.cars).toEqual([]);
        const saved = jsonSnapshot(waiting);

        const replaced = yield* stepTrain(saved, [
          toTrainEvent(postedPlan.make({ at: T0, landed: ["install"], plan })),
        ]);

        const visible = viewTrain(yield* readTrain(replaced));

        expect(visible.plan).toEqual(plan);
        expect(visible.landed).toEqual(["install"]);

        const departed = yield* readTrain(
          yield* stepTrain(jsonSnapshot(replaced), [{ at: T0, type: "depart" }])
        );

        expect(stateName(departed)).toBe("building");
        expect(departed.context.cars.map((car) => car.number)).toEqual([23]);
        expect(departed.context.build?.base).toBe("main-one");

        const cleared = yield* stepTrain(waiting, [
          toTrainEvent(
            postedPlan.make({
              at: T0,
              landed: [],
              plan: { edges: [], nodes: [] },
            })
          ),
          { at: T0, type: "depart" },
        ]);

        expect((yield* readTrain(cleared)).context.cars).toEqual(
          departed.context.cars
        );
      })
  );
});
