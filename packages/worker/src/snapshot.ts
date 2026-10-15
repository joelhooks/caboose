import { Effect, Schema } from "effect";

const rest = Schema.Record(Schema.String, Schema.Unknown);

const SnapshotSchema = Schema.Union([
  Schema.StructWithRest(
    Schema.Struct({
      error: Schema.Undefined,
      output: Schema.Undefined,
      status: Schema.Literal("active"),
    }),
    [rest]
  ),
  Schema.StructWithRest(
    Schema.Struct({
      error: Schema.Undefined,
      output: Schema.Unknown,
      status: Schema.Literal("done"),
    }),
    [rest]
  ),
  Schema.StructWithRest(
    Schema.Struct({
      error: Schema.Unknown,
      output: Schema.Undefined,
      status: Schema.Literal("error"),
    }),
    [rest]
  ),
  Schema.StructWithRest(
    Schema.Struct({
      error: Schema.Undefined,
      output: Schema.Undefined,
      status: Schema.Literal("stopped"),
    }),
    [rest]
  ),
]);

export const restoreSnapshot = Effect.fn("Snapshot.restore")(
  function* restoreSnapshot(encoded: string) {
    const fields = yield* Schema.decodeEffect(Schema.fromJsonString(rest))(
      encoded
    );

    return yield* Schema.decodeUnknownEffect(SnapshotSchema)({
      error: undefined,
      output: undefined,
      ...fields,
    });
  },
  Effect.orDie
);
