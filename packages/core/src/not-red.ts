import { Schema } from "effect";

export class NotRed extends Schema.TaggedError<NotRed>()("NotRed", {
  key: Schema.String,
}) {}
