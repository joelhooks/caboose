# Provenance

Piper is MIT licensed. Its initial tree starts from a license-only repository; no predecessor history is imported.

## Core

The train and solo-triage machines, domain types, policy, storage-independent host helpers, and test suites were adapted from an earlier private merge-train prototype by Joel Hooks. The public tree contains none of that prototype's deployment files, service configuration, operational records, or real fixtures.

Public adaptations:

- Replace project settings and identifiers with explicit configuration and synthetic examples.
- Use operator and judge terminology throughout the public contract.
- Move prose comments into documentation and descriptive names.
- Separate schemas from their inferred type names.
- Use Effect tagged constructors and predicates instead of hand-written tag handling.
- Replace unsafe snapshot assertions with a schema-checked opaque snapshot envelope, then inspect state through a restored actor.
- Split oracle checks into named independent methods without removing their assertions.
- Preserve all 32 fixture and property tests, including restoration and judge-call independence.

The public package adds a display-only vocabulary schema, `rat` and `plain` presets, and a pure notify-intent renderer. Two generated-trace properties verify that arbitrary decoded display vocabularies leave both machines' outcomes, intents, and ledger facts unchanged. Four seam tests cover decoding, missing keys, presets, custom words, evidence preservation, and non-notification intents.

## Rat-stack fence

The fence comes from [joelhooks/rat-stack](https://github.com/joelhooks/rat-stack), revision `4ff1dd0`:

- Oxlint/Ultracite configuration and the strict Effect diagnostic map.
- `scripts/oxlint-plugin-no-comments.ts`.
- `scripts/oxlint-plugin-xstate-effect.ts` and `scripts/oxlint-plugin-effect-tests.ts`.
- The debt-ledger plugin and its configuration.
- `tools/oxlint/anti-slop/`, including its upstream license and provenance.
- Lefthook pre-commit commands.
- The shared VCS command policy and Claude, Cursor, and Pi hook-bypass blockers.

The copied configuration omits unrelated application, browser, infrastructure, capability, and content rules. All generic anti-slop rules and Effect anti-slop rules from that revision remain enabled at error severity. The XState pin advances from alpha.65 to alpha.66 as required by the core's tested snapshot-restoration contract. As rat-stack's contribution rules permit, a child test config opts into the exact `effect/Arbitrary` module. Production code uses the base diagnostic map without that opt-in. No severity map is copied into the child config. The XState/Effect plugin uses Effect predicates in its AST walker instead of its inherited lint suppression. The suppression is removed. The anti-slop upstream note drops a private attribution sentence; the vendored rule code and license remain unchanged.

Piper adds `scripts/lint-exemption-ratchet.mjs`. It runs the copied debt-ledger plugin and refuses any suppression directive in maintained code. Vendored anti-slop sources retain their upstream boundary exemptions and remain excluded from lint, as in the source fence. They are still typechecked. The Pi blocker lives under `tools/pi` so local harness metadata stays ignored. Installation links the blocker into the local extension directory.

## Anti-slop

The vendored anti-slop rules retain their own [LICENSE](tools/oxlint/anti-slop/LICENSE) and [UPSTREAM.md](tools/oxlint/anti-slop/UPSTREAM.md). Those files identify upstream sources and earlier adaptations.
