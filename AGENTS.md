# AGENTS.md

Guidance for coding agents working in `langchain-azure-js`.

## Repository relationship

This repository is the standalone home for the JavaScript/TypeScript
`langchain-azure` integration package. It is part of the LangChain.js
ecosystem, but it is not the `langchainjs` monorepo and should not be treated as
a fork that is kept in sync wholesale.

The canonical upstream repositories have different responsibilities:

- [`langchain-ai/langchainjs`](https://github.com/langchain-ai/langchainjs)
  owns LangChain.js core abstractions, first-party provider packages, shared
  tooling, and the historical `@langchain/community` Azure integrations.
- [`langchain-ai/langchain-azure-js`](https://github.com/langchain-ai/langchain-azure-js)
  owns Azure-native integrations selected for the standalone
  `langchain-azure` package.
- [`langchain-ai/langchain-azure`](https://github.com/langchain-ai/langchain-azure)
  is the Python Azure integration repository and may be used as a behavioral
  reference, not as a source for direct language-level ports.

`langchain-azure-js` depends on public APIs from `@langchain/core`. Changes to
core abstractions belong in `langchainjs`; do not copy or privately reimplement
core classes here. When this repository exposes models or services already
owned by another LangChain.js package, extend or fix that owner instead of
creating a competing implementation. In particular, Azure OpenAI and
OpenAI-compatible Microsoft Foundry model support belongs in
`@langchain/openai`.

Historical Azure implementations may be migrated from the `langchainjs`
community package, but they must be updated to current LangChain.js interfaces,
Azure SDKs, authentication practices, tests, and error-handling standards.
Preserve useful public behavior where practical; do not preserve obsolete
dependencies or known defects solely for source compatibility.

## Current repository state

The repository was scaffolded from an older LangChain.js integration template.
Some README text, package metadata, scripts, placeholders, and dependency
versions may still describe the original monorepo or an unfinished sample.
Treat those values as migration work, not as authoritative architecture.

Before implementing a feature:

1. Compare the relevant package conventions with the current `langchainjs`
   monorepo.
2. Identify whether the feature already has an owner in another LangChain.js
   package.
3. Check current Azure SDK status and avoid deprecated or retired services.
4. Prefer injected Azure SDK clients and `TokenCredential`; retain API keys or
   connection strings only where they are supported and useful.

## Scope and compatibility

- Keep `@langchain/core` as a peer dependency and code against its public APIs.
- Do not add `@langchain/openai` merely to wrap or duplicate its classes.
- Keep service dependencies isolated so consumers do not load unrelated Azure
  SDKs.
- Follow current LangChain.js naming, serialization, callback, streaming, test,
  and package-export conventions unless this standalone repository documents a
  deliberate difference.
- Live Azure tests must be gated by service-specific environment variables;
  unit tests must not require Azure credentials or resources.

## Change discipline

- Do not modify sibling repositories as an implicit part of a change here.
  Cross-repository work must be called out and reviewed separately.
- Do not overwrite unrelated local changes. This repository may contain active
  work on feature branches.
- Keep migrations and new integrations in focused, independently reviewable
  changes.
