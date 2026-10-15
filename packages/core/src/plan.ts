import { Data, flow, Result, Schema } from "effect";

export const PlanNodeSchema = Schema.Struct({
  files: Schema.optionalKey(Schema.Array(Schema.NonEmptyString)),
  id: Schema.NonEmptyString,
  pr: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
  priority: Schema.optionalKey(Schema.Int),
});

export type PlanNode = typeof PlanNodeSchema.Type;

const PlanDataSchema = Schema.Struct({
  edges: Schema.Array(
    Schema.Struct({
      after: Schema.NonEmptyString,
      before: Schema.NonEmptyString,
    })
  ),
  nodes: Schema.Array(PlanNodeSchema),
});

export type Plan = typeof PlanDataSchema.Type;

export class InvalidPlan extends Data.TaggedError("InvalidPlan")<{
  readonly reason: "DuplicateId" | "UnknownNode" | "Cycle" | "DuplicatePr";
  readonly ids: readonly string[];
  readonly message: string;
}> {}

export const readyNodes = (
  plan: Plan,
  landed: ReadonlySet<string>
): readonly PlanNode[] =>
  plan.nodes.filter((node) =>
    plan.edges.every(
      (edge) => edge.after !== node.id || landed.has(edge.before)
    )
  );

export const waves = (plan: Plan): readonly (readonly PlanNode[])[] => {
  const landed = new Set<string>();
  const layers: (readonly PlanNode[])[] = [];

  while (landed.size < plan.nodes.length) {
    const layer = readyNodes(plan, landed).filter(
      (node) => !landed.has(node.id)
    );

    if (layer.length === 0) {
      break;
    }

    layers.push(layer);

    for (const node of layer) {
      landed.add(node.id);
    }
  }

  return layers;
};

const graphError = (plan: Plan): InvalidPlan | undefined => {
  const ids = new Set<string>();
  const prs = new Set<number>();

  for (const node of plan.nodes) {
    if (ids.has(node.id)) {
      return new InvalidPlan({
        ids: [node.id],
        message: `Duplicate node id: ${node.id}`,
        reason: "DuplicateId",
      });
    }

    ids.add(node.id);

    if (node.pr !== undefined) {
      if (prs.has(node.pr)) {
        return new InvalidPlan({
          ids: [node.id],
          message: `PR belongs to more than one node: ${node.pr}`,
          reason: "DuplicatePr",
        });
      }

      prs.add(node.pr);
    }
  }

  for (const edge of plan.edges) {
    const unknown = [edge.before, edge.after].filter((id) => !ids.has(id));

    if (unknown.length > 0) {
      return new InvalidPlan({
        ids: unknown,
        message: `Unknown nodes: ${unknown.join(", ")}`,
        reason: "UnknownNode",
      });
    }
  }

  const reached = new Set(
    waves(plan)
      .flat()
      .map((node) => node.id)
  );

  const blocked = plan.nodes
    .filter((node) => !reached.has(node.id))
    .map((node) => node.id);

  return blocked.length === 0
    ? undefined
    : new InvalidPlan({
        ids: blocked,
        message: `Cycle blocks nodes: ${blocked.join(", ")}`,
        reason: "Cycle",
      });
};

export const PlanSchema = PlanDataSchema.check(
  Schema.makeFilter((plan) => graphError(plan)?.message)
);

export const decodePlan = flow(
  Schema.decodeUnknownResult(PlanDataSchema),
  Result.flatMap((plan) => {
    const error = graphError(plan);

    return error === undefined ? Result.succeed(plan) : Result.fail(error);
  })
);

export const conflictPairs = (
  plan: Plan
): readonly (readonly [string, string])[] =>
  plan.nodes.flatMap((left) =>
    plan.nodes.flatMap((right) =>
      left.id !== right.id &&
      (left.files ?? []).some((file) => (right.files ?? []).includes(file))
        ? [[left.id, right.id] as const]
        : []
    )
  );
