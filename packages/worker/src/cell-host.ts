import { Effect, Layer, Semaphore, flow } from "effect";

import { Auth } from "./auth.js";
import type { Env, ObjectState } from "./bindings.js";
import { cellAlarm, cellFetch } from "./cell.js";
import type { Kind } from "./cell.js";
import { Storage } from "./storage.js";

export class CellHost {
  readonly fetch: (request: Request) => Promise<Response>;
  readonly alarm: () => Promise<void>;

  constructor(state: ObjectState, env: Env, kind: Kind) {
    const serial = Semaphore.makeUnsafe(1);
    const layer = Layer.merge(Auth.layer(env), Storage.layer(state));
    const execute = serial.withPermit.bind(serial);
    this.fetch = flow(
      cellFetch.bind(undefined, kind),
      Effect.provide(layer),
      execute,
      Effect.runPromise
    );
    this.alarm = flow(
      cellAlarm.bind(undefined, kind),
      Effect.orDie,
      Effect.asVoid,
      Effect.provide(layer),
      execute,
      Effect.runPromise
    );
  }
}
