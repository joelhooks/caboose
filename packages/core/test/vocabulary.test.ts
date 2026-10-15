import { describe, expect, it } from "@effect/vitest";
import { Schema } from "effect";

import type { Intent, SoloIntent } from "../src/domain.js";
import {
  plain,
  rat,
  renderNotification,
  VocabularySchema,
} from "../src/vocabulary.js";

const conflict: Intent = {
  at: 0,
  car: { headSha: "synthetic-head", number: 1, owner: "contributor" },
  excerpt: "Synthetic conflict details.",
  id: "notice-1",
  kind: "NotifyOwner",
  reason: "conflict",
};

const regression: SoloIntent = {
  at: 0,
  excerpt: "Synthetic baseline evidence.",
  head: "synthetic-head",
  id: "notice-2",
  judgment: undefined,
  kind: "NotifyOwner",
  owner: "contributor",
  pr: 1,
  reason: "regression",
};

const operator: SoloIntent = {
  at: 0,
  detail: "Synthetic runner failure.",
  head: "synthetic-head",
  id: "notice-3",
  judgment: undefined,
  kind: "NotifyOperator",
  outcome: "infra",
  pr: 1,
};

describe("display vocabulary", () => {
  it("decodes both presets and rejects missing vocabulary keys", () => {
    const decode = Schema.decodeUnknownSync(VocabularySchema);
    expect(decode(rat)).toEqual(rat);
    expect(decode(plain)).toEqual(plain);
    expect(() => decode({ train: "queue" })).toThrow();
  });

  it("defaults to the rat preset and keeps evidence verbatim", () => {
    expect(renderNotification(conflict)).toBe(
      "rat #1 left the run: rat king.\n\nSynthetic conflict details."
    );
    expect(renderNotification(regression)).toBe(
      "sniff test #1: stink.\n\nSynthetic baseline evidence."
    );
  });

  it("renders plain and custom vocabulary without changing the intent", () => {
    const before = structuredClone(conflict);

    const custom = Schema.decodeSync(VocabularySchema)({
      ...plain,
      car: "change",
      conflict: "overlap",
      train: "queue",
    });

    expect(renderNotification(conflict, plain)).toBe(
      "car #1 left the train: conflict.\n\nSynthetic conflict details."
    );
    expect(renderNotification(conflict, custom)).toBe(
      "change #1 left the queue: overlap.\n\nSynthetic conflict details."
    );
    expect(conflict).toEqual(before);
  });

  it("renders operator notices and leaves work intents alone", () => {
    expect(renderNotification(operator, plain)).toBe(
      "solo #1: infra.\n\nSynthetic runner failure."
    );
    expect(
      renderNotification({
        at: 0,
        head: "synthetic-head",
        id: "work-1",
        kind: "PollChecks",
      })
    ).toBeUndefined();
  });
});
