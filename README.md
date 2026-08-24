# 🦜️🔗 LangChain Azure for JavaScript

[![CI](https://github.com/langchain-ai/langchain-azure-js/actions/workflows/ci.yml/badge.svg)](https://github.com/langchain-ai/langchain-azure-js/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Azure AI integrations for [LangChain.js](https://github.com/langchain-ai/langchainjs) and [LangGraph.js](https://github.com/langchain-ai/langgraphjs).

> [!IMPORTANT]
> This repository is in an early development stage. The current `langchain-azure-ai` package contains integration scaffolding and does not yet provide production-ready Azure integrations. Its public API may change before the first release.

## Purpose

This repository provides LangChain-compatible integrations for Microsoft Azure AI services. Integrations should compose with standard LangChain.js runnables and work in LangGraph.js applications without adapters.

Released integrations are expected to:

- Follow LangChain.js contracts for callbacks, streaming, tool calling, serialization, tracing, and cancellation.
- Support both API-key authentication and Microsoft Entra ID authentication when the Azure service supports them.
- Use official Azure SDK clients and standard LangChain.js types.
- Preserve useful Azure response metadata without changing standard LangChain outputs.

## Packages

| Package              | Path                                                 | Status               |
| -------------------- | ---------------------------------------------------- | -------------------- |
| `langchain-azure-ai` | [`libs/langchain-azure-ai`](libs/langchain-azure-ai) | Integration scaffold |

## Development

This repository uses pnpm workspaces and requires pnpm for dependency installation and development. The supported pnpm version is pinned in the root `package.json`. Do not use npm or Yarn to install repository dependencies because `pnpm-lock.yaml` is the source of truth for the workspace.

Node.js 18 or later is required. Run all commands from the repository root:

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm build
```

Before submitting a change, run the relevant repository checks:

```bash
pnpm lint
pnpm test
pnpm format:check
```

To run checks for only the current package:

```bash
pnpm --filter langchain-azure-ai build
pnpm --filter langchain-azure-ai lint
pnpm --filter langchain-azure-ai test
```

## Contributing

Before designing or changing a public API, compare the analogous LangChain.js abstraction and implementation. Azure-specific behavior should remain additive and should be documented with focused tests for both supported authentication paths.

Repository-wide guidance is available in [`AGENTS.md`](AGENTS.md), with package-specific guidance in [`libs/langchain-azure-ai/AGENTS.md`](libs/langchain-azure-ai/AGENTS.md).

## Related projects

- [LangChain.js](https://github.com/langchain-ai/langchainjs): upstream JavaScript abstractions and compatibility reference.
- [LangGraph.js](https://github.com/langchain-ai/langgraphjs): graph-based orchestration for LangChain-compatible components.
- [langchain-azure](https://github.com/langchain-ai/langchain-azure): Python counterpart and secondary feature reference.

## License

This project is licensed under the [MIT License](LICENSE).
