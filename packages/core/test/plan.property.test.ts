import { describe, expect, it } from "@effect/vitest";
import { Result, Schema } from "effect";
import * as Arbitrary from "effect/Arbitrary";

import {
  conflictPairs,
  decodePlan,
  PlanSchema,
  readyNodes,
  waves,
} from "../src/plan.js";
import type { Plan } from "../src/plan.js";

const nodeBits = Arbitrary.array(
  Arbitrary.schema(
    Schema.Int.check(Schema.isBetween({ maximum: 65_535, minimum: 0 }))
  ),
  { maxLength: 16 }
);

const dag = nodeBits.pipe(
  Arbitrary.map((bits): Plan => ({
    edges: bits.flatMap((mask, after) =>
      bits.flatMap((_, before) =>
        before < after && Math.floor(mask / 2 ** before) % 2 === 1
          ? [{ after: `node-${after}`, before: `node-${before}` }]
          : []
      )
    ),
    nodes: bits.map((mask, index) => ({
      files: [`src/file-${mask % 4}.ts`],
      id: `node-${index}`,
      pr: 100 + index,
      priority: (mask % 5) - 2,
    })),
  }))
);

const count = Arbitrary.schema(
  Schema.Int.check(Schema.isBetween({ maximum: 20, minimum: 1 }))
);

const ids = (nodes: ReturnType<typeof readyNodes>) =>
  nodes.map((node) => node.id);

describe("plan graph", () => {
  it.prop(
    "generated DAGs decode and waves contain every node once in edge order",
    { plan: dag },
    ({ plan }) => {
      expect(Result.isSuccess(decodePlan(plan))).toBe(true);
      const layers = waves(plan);
      expect(
        layers
          .flat()
          .map((node) => node.id)
          .toSorted()
      ).toEqual(ids(plan.nodes).toSorted());

      const positions = new Map(
        layers.flatMap((layer, index) =>
          layer.map((node) => [node.id, index] as const)
        )
      );

      for (const edge of plan.edges) {
        expect(positions.get(edge.before)).toBeLessThan(
          positions.get(edge.after) ?? -1
        );
      }
    }
  );

  it.prop(
    "every generated cycle is rejected by both decoders",
    { length: count },
    ({ length }) => {
      const nodes = Array.from({ length }, (_, index) => ({
        id: `cycle-${index}`,
      }));

      const plan = {
        edges: nodes.map((node, index) => ({
          after: `cycle-${(index + 1) % length}`,
          before: node.id,
        })),
        nodes,
      };

      expect(decodePlan(plan)).toMatchObject({ failure: { reason: "Cycle" } });
      expect(Result.isFailure(Schema.decodeResult(PlanSchema)(plan))).toBe(
        true
      );
    }
  );

  it.prop(
    "readiness is exact and monotone as landed facts grow",
    { plan: dag, prefix: count },
    ({ plan, prefix }) => {
      const landed = new Set(
        ids(plan.nodes.slice(0, prefix % (plan.nodes.length + 1)))
      );

      const more = new Set([
        ...landed,
        ...ids(plan.nodes.filter((_, index) => index % 2 === 0)),
      ]);

      const ready = ids(readyNodes(plan, landed));
      const later = ids(readyNodes(plan, more));
      expect(ready.every((id) => later.includes(id))).toBe(true);

      for (const node of plan.nodes) {
        const prerequisites = plan.edges
          .filter((edge) => edge.after === node.id)
          .map((edge) => edge.before);

        expect(ready.includes(node.id)).toBe(
          prerequisites.every((id) => landed.has(id))
        );
      }
    }
  );

  it.prop(
    "conflicts are symmetric, irreflexive and exactly shared files",
    { plan: dag },
    ({ plan }) => {
      const pairs = conflictPairs(plan);

      for (const left of plan.nodes) {
        for (const right of plan.nodes) {
          const expected =
            left.id !== right.id &&
            (left.files ?? []).some((file) =>
              (right.files ?? []).includes(file)
            );

          expect(pairs.some(([a, b]) => a === left.id && b === right.id)).toBe(
            expected
          );
        }
      }

      for (const [a, b] of pairs) {
        expect(a).not.toBe(b);
        expect(pairs).toContainEqual([b, a]);
      }
    }
  );

  it("rejects ambiguous identities, unknown references and invalid shapes", () => {
    expect(
      decodePlan({ edges: [], nodes: [{ id: "repeat" }, { id: "repeat" }] })
    ).toMatchObject({ failure: { reason: "DuplicateId" } });
    expect(
      decodePlan({
        edges: [],
        nodes: [
          { id: "one", pr: 101 },
          { id: "two", pr: 101 },
        ],
      })
    ).toMatchObject({ failure: { reason: "DuplicatePr" } });
    expect(
      decodePlan({
        edges: [{ after: "known", before: "missing" }],
        nodes: [{ id: "known" }],
      })
    ).toMatchObject({ failure: { reason: "UnknownNode" } });

    for (const value of [
      null,
      {},
      { edges: [], nodes: [{ id: "" }] },
      { edges: [], nodes: [{ id: "one", priority: 0.5 }] },
      { edges: [], nodes: [{ id: "one", pr: 0 }] },
    ]) {
      expect(Result.isFailure(decodePlan(value))).toBe(true);
    }

    expect(waves({ edges: [], nodes: [] })).toEqual([]);
  });
});
