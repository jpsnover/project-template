# Contributing

## Setup

```bash
git clone https://github.com/your-org/your-project.git
cd your-project
cp .env.example .env  # Add your API keys
cd app && npm install
```

## Development

```bash
npm run dev          # Start dev server
npm run test:watch   # Watch-mode tests
npm run verify       # Full local gate (tsc + eslint + depcruise + vitest + build)
```

## Before Submitting a PR

1. Run `npm run verify` — must pass cleanly
2. Every bug fix includes a regression test
3. No bare `throw "message"` — use `ActionableError` with Goal/Problem/Location/Next Steps
4. Every `catch` block calls `getGlobalRecorder()?.record()` before throwing or returning
5. No hardcoded secrets — use environment variables or the key store

## Commit Conventions

- Format: `type(scope): description`
- Types: `feat`, `fix`, `refactor`, `test`, `docs`, `chore`, `ci`
- Always create new commits — never `--amend` on shared branches
- Use `git commit -- <files>` to avoid sweeping in unrelated staged files

## Code Review

AI code review agents use the guides in `docs/CodeReview/`. Human reviewers should reference them too.

## Testing Tiers

| Tier | When | Command | Target |
|------|------|---------|--------|
| 1 | During development | `npm run test:watch` | <10s |
| 2 | Before push | `npm run verify` | ~2-3 min |
| 3 | CI (auto on PR) | Automated | ~2-3 min |
| 4 | Pre-release | `npm run test:slow` | ~10-15 min |
