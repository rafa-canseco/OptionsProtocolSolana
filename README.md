# b1nary options

b1nary is the volatility protocol for covered calls, cash-secured puts, and automated option vaults.

This repository is the public entry point for the Colosseum submission. It leads with the Solana deployment and links the full product surface: live app, demo, pitch deck, documentation, backend, frontend, market maker, EVM contracts, launch metrics, and social proof.

## Submission links

| Asset | Link | Status |
| --- | --- | --- |
| Product | https://b1nary.app/ | Live |
| Documentation | https://docs.b1nary.app/ | Live |
| Demo | https://youtu.be/7L6NZzeQNko | Live |
| Pitch deck | https://www.canva.com/design/DAHC4xmnS0A/7FtAXBe_VStdRMDyNC4BcA/view?utm_content=DAHC4xmnS0A&utm_campaign=designshare&utm_medium=link&utm_source=viewer | Live |
| Twitter / X | https://x.com/b1naryapp | Live |
| Solana programs | https://github.com/rafa-canseco/OptionsProtocolSolana | Public |
| Frontend | https://github.com/rafa-canseco/OptionsProtocolFrontend | Public |
| Backend | https://github.com/rafa-canseco/OptionsProtocolBackend | Public |
| Market maker | https://github.com/rafa-canseco/OptionsProtocolMarketMaker | Public |
| EVM contracts | https://github.com/rafa-canseco/OptionsProtocolBlockchain | Public |

## What b1nary does

b1nary lets users set the price where they want to earn yield. Under the hood, users sell fully collateralized options: cash-secured puts or covered calls. The app shows live executable prices from the market maker; when the user accepts one, the protocol atomically locks collateral, mints the option token, transfers the option exposure to the market maker, and pays premium to the user.

The system is built for instant settlement, not a request-for-quote workflow. Users do not wait for manual dealer responses. They accept already-published, signed quotes with capacity limits, expiry, nonce protection, and on-chain verification.

The Base implementation is live in production. The Solana implementation extends the same product model to Solana assets with PDA-owned collateral accounts, deterministic option mints, Pyth prices, Jupiter physical delivery routing, and Ed25519 quote verification.

## Architecture

| Component | Repository | Purpose |
| --- | --- | --- |
| Solana programs | https://github.com/rafa-canseco/OptionsProtocolSolana | Anchor programs for oToken creation, collateral vaults, signed quote acceptance, oracle integration, whitelisting, and redemption flows. |
| EVM contracts | https://github.com/rafa-canseco/OptionsProtocolBlockchain | Solidity implementation used on EVM networks, including controller, margin pool, oracle, oToken factory, batch settler, and vault logic. |
| Backend | https://github.com/rafa-canseco/OptionsProtocolBackend | API, quote orchestration, Solana/EVM chain abstraction, event indexing, settlement jobs, notifications, capacity endpoints, and operational bots. |
| Frontend | https://github.com/rafa-canseco/OptionsProtocolFrontend | Next.js app for user onboarding, wallet flows, option discovery, trade execution, redemption, and portfolio views. |
| Market maker | https://github.com/rafa-canseco/OptionsProtocolMarketMaker | Quote engine, pricing, capacity management, signing, fill listener, trade logging, and hedge execution. |

## Solana mainnet programs

The Solana programs are deployed on mainnet-beta and configured for the Solana expansion path. Latest checked with `solana program show -u mainnet-beta` on 2026-05-08.

