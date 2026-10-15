import { describe, expect, it } from "@effect/vitest";
import { CandidateSchema } from "@joelhooks/piper/domain";
import { Clock, Effect, Layer, Schema } from "effect";
import * as Arbitrary from "effect/Arbitrary";
import { TestClock } from "effect/testing";

import { Auth, equalToken } from "../src/auth.js";
import type { ObjectState } from "../src/bindings.js";
import { cellFetch } from "../src/cell.js";
import { Storage } from "../src/storage.js";
import { bodyOf, memory, request } from "./memory.js";

const TOKEN = "test-token";

const solo = JSON.stringify({
  base: "base",
  checks: [
    {
      conclusion: "failure",
      headSha: "head",
      name: "unit",
      status: "completed",
    },
  ],
  head: "head",
  owner: "contributor",
  pr: 7,
});

const Tick = Schema.TaggedStruct("tick", {
  at: Schema.optionalKey(Schema.Int),
});

const Abandon = Schema.TaggedStruct("abandon", { reason: Schema.String });

const Candidates = Schema.TaggedStruct("candidates", {
  candidates: Schema.Array(CandidateSchema),
  main: Schema.String,
});

const tick = JSON.stringify(Tick.make({}));

const note = JSON.stringify({ action: "reviewed", note: "synthetic" });

const View = Schema.StructWithRest(
  Schema.Struct({ state: Schema.String, status: Schema.String }),
  [Schema.Record(Schema.String, Schema.Unknown)]
);

const viewOf = (response: Response) =>
  bodyOf(response).pipe(Effect.flatMap(Schema.decodeUnknownEffect(View)));

const openBoth = Effect.fn("Test.openBoth")(function* openBoth(
  host: ReturnType<typeof memory>
) {
  expect(
    (yield* host.fetch(request("/trains", "POST", "{}", TOKEN))).status
  ).toBe(201);
  expect(
    (yield* host.fetch(request("/solos", "POST", solo, TOKEN))).status
  ).toBe(201);
});

const unavailable = () => {
  throw new Error("storage must not be touched");
};

