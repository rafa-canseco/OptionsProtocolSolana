# Solana Instance

You are the **Solana instance**. You own all code in `solana/`.

## Scope

- **Write/modify**: only files in `solana/`
- **Read**: any file in the repo for context
- **Never access**: `../options-scenarios/` (holdout test boundary)

## Tooling

- Rust, Anchor framework
- Build: `anchor build`
- Test: `anchor test`
- Format: `cargo fmt`
- Lint: `cargo clippy`
- Deploy scripts: `solana/scripts/` (to be created)

## Block Explorer

Solana Explorer for devnet: https://explorer.solana.com/?cluster=devnet

## Holdout Rule

You MUST NOT read, explore, glob, grep, or access any file inside
`../options-scenarios/`. This is a holdout testing setup. The user
will share only error messages when tests fail.

## Before You Start

1. Read `playbook/CONTEXT.md` for project overview, architecture,
   deployed addresses, and file map
2. Read your assigned Linear issue (b1nary workspace, team B1N)
3. Post your implementation plan as a comment on the Linear issue.
   Do NOT start coding until the plan is approved.

## Git Workflow

- Commit often. One logical change per commit.
- Conventional commit prefixes: feat:, fix:, chore:, refactor:, docs:
- Never push to main or dev directly. Feature branches only.
- All PRs target `dev`. Branch naming includes Linear issue ID:
  `feat/b1n-5-description`
- PR titles include the Linear issue ID: "B1N-5: Description"

## Linear Workflow

- When you receive a task: read the issue, post your plan as a comment
- When plan is approved: move issue to "In Progress"
- When code is done: commit, push, create PR to dev, post completion
  summary on the issue, move to "Review"
- When user says "merge it": post final summary (what delivered,
  security audit, testing results), move to "Done"
- If you unblock others: comment on blocked issues with available
  endpoints/files
- If you get blocked: comment on the issue explaining the blocker

## Chain & Environment

- **Testnet**: Solana Devnet (mock tokens for staging, same as Base Sepolia approach)
- **Mainnet**: Solana Mainnet-Beta
- **RPC**: Helius (API key in env, never committed)
- **Oracle**: Pyth (replaces Chainlink on Base)
- **Swap**: Jupiter (replaces Uniswap on Base)
- **Flash loans**: SPL token-lending (replaces Aave on Base)

## Programs

| Program | Description |
|---------|-------------|
| `address_book` | Central registry (equivalent to AddressBook) |
| `controller` | Vault lifecycle (open, deposit, mint, settle, redeem) |
| `margin_pool` | Holds collateral in PDA-owned SPL token accounts |
| `otoken_factory` | Creates oToken SPL mints via PDA derivation |
| `oracle` | Pyth price feed integration |
| `whitelist` | Whitelisted assets and products |
| `batch_settler` | executeOrder + expiry settlement |
