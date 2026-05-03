/**
 * Mainnet setup script for the current Solana programs.
 *
 * Safety:
 *   - Refuses to run unless MAINNET_CONFIRM=I_UNDERSTAND_MAINNET.
 *   - Use the Ledger/admin wallet for protocol configuration.
 *   - Re-run with the MM/operator hot wallet to create + approve the MM USDC ATA.
 *
 * Example:
 *   MAINNET_CONFIRM=I_UNDERSTAND_MAINNET \
 *   ANCHOR_PROVIDER_URL=https://api.mainnet-beta.solana.com \
 *   ANCHOR_WALLET=usb://ledger \
 *   OPERATOR_PUBKEY=<hot-wallet> \
 *   TREASURY_PUBKEY=<treasury> \
 *   MM_PUBKEY=<mm-hot-wallet> \
 *   npx ts-node scripts/setup-mainnet.ts
 */
// @ts-nocheck
import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  LAMPORTS_PER_SOL,
  Transaction,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createApproveCheckedInstruction,
  createInitializeAccountInstruction,
  getAccountLenForMint,
  getAssociatedTokenAddressSync,
  getMint,
} from "@solana/spl-token";
import * as crypto from "crypto";

const MAINNET_CONFIRM = "I_UNDERSTAND_MAINNET";

const MINTS = {
  USDC: {
    mint: new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"),
    decimals: 6,
    tokenProgram: TOKEN_PROGRAM_ID,
  },
  WSOL: {
    mint: new PublicKey("So11111111111111111111111111111111111111112"),
    decimals: 9,
    tokenProgram: TOKEN_PROGRAM_ID,
  },
  TSLAX: {
    mint: new PublicKey("XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB"),
    decimals: 8,
    tokenProgram: TOKEN_2022_PROGRAM_ID,
  },
};

const PYTH_RECEIVER_PROGRAM = new PublicKey("rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ");
const JUPITER_PROGRAM = new PublicKey("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");

const PYTH_FEEDS = {
  SOL_USD: "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d",
  TSLAX_USD: "47a156470288850a440df3a6ce85a55917b813a19bb5b31128a33a986566a362",
};

const PROTOCOL_FEE_BPS = 400;
const MIN_ESCAPE_DELAY = new BN(259200);
const MAX_ORACLE_STALENESS = new BN(3600);
const MAX_CONFIDENCE_BPS = 200;
const PRICE_DEVIATION_BPS = 1000;
const MAX_MM_USDC_DELEGATION = BigInt("18446744073709551615");
const JUPITER_QUOTE_API =
  process.env.JUPITER_QUOTE_API ?? "https://api.jup.ag/swap/v1/quote";

function requireEnv(name: string): PublicKey {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return new PublicKey(value);
}

function findPda(seeds: Buffer[], programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(seeds, programId)[0];
}

function hexToBytes(hex: string): number[] {
  return Array.from(Buffer.from(hex, "hex"));
}

function keypairFromSeed(seed: string): Keypair {
  return Keypair.fromSeed(crypto.createHash("sha256").update(seed).digest());
}

async function tryRpc(label: string, fn: () => Promise<unknown>) {
  try {
    const sig = await fn();
    console.log(`  ${label}: OK${typeof sig === "string" ? ` ${sig}` : ""}`);
  } catch (e: any) {
    const msg = String(e);
    if (
      msg.includes("already in use") ||
      msg.includes("already been initialized") ||
      msg.includes("custom program error: 0x0")
    ) {
      console.log(`  ${label}: already done`);
      return;
    }
    console.error(`  ${label}: FAILED ${msg.slice(0, 180)}`);
    throw e;
  }
}

async function createVaultAccount(connection, payer, program, mintCfg, label: string) {
  const poolVault = findPda([Buffer.from("pool_vault"), mintCfg.mint.toBuffer()], program.programId);
  const vaultAuth = findPda([Buffer.from("lending_vault_auth"), mintCfg.mint.toBuffer()], program.programId);
  const tokenKp = keypairFromSeed(`b1nary-mainnet-vault-${label.toLowerCase()}-v1`);
  let tokenAccount = tokenKp.publicKey;

  try {
    const mint = await getMint(connection, mintCfg.mint, undefined, mintCfg.tokenProgram);
    const space = getAccountLenForMint(mint);
    const lamports = await connection.getMinimumBalanceForRentExemption(space);
    const tx = new Transaction().add(
      SystemProgram.createAccount({
        fromPubkey: payer.publicKey,
        newAccountPubkey: tokenKp.publicKey,
        lamports,
        space,
        programId: mintCfg.tokenProgram,
      }),
      createInitializeAccountInstruction(
        tokenKp.publicKey,
        mintCfg.mint,
        vaultAuth,
        mintCfg.tokenProgram,
      ),
    );
    await providerSend(connection, payer, tx, [tokenKp]);
  } catch (e: any) {
    if (!String(e).includes("already in use")) throw e;
  }

  return { poolVault, vaultAuth, tokenAccount };
}

