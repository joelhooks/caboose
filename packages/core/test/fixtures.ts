import { Match } from "effect";

import type { Candidate, CheckRun, TrainInput } from "../src/domain.js";
import { DEFAULT_CARS } from "../src/policy.js";

export const MAIN_BEFORE_TRAIN_1 = "synthetic-revision-32";

export const TRAIN_1_HEAD = "synthetic-revision-19";

export const TRAIN_1_MERGE = "synthetic-revision-16";

export const TRAIN_1_PR = 32;

export const TRAIN_2_HEAD = "synthetic-revision-22";

export const TRAIN_2_PR = 34;

export const JUDGE = {
  inputsDigest: "sha256:fixture",
  model: "judge",
  version: "fixture",
} as const;

export const T0 = 1_700_000_000_000;

export const minutes = (n: number) => T0 + n * 60_000;

export const input = (train: number, maxCars = DEFAULT_CARS): TrainInput => ({
  ciTimeoutMs: 60 * 60_000,
  ignoredChecks: ["branch-current"],
  maxCars,
  pollMs: 90_000,
  repo: "example/project",
  train,
  trainLabel: "train",
});

export const ciOn = (
  head: string,
  outcome: "green" | "red" | "timeout" | "pending" = "green"
): readonly CheckRun[] => {
  const required: CheckRun = Match.value(outcome).pipe(
    Match.when("pending", () => ({
      conclusion: null,
      headSha: head,
      name: "checks",
      status: "in_progress" as const,
    })),
    Match.when("red", () => ({
      conclusion: "failure" as const,
      excerpt: "synthetic assertion: expected blue, got red",
      headSha: head,
      name: "checks",
      status: "completed" as const,
    })),
    Match.orElse((value) => ({
      conclusion:
        value === "green" ? ("success" as const) : ("timed_out" as const),
      headSha: head,
      name: "checks",
      status: "completed" as const,
    }))
  );

  return [
    required,
    {
      conclusion: "success",
      headSha: head,
      name: "lint and format",
      status: "completed",
    },
    {
      conclusion: "failure",
      headSha: head,
      name: "branch-current",
      status: "completed",
    },
    {
      conclusion: "neutral",
      headSha: head,
      name: "advisory status",
      status: "completed",
    },
  ];
};

const slice = (number: number, headSha: string, lane: string): Candidate => ({
  checks: ciOn(headSha),
  headSha,
  labels: ["train"],
  number,
  operatorReviewed: true,
  owner: `contributor/${lane}`,
  upToDate: true,
});

export const TRAIN_1_SLICES: readonly Candidate[] = [
  slice(23, "synthetic-revision-27", "alpha"),
  slice(24, "synthetic-revision-31", "beta"),
  slice(25, "synthetic-revision-17", "gamma"),
  slice(27, "synthetic-revision-15", "delta"),
  slice(28, "synthetic-revision-29", "epsilon"),
];

export const TRAIN_2_SLICES: readonly Candidate[] = [
  slice(33, "synthetic-revision-26", "zeta"),
  slice(29, "synthetic-revision-25", "eta"),
  slice(30, "synthetic-revision-24", "theta"),
  slice(31, "synthetic-revision-28", "gamma"),
  slice(26, "synthetic-revision-1", "iota"),
];

export const numbers = (candidates: readonly { readonly number: number }[]) =>
  candidates.map((candidate) => candidate.number);