| Program | Mainnet program ID | Last deployed slot | Description |
| --- | --- | ---: | --- |
| `controller` | [`FH3z4BYRZMFU8YzpJoFXUbrdoYksdERnWbZvDAEc3qcC`](https://explorer.solana.com/address/FH3z4BYRZMFU8YzpJoFXUbrdoYksdERnWbZvDAEc3qcC) | 417995444 | Core vault lifecycle: opens vaults, accepts collateral deposits, mints oTokens, settles vaults after expiry, redeems oTokens, stores option metadata, and applies pause/emergency controls. |
| `batch_settler` | [`GpR6id2cHu5fUGsFm7NUKkB4NzfuEDa6brPzkSrgAzvS`](https://explorer.solana.com/address/GpR6id2cHu5fUGsFm7NUKkB4NzfuEDa6brPzkSrgAzvS) | 417996636 | Instant signed-quote acceptance and settlement layer: verifies market-maker Ed25519 signatures, prevents overfills/cancellations, transfers premium, custodies maker oTokens, supports maker redemption, self-redemption escape paths, and physical delivery through Jupiter routing. |
| `oracle` | [`EMgyserXHEQz4dYTT9LoSa5KNszXnTruV6LL5w63dvJd`](https://explorer.solana.com/address/EMgyserXHEQz4dYTT9LoSa5KNszXnTruV6LL5w63dvJd) | 417988035 | Pyth price integration: registers feeds, validates staleness/confidence/deviation, normalizes prices to 8 decimals, and finalizes expiry prices for settlement. |
| `otoken_factory` | [`84hBdboukYWVg7DoBu5Z22vCgodG4B1PFSMXrBZAivZ1`](https://explorer.solana.com/address/84hBdboukYWVg7DoBu5Z22vCgodG4B1PFSMXrBZAivZ1) | 417454408 | Deterministic oToken metadata and mint creation for each option series: underlying, strike asset, collateral, strike price, expiry, and put/call side. |
| `margin_pool` | [`Hp7XDp9USyoid2f7cJKPxmDrvHM2D8izeeGzkViPiy5r`](https://explorer.solana.com/address/Hp7XDp9USyoid2f7cJKPxmDrvHM2D8izeeGzkViPiy5r) | 417410355 | Collateral pool program for PDA-owned SPL token vaults, direct pool deposits/withdrawals, and admin-configured controller/operator/yield recipient settings. |
| `whitelist` | [`F759VGDWkcxjjGByWZTTdDKJwj1RFzH2VHZS3p4VXnts`](https://explorer.solana.com/address/F759VGDWkcxjjGByWZTTdDKJwj1RFzH2VHZS3p4VXnts) | 417455083 | Whitelist registry for approved oTokens, callable by admin, factory, or factory operator. |

### Integrated mainnet programs and assets

| Dependency | Address | Purpose |
| --- | --- | --- |
| Pyth Receiver | [`rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ`](https://explorer.solana.com/address/rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ) | Pull oracle receiver used by the oracle program. |
| Jupiter | [`JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4`](https://explorer.solana.com/address/JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4) | Swap route execution for physical settlement. |
| USDC | [`EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`](https://explorer.solana.com/address/EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v) | Premium, strike, and collateral asset. |
| WSOL | [`So11111111111111111111111111111111111111112`](https://explorer.solana.com/address/So11111111111111111111111111111111111111112) | Underlying or collateral asset for SOL products. |
| TSLAx | [`XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB`](https://explorer.solana.com/address/XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB) | Tokenized equity underlying used in current setup scripts. |

## Deployment flow

The mainnet setup script is [`scripts/setup-mainnet.ts`](scripts/setup-mainnet.ts). It is guarded by `MAINNET_CONFIRM=I_UNDERSTAND_MAINNET`, expects a Ledger/admin wallet for protocol configuration, and can be re-run idempotently when `MAINNET_SEED_NONCE` is reused.

High-level flow:

1. Build and deploy Anchor programs.
2. Initialize program configs with admin, operator, treasury, Pyth receiver, Jupiter, fee settings, confidence limits, and escape delay.
3. Create collateral vault token accounts for supported assets.
4. Register Pyth feeds for supported underlyings.
5. Create option series through the oToken factory.
6. Whitelist approved oTokens.
7. Configure market-maker wallet, premium accounts, quote nonce state, and delegation.
8. Run smoke tests and operational checks before enabling production fills.

Example:

```bash
MAINNET_CONFIRM=I_UNDERSTAND_MAINNET \
MAINNET_SEED_NONCE=<secret-reused-on-reruns> \
ANCHOR_PROVIDER_URL=https://api.mainnet-beta.solana.com \
ANCHOR_WALLET='usb://ledger?key=0/0' \
OPERATOR_PUBKEY=<operator-hot-wallet> \
TREASURY_PUBKEY=<treasury-wallet> \
MM_PUBKEY=<market-maker-wallet> \
npx ts-node scripts/setup-mainnet.ts
```

## Product metrics: first 5 weeks

| Metric | First 5 weeks |
| --- | ---: |
| Notional volume | $53,000 |
| Premium paid to users | $200 |
| Number of trades | 310 |
| Unique wallets | 67 |
| Returning users | 65% |

Additional proof:

- Demo: https://youtu.be/7L6NZzeQNko
- Product: https://b1nary.app/
- Twitter / X: https://x.com/b1naryapp

## Security and risk controls

- PDA-owned token accounts hold collateral; users do not transfer custody to an externally owned market-maker account.
- oToken mints and vault state use deterministic PDA derivation.
- Market-maker quotes are published by the backend/MM stack and verified on-chain when accepted.
- Quote fills track nonce, quote ID, max amount, deadline, cancellation, and partial-fill limits.
- Pyth prices are validated for feed registration, staleness, confidence interval, and expiry-price deviation.
- Controller and settler include pause controls and emergency paths.
- Maker self-redemption is available after expiry plus escape delay if the operator is offline.
- Physical settlement does not rely on Solana flash loans; it redeems first and routes swaps through Jupiter with balance-delta checks.

## Roadmap

- On-ramp and off-ramp integration.
- Strategy vaults for cash-secured puts and covered calls.
- Meta-vault that automates the wheel strategy.
- Add 10 more supported assets.
- Idle yield switch: route unused collateral into Kamino on Solana and Aave on Base while waiting for expiry.
- Vault curator branch for managed vault deployment and curation.

## Development

Build:

```bash
anchor build
```

Test:

```bash
anchor test
```

Run a targeted test:

```bash
yarn run ts-mocha -p ./tsconfig.json -t 1000000 tests/b1nary-options.ts
```

## Anchor programs

| Program | PDA seeds |
| --- | --- |
| `controller` | `[b"controller_config"]`, `[b"vault", owner, vault_id]`, `[b"vault_counter", owner]`, `[b"pool_vault_auth", collateral_mint]` |
| `batch_settler` | `[b"settler_config"]`, `[b"maker", maker]`, `[b"quote_fill", maker, maker_nonce, quote_id]`, `[b"maker_otoken_balance", maker, otoken_mint]`, `[b"rent_reserve"]` |
| `oracle` | `[b"oracle_config"]`, `[b"feed", underlying]`, `[b"expiry_price", underlying, expiry]` |
| `otoken_factory` | `[b"factory_config"]`, `[b"factory_operator_config"]`, `[b"otoken", underlying, strike_asset, collateral, strike_price, expiry, is_put]` |
| `margin_pool` | `[b"margin_pool_config"]`, `[b"pool_vault", collateral_mint]`, `[b"lending_vault_auth", collateral_mint]` |
| `whitelist` | `[b"whitelist_config"]`, `[b"whitelisted_otoken", otoken_mint]` |

## Base mainnet contracts

These are the live Base mainnet proxy contracts for the production app.

| Contract | Proxy address | Current implementation |
| --- | --- | --- |
| `AddressBook` | [`0x48FE24a69417038a2D3d46B2B6B9De03b884eD72`](https://basescan.org/address/0x48FE24a69417038a2D3d46B2B6B9De03b884eD72) | `0x40D39d9531c4dDcC0b4CE2542170ea06BfEfaee2` |
| `Controller` | [`0x2Ab6D1c41f0863Bc2324b392f1D8cF073cF42624`](https://basescan.org/address/0x2Ab6D1c41f0863Bc2324b392f1D8cF073cF42624) | `0x796033f42fEf0036bB0486C83232A5E575Df1E6E` |
| `MarginPool` | [`0xa1e04873F6d112d84824C88c9D6937bE38811657`](https://basescan.org/address/0xa1e04873F6d112d84824C88c9D6937bE38811657) | `0x0dE4993243B263C92354c9a45b7F08B31307b0fF` |
| `OTokenFactory` | [`0x0701b7De84eC23a3CaDa763bCA7A9E324486F6D7`](https://basescan.org/address/0x0701b7De84eC23a3CaDa763bCA7A9E324486F6D7) | `0xC02828aB769edE49548315cb60d15189faB510A5` |
| `Oracle` | [`0x09daa0194A3AF59b46C5443aF9C20fAd98347671`](https://basescan.org/address/0x09daa0194A3AF59b46C5443aF9C20fAd98347671) | `0x14987C5e3D74206CF3e417FC181Cda01543351c2` |
| `Whitelist` | [`0xC0E6b9F214151cEDbeD3735dF77E9d8EE70ebA8A`](https://basescan.org/address/0xC0E6b9F214151cEDbeD3735dF77E9d8EE70ebA8A) | `0x5F3b652b2b258e36bc88C3Bdf3c4e1EcF04BCF00` |
| `BatchSettler` | [`0xd281ADdB8b5574360Fd6BFC245B811ad5C582a3B`](https://basescan.org/address/0xd281ADdB8b5574360Fd6BFC245B811ad5C582a3B) | `0xAA2bcAF585AAd5831e8fBc5E13CA9a9F8233fFc9` |

External Base integrations:

| Integration | Address |
| --- | --- |
| WETH | [`0x4200000000000000000000000000000000000006`](https://basescan.org/address/0x4200000000000000000000000000000000000006) |
| USDC | [`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`](https://basescan.org/address/0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913) |
| cbBTC | [`0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf`](https://basescan.org/address/0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf) |
| Aave V3 Pool | [`0xA238Dd80C259a72e81d7e4664a9801593F98d1c5`](https://basescan.org/address/0xA238Dd80C259a72e81d7e4664a9801593F98d1c5) |
| Uniswap SwapRouter | [`0x2626664c2603336E57B271c5C0b26F421741e481`](https://basescan.org/address/0x2626664c2603336E57B271c5C0b26F421741e481) |
