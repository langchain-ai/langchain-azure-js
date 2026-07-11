# 🦜️🔗langchain-azure-js

[![CI](https://github.com/langchain-ai/langchain-azure-js/actions/workflows/ci.yml/badge.svg)](https://github.com/langchain-ai/langchain-azure-js/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

Azure integrations for [LangChain.js](https://github.com/langchain-ai/langchainjs), developed as a pnpm workspace.

This repository uses pnpm to manage dependencies and scripts across multiple workspaces.

## Project status

This repository is under active development. The `langchain-azure` workspace currently contains scaffolding for chat model, LLM, and vector store integrations; their core service methods are not implemented yet. Do not use the package in production until those integrations and their tests are complete.

## Repository layout

```text
.
|-- libs/
|   `-- langchain-azure/  # LangChain Azure integration package
|-- patches/              # pnpm dependency patches
|-- package.json          # Workspace scripts and tool versions
`-- pnpm-workspace.yaml   # Workspace and dependency configuration
```

## Prerequisites

- Node.js 20 or higher, as declared by the root `engines` field.
- pnpm 10.14.0, as declared by the root `packageManager` field
- Corepack, for activating the repository's pinned pnpm version

## Setup

From the repository root:

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm build
```

Corepack reads the `packageManager` field and selects the expected pnpm version.

## Development

Run these commands from the repository root:

| Task | Command |
| --- | --- |
| Build all workspaces | `pnpm build` |
| Run unit tests | `pnpm test` |
| Run lint checks | `pnpm lint` |
| Check formatting | `pnpm format:check` |
| Apply formatting | `pnpm format` |
| Remove generated build output | `pnpm clean` |

Before opening a pull request, run:

```bash
pnpm build
pnpm lint
pnpm test
pnpm format:check
```

## Contributing

Keep changes focused, add or update tests for behavior changes, and update documentation whenever setup steps, commands, public APIs, or user-visible behavior change.

## License

This project is licensed under the [MIT License](./LICENSE).
