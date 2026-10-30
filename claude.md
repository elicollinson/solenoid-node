# Claude Code Configuration

This file provides guidance for AI agents working on the Solenoid codebase.

## Verification Workflow

Before pushing any code changes, you **must** complete the following verification steps in order:

### 1. Run `/simplify`

After making any code changes, start by running the `/simplify` skill on the branch. It reviews the diff for reuse, simplification, efficiency and altitude issues, then applies the fixes.

### 2. Run Unit Tests

Execute the test suite to ensure all tests pass:

```bash
bun test
```

### 3. Functional Testing with Agent Harness

Use the agent harness to functionally test your changes before pushing:

```bash
bun test tests/e2e/harness-integration.test.tsx
```

## Verification Checklist

Before pushing code, confirm all of the following:

- [ ] `/simplify` has been run
- [ ] All unit tests pass
- [ ] Functional tests via agent harness pass

## Important Notes

- **Never push code that fails any verification step**
- If any step fails, fix the issues and re-run the entire verification workflow
- When in doubt, run the full verification suite again before pushing
