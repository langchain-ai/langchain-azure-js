# Repository Guidelines

## Package management

- Use pnpm for dependency management and repository scripts.
- Do not add npm or Yarn lockfiles, configuration, or commands.
- Run workspace commands from the repository root unless a task specifically requires a package directory.

## Build and test

- Install dependencies with `pnpm install --frozen-lockfile`.
- Validate relevant changes with the narrowest applicable checks, then run the broader build, lint, test, and format checks when appropriate.
- Use the scripts declared in the root `package.json` instead of duplicating their underlying commands.

## Documentation

- Before completing work intended for a commit or opening or updating a pull request, assess whether repository documentation needs to change.
- Update the README or other relevant documentation when changes affect setup, package management, configuration, environment variables, public APIs, workflows, or user-visible behavior.
- When no documentation update is needed, state that the documentation impact was considered in the commit or pull request summary.