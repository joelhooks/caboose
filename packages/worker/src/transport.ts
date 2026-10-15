import { Context, Effect, Layer } from "effect";

import type { Env } from "./bindings.js";

export type Target = "TRAIN" | "SOLO" | "DEPOT";

export class Transport extends Context.Service<
  Transport,
  {
    readonly call: (
      target: Target,
      key: string,
      path: string,
      method: string,
      body: string | undefined
    ) => Effect.Effect<Response>;
  }
>()("piper-worker/Transport") {
  static layer(env: Env) {
    const call = (
      target: Target,
      key: string,
      path: string,
      method: string,
      body: string | undefined
    ) => {
      const namespace = env[target];
      const headers = new Headers();

      if (env.API_TOKEN !== undefined) {
        headers.set("authorization", `Bearer ${env.API_TOKEN}`);
      }

      const init: RequestInit = { headers, method };

      if (body !== undefined) {
        init.body = body;
      }

      const request = new Request(`https://cell.invalid${path}`, init);
      const stub = namespace.get(namespace.idFromName(key));

      return Effect.promise(stub.fetch.bind(stub, request));
    };

    return Layer.succeed(Transport, Transport.of({ call }));
  }
}

export const forward = Effect.fn("Transport.forward")(function* forward(
  target: Target,
  key: string,
  path: string,
  method?: string,
  body?: string
) {
  const transport = yield* Transport;

  return yield* transport.call(target, key, path, method ?? "GET", body);
});
