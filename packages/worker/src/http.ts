import type { TrainFinished } from "@joelhooks/piper/host";
import type { NotRed, SoloFinished } from "@joelhooks/piper/solo-host";
import { Effect, Schema, flow } from "effect";

export class BadRequest extends Schema.TaggedError<BadRequest>()("BadRequest", {
  detail: Schema.String,
}) {}

export const json = Response.json.bind(Response);

export const refuse = (status: number, error: string) =>
  json({ error }, { status });

export const decode = <
  S extends Schema.Top & { readonly DecodingServices: never },
>(
  schema: S
) =>
  flow(
    Schema.decodeUnknownEffect(schema),
    Effect.mapError((failure) => new BadRequest({ detail: String(failure) }))
  );

export const readJson = (request: Request) =>
  Effect.tryPromise({
    catch: () => new BadRequest({ detail: "body is not JSON" }),
    try: request.json.bind(request),
  });

const RawRecord = Schema.Record(Schema.String, Schema.Unknown);

const RawBatch = Schema.Array(RawRecord);

const stamp = (value: typeof RawRecord.Type, at: number) =>
  "at" in value ? value : { ...value, at };

export const stampedBody = Effect.fn("Http.stampedBody")(function* stampedBody(
  request: Request,
  at: number
) {
  const body = yield* decode(Schema.Union([RawRecord, RawBatch]))(
    yield* readJson(request)
  );

  return Schema.is(RawBatch)(body)
    ? body.map((item) => stamp(item, at))
    : stamp(body, at);
});

export const respond = <A, R>(
  effect: Effect.Effect<
    A,
    BadRequest | NotRed | TrainFinished | SoloFinished,
    R
  >,
  status = 200
) =>
  effect.pipe(
    Effect.map((body) => json(body, { status })),
    Effect.catchTags({
      BadRequest: () => Effect.succeed(refuse(400, "bad-request")),
      NotRed: () => Effect.succeed(refuse(422, "nothing-red")),
      SoloFinished: () => Effect.succeed(refuse(409, "solo-finished")),
      TrainFinished: () => Effect.succeed(refuse(409, "train-finished")),
    })
  );
