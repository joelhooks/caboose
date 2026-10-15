import { Context, Effect, Layer } from "effect";

import type { Settings } from "./bindings.js";

export const equalToken = Effect.fn("Auth.equalToken")(function* equalToken(
  actual: string,
  expected: string
) {
  const { subtle } = crypto;
  const encoder = new TextEncoder();

  const key = yield* Effect.promise(
    subtle.importKey.bind(
      subtle,
      "raw",
      new Uint8Array(32),
      { hash: "SHA-256", name: "HMAC" },
      false,
      ["sign", "verify"]
    )
  );

  const signature = yield* Effect.promise(
    subtle.sign.bind(subtle, "HMAC", key, encoder.encode(expected))
  );

  return yield* Effect.promise(
    subtle.verify.bind(subtle, "HMAC", key, signature, encoder.encode(actual))
  );
});

export class Auth extends Context.Service<
  Auth,
  {
    readonly allowed: (request: Request) => Effect.Effect<boolean>;
  }
>()("piper-worker/Auth") {
  static layer(env: Settings) {
    const allowed = Effect.fn("Auth.allowed")(function* allowed(
      request: Request
    ) {
      if (
        (request.method === "GET" || request.method === "HEAD") &&
        env.REQUIRE_READ_AUTH !== "true"
      ) {
        return true;
      }

      const header = request.headers.get("authorization");
      const token = header?.match(/^Bearer (?<token>[^\s]+)$/iu)?.groups?.token;

      if (
        env.API_TOKEN === undefined ||
        env.API_TOKEN === "" ||
        token === undefined
      ) {
        return false;
      }

      return yield* equalToken(token, env.API_TOKEN);
    });

    return Layer.succeed(Auth, Auth.of({ allowed }));
  }
}
