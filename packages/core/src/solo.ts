import { setupEffect } from "@xstate/effect";
import { Predicate, Schema } from "effect";
import { types } from "xstate";
import type { StateValue } from "xstate";

import type {
  SoloEvent,
  AttemptRole,
  CheckRun,
  SoloFact,
  SoloInput,
  SoloIntent,
  SoloIntentDraft,
  SoloJudgment,
  SoloOutcome,
} from "./domain.js";
import { SoloEvents, SoloInputSchema } from "./domain.js";
import {
  attemptOf,
  isFailed,
  isInfra,
  isLaterAttempt,
  latestRuns,
} from "./policy.js";

export interface Rejection {
  readonly type: string;
  readonly at: number | undefined;
  readonly state: string;
}

export interface SoloContext {
  readonly repo: string;
  readonly pr: number;
  readonly head: string;
  readonly owner: string;
  readonly base: string;
  readonly pollMs: number;
  readonly ciTimeoutMs: number;

  readonly original: readonly CheckRun[];

  readonly retried: readonly CheckRun[];

  readonly baselined: readonly string[];
  readonly baseline: readonly CheckRun[];
  readonly judgment: SoloJudgment | undefined;
  readonly outcome: SoloOutcome | undefined;
  readonly pollAt: number | undefined;
  readonly deadlineAt: number | undefined;

  readonly recorded: readonly string[];
  readonly intents: readonly SoloIntent[];
  readonly facts: readonly SoloFact[];
  readonly rejected: readonly Rejection[];

  readonly sync: number;
}

const REJECTIONS_KEPT = 50;

export const soloKey = (pr: number, head: string) => `pr-${pr}@${head}`;

export const failingOn = (
  head: string,
  checks: readonly CheckRun[],
  ignoredChecks: readonly string[]
): readonly CheckRun[] =>
  latestRuns(checks).filter(
    (run) =>
      run.headSha === head && !ignoredChecks.includes(run.name) && isFailed(run)
  );

const emit = (
  context: SoloContext,
  at: number,
  ...drafts: readonly SoloIntentDraft[]
): SoloContext => ({
  ...context,
  intents: [
    ...context.intents,
    ...drafts.map((draft, index) => ({
      ...draft,
      at,
      id: `solo-${context.pr}@${context.head.slice(0, 8)}/${context.intents.length + index + 1}`,
    })),
  ],
});

const record = (
  context: SoloContext,
  ...facts: readonly SoloFact[]
): SoloContext => ({
  ...context,
  facts: [...context.facts, ...facts],
});

const attemptKey = (run: CheckRun) =>
  `${run.headSha}/${run.name}/${attemptOf(run)}/${run.id ?? ""}`;

const recordAttempts = (
  context: SoloContext,
  at: number,
  role: AttemptRole,
  runs: readonly CheckRun[]
): SoloContext => {
  const fresh = runs.filter(
    (run, index) =>
      run.status === "completed" &&
      !context.recorded.includes(attemptKey(run)) &&
      runs.findIndex((other) => attemptKey(other) === attemptKey(run)) === index
  );

  return record(
    { ...context, recorded: [...context.recorded, ...fresh.map(attemptKey)] },
    ...fresh.map((run): SoloFact => ({
      at,
      attempt: attemptOf(run),
      check: run.name,
      conclusion: run.conclusion,
      excerpt: run.excerpt,
      id: run.id,
      kind: "attempt",
      role,
      sha: run.headSha,
    }))
  );
};

const wait = (context: SoloContext, at: number): SoloContext => ({
  ...context,
  deadlineAt: at + context.ciTimeoutMs,
  pollAt: at + context.pollMs,
});

const names = (runs: readonly CheckRun[]) => runs.map((run) => run.name);

const excerptOf = (runs: readonly CheckRun[]) =>
  runs
    .map(
      (run) =>
        `${run.name} (attempt ${attemptOf(run)}): ${run.conclusion ?? "failed"}${run.excerpt === undefined ? "" : `\n${run.excerpt}`}`
    )
    .join("\n\n");

const TARGET: Record<SoloOutcome, `#solo.${SoloOutcome}`> = {
  baseRed: "#solo.baseRed",
  dismissed: "#solo.dismissed",
  flake: "#solo.flake",
  infra: "#solo.infra",
  regression: "#solo.regression",
  superseded: "#solo.superseded",
  unknown: "#solo.unknown",
};

