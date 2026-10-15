import { Effect, Layer, Semaphore, flow } from "effect";

import { Auth } from "./auth.js";
import type { Env, ObjectState } from "./bindings.js";
import { depotFetch } from "./depot.js";
import { refuse } from "./http.js";
import { Storage } from "./storage.js";

export class Depot {
  readonly fetch: (request: Request) => Promise<Response>;

  constructor(state: ObjectState, env: Env) {
    const serial = Semaphore.makeUnsafe(1);
    const layer = Layer.merge(Auth.layer(env), Storage.layer(state));
    this.fetch = flow(
      depotFetch,
      Effect.catchTag("BadRequest", () =>
        Effect.succeed(refuse(400, "bad-request"))
      ),
      Effect.provide(layer),
      serial.withPermit.bind(serial),
      Effect.runPromise
    );
  }
}
