# Repository Guidelines

## Purpose and Scope

- This monorepo provides SDKs that help LangChain.js and LangGraph.js users connect to Azure resources.
- Treat [LangChain.js](https://github.com/langchain-ai/langchainjs) and [LangGraph.js](https://github.com/langchain-ai/langgraphjs) as the upstream compatibility references.
- A nested `AGENTS.md` extends these repository-wide instructions for its package. Follow both files; when guidance conflicts, the instruction closest to the edited file takes precedence.
- Keep agent instructions in hierarchical `AGENTS.md` files. Do not add parallel `copilot-instructions.md` or `*.instructions.md` files.

## Upstream Compatibility

- Before designing or changing a public API, find the analogous upstream abstraction, implementation, tests, and documentation. Prefer upstream names, signatures, option shapes, return types, and lifecycle semantics.
- Preserve LangChain contracts for runnables, callbacks, streaming, tool calling, serialization, tracing, cancellation, and standardized input/output types wherever they apply.
- Keep integrations naturally usable from LangGraph.js. Prefer shared LangChain primitives over graph-specific wrappers unless the feature is inherently graph-specific.
- Introduce Azure-specific behavior only where the service requires it. Keep it additive and document any deliberate divergence from upstream behavior.
- Do not copy an upstream implementation blindly. Reconcile it with this repository's supported `@langchain/core`, Azure SDK, TypeScript, and runtime versions.
- Treat public exports, constructor options, serialized fields, and environment-variable names as compatibility surfaces. Avoid breaking them without an explicit migration plan and tests.

## Development Principles

- Keep implementations simple, focused, and efficient. Prefer the smallest design that satisfies the contract, and avoid speculative abstractions or duplicated layers.
- Treat code as the primary documentation: use precise names, types, module boundaries, and control flow so behavior is clear without explanatory comments. Document rationale, constraints, and non-obvious tradeoffs where code alone cannot express them.
- Keep interface definitions rigorous and consistent. Follow upstream conventions for naming, option objects, return types, error behavior, and serialization; use standard LangChain and TypeScript types instead of package-specific shapes when they fit.

## Design and Documentation Workflow

- Before implementing a module or feature, search the root `docs/` directory by SDK or package name for the corresponding documentation.
- If no SDK documentation exists, create it under `docs/` before implementation. If it exists, review its current design and constraints first.
- When the feature has no established design, work through its public contract, upstream compatibility, Azure-specific behavior, edge cases, and validation strategy before writing the implementation.
- Use the gitignored root `.agent-drafts/` directory for temporary todo lists, development workflows, and lightweight specifications when useful. These drafts may be shared with developers for review and direct revision during implementation.
- Treat `.agent-drafts/` as temporary working material, not durable documentation. After implementation is complete, record the final behavior and lasting design decisions in the appropriate location under `docs/` and remove or retire the corresponding draft.

## Monorepo Workflow

- Use Node.js 18 or newer and Yarn 3.5.1. Use `yarn`, not npm or pnpm, for dependency and script operations.
- Install dependencies with `yarn install`.
- Run repository checks with `yarn build`, `yarn lint`, `yarn test`, and `yarn format:check`.
- During development, run the narrowest relevant package or test command first. Run broader repository checks when changing shared configuration, dependencies, or cross-package contracts.
- Do not edit generated output such as `dist/` or generated package entrypoints. Change source or build configuration and regenerate it through package scripts.

## Change Expectations

- Keep changes scoped to the requested package and avoid unrelated refactors.
- Add or update focused unit tests for behavior changes. Add integration coverage when correctness depends on a live Azure service.
- Update public documentation and examples when changing installation, configuration, authentication, exports, or user-visible behavior.
- Never commit credentials, connection strings, access keys, tokens, or recorded responses containing sensitive customer data.
- Use Conventional Commits-style titles for commits and pull requests whenever possible, for example `feat(langchain-azure): add managed identity support` or `fix(vectorstores): forward abort signals`.
- If these instructions no longer match the repository's tooling or current best practices, update the relevant `AGENTS.md` in the same change. Verify the new guidance against working configuration, source, or upstream documentation.
