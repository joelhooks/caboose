import { expect } from "@effect/vitest";

import type { CheckRun, SoloEvent, SoloIntent } from "../src/domain.js";
import type { SoloSnapshot } from "../src/solo-host.js";
import { soloAlarmAt } from "../src/solo-host.js";
import type { Opening } from "./solo.property.test.js";

const HEAD = "head-1";

const BASE = "base-1";

const NAMES = [
  "integration shard 1/3",
  "unit shard 4/9",
  "lint and format",
  "checks",
];

const redNames = (open: Opening) =>
  NAMES.filter((_, index) => Math.floor(open.red / 2 ** index) % 2 === 1);

const GREEN = new Set(["success", "neutral", "skipped"]);

const RUNNER = new Set(["cancelled", "startup_failure", "stale"]);

const latest = (
  runs: readonly CheckRun[],
  name: string,
  sha: string
): CheckRun | undefined => {
  let held: CheckRun | undefined;

  for (const run of runs) {
    if (run.name !== name || run.headSha !== sha) {
      continue;
    }

    if (
      held === undefined ||
      (run.attempt ?? 1) > (held.attempt ?? 1) ||
      ((run.attempt ?? 1) === (held.attempt ?? 1) &&
        (run.id ?? 0) >= (held.id ?? 0))
    ) {
      held = run;
    }
  }

  return held;
};

const baselineOf = (intents: readonly SoloIntent[]) =>
  intents.flatMap((intent) =>
    intent.kind === "RunBaseline" ? intent.checks : []
  );

export class Rules {
  readonly posted: SoloEvent[] = [];
  readonly trail: string[] = [];

  baselineFrom: number | undefined;
  readonly triaged: readonly string[];

  constructor(open: Opening) {
    this.triaged = redNames(open);
  }

  opened(snapshot: SoloSnapshot) {
    const reruns = snapshot.context.intents.filter(
      (intent) => intent.kind === "RerunFailed"
    );

    expect(reruns).toHaveLength(1);
    expect(reruns[0]?.kind === "RerunFailed" && reruns[0].checks).toEqual(
      this.triaged
    );
  }

  check(before: SoloSnapshot, event: SoloEvent, after: SoloSnapshot) {
    this.posted.push(event);
    this.trail.push(`${event.type} ${before.value} -> ${after.value}`);
    this.outbox(before, event, after);
    this.baselineRequest(before, event, after);
    this.rerunLedger(before, event, after);
    this.baselineLedger(before, event, after);
    this.ownerSafety(before, event, after);
    Rules.regressionNotification(before, event, after);
    this.retryVerdict(before, event, after);
    this.flakeVerdict(before, event, after);
    Rules.supersession(before, event, after);
    Rules.deadline(before, event, after);
  }
  outbox(before: SoloSnapshot, event: SoloEvent, after: SoloSnapshot) {
    const why = this.trail.join("\n");
    const fresh = after.context.intents.slice(before.context.intents.length);

    expect(
      after.context.intents.slice(0, before.context.intents.length)
    ).toEqual(before.context.intents);

    expect(
      fresh.filter((intent) => intent.kind === "RerunFailed"),
      why
    ).toEqual([]);
  }

  baselineRequest(before: SoloSnapshot, event: SoloEvent, after: SoloSnapshot) {
    const fresh = after.context.intents.slice(before.context.intents.length);

    if (fresh.some((intent) => intent.kind === "RunBaseline")) {
      this.baselineFrom = this.posted.length;
    }
  }

  rerunLedger(before: SoloSnapshot, event: SoloEvent, after: SoloSnapshot) {
    const why = this.trail.join("\n");

    if (
      before.value === "retrying" &&
      event.type === "checks" &&
      event.head === HEAD
    ) {
      for (const run of event.checks) {
        if (
          run.status === "completed" &&
          this.triaged.includes(run.name) &&
          (run.attempt ?? 1) > 1
        ) {
          expect(
            after.context.facts.some(
              (fact) =>
                fact.kind === "attempt" &&
                fact.role === "rerun" &&
                fact.check === run.name &&
                fact.attempt === run.attempt &&
                fact.id === run.id
            ),
            why
          ).toBe(true);
        }
      }
    }
  }

  baselineLedger(before: SoloSnapshot, event: SoloEvent, after: SoloSnapshot) {
    const why = this.trail.join("\n");

    const asked = baselineOf(after.context.intents);

    if (
      before.value === "baselining" &&
      event.type === "baseline" &&
      event.base === BASE
    ) {
      for (const run of event.checks) {
        if (
          run.status === "completed" &&
          run.headSha === BASE &&
          asked.includes(run.name)
        ) {
          expect(
            after.context.facts.some(
              (fact) =>
                fact.kind === "attempt" &&
                fact.role === "baseline" &&
                fact.id === run.id
            ),
            why
          ).toBe(true);
        }
      }
    }

    const keys = after.context.facts.flatMap((fact) =>
      fact.kind === "attempt"
        ? [`${fact.role}/${fact.sha}/${fact.check}/${fact.attempt}/${fact.id}`]
        : []
    );

    expect(new Set(keys).size).toBe(keys.length);
  }

