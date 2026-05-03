# b1nary options - Solana Programs

Options protocol on Solana, mirroring the EVM contracts on Base (`blockchain/`).

## Programs

| Program | Description | PDA Seeds |
|---------|-------------|-----------|
| `controller` | Vault lifecycle (open, deposit, mint, settle, redeem) | `[b"vault", owner, vault_id]`, `[b"vault_counter", owner]` |
| `margin_pool` | Holds collateral in PDA-owned SPL token accounts | `[b"margin_pool", collateral_mint]` |
| `otoken_factory` | Creates oToken SPL mints via PDA derivation | `[b"otoken", underlying, strike_asset, collateral, strike_price, expiry, is_put]` |
| `oracle` | Pyth price feed integration | `[b"oracle_config"]`, `[b"feed", underlying]`, `[b"expiry_price", underlying, expiry]` |
| `whitelist` | Whitelisted assets and products | `[b"whitelist_config"]`, `[b"asset", mint]`, `[b"product", underlying, collateral, is_put]` |
| `batch_settler` | Trade execution (executeOrder) and expiry settlement | `[b"settler_config"]` |

## Architecture Decisions

**Account model.** All state is stored in PDA accounts derived from deterministic seeds. This replaces Solidity's storage mappings. Each vault, oToken, and pool is its own account.

**No proxy pattern.** Solana programs are natively upgradeable via the BPF loader. No UUPS/transparent proxy needed. The upgrade authority is a multisig.

**Collateral handling.** SPL token accounts owned by program PDAs hold all collateral. The MarginPool PDA is the token account authority.

**Signed quotes.** Market maker signs quotes with ed25519 (Solana native). This replaces EIP-712 typed data from the EVM side. The Ed25519 precompile verifies signatures on-chain.

**Oracle.** Pyth price feeds replace Chainlink. Pyth provides price + confidence interval. We enforce staleness and confidence deviation checks.

**Physical settlement.** Direct collateral delivery plus Jupiter swap routing replaces the Base flash-loan path. The Solana version intentionally does not deploy a lending/flash-loan integration.

## Build

```bash
anchor build
```

## Test

```bash
anchor test
```

## Dependencies

| Crate | Version | Programs | Notes |
|-------|---------|----------|-------|
| `anchor-lang` | 0.32.1 | All programs | Core framework |
| `anchor-spl` | 0.32.1 | controller, margin_pool, otoken_factory, batch_settler | `default-features = false, features = ["token"]` to avoid token-2022 version conflict |
| `pyth-solana-receiver-sdk` | 1.1.0 | oracle | Pyth pull oracle integration |
| `jupiter-cpi` | 4.0.3 | batch_settler | Jupiter swap CPI for physical settlement |

**Note:** `anchor-spl` must use `default-features = false` with only the `token` feature. Enabling `token_2022` (on by default) creates a `solana-instruction` version conflict between `solana-zk-sdk =2.2.1` and `anchor-lang`'s `2.3.3`.
