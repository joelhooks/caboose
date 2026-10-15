import { Schema } from "effect";
import type { Snapshot } from "xstate";

const SnapshotSchema = Schema.Union([
  Schema.StructWithRest(
    Schema.Struct({
      error: Schema.Undefined,
      output: Schema.Undefined,
      status: Schema.Literal("active"),
    }),
    [Schema.Record(Schema.String, Schema.Unknown)]
  ),
  Schema.StructWithRest(
    Schema.Struct({
      error: Schema.Undefined,
      output: Schema.Unknown,
      status: Schema.Literal("done"),
    }),
    [Schema.Record(Schema.String, Schema.Unknown)]
  ),
  Schema.StructWithRest(
    Schema.Struct({
      error: Schema.Unknown,
      output: Schema.Undefined,
      status: Schema.Literal("error"),
    }),
    [Schema.Record(Schema.String, Schema.Unknown)]
  ),
  Schema.StructWithRest(
    Schema.Struct({
      error: Schema.Undefined,
      output: Schema.Undefined,
      status: Schema.Literal("stopped"),
    }),
    [Schema.Record(Schema.String, Schema.Unknown)]
  ),
]);

export const jsonSnapshot = (snapshot: Snapshot<unknown>) => {
  const encoded = JSON.stringify(snapshot);

  const fields = Schema.decodeUnknownSync(
    Schema.Record(Schema.String, Schema.Unknown)
  )(JSON.parse(encoded));

  return Schema.decodeUnknownSync(SnapshotSchema)({
    error: undefined,
    output: undefined,
    ...fields,
  });
};
