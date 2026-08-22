# Repository Guidelines

## Purpose and Scope

- This monorepo provides SDKs that help LangChain.js and LangGraph.js users connect to Azure resources.
- Treat [LangChain.js](https://github.com/langchain-ai/langchainjs) and [LangGraph.js](https://github.com/langchain-ai/langgraphjs) as the upstream compatibility references.
- Use [langchain-azure](https://github.com/langchain-ai/langchain-azure), the Python counterpart, as a secondary reference for feature coverage, service behavior, and design lessons. Aim for long-term capability convergence rather than line-by-line parity, and account for differences between the JavaScript and Python Azure SDKs and language ecosystems.
- A nested `AGENTS.md` extends these repository-wide instructions for its package. Follow both files; when guidance conflicts, the instruction closest to the edited file takes precedence.
- Keep agent instructions in hierarchical `AGENTS.md` files. Do not add parallel `copilot-instructions.md` or `*.instructions.md` files.

## Upstream Compatibility

- Before designing or changing a public API, find the analogous upstream abstraction, implementation, tests, and documentation. Prefer upstream names, signatures, option shapes, return types, and lifecycle semantics.
- Preserve LangChain contracts for runnables, callbacks, streaming, tool calling, serialization, tracing, cancellation, and standardized input/output types wherever they apply.
- Keep integrations naturally usable from LangGraph.js. Prefer shared LangChain primitives over graph-specific wrappers unless the feature is inherently graph-specific.
- Introduce Azure-specific behavior only where the service requires it. Keep it additive and document any deliberate divergence from upstream behavior.
- Do not copy an upstream implementation blindly. Reconcile it with this repository's supported `@langchain/core`, Azure SDK, TypeScript, and runtime versions.
- Treat public exports, constructor options, serialized fields, and environment-variable names as compatibility surfaces. Avoid breaking them without an explicit migration plan and tests.
- Preserve published APIs by default. Change a public API only when a new capability or a deliberate change in the product's mental model requires it; align the new shape with LangChain.js conventions and clearly communicate compatibility impact and migration guidance to users.
- Prefer additive evolution and deprecation periods over immediate removal or renaming of published APIs. Record any public compatibility impact, before-and-after usage, and migration guidance in the corresponding SDK documentation.
- Refine internal interfaces proactively as understanding improves. Internal parameter shapes and module boundaries may change when doing so makes the implementation simpler, more coherent, or easier to extend.

## Development Principles

- Keep implementations simple, focused, and efficient. Prefer the smallest design that satisfies the contract, and avoid speculative abstractions or duplicated layers.
- Treat code as the primary documentation: use precise names, types, module boundaries, and control flow so behavior is clear without explanatory comments. Document rationale, constraints, and non-obvious tradeoffs where code alone cannot express them.
- Keep interface definitions rigorous and consistent. Follow upstream conventions for naming, option objects, return types, error behavior, and serialization; use standard LangChain and TypeScript types instead of package-specific shapes when they fit.
- Structure code around clear responsibilities, explicit ownership, and stable dependency directions. Favor high cohesion and low coupling; avoid modules that mix transport, Azure service translation, LangChain adaptation, and policy without a clear boundary.
- Because the repository is early-stage, design new modules around credible future extension points rather than one-off implementations. Ground extensibility in known service capabilities, upstream patterns, or the Python counterpart, and do not add generic abstractions without a concrete use case.
- Give newly introduced or modified public APIs complete, precise TSDoc that describes parameters, return values, errors, constraints, and useful examples where appropriate. Keep internal comments short and focused on non-obvious rationale; prefer clearer structure and names over large narrative comment blocks.

## Quality Review

- At meaningful implementation checkpoints, review the complete diff, including tests and documentation, for correctness, unnecessary complexity, weak abstractions, awkward internal parameter shapes, duplication, dead paths, stale scaffolding, and temporary workarounds. Remove low-quality code as soon as it is identified rather than carrying it to final review.
- Hold documentation to the same standard as code. It must be accurate, concise, organized for its intended reader, and consistent with the implemented API and current examples.
- Use checkpoint reviews to improve internal contracts freely while the change is still local. If a review reveals a public API change, reassess whether it is truly necessary and make the user-visible impact explicit before proceeding.

## Design and Documentation Workflow

- Before implementing a module or feature, search the root `docs/` directory by SDK or package name for the corresponding documentation.
- Store package-level design and public contracts in `docs/<sdk-name>/README.md`, and feature-specific design and decisions in `docs/<sdk-name>/<feature-name>.md`. Follow an established package structure when one already exists.
- If no SDK documentation exists, create its `README.md` under `docs/<sdk-name>/` before implementation. If it exists, review its current design and constraints first.
- When the feature has no established design, work through its public contract, upstream compatibility, Azure-specific behavior, edge cases, and validation strategy before writing the implementation.
- Use the gitignored root `.agent-drafts/` directory for temporary todo lists, development workflows, and lightweight specifications when useful. These drafts may be shared with developers for review and direct revision during implementation.
- Never put credentials, tokens, connection strings, customer data, or other sensitive values in `.agent-drafts/`.
- Treat `.agent-drafts/` as temporary working material, not durable documentation. After implementation is complete, record the final behavior and lasting design decisions in the appropriate location under `docs/` and remove the corresponding draft.

## Monorepo Workflow

- Keep supported Node.js versions aligned with the current LangChain.js support policy. Treat package `engines` fields and the CI version matrix as the executable support contract; verify upstream before changing them, and update packages, CI, and documentation together.
- Use the repository-pinned Yarn version. Use `yarn`, not npm or pnpm, for dependency and script operations.
- Install dependencies with `yarn install`.
- Run repository checks with `yarn build`, `yarn lint`, `yarn test`, and `yarn format:check`.
- Avoid repeatedly running broad test and lint suites while implementation is still changing. During iteration, run only the narrowest relevant test, typecheck, or lint command when feedback is needed; once the change is believed complete, run the package-level checks, then broader repository checks when shared configuration, dependencies, or cross-package contracts changed.
- Treat VS Code as the recommended development environment. Keep `.vscode/settings.json`, recommended extensions, repository scripts, and CI aligned so editor formatting and diagnostics use the same checked-in configuration and effective options as command-line and CI checks.
- Keep tooling configuration in shared files whenever possible. CI should invoke repository scripts rather than duplicate formatter, linter, compiler, or test-runner flags that can drift from local and VS Code behavior.
- Maintain exactly one root `.prettierrc` and one root `.prettierignore` for the entire monorepo. Package scripts, VS Code, and CI must consume those root files; do not add package-local Prettier configuration or ignore files.
- Use one repository-wide test framework and centralize its dependencies and shared configuration at the root. Package-specific test setup may extend the shared configuration only for genuine environment or service differences; do not duplicate the framework or its common dependencies per package.
- Do not edit generated output such as `dist/` or generated package entrypoints. Change source or build configuration and regenerate it through package scripts.

## Change Expectations

- Keep changes scoped to the requested package and avoid unrelated refactors.
- Add or update focused unit tests for behavior changes. Add integration coverage when correctness depends on a live Azure service.
- Update public documentation and examples when changing installation, configuration, authentication, exports, or user-visible behavior.
- Never commit credentials, connection strings, access keys, tokens, or recorded responses containing sensitive customer data.
- Use Conventional Commits-style titles for commits and pull requests whenever possible, for example `feat(langchain-azure): add managed identity support` or `fix(vectorstores): forward abort signals`.
- If these instructions no longer match the repository's tooling or current best practices, update the relevant `AGENTS.md` in the same change. Verify the new guidance against working configuration, source, or upstream documentation.