async function providerSend(connection, wallet, tx: Transaction, signers = []) {
  const provider = anchor.getProvider() as anchor.AnchorProvider;
  return provider.sendAndConfirm(tx, signers);
}

async function assertJupiterLiquidity(label: string, inputMint: PublicKey, outputMint: PublicKey, amount: bigint) {
  const url = new URL(JUPITER_QUOTE_API);
  url.searchParams.set("inputMint", inputMint.toBase58());
  url.searchParams.set("outputMint", outputMint.toBase58());
  url.searchParams.set("amount", amount.toString());
  url.searchParams.set("slippageBps", "50");

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Jupiter ${label} quote failed: HTTP ${res.status}`);
  }
  const quote = await res.json();
  if (!quote.outAmount || BigInt(quote.outAmount) === 0n || !quote.routePlan?.length) {
    throw new Error(`Jupiter ${label} quote has no route`);
  }
  console.log(
    `Jupiter ${label}: out=${quote.outAmount} priceImpact=${quote.priceImpactPct ?? "n/a"} routes=${quote.routePlan
      .map((r) => r.swapInfo?.label)
      .filter(Boolean)
      .join(",")}`,
  );
}

async function main() {
  if (process.env.MAINNET_CONFIRM !== MAINNET_CONFIRM) {
    throw new Error(`Refusing mainnet setup. Set MAINNET_CONFIRM=${MAINNET_CONFIRM}`);
  }

  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const wallet = provider.wallet as anchor.Wallet;
  const admin = wallet.publicKey;
  const connection = provider.connection;

  const operator = requireEnv("OPERATOR_PUBKEY");
  const treasury = requireEnv("TREASURY_PUBKEY");
  const mm = process.env.MM_PUBKEY ? new PublicKey(process.env.MM_PUBKEY) : operator;
  const approvalsOnly = process.env.RUN_APPROVALS_ONLY === "1";

  console.log("Cluster: mainnet-beta");
  console.log("Signer:", admin.toBase58());
  console.log("Operator:", operator.toBase58());
  console.log("Treasury:", treasury.toBase58());
  console.log("MM:", mm.toBase58());
  console.log("Balance SOL:", (await connection.getBalance(admin)) / LAMPORTS_PER_SOL);
  await assertJupiterLiquidity("TSLAx->USDC", MINTS.TSLAX.mint, MINTS.USDC.mint, 100000000n);
  await assertJupiterLiquidity("USDC->TSLAx", MINTS.USDC.mint, MINTS.TSLAX.mint, 1000000000n);

  const programs = {
    whitelist: anchor.workspace.whitelist,
    oracle: anchor.workspace.oracle,
    controller: anchor.workspace.controller,
    marginPool: anchor.workspace.marginPool,
    otokenFactory: anchor.workspace.otokenFactory,
    batchSettler: anchor.workspace.batchSettler,
  };

  const pdas = {
    controller: findPda([Buffer.from("controller_config")], programs.controller.programId),
    marginPool: findPda([Buffer.from("margin_pool_config")], programs.marginPool.programId),
    oracle: findPda([Buffer.from("oracle_config")], programs.oracle.programId),
    whitelist: findPda([Buffer.from("whitelist_config")], programs.whitelist.programId),
    factory: findPda([Buffer.from("factory_config")], programs.otokenFactory.programId),
    settler: findPda([Buffer.from("settler_config")], programs.batchSettler.programId),
  };

  if (!approvalsOnly) {
    await tryRpc("whitelist.initialize", () =>
      programs.whitelist.methods.initialize(admin).accounts({ payer: admin }).rpc()
    );
    for (const [name, mint] of [["SOL", MINTS.WSOL.mint], ["TSLAx", MINTS.TSLAX.mint]]) {
      await tryRpc(`whitelist.underlying(${name})`, () =>
        programs.whitelist.methods
          .whitelistUnderlying(mint, Array.from(Buffer.from(name.padEnd(8, "\0"))))
          .accounts({ admin })
          .rpc()
      );
    }
    for (const [name, mint] of [["USDC", MINTS.USDC.mint], ["wSOL", MINTS.WSOL.mint], ["TSLAx", MINTS.TSLAX.mint]]) {
      await tryRpc(`whitelist.collateral(${name})`, () =>
        programs.whitelist.methods
          .whitelistCollateral(mint, Array.from(Buffer.from(name.padEnd(8, "\0"))))
          .accounts({ admin })
          .rpc()
      );
    }

    const products = [
      ["SOL-put", MINTS.WSOL.mint, MINTS.USDC.mint, true],
      ["SOL-call", MINTS.WSOL.mint, MINTS.WSOL.mint, false],
      ["TSLAx-put", MINTS.TSLAX.mint, MINTS.USDC.mint, true],
      ["TSLAx-call", MINTS.TSLAX.mint, MINTS.TSLAX.mint, false],
    ];
    for (const [name, underlying, collateral, isPut] of products) {
      const product = findPda(
        [Buffer.from("product"), underlying.toBuffer(), collateral.toBuffer(), Buffer.from([isPut ? 1 : 0])],
        programs.whitelist.programId,
      );
      await tryRpc(`whitelist.product(${name})`, () =>
        programs.whitelist.methods
          .whitelistProduct(underlying, MINTS.USDC.mint, collateral, isPut)
          .accounts({ product, admin })
          .rpc()
      );
    }

    await tryRpc("oracle.initialize", () =>
      programs.oracle.methods
        .initialize(admin, operator, PYTH_RECEIVER_PROGRAM, MAX_ORACLE_STALENESS, MAX_CONFIDENCE_BPS, PRICE_DEVIATION_BPS)
        .accounts({ payer: admin })
        .rpc()
    );
    for (const [name, mint, feed] of [
      ["SOL/USD", MINTS.WSOL.mint, PYTH_FEEDS.SOL_USD],
      ["TSLAx/USD", MINTS.TSLAX.mint, PYTH_FEEDS.TSLAX_USD],
    ]) {
      await tryRpc(`oracle.registerFeed(${name})`, () =>
        programs.oracle.methods.registerFeed(mint, hexToBytes(feed)).accounts({ admin }).rpc()
      );
    }

    await tryRpc("controller.initialize", () =>
      programs.controller.methods.initialize(admin).accounts({ payer: admin }).rpc()
    );
    await tryRpc("marginPool.initialize", () =>
      programs.marginPool.methods
        .initialize(pdas.controller, operator, operator)
        .accounts({ admin })
        .rpc()
    );
    for (const [name, cfg] of Object.entries(MINTS)) {
      const vault = await createVaultAccount(connection, wallet, programs.marginPool, cfg, name);
      await tryRpc(`marginPool.createPoolVault(${name})`, () =>
        programs.marginPool.methods.createPoolVault().accounts({
          config: pdas.marginPool,
          poolVault: vault.poolVault,
          vaultTokenAccount: vault.tokenAccount,
          vaultAuthority: vault.vaultAuth,
          collateralMint: cfg.mint,
          admin,
          systemProgram: SystemProgram.programId,
        }).rpc()
      );
    }

    await tryRpc("factory.initialize", () =>
      programs.otokenFactory.methods.initialize(admin).accounts({ payer: admin }).rpc()
    );
    await tryRpc("factory.setController", () =>
      programs.otokenFactory.methods.setController(pdas.controller).accounts({ admin }).rpc()
    );
    await tryRpc("settler.initialize", () =>
      programs.batchSettler.methods
        .initialize(operator, treasury, PROTOCOL_FEE_BPS, MIN_ESCAPE_DELAY, JUPITER_PROGRAM)
        .accounts({ payer: admin })
        .rpc()
    );
    await tryRpc("settler.whitelistMaker(mm)", () =>
      programs.batchSettler.methods.whitelistMaker(mm, true).accounts({ owner: admin }).rpc()
    );
    const vaultCounter = findPda([Buffer.from("vault_counter"), pdas.settler.toBuffer()], programs.controller.programId);
    await tryRpc("settler.initVaultCounter", () =>
      programs.batchSettler.methods.initVaultCounter().accounts({
        settlerConfig: pdas.settler,
        owner: admin,
        vaultCounter,
        controllerProgram: programs.controller.programId,
        systemProgram: SystemProgram.programId,
      }).rpc()
    );
  }

  const treasuryUsdc = getAssociatedTokenAddressSync(
    MINTS.USDC.mint,
    treasury,
    true,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  const mmUsdc = getAssociatedTokenAddressSync(
    MINTS.USDC.mint,
    mm,
    false,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  await tryRpc("create treasury USDC ATA", () =>
    provider.sendAndConfirm(
      new Transaction().add(
        createAssociatedTokenAccountIdempotentInstruction(
          admin,
          treasuryUsdc,
          treasury,
          MINTS.USDC.mint,
          TOKEN_PROGRAM_ID,
          ASSOCIATED_TOKEN_PROGRAM_ID,
        ),
      ),
      [],
    )
  );
  await tryRpc("create MM USDC ATA", () =>
    provider.sendAndConfirm(
      new Transaction().add(
        createAssociatedTokenAccountIdempotentInstruction(
          admin,
          mmUsdc,
          mm,
          MINTS.USDC.mint,
          TOKEN_PROGRAM_ID,
          ASSOCIATED_TOKEN_PROGRAM_ID,
        ),
      ),
      [],
    )
  );
  console.log("Treasury USDC ATA:", treasuryUsdc.toBase58());
  console.log("MM USDC ATA:", mmUsdc.toBase58());

  if (admin.equals(mm)) {
    const approveIx = createApproveCheckedInstruction(
      mmUsdc,
      MINTS.USDC.mint,
      pdas.settler,
      mm,
      MAX_MM_USDC_DELEGATION,
      MINTS.USDC.decimals,
      [],
      TOKEN_PROGRAM_ID,
    );
    await tryRpc("MM USDC approve settler_config delegate", () =>
      provider.sendAndConfirm(new Transaction().add(approveIx), [])
    );
  } else {
    console.log("MM approval skipped: rerun with ANCHOR_WALLET set to the MM hot wallet and RUN_APPROVALS_ONLY=1.");
  }

  console.log("Mainnet setup script complete.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