describe("operator HTTP API", () => {
  it.effect(
    "rejects unauthenticated requests before SQLite initialization",
    () =>
      Effect.gen(function* scenario() {
        const state: ObjectState = {
          blockConcurrencyWhile: unavailable,
          storage: {
            deleteAlarm: unavailable,
            setAlarm: unavailable,
            sql: { exec: unavailable },
            transactionSync: unavailable,
          },
        };

        const response = yield* cellFetch(
          "train",
          request("/open", "POST", "{}")
        ).pipe(
          Effect.provide(
            Layer.merge(Auth.layer({ API_TOKEN: TOKEN }), Storage.layer(state))
          )
        );

        expect(response.status).toBe(401);
      })
  );
  it.effect(
    "requires a token for writes and fails closed without a binding",
    () =>
      Effect.gen(function* scenario() {
        const host = memory();

        for (const token of [
          undefined,
          "wrong-token",
          "",
          "test-token-extra",
        ]) {
          expect(
            (yield* host.fetch(request("/trains", "POST", "{}", token))).status
          ).toBe(401);
          expect(host.documents.size).toBe(0);
        }

        const missing = memory({});
        expect(
          (yield* missing.fetch(request("/trains", "POST", "{}", TOKEN))).status
        ).toBe(401);
        expect(missing.documents.size).toBe(0);
        expect(
          (yield* host.fetch(request("/trains", "POST", "{}", TOKEN))).status
        ).toBe(201);
      })
  );

  it.effect(
    "exposes every read and write route with the reference status codes",
    () =>
      Effect.gen(function* scenario() {
        const host = memory();
        yield* openBoth(host);

        for (const path of [
          "/",
          "/health",
          "/state",
          "/trains",
          "/trains/1",
          "/trains/1/events",
          "/solos",
          "/solos/pr-7@head",
          "/solos/pr-7@head/events",
        ]) {
          expect((yield* host.fetch(request(path, "GET"))).status, path).toBe(
            200
          );
        }

        expect(
          (yield* host.fetch(request("/trains/1/events", "POST", tick, TOKEN)))
            .status
        ).toBe(200);
        expect(
          (yield* host.fetch(
            request("/solos/pr-7@head/events", "POST", tick, TOKEN)
          )).status
        ).toBe(200);
        expect(
          (yield* host.fetch(
            request("/solos/pr-7@head/operator", "POST", note, TOKEN)
          )).status
        ).toBe(200);
        expect(
          (yield* host.fetch(request("/solos", "POST", solo, TOKEN))).status
        ).toBe(409);
        expect(
          (yield* host.fetch(
            request("/trains", "POST", JSON.stringify({ train: 1 }), TOKEN)
          )).status
        ).toBe(409);
        expect((yield* host.fetch(request("/trains/99", "GET"))).status).toBe(
          404
        );
        expect(
          (yield* host.fetch(request("/solos/absent", "GET"))).status
        ).toBe(404);
        expect((yield* host.fetch(request("/absent", "GET"))).status).toBe(404);
        expect((yield* host.fetch(request("/trains/0", "GET"))).status).toBe(
          404
        );

        const state = yield* bodyOf(
          yield* host.fetch(request("/state", "GET"))
        );

        expect(state).toMatchObject({
          current: { train: 1 },
          solos: [{ key: "pr-7@head", operator: ["reviewed"] }],
          trains: [{ train: 1 }],
        });
      })
  );

  it.effect(
    "can protect reads, including health, and keeps default reads open",
    () =>
      Effect.gen(function* scenario() {
        expect(
          (yield* memory({}).fetch(request("/health", "GET"))).status
        ).toBe(200);
        const host = memory({ API_TOKEN: TOKEN, REQUIRE_READ_AUTH: "true" });

        for (const path of [
          "/",
          "/health",
          "/state",
          "/trains",
          "/solos",
          "/trains/1",
          "/solos/pr-7@head/events",
        ]) {
          expect((yield* host.fetch(request(path, "GET"))).status).toBe(401);
          expect(
            (yield* host.fetch(request(path, "GET", undefined, "wrong"))).status
          ).toBe(401);
        }

        expect(
          (yield* host.fetch(request("/health", "GET", undefined, TOKEN)))
            .status
        ).toBe(200);
        expect(
          (yield* memory({ REQUIRE_READ_AUTH: "true" }).fetch(
            request("/health", "GET", undefined, TOKEN)
          )).status
        ).toBe(401);
        yield* openBoth(host);
        expect(
          (yield* host.fetch(request("/state", "GET", undefined, TOKEN))).status
        ).toBe(200);
      })
  );

  it.effect("decodes every write body before mutation", () =>
    Effect.gen(function* scenario() {
      const host = memory();
      yield* openBoth(host);

      for (const [path, body] of [
        ["/trains", "not-json"],
        ["/trains", JSON.stringify({ maxCars: 0 })],
        ["/solos", "{}"],
        ["/trains/1/events", "{}"],
        ["/trains/1/events", '[{"_tag":"tick"},{"_tag":"not-an-event"}]'],
        ["/solos/pr-7@head/events", "{}"],
        ["/solos/pr-7@head/operator", "{}"],
      ]) {
        const before = [...host.documents];
        expect(
          (yield* host.fetch(request(path ?? "", "POST", body, TOKEN))).status
        ).toBe(400);
        expect([...host.documents]).toEqual(before);
      }

      expect(
        (yield* host.direct(
          "DEPOT",
          "depot",
          request("/trains", "POST", JSON.stringify({ n: -1 }), TOKEN)
        )).status
      ).toBe(400);
      expect(
        (yield* host.direct(
          "DEPOT",
          "depot",
          request("/solos", "POST", "{}", TOKEN)
        )).status
      ).toBe(400);
    })
  );

  it.effect(
    "restores across eviction from serialized storage and keeps the event log",
    () =>
      Effect.gen(function* scenario() {
        const host = memory();
        yield* openBoth(host);
        yield* host.fetch(
          request(
            "/trains/1/events",
            "POST",
            JSON.stringify(Abandon.make({ reason: "operator" })),
            TOKEN
          )
        );
        yield* host.fetch(
          request("/solos/pr-7@head/operator", "POST", note, TOKEN)
        );

        const before = yield* viewOf(
          yield* host.fetch(request("/trains/1", "GET"))
        );

        const soloBefore = yield* viewOf(
          yield* host.fetch(request("/solos/pr-7@head", "GET"))
        );

        const evicted = memory({ API_TOKEN: TOKEN }, host.documents);

        const after = yield* viewOf(
          yield* evicted.fetch(request("/trains/1", "GET"))
        );

        expect(after).toEqual(before);
        expect(after.status).toBe("done");
        expect(
          yield* viewOf(
            yield* evicted.fetch(request("/solos/pr-7@head", "GET"))
          )
        ).toEqual(soloBefore);
        expect(
          yield* bodyOf(
            yield* evicted.fetch(request("/trains/1/events", "GET"))
          )
        ).toMatchObject([
          { body: Abandon.make({ reason: "operator" }), seq: 1 },
        ]);
        expect(
          (yield* evicted.fetch(
            request("/trains/1/events", "POST", tick, TOKEN)
          )).status
        ).toBe(409);
      })
  );

  it.effect("re-derives due work and the next alarm after eviction", () =>
    Effect.gen(function* scenario() {
      const host = memory();
      yield* openBoth(host);
      const due = host.alarms.get("SOLO:pr-7@head");
      expect(due).toBeDefined();
      const before = yield* Clock.currentTimeMillis;
      yield* TestClock.adjust(90_000);
      const evicted = memory({ API_TOKEN: TOKEN }, host.documents);
      yield* evicted.alarm("solo", "pr-7@head");

      const view = yield* viewOf(
        yield* evicted.fetch(request("/solos/pr-7@head", "GET"))
      );

      expect(view.intents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ at: before + 90_000, kind: "PollChecks" }),
        ])
      );
      expect(evicted.alarms.get("SOLO:pr-7@head")).toBe(before + 180_000);
      expect(
        yield* bodyOf(
          yield* evicted.fetch(request("/solos/pr-7@head/events", "GET"))
        )
      ).toMatchObject([{ body: Tick.make({ at: before + 90_000 }) }]);
      yield* evicted.alarm("train", "absent");
    })
  );

  it.effect("keeps operator notes separate after solo completion", () =>
    Effect.gen(function* scenario() {
      const host = memory();
      yield* openBoth(host);

      const dismissed = yield* host.fetch(
        request(
          "/solos/pr-7@head/events",
          "POST",
          '{"_tag":"dismiss","reason":"operator"}',
          TOKEN
        )
      );

      expect(dismissed.status).toBe(200);
      const finished = yield* viewOf(dismissed);
      expect(finished.status).toBe("done");

      const annotated = yield* host.fetch(
        request("/solos/pr-7@head/operator", "POST", note, TOKEN)
      );

      expect(annotated.status).toBe(200);
      expect(yield* viewOf(annotated)).toMatchObject({
        operator: [{ action: "reviewed" }],
        status: "done",
      });
      yield* host.alarm("solo", "pr-7@head");
      expect(host.alarms.has("SOLO:pr-7@head")).toBe(false);
    })
  );

  it.effect("starts solo triage from red candidates with a base", () =>
    Effect.gen(function* scenario() {
      const host = memory();
      yield* host.fetch(request("/trains", "POST", "{}", TOKEN));

      const body = JSON.stringify(
        Candidates.make({
          candidates: [
            {
              checks: [
                {
                  baseSha: "base",
                  conclusion: "failure",
                  headSha: "head",
                  name: "unit",
                  status: "completed",
                },
              ],
              headSha: "head",
              labels: ["train"],
              number: 7,
              operatorReviewed: false,
              owner: "contributor",
              upToDate: true,
            },
          ],
          main: "base",
        })
      );

      expect(
        (yield* host.fetch(request("/trains/1/events", "POST", body, TOKEN)))
          .status
      ).toBe(200);
      expect(
        (yield* host.fetch(request("/solos/pr-7@head", "GET"))).status
      ).toBe(200);
    })
  );

  it.effect(
    "treats ignored and aggregate checks as configured and validates maxCars",
    () =>
      Effect.gen(function* scenario() {
        const host = memory({
          API_TOKEN: TOKEN,
          IGNORED_CHECKS: " unit ",
          MAX_CARS: "2",
          TRAIN_LABEL: "ready",
        });

        expect(
          (yield* host.fetch(request("/solos", "POST", solo, TOKEN))).status
        ).toBe(422);
        expect(
          (yield* host.fetch(request("/trains", "POST", "{}", TOKEN))).status
        ).toBe(201);
        expect(
          (yield* memory({ API_TOKEN: TOKEN, MAX_CARS: "invalid" }).fetch(
            request("/trains", "POST", "{}", TOKEN)
          )).status
        ).toBe(400);
      })
  );

  it.effect("passes aggregate-check configuration to solo triage", () =>
    Effect.gen(function* scenario() {
      const host = memory({ AGGREGATE_CHECKS: " summary ", API_TOKEN: TOKEN });

      const opening = JSON.stringify({
        base: "base",
        checks: ["unit", "summary"].map((name) => ({
          conclusion: "failure",
          headSha: "head",
          name,
          status: "completed",
        })),
        head: "head",
        owner: "contributor",
        pr: 7,
      });

      const opened = yield* host.fetch(
        request("/solos", "POST", opening, TOKEN)
      );

      expect(opened.status).toBe(201);
      expect(yield* viewOf(opened)).toMatchObject({ checks: ["unit"] });
    })
  );

  it.effect.prop(
    "compares full token digests without prefix or length matches",
    { token: Arbitrary.schema(Schema.NonEmptyString) },
    ({ token }) =>
      Effect.gen(function* scenario() {
        expect(yield* equalToken(token, token)).toBe(true);
        expect(yield* equalToken(`${token}x`, token)).toBe(false);
        expect(yield* equalToken("", token)).toBe(false);
      })
  );

  it.effect.prop(
    "no write route mutates storage without a valid token",
    {
      writes: Arbitrary.array(
        Arbitrary.schema(
          Schema.Struct({
            method: Schema.Literals(["POST", "PUT", "PATCH", "DELETE"]),
            path: Schema.Literals([
              "/trains",
              "/solos",
              "/trains/1/events",
              "/solos/pr-7@head/events",
              "/solos/pr-7@head/operator",
              "/trains/1/open",
              "/solos/pr-7@head/open",
            ]),
            token: Schema.Literals(["missing", "bad", "valid"]),
          })
        ),
        { maxLength: 20, minLength: 1 }
      ),
    },
    ({ writes }) =>
      Effect.gen(function* scenario() {
        const host = memory();
        yield* openBoth(host);
        const initial = [...host.documents];

        const denied = yield* host.fetch(
          request("/trains/1/events", "POST", tick)
        );

        expect([...host.documents]).toEqual(initial);
        expect(denied.status).toBe(401);

        for (const command of writes) {
          const token = { bad: "wrong", missing: undefined, valid: TOKEN }[
            command.token
          ];

          const before = [...host.documents];
          const alarms = [...host.alarms];

          const response = yield* host.fetch(
            request(command.path, command.method, tick, token)
          );

          if (command.token !== "valid") {
            expect([...host.documents]).toEqual(before);
            expect([...host.alarms]).toEqual(alarms);
            expect(response.status).toBe(401);
          }
        }
      }),
    { arbitrary: { runs: 100 } }
  );

  it.effect(
    "authenticates every Durable Object boundary before touching storage",
    () =>
      Effect.gen(function* scenario() {
        const host = memory();
        yield* openBoth(host);

        for (const target of ["TRAIN", "SOLO", "DEPOT"] as const) {
          for (const path of [
            "/open",
            "/events",
            "/operator",
            "/trains",
            "/solos",
          ]) {
            const before = [...host.documents];
            expect(
              (yield* host.direct(target, "depot", request(path, "POST", "{}")))
                .status
            ).toBe(401);
            expect([...host.documents]).toEqual(before);
          }
        }
      })
  );
});
