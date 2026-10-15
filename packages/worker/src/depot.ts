import { PrNumber, Sha } from "@joelhooks/piper/domain";
import { soloKey } from "@joelhooks/piper/solo";
import { Clock, Effect, Schema } from "effect";

import { Auth } from "./auth.js";
import { decode, json, readJson, refuse } from "./http.js";
import { Storage } from "./storage.js";

const TrainRegistration = Schema.Struct({ n: Schema.optionalKey(PrNumber) });

const SoloRegistration = Schema.Struct({ head: Sha, pr: PrNumber });

export const depotFetch = Effect.fn("Depot.fetch")(function* depotFetch(
  request: Request
) {
  const auth = yield* Auth;

  if (!(yield* auth.allowed(request))) {
    return refuse(401, "unauthorized");
  }

  const path = new URL(request.url).pathname;
  const storage = yield* Storage;
  const document = yield* storage.load;

  if (request.method === "GET" && path === "/trains") {
    return json(document.trains);
  }

  if (request.method === "GET" && path === "/solos") {
    return json(document.solos);
  }

  if (request.method !== "POST") {
    return refuse(404, "no-such-route");
  }

  const at = yield* Clock.currentTimeMillis;

  if (path === "/trains") {
    const body = yield* decode(TrainRegistration)(yield* readJson(request));
    const n = body.n ?? Math.max(0, ...document.trains.map((row) => row.n)) + 1;

    if (document.trains.some((row) => row.n === n)) {
      return refuse(409, "train-exists");
    }

    yield* storage.save({
      ...document,
      trains: [...document.trains, { n, opened_at: at }],
    });

    return json({ n }, { status: 201 });
  }

  if (path === "/solos") {
    const body = yield* decode(SoloRegistration)(yield* readJson(request));
    const key = soloKey(body.pr, body.head);

    if (!document.solos.some((row) => row.key === key)) {
      yield* storage.save({
        ...document,
        solos: [...document.solos, { ...body, key, opened_at: at }],
      });
    }

    return json({ key }, { status: 201 });
  }

  return refuse(404, "no-such-route");
});
