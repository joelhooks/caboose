import { Effect, Layer, flow } from "effect";

import { Auth } from "./auth.js";
import type { Env } from "./bindings.js";
import { workerFetch } from "./router.js";
import { Transport } from "./transport.js";

export { Depot } from "./depot-host.js";

export { Solo } from "./solo.js";

export { Train } from "./train.js";

const program = (request: Request, env: Env) =>
  workerFetch(request, env).pipe(
    Effect.provide(Layer.merge(Auth.layer(env), Transport.layer(env)))
  );

export default { fetch: flow(program, Effect.runPromise) };