const conclude = (
  context: SoloContext,
  at: number,
  outcome: SoloOutcome,
  checks: readonly string[],
  detail: string,
  quiet = false
) => {
  const ended = record(
    { ...context, deadlineAt: undefined, outcome, pollAt: undefined },
    { at, checks, detail, kind: "outcome", outcome }
  );

  let notified = ended;

  if (outcome === "regression") {
    notified = emit(ended, at, {
      excerpt: detail,
      head: context.head,
      judgment: context.judgment,
      kind: "NotifyOwner",
      owner: context.owner,
      pr: context.pr,
      reason: "regression",
    });
  } else if (
    !quiet &&
    (outcome === "baseRed" || outcome === "infra" || outcome === "unknown")
  ) {
    notified = emit(ended, at, {
      detail,
      head: context.head,
      judgment: context.judgment,
      kind: "NotifyOperator",
      outcome,
      pr: context.pr,
    });
  }

  return { context: notified, target: TARGET[outcome] };
};

const judgeRetry = (
  context: SoloContext,
  at: number,
  runs: readonly CheckRun[]
) => {
  const laterThanOriginal = (run: CheckRun) =>
    run.headSha === context.head &&
    context.original.some(
      (original) => original.name === run.name && isLaterAttempt(run, original)
    );

  const retried = latestRuns(
    [...context.retried, ...runs].filter(laterThanOriginal)
  );

  const next = recordAttempts(
    { ...context, retried },
    at,
    "rerun",
    runs.filter(laterThanOriginal)
  );

  const done = retried.filter((run) => run.status === "completed");

  if (done.length < context.original.length) {
    return { context: next };
  }

  const failed = done.filter(isFailed);
  const real = failed.filter((run) => !isInfra(run));

  if (failed.length === 0) {
    return context.original.every(isInfra)
      ? conclude(
          next,
          at,
          "infra",
          names(context.original),
          "The runner failed, and the re-run passed.",
          true
        )
      : conclude(
          next,
          at,
          "flake",
          names(context.original),
          "Red, then green on a same-context re-run."
        );
  }

  if (real.length === 0) {
    return conclude(
      next,
      at,
      "infra",
      names(failed),
      `The re-run failed on the runner again:\n\n${excerptOf(failed)}`
    );
  }

  return {
    context: emit(wait({ ...next, baselined: names(real) }, at), at, {
      base: context.base,
      checks: names(real),
      kind: "RunBaseline",
      pr: context.pr,
    }),
    target: "#solo.baselining" as const,
  };
};

const judgeBaseline = (
  context: SoloContext,
  at: number,
  runs: readonly CheckRun[]
) => {
  const onBase = (run: CheckRun) =>
    run.headSha === context.base && context.baselined.includes(run.name);

  const baseline = latestRuns([...context.baseline, ...runs].filter(onBase));

  const next = recordAttempts(
    { ...context, baseline },
    at,
    "baseline",
    runs.filter(onBase)
  );

  const done = baseline.filter((run) => run.status === "completed");

  if (done.length < context.baselined.length) {
    return { context: next };
  }

  const red = done.filter((run) => isFailed(run) && !isInfra(run));

  if (red.length > 0) {
    return conclude(
      next,
      at,
      "baseRed",
      names(red),
      `The same checks fail on ${context.base} without the patch:\n\n${excerptOf(red)}`
    );
  }

  if (done.some(isInfra)) {
    return conclude(
      next,
      at,
      "unknown",
      context.baselined,
      "The baseline's runner failed, so the base proves nothing."
    );
  }

  const failing = context.retried.filter((run) =>
    context.baselined.includes(run.name)
  );

  return conclude(
    next,
    at,
    "regression",
    context.baselined,
    `Red twice on ${context.head} and green on ${context.base} without the patch.\n\n${excerptOf(
      [
        ...context.original.filter((run) =>
          context.baselined.includes(run.name)
        ),
        ...failing,
      ]
    )}`
  );
};

const onTick = (
  context: SoloContext,
  at: number,
  sha: string,
  checks: readonly string[]
):
  | { readonly context: SoloContext; readonly target?: `#solo.${SoloOutcome}` }
  | undefined => {
  if (context.deadlineAt !== undefined && at >= context.deadlineAt) {
    return conclude(
      context,
      at,
      "unknown",
      checks,
      `No result for ${checks.join(", ")} on ${sha} before the deadline.`
    );
  }

  if (context.pollAt !== undefined && at >= context.pollAt) {
    return {
      context: emit({ ...context, pollAt: at + context.pollMs }, at, {
        checks,
        kind: "PollChecks",
        pr: context.pr,
        sha,
      }),
    };
  }

  return undefined;
};

