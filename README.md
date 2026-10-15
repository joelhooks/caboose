# Piper

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/piper-map-dark.svg">
  <img alt="Piper drawn as a chewed Tube map: the Run line from Queue through Checks to the Nest, with Gnaw, Sniff, Trail and the Hoard loop" src="docs/piper-map-light.svg">
</picture>

Piper leads your PRs to main in single file. The `@joelhooks/piper` package models a merge train and investigates failed pull-request checks. It keeps decisions in XState machines and runs those machines through Effect. This package computes work requests. It does not call a hosting provider, merge code, or deploy anything. Source: [joelhooks/piper](https://github.com/joelhooks/piper).

## Run the checks

Use Node 24.18 or newer within Node 24, and pnpm 11.3.0. The repository pins both tools in `.nvmrc` and `package.json`.

```sh
corepack pnpm@11.3.0 install --frozen-lockfile
pnpm check
```

`pnpm check` runs the strict TypeScript check, the lint and formatting fence, the lint-exemption ratchet, and all tests. Run `pnpm test` for tests alone. Run `pnpm fix` to apply lint fixes and formatting. Installation patches the TypeScript compiler with `@effect/tsgo` and installs the pre-commit hook.

## What the machines do

**Train:** select eligible pull requests in operator order, build them together, and wait for checks on the exact build head. A green train needs an operator's head-bound GO before it requests a merge. A changed main branch triggers a rebuild. A failed train narrows suspects through probe builds and removes a culprit. Judge rankings order suspects. A timeout earns one retry only when every car has a known probability below 0.2.

**Solo triage:** retry failed checks once in the same workflow context. Checks that remain red run against the original base without the patch. The results distinguish a flake, runner failure, broken base, and patch regression. Judge calls annotate the record. They cannot change the outcome or requested work.

Both machines append intents to an outbox and facts to a ledger. An external executor must carry out each intent and return the resulting event. Use intent IDs to identify work. An integration must supply its own delivery and idempotency guarantees.

## Core modules

| Module | Owns |
| --- | --- |
| `packages/core/src/domain.ts` | Effect schemas, events, intents, and facts |
| `packages/core/src/policy.ts` | Eligibility, latest check attempts, verdicts, and suspect ordering |
| `packages/core/src/machine.ts` | Train lifecycle |
| `packages/core/src/solo.ts` | Solo-triage lifecycle |
| `packages/core/src/host.ts` | Scoped train creation, restoration, stepping, and inspection |
| `packages/core/src/solo-host.ts` | Scoped solo creation, restoration, stepping, and inspection |
| `packages/core/src/vocabulary.ts` | Display vocabulary presets, schema, and pure notification rendering |

The host helpers are storage-independent. They restore with `createEffectActor(machine, { snapshot })`, deliver events, and wait for a mailbox barrier before returning a persisted snapshot. Deadlines and poll times live in context. An integration reads the next alarm time and posts a `tick`; there are no process-local timers to restore.

Repository settings are explicit inputs: `trainLabel`, `ignoredChecks`, and `aggregateChecks`. The synthetic examples use `train`, `branch-current`, and `checks`. These names carry no provider-specific policy.

## Plan graph

`@joelhooks/piper/plan` exports `PlanSchema`, `decodePlan`, `readyNodes`, `conflictPairs`, and `waves`. Nodes have a unique `id`, optional unique `pr`, optional `files`, and optional integer `priority`. Lower priorities board first. Edges use `{ before, after }` node IDs.

`decodePlan` returns an Effect `Result` with typed structural or graph errors. Graph errors distinguish duplicate IDs, ambiguous PR assignments, unknown references, and cycles. `PlanSchema` also rejects invalid graphs when nested in another schema.

`readyNodes(plan, landed)` reads a set of landed node IDs and returns nodes whose direct prerequisites have landed, including already-landed nodes. `waves(plan)` returns dependency layers in input order. Layers do not separate file conflicts. `conflictPairs(plan)` returns both directions of every pair sharing an exact file string. Files are not normalized and missing file lists imply no known conflicts.

The graph is pure data, not another lifecycle. This module does not query a provider or infer landing from a missing candidate.

## Tests and development fence

The property suites generate event traces and check the rules at each step. They cover the car cap, exact-head green plus GO, bisect progress, main movement, retry accounting, attempt retention, and owner notifications. Both suites compare an uninterrupted run with a JSON snapshot restored at an arbitrary cut. The solo suite also drops and scrambles judge calls and compares outcomes, attempt facts, and intents. Both suites replay generated traces while rendering notifications with arbitrary decodable vocabularies and verify unchanged machine state, intents, and facts. Fixed-seed coverage checks verify that generated traces reach the outcomes they claim to test. All fixtures use synthetic contributors, revisions, checks, and pull-request numbers.

Oxlint and Ultracite enforce the no-comments rule, anti-slop rules, XState/Effect boundaries, and Effect-native tests. The lint-exemption baseline is zero. Lefthook runs the gate before a commit. Agent hooks reject hook-bypass commands. See [AGENTS.md](AGENTS.md) for the contribution gate and [PROVENANCE.md](PROVENANCE.md) for sources and adaptations.

## Glossary

The code and API keep plain domain names. The glossary is the default `rat` display preset. `@joelhooks/piper/vocabulary` exports `VocabularySchema`, `rat`, `plain`, and `renderNotification`. To supply your own, decode a complete record with `Schema.decodeUnknownSync(VocabularySchema)` and pass it as the renderer's second argument. Missing keys are rejected. Vocabulary never enters the machines, events, policy, intents, or ledger.

| Rat voice  | Domain term                                              |
| ---------- | -------------------------------------------------------- |
| run        | train                                                    |
| rat        | pull request or car                                      |
| gnaw       | bisect                                                   |
| sniff test | solo triage; a whiff is a flake, a stink is a regression |
| whiskers   | judge; suggests, never decides                           |
| hoard      | ledger                                                   |
| nest       | main                                                     |
| rat king   | conflict                                                 |
| maze       | invariants no configuration can change                   |

## Scope

This first stage contains only core machines, policies, host helpers, tests, and development tooling. Provider executors, Workers, durable storage, authentication, and infrastructure belong in later stages.

MIT. See [LICENSE](LICENSE).
