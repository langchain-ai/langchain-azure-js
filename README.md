# 🦜️🔗 LangChain Azure JS

A pnpm workspace for developing Azure integrations for [LangChain.js](https://js.langchain.com/).

[![CI](https://github.com/langchain-ai/langchain-azure-js/actions/workflows/ci.yml/badge.svg)](https://github.com/langchain-ai/langchain-azure-js/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

> [!IMPORTANT]
> The `langchain-azure` package is currently an unpublished development scaffold. Its provider operations are not implemented yet, so it is not ready for production use.

The workspace currently provides extension points for chat models, LLMs, and vector stores built on `@langchain/core`.

## 🛠️ Development Setup

This repository is a pnpm workspace. Run development commands from the repository root.

### Prerequisites

- Node.js 20.x or 22.x is recommended; Node.js 18 or later is required.
- [Corepack](https://nodejs.org/api/corepack.html) must be available. If the `corepack` command is missing, install it with `npm install --global corepack`.

### Install

```bash
git clone https://github.com/langchain-ai/langchain-azure-js.git
cd langchain-azure-js
corepack enable
pnpm install --frozen-lockfile
```

Corepack uses the pnpm version declared in `package.json`. Use `pnpm install` without `--frozen-lockfile` only when intentionally updating dependencies, and commit the resulting `pnpm-lock.yaml` changes.

### Common Commands

| Command | Description |
| --- | --- |
| `pnpm build` | Build all workspace packages. |
| `pnpm test` | Build the required packages and run unit tests. |
| `pnpm lint` | Run ESLint and circular dependency checks. |
| `pnpm lint:fix` | Fix supported lint issues, then run circular dependency checks. |
| `pnpm format` | Format source files with Prettier. |
| `pnpm format:check` | Check formatting without modifying files. |
| `pnpm clean` | Remove workspace build outputs. |
| `pnpm --filter langchain-azure test` | Run unit tests only for `langchain-azure`. |
| `pnpm --filter langchain-azure test:watch` | Run the package unit tests in watch mode. |

Use pnpm's `--filter` option to run other package-level scripts, for example:

```bash
pnpm --filter langchain-azure build
pnpm --filter langchain-azure lint
```

## 📁 Project Structure

| Path | Purpose |
| --- | --- |
| `libs/langchain-azure/src/chat_models.ts` | Chat model integration scaffold. |
| `libs/langchain-azure/src/llms.ts` | LLM integration scaffold. |
| `libs/langchain-azure/src/vectorstores.ts` | Vector store integration scaffold. |
| `libs/langchain-azure/src/tests/` | Unit and integration tests. |
| `patches/` | pnpm dependency patches. |

## 🌐 Supported Environment

- Node.js 18 or later.
- Node.js 20 and 22 are exercised in CI.
- TypeScript source with ESM and CommonJS build outputs.

Browser, edge-runtime, and Deno compatibility are not currently guaranteed.

## 📖 LangChain Resources

- [LangChain.js documentation](https://js.langchain.com/docs/introduction)
- [LangChain concepts](https://js.langchain.com/docs/concepts)
- [Integration documentation](https://js.langchain.com/docs/integrations/platforms/)
- [LangChain.js API reference](https://api.js.langchain.com)
- [LangSmith](https://docs.smith.langchain.com/)

## 💁 Contributing

Contributions are welcome. Use the development setup above, run the relevant checks, and open a pull request against this repository.

- [Open an issue](https://github.com/langchain-ai/langchain-azure-js/issues)
- [View pull requests](https://github.com/langchain-ai/langchain-azure-js/pulls)

## 📄 License

This project is licensed under the [MIT License](LICENSE).