const rejectedState = (value: StateValue): string =>
  Predicate.isString(value) ? value : JSON.stringify(value);

const timeOf = (
  event: SoloEvent | { readonly type: "sync"; readonly token: number }
): number | undefined => ("at" in event ? event.at : undefined);

const triaged = (input: SoloInput): readonly CheckRun[] => {
  const red = failingOn(input.head, input.checks, input.ignoredChecks);
  const real = red.filter((run) => !input.aggregateChecks.includes(run.name));

  return real.length > 0 ? real : red;
};

const unique = (values: readonly (number | undefined)[]) => [
  ...new Set(values.filter((value): value is number => value !== undefined)),
];

const initialContext = (input: SoloInput): SoloContext => {
  const original = triaged(input);

  const opened: SoloContext = {
    base: input.base,
    baseline: [],
    baselined: [],
    ciTimeoutMs: input.ciTimeoutMs,
    deadlineAt: undefined,
    facts: [],
    head: input.head,
    intents: [],
    judgment: undefined,
    original,
    outcome: undefined,
    owner: input.owner,
    pollAt: undefined,
    pollMs: input.pollMs,
    pr: input.pr,
    recorded: [],
    rejected: [],
    repo: input.repo,
    retried: [],
    sync: 0,
  };

  return emit(
    wait(recordAttempts(opened, input.at, "original", original), input.at),
    input.at,
    {
      checkRunIds: unique(original.map((run) => run.id)),
      checks: names(original),
      head: input.head,
      kind: "RerunFailed",
      pr: input.pr,
      workflowRunIds: unique(original.map((run) => run.runId)),
    }
  );
};

export const soloMachine = setupEffect({
  schemas: {
    context: types<SoloContext>(),
    events: { ...SoloEvents, sync: Schema.Struct({ token: Schema.Int }) },
    input: SoloInputSchema,
  },
}).createMachine({
  context: ({ input }: { input: SoloInput }) => initialContext(input),
  id: "solo",
  initial: "retrying",
  on: {
    "*": ({ context, event, value }) => ({
      context: {
        ...context,
        rejected: [
          ...context.rejected,
          { at: timeOf(event), state: rejectedState(value), type: event.type },
        ].slice(-REJECTIONS_KEPT),
      },
    }),
    dismiss: ({ context, event }) =>
      conclude(
        context,
        event.at,
        "dismissed",
        names(context.original),
        event.reason
      ),

    judged: ({ context, event }) =>
      event.head === context.head
        ? {
            context: record(
              {
                ...context,
                judgment: {
                  at: event.at,
                  classes: event.classes,
                  evidence: event.evidence,
                  judge: event.judge,
                },
              },
              {
                at: event.at,
                classes: event.classes,
                evidence: event.evidence.length,
                judge: event.judge,
                kind: "judged",
              }
            ),
          }
        : undefined,
    newHead: ({ context, event }) =>
      event.head === context.head
        ? undefined
        : conclude(
            context,
            event.at,
            "superseded",
            names(context.original),
            `#${context.pr} moved to ${event.head}; a red there opens its own triage.`
          ),
    sync: ({ context, event }) => ({
      context: { ...context, sync: event.token },
    }),
    tick: {},
  },
  output: ({ context }) => ({
    head: context.head,
    outcome: context.outcome,
    pr: context.pr,
  }),
  states: {
    baseRed: { type: "final" },
    baselining: {
      on: {
        baseline: ({ context, event }) =>
          event.base === context.base
            ? judgeBaseline(context, event.at, event.checks)
            : undefined,
        tick: ({ context, event }) =>
          onTick(context, event.at, context.base, context.baselined),
      },
    },
    dismissed: { type: "final" },
    flake: { type: "final" },
    infra: { type: "final" },
    regression: { type: "final" },
    retrying: {
      on: {
        checks: ({ context, event }) =>
          event.head === context.head
            ? judgeRetry(context, event.at, event.checks)
            : undefined,
        tick: ({ context, event }) =>
          onTick(context, event.at, context.head, names(context.original)),
      },
    },
    superseded: { type: "final" },
    unknown: { type: "final" },
  },
});

export type SoloMachine = typeof soloMachine;
