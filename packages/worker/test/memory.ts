import { Effect, Layer, Schema } from "effect";

import { Auth } from "../src/auth.js";
import type { Settings } from "../src/bindings.js";
import { cellAlarm, cellFetch } from "../src/cell.js";
import { depotFetch } from "../src/depot.js";
import { refuse } from "../src/http.js";
import { workerFetch } from "../src/router.js";
import { DocumentSchema, Storage, emptyDocument } from "../src/storage.js";
import type { Document } from "../src/storage.js";
import { Transport } from "../src/transport.js";
import type { Target } from "../src/transport.js";

const DEFAULT_SETTINGS: Settings = { API_TOKEN: "test-token" };

export const memory = (
  settings: Settings = DEFAULT_SETTINGS,
  documents = new Map<string, string>()
) => {
  const alarms = new Map<string, number>();
  const auth = Auth.layer(settings);

  const storage = (id: string) =>
    Storage.of({
      alarm: (at) =>
        Effect.sync(() => {
          if (at === undefined) {
            alarms.delete(id);
          } else {
            alarms.set(id, at);
          }
        }),
      load: Effect.suspend(() => {
        const encoded = documents.get(id);

        return encoded === undefined
          ? Effect.succeed(emptyDocument())
          : Schema.decodeEffect(Schema.fromJsonString(DocumentSchema))(
              encoded
            ).pipe(Effect.orDie);
      }),
      save: (document: Document) =>
        Effect.sync(() => {
          documents.set(id, JSON.stringify(document));
        }),
    });

  const call = (
    target: Target,
    key: string,
    path: string,
    method: string,
    body: string | undefined
  ) => {
    const init: RequestInit = {
      headers: { authorization: `Bearer ${settings.API_TOKEN ?? ""}` },
      method,
    };

    if (body !== undefined) {
      init.body = body;
    }

    const request = new Request(`https://cell.invalid${path}`, init);

    const program =
      target === "DEPOT"
        ? depotFetch(request).pipe(
            Effect.catchTag("BadRequest", () =>
              Effect.succeed(refuse(400, "bad-request"))
            )
          )
        : cellFetch(target === "TRAIN" ? "train" : "solo", request);

    return program.pipe(
      Effect.provideService(Storage, storage(`${target}:${key}`)),
      Effect.provide(auth)
    );
  };

  const transport = Layer.succeed(Transport, Transport.of({ call }));

  const fetch = (request: Request) =>
    workerFetch(request, settings).pipe(
      Effect.provide(Layer.merge(auth, transport))
    );

  const alarm = (target: "train" | "solo", key: string) =>
    cellAlarm(target).pipe(
      Effect.provideService(
        Storage,
        storage(`${target === "train" ? "TRAIN" : "SOLO"}:${key}`)
      )
    );

  const direct = (target: Target, key: string, request: Request) =>
    (target === "DEPOT"
      ? depotFetch(request).pipe(
          Effect.catchTag("BadRequest", () =>
            Effect.succeed(refuse(400, "bad-request"))
          )
        )
      : cellFetch(target === "TRAIN" ? "train" : "solo", request)
    ).pipe(
      Effect.provideService(Storage, storage(`${target}:${key}`)),
      Effect.provide(auth)
    );

  return { alarm, alarms, direct, documents, fetch, storage };
};

export const request = (
  path: string,
  method: string,
  body?: string,
  token?: string
) => {
  const headers = new Headers();
  const init: RequestInit = { headers, method };

  if (token !== undefined) {
    headers.set("authorization", `Bearer ${token}`);
  }

  if (body !== undefined) {
    init.body = body;
  }

  return new Request(`https://worker.invalid${path}`, init);
};

export const bodyOf = (response: Response) =>
  Effect.promise(response.json.bind(response));
