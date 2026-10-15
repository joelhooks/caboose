import { Context, Effect, Layer, Schema } from "effect";

import type { ObjectState } from "./bindings.js";

export const DocumentSchema = Schema.Struct({
  events: Schema.Array(
    Schema.Struct({
      body: Schema.Unknown,
      received_at: Schema.Int,
      seq: Schema.Int,
    })
  ),
  notes: Schema.Array(
    Schema.Struct({
      action: Schema.String,
      at: Schema.Int,
      note: Schema.NullOr(Schema.String),
    })
  ),
  snapshot: Schema.optionalKey(Schema.String),
  solos: Schema.Array(
    Schema.Struct({
      head: Schema.String,
      key: Schema.String,
      opened_at: Schema.Int,
      pr: Schema.Int,
    })
  ),
  trains: Schema.Array(Schema.Struct({ n: Schema.Int, opened_at: Schema.Int })),
});

export type Document = typeof DocumentSchema.Type;

interface EventRow {
  readonly body: string;
  readonly received_at: number;
  readonly seq: number;
}

export const emptyDocument = (): Document => ({
  events: [],
  notes: [],
  solos: [],
  trains: [],
});

export class Storage extends Context.Service<
  Storage,
  {
    readonly load: Effect.Effect<Document>;
    readonly save: (document: Document) => Effect.Effect<void>;
    readonly alarm: (at: number | undefined) => Effect.Effect<void>;
  }
>()("piper-worker/Storage") {
  static layer(state: ObjectState) {
    const { sql } = state.storage;

    const initialize = Effect.sync(() => {
      sql.exec(
        "CREATE TABLE IF NOT EXISTS cell (id INTEGER PRIMARY KEY CHECK (id = 1), document TEXT NOT NULL)"
      );
      sql.exec(
        "CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY, received_at INTEGER NOT NULL, body TEXT NOT NULL)"
      );
    });

    const load = Effect.gen(function* load() {
      yield* initialize;

      const row = yield* Effect.sync(
        () =>
          sql
            .exec<{ document: string }>(
              "SELECT document FROM cell WHERE id = 1"
            )
            .toArray()[0]
      );

      const document =
        row === undefined
          ? emptyDocument()
          : yield* Schema.decodeEffect(Schema.fromJsonString(DocumentSchema))(
              row.document
            ).pipe(Effect.orDie);

      const rows = yield* Effect.sync(() =>
        sql
          .exec<EventRow>(
            "SELECT seq, received_at, body FROM events ORDER BY seq"
          )
          .toArray()
      );

      const events = yield* Effect.forEach((event: EventRow) =>
        Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(
          event.body
        ).pipe(
          Effect.map((body) => ({ ...event, body })),
          Effect.orDie
        )
      )(rows);

      return { ...document, events };
    });

    const save = Effect.fn("Storage.save")(function* save(document: Document) {
      yield* initialize;
      yield* Effect.sync(() => {
        state.storage.transactionSync(() => {
          const last =
            sql
              .exec<{ seq: number }>(
                "SELECT coalesce(max(seq), 0) AS seq FROM events"
              )
              .toArray()[0]?.seq ?? 0;

          for (const event of document.events) {
            if (event.seq > last) {
              sql.exec(
                "INSERT INTO events (seq, received_at, body) VALUES (?, ?, ?)",
                event.seq,
                event.received_at,
                JSON.stringify(event.body)
              );
            }
          }

          sql.exec(
            "INSERT INTO cell (id, document) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET document = excluded.document",
            JSON.stringify({ ...document, events: [] })
          );
        });
      });
    });

    const alarm = (at: number | undefined) =>
      Effect.promise(
        at === undefined
          ? state.storage.deleteAlarm.bind(state.storage)
          : state.storage.setAlarm.bind(state.storage, at)
      );

    return Layer.succeed(Storage, Storage.of({ alarm, load, save }));
  }
}