  ownerSafety(before: SoloSnapshot, event: SoloEvent, after: SoloSnapshot) {
    const why = this.trail.join("\n");
    const fresh = after.context.intents.slice(before.context.intents.length);
    const asked = baselineOf(after.context.intents);

    for (const notify of fresh.filter(
      (intent) => intent.kind === "NotifyOwner"
    )) {
      expect(after.value, why).toBe("regression");
      expect(notify.kind === "NotifyOwner" && notify.owner).toBe(
        "contributor/lane"
      );
      expect(asked.length).toBeGreaterThan(0);

      const reruns = this.posted
        .slice(0, this.baselineFrom ?? 0)
        .flatMap((posted) =>
          posted.type === "checks"
            ? posted.checks.filter((run) => (run.attempt ?? 1) > 1)
            : []
        );

      const baselines = this.posted
        .slice(this.baselineFrom ?? this.posted.length)
        .flatMap((posted) =>
          posted.type === "baseline" && posted.base === BASE
            ? posted.checks
            : []
        );

      for (const name of asked) {
        const again = latest(reruns, name, HEAD);
        const onBase = latest(baselines, name, BASE);

        expect(
          again?.status === "completed" &&
            !GREEN.has(again.conclusion ?? "") &&
            !RUNNER.has(again.conclusion ?? ""),
          why
        ).toBe(true);
        expect(
          onBase?.status === "completed" && GREEN.has(onBase.conclusion ?? ""),
          why
        ).toBe(true);
      }
    }
  }

  static regressionNotification(
    before: SoloSnapshot,
    event: SoloEvent,
    after: SoloSnapshot
  ) {
    const fresh = after.context.intents.slice(before.context.intents.length);

    if (after.value === "regression" && before.value !== "regression") {
      expect(
        fresh.filter((intent) => intent.kind === "NotifyOwner")
      ).toHaveLength(1);
    }
  }

  retryVerdict(before: SoloSnapshot, event: SoloEvent, after: SoloSnapshot) {
    const why = this.trail.join("\n");

    if (
      before.value === "retrying" &&
      after.value !== "retrying" &&
      event.type === "checks"
    ) {
      const reruns = this.posted.flatMap((posted) =>
        posted.type === "checks"
          ? posted.checks.filter((run) => (run.attempt ?? 1) > 1)
          : []
      );

      const red = this.triaged
        .map((name) => latest(reruns, name, HEAD))
        .filter((run) => run !== undefined && !GREEN.has(run.conclusion ?? ""));

      if (after.value === "infra") {
        expect(
          red.every((run) => RUNNER.has(run?.conclusion ?? "")),
          why
        ).toBe(true);
      }

      if (after.value === "baselining") {
        expect(
          red.some((run) => !RUNNER.has(run?.conclusion ?? "")),
          why
        ).toBe(true);
      }
    }
  }

  flakeVerdict(before: SoloSnapshot, event: SoloEvent, after: SoloSnapshot) {
    const why = this.trail.join("\n");

    if (after.value === "flake" && before.value !== "flake") {
      const reruns = this.posted.flatMap((posted) =>
        posted.type === "checks"
          ? posted.checks.filter((run) => (run.attempt ?? 1) > 1)
          : []
      );

      for (const name of this.triaged) {
        expect(
          GREEN.has(latest(reruns, name, HEAD)?.conclusion ?? ""),
          why
        ).toBe(true);
      }
    }
  }

  static supersession(
    before: SoloSnapshot,
    event: SoloEvent,
    after: SoloSnapshot
  ) {
    const fresh = after.context.intents.slice(before.context.intents.length);

    const alarm = soloAlarmAt(after);

    if (
      before.status === "active" &&
      event.type === "newHead" &&
      event.head !== HEAD
    ) {
      expect(after.value).toBe("superseded");
      expect(fresh).toEqual([]);
    }

    const outcomes = after.context.facts.filter(
      (fact) => fact.kind === "outcome"
    );

    expect(outcomes).toHaveLength(after.status === "done" ? 1 : 0);

    expect(alarm !== undefined).toBe(after.status === "active");
  }

  static deadline(before: SoloSnapshot, event: SoloEvent, after: SoloSnapshot) {
    const fresh = after.context.intents.slice(before.context.intents.length);

    const due = soloAlarmAt(before);

    if (event.type === "tick" && due !== undefined && event.at >= due) {
      expect(fresh.length > 0 || after.status !== "active").toBe(true);
    }
  }
}
