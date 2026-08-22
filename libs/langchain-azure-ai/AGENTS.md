# LangChain Azure AI SDK Guidelines

This file extends the repository-level [`AGENTS.md`](../../AGENTS.md) for work under `libs/langchain-azure-ai`.

## Package Role

- `langchain-azure-ai` exposes LangChain-compatible integrations for Azure AI resources. Its components should compose with normal LangChain.js runnables and remain usable inside LangGraph.js applications without adapters.
- The source currently contains integration scaffold placeholders. Treat only code that is explicitly recognizable as placeholder content as replaceable scaffolding; once an API is documented, exported as intentional behavior, or published, the repository's public API stability rules apply. Remove this note when the scaffold has been replaced.
- Keep implementation code in `src/`, tests in `src/tests/`, and public exports in `src/index.ts` unless package export configuration is deliberately expanded.

## API and Implementation Design

- Start with the matching interface or base class in the supported `@langchain/core` version, then compare the nearest upstream LangChain.js integration before defining the Azure API.
- Match upstream constructor patterns, call options, message and document types, generation chunks, metadata, usage reporting, callbacks, and serialization identifiers as applicable.
- Implement both required authentication paths with official Azure SDK clients and standard credential types: service-native key credentials for API keys and Azure Identity credentials or token providers for Microsoft Entra ID. Prefer accepting injectable clients or credentials over creating incompatible authentication abstractions.
- Keep credentials out of logs, errors, tracing payloads, and serialized state. Declare secret mappings for serializable LangChain components when applicable.
- Forward cancellation signals and use established LangChain retry/caller mechanisms where the underlying API supports them. Avoid stacking independent retry policies without a documented reason.
- For streaming APIs, emit standard LangChain chunks incrementally and invoke token callbacks consistently; do not buffer the complete response first.
- Translate Azure responses into standard LangChain outputs while retaining useful Azure metadata in the conventional response or document metadata fields.
- Use ESM-compatible TypeScript and include `.js` extensions in relative imports, matching the existing source and NodeNext resolution setup.
- Keep the root export surface intentional. Do not expose Azure SDK internals or implementation-only helpers accidentally.
- Do not change the `@langchain/core` peer range incidentally. If a feature requires a newer upstream contract, update the range, implementation, and compatibility tests together.

## Testing and Validation

- Put isolated tests in `src/tests/*.test.ts` and live-service tests in `src/tests/*.int.test.ts`.
- Unit tests must not require Azure credentials or network access. Mock at the Azure client boundary, cover credential selection and client construction for both API-key and Microsoft Entra ID authentication, and assert the observable LangChain contract.
- Integration tests should use environment-based configuration, avoid destructive operations by default, clean up resources they create, and never print secrets.
- While iterating, use the narrowest check that can validate the current change, normally `pnpm --filter langchain-azure-ai run test:single src/tests/<file>.test.ts` for a focused unit test. Use editor diagnostics or a targeted command instead when they provide a cheaper relevant signal.
- Once the implementation is believed complete, run the final build, test, lint, and formatting checks through the repository-level commands in the root `AGENTS.md`; do not add package-local lint or formatting configuration as a separate CI gate.
- Run `pnpm --filter langchain-azure-ai run test:int` only when the required Azure resources and environment variables are available. State clearly when integration tests were not run.
- For public API changes, verify both behavior and generated type/export compatibility with a package build.
