// @ts-nocheck
/**
 * Devnet setup script: initialize all programs + configure markets.
 *
 * Usage:
 *   npx ts-node scripts/setup-devnet.ts
 *
 * Prerequisites:
 *   - All 7 programs deployed to devnet
 *   - Solana CLI configured with devnet keypair
 *   - Sufficient SOL for tx fees (~0.1 SOL)
 */
import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Connection,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createMint,
  createAccount,
  mintTo,
} from "@solana/spl-token";
import * as fs from "fs";
import * as path from "path";

import { AddressBook } from "../target/types/address_book";
import { Whitelist } from "../target/types/whitelist";
import { Oracle } from "../target/types/oracle";
import { Controller } from "../target/types/controller";
import { MarginPool } from "../target/types/margin_pool";
import { OtokenFactory } from "../target/types/otoken_factory";
import { BatchSettler } from "../target/types/batch_settler";

// ── Pyth feed IDs (same on mainnet + devnet) ──────────────
const PYTH_FEEDS = {
  SOL_USD:
    "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d",
  JUP_USD:
    "0a0408d619e9380abad35060f9192039ed5042fa6f82301d0e48bb52be830996",
  XAU_USD:
    "765d2ba906dbc32ca17cc11f5310a89e9ee1f6420508c63861f2f8ba4ee34bb2",
};

// Pyth Solana Receiver program ID (mainnet + devnet)
const PYTH_RECEIVER_PROGRAM = new PublicKey(
  "rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ"
);

// Jupiter aggregator program ID
const JUPITER_PROGRAM = new PublicKey(
  "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4"
);

// Native wrapped SOL mint
const NATIVE_SOL_MINT = new PublicKey(
  "So11111111111111111111111111111111111111112"
);

const MIN_ESCAPE_DELAY = new BN(259200); // 3 days
const PROTOCOL_FEE_BPS = 400; // 4%
const MAX_ORACLE_STALENESS = new BN(3600); // 1 hour
const MAX_CONFIDENCE_BPS = 200; // 2%
const PRICE_DEVIATION_BPS = 1000; // 10%

async function tryRpc(label: string, fn: () => Promise<any>) {
  try {
    await fn();
    console.log(`  ${label}: OK`);
  } catch (e: any) {
    const msg = e.toString();
    if (msg.includes("already in use") || msg.includes("0x0")) {
      console.log(`  ${label}: already done, skipping`);
    } else {
      console.error(`  ${label}: FAILED`);
      throw e;
    }
  }
}

function hexToBytes(hex: string): number[] {
  const bytes: number[] = [];
  for (let i = 0; i < hex.length; i += 2) {
    bytes.push(parseInt(hex.substring(i, i + 2), 16));
  }
  return bytes;
}

function findPda(
  seeds: Buffer[],
  programId: PublicKey
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(seeds, programId);
}

async function main() {
  // Setup provider from CLI config
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const admin = provider.wallet as anchor.Wallet;
  const connection = provider.connection;

  console.log("Admin:", admin.publicKey.toBase58());
  console.log(
    "Balance:",
    (await connection.getBalance(admin.publicKey)) / LAMPORTS_PER_SOL,
    "SOL"
  );

  // Load programs
  const addressBook = anchor.workspace
    .addressBook as Program<AddressBook>;
  const whitelist = anchor.workspace
    .whitelist as Program<Whitelist>;
  const oracle = anchor.workspace
    .oracle as Program<Oracle>;
  const controller = anchor.workspace
    .controller as Program<Controller>;
  const marginPool = anchor.workspace
    .marginPool as Program<MarginPool>;
  const otokenFactory = anchor.workspace
    .otokenFactory as Program<OtokenFactory>;
  const batchSettler = anchor.workspace
    .batchSettler as Program<BatchSettler>;

  console.log("\n=== Program IDs ===");
  console.log("address_book:", addressBook.programId.toBase58());
  console.log("whitelist:", whitelist.programId.toBase58());
  console.log("oracle:", oracle.programId.toBase58());
  console.log("controller:", controller.programId.toBase58());
  console.log("margin_pool:", marginPool.programId.toBase58());
  console.log("otoken_factory:", otokenFactory.programId.toBase58());
  console.log("batch_settler:", batchSettler.programId.toBase58());

  // ── Step 1: Create mock tokens ──────────────────────────
  console.log("\n=== Creating mock tokens ===");

  const mockUSDC = await createMint(
    connection,
    admin.payer,
    admin.publicKey,
    null,
    6 // USDC decimals
  );
  console.log("Mock USDC:", mockUSDC.toBase58());

  const mockJUP = await createMint(
    connection,
    admin.payer,
    admin.publicKey,
    null,
    6 // JUP decimals
  );
  console.log("Mock JUP:", mockJUP.toBase58());

  const mockXAU = await createMint(
    connection,
    admin.payer,
    admin.publicKey,
    null,
    8 // XAU decimals (gold, 8 like BTC)
  );
  console.log("Mock XAU:", mockXAU.toBase58());

  // wSOL uses native mint
  console.log("wSOL (native):", NATIVE_SOL_MINT.toBase58());

  // ── Step 2: Initialize AddressBook ──────────────────────
  console.log("\n=== Initializing AddressBook ===");
  await tryRpc("initialize", () =>
    addressBook.methods
      .initialize(admin.publicKey)
      .accounts({ payer: admin.publicKey })
      .rpc()
  );

  const [registryPda] = findPda(
    [Buffer.from("registry")],
    addressBook.programId
  );

  // Set all addresses
  const [controllerConfigPda] = findPda(
    [Buffer.from("controller_config")],
    controller.programId
  );
  const [marginPoolConfigPda] = findPda(
    [Buffer.from("margin_pool_config")],
    marginPool.programId
  );
  const [oracleConfigPda] = findPda(
    [Buffer.from("oracle_config")],
    oracle.programId
  );
  const [whitelistConfigPda] = findPda(
    [Buffer.from("whitelist_config")],
    whitelist.programId
  );
  const [factoryConfigPda] = findPda(
    [Buffer.from("factory_config")],
    otokenFactory.programId
  );
  const [settlerConfigPda] = findPda(
    [Buffer.from("settler_config")],
    batchSettler.programId
  );

  const addrEntries = [
    [{ controller: {} }, controllerConfigPda, "controller"],
    [{ marginPool: {} }, marginPoolConfigPda, "marginPool"],
    [{ oracle: {} }, oracleConfigPda, "oracle"],
    [{ whitelist: {} }, whitelistConfigPda, "whitelist"],
    [{ otokenFactory: {} }, factoryConfigPda, "otokenFactory"],
    [{ batchSettler: {} }, settlerConfigPda, "batchSettler"],
  ] as const;
  for (const [role, addr, name] of addrEntries) {
    await tryRpc(`setAddress(${name})`, () =>
      addressBook.methods
        .setAddress(role, addr)
        .accounts({ admin: admin.publicKey })
        .rpc()
    );
  }
  console.log("AddressBook configured");

  // ── Step 3: Initialize Whitelist ────────────────────────
  console.log("\n=== Initializing Whitelist ===");
  await tryRpc("initialize", () =>
    whitelist.methods
      .initialize(admin.publicKey)
      .accounts({ payer: admin.publicKey })
      .rpc()
  );

  // Whitelist underlyings
  const underlyings = [
    { mint: NATIVE_SOL_MINT, symbol: "SOL\0\0\0\0\0" },
    { mint: mockJUP, symbol: "JUP\0\0\0\0\0" },
    { mint: mockXAU, symbol: "XAU\0\0\0\0\0" },
  ];
  for (const u of underlyings) {
    const symbolBytes = Array.from(
      Buffer.from(u.symbol.padEnd(8, "\0"))
    ) as number[];
    await tryRpc(`underlying(${u.symbol.trim()})`, () =>
      whitelist.methods
        .whitelistUnderlying(u.mint, symbolBytes)
        .accounts({ admin: admin.publicKey })
        .rpc()
    );
  }

  // Whitelist collateral (skip mints already whitelisted as underlying)
  const collaterals = [
    { mint: mockUSDC, symbol: "USDC\0\0\0\0" },
    // wSOL already registered as underlying — same PDA seeds
    // JUP/XAU used as call collateral, already registered as underlying
  ];
  for (const c of collaterals) {
    const symbolBytes = Array.from(
      Buffer.from(c.symbol.padEnd(8, "\0"))
    ) as number[];
    await tryRpc(`collateral(${c.symbol.trim()})`, () =>
      whitelist.methods
        .whitelistCollateral(c.mint, symbolBytes)
        .accounts({ admin: admin.publicKey })
        .rpc()
    );
  }

  // Whitelist products (underlying, strikeAsset, collateral, isPut)
  const products = [
    // SOL puts (collateral=USDC) and calls (collateral=wSOL)
    { underlying: NATIVE_SOL_MINT, strike: mockUSDC, collateral: mockUSDC, isPut: true },
    { underlying: NATIVE_SOL_MINT, strike: mockUSDC, collateral: NATIVE_SOL_MINT, isPut: false },
    // JUP puts (collateral=USDC) and calls (collateral=JUP... or USDC)
    { underlying: mockJUP, strike: mockUSDC, collateral: mockUSDC, isPut: true },
    { underlying: mockJUP, strike: mockUSDC, collateral: mockJUP, isPut: false },
    // XAU puts (collateral=USDC) and calls (collateral=XAU)
    { underlying: mockXAU, strike: mockUSDC, collateral: mockUSDC, isPut: true },
    { underlying: mockXAU, strike: mockUSDC, collateral: mockXAU, isPut: false },
  ];
  for (const p of products) {
    const [productPda] = findPda(
      [
        Buffer.from("product"),
        p.underlying.toBuffer(),
        p.collateral.toBuffer(),
        Buffer.from([p.isPut ? 1 : 0]),
      ],
      whitelist.programId
    );
    await tryRpc(`product(isPut=${p.isPut})`, () =>
      whitelist.methods
        .whitelistProduct(p.underlying, p.strike, p.collateral, p.isPut)
        .accounts({
          product: productPda,
          admin: admin.publicKey,
        })
        .rpc()
    );
  }
  console.log("Whitelist configured");

  // ── Step 4: Initialize Oracle ───────────────────────────
  console.log("\n=== Initializing Oracle ===");
  await tryRpc("initialize", () =>
    oracle.methods
      .initialize(
        admin.publicKey,
        admin.publicKey, // operator = admin for devnet
        PYTH_RECEIVER_PROGRAM,
        MAX_ORACLE_STALENESS,
        MAX_CONFIDENCE_BPS,
        PRICE_DEVIATION_BPS
      )
      .accounts({ payer: admin.publicKey })
      .rpc()
  );

  // Register Pyth feeds
  const feeds = [
    { underlying: NATIVE_SOL_MINT, feedId: PYTH_FEEDS.SOL_USD, name: "SOL/USD" },
    { underlying: mockJUP, feedId: PYTH_FEEDS.JUP_USD, name: "JUP/USD" },
    { underlying: mockXAU, feedId: PYTH_FEEDS.XAU_USD, name: "XAU/USD" },
  ];
  for (const f of feeds) {
    await tryRpc(`feed(${f.name})`, () =>
      oracle.methods
        .registerFeed(f.underlying, hexToBytes(f.feedId))
        .accounts({ admin: admin.publicKey })
        .rpc()
    );
  }
  console.log("Oracle configured");

  // ── Step 5: Initialize Controller ───────────────────────
  console.log("\n=== Initializing Controller ===");
  await tryRpc("initialize", () =>
    controller.methods
      .initialize(admin.publicKey)
      .accounts({ payer: admin.publicKey })
      .rpc()
  );
  console.log("Controller initialized");

  // ── Step 6: Initialize MarginPool ───────────────────────
  console.log("\n=== Initializing MarginPool ===");
  await tryRpc("initialize", () =>
    marginPool.methods
      .initialize(controllerConfigPda)
      .accounts({ admin: admin.publicKey })
      .rpc()
  );

  // Create pool vaults for each collateral type
  const collateralMints = [mockUSDC, mockJUP, mockXAU];
  for (const mint of collateralMints) {
    const [poolVaultPda] = findPda(
      [Buffer.from("pool_vault"), mint.toBuffer()],
      marginPool.programId
    );
    const [vaultAuthPda] = findPda(
      [Buffer.from("pool_vault_auth"), mint.toBuffer()],
      marginPool.programId
    );

    const vaultTokenAccount = await createAccount(
      connection,
      admin.payer,
      mint,
      vaultAuthPda,
      Keypair.generate()
    );

    await tryRpc(`poolVault(${mint.toBase58().slice(0, 8)})`, () =>
      marginPool.methods
        .createPoolVault()
        .accounts({
          config: marginPoolConfigPda,
          poolVault: poolVaultPda,
          vaultTokenAccount: vaultTokenAccount,
          vaultAuthority: vaultAuthPda,
          collateralMint: mint,
          admin: admin.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc()
    );
  }
  console.log("MarginPool configured");

  // ── Step 7: Initialize OTokenFactory ────────────────────
  console.log("\n=== Initializing OTokenFactory ===");
  await tryRpc("initialize", () =>
    otokenFactory.methods
      .initialize(admin.publicKey)
      .accounts({ payer: admin.publicKey })
      .rpc()
  );
  await tryRpc("setController", () =>
    otokenFactory.methods
      .setController(controllerConfigPda)
      .accounts({ admin: admin.publicKey })
      .rpc()
  );
  console.log("OTokenFactory configured");

  // ── Step 8: Initialize BatchSettler ─────────────────────
  console.log("\n=== Initializing BatchSettler ===");
  await tryRpc("initialize", () =>
    batchSettler.methods
      .initialize(
        admin.publicKey, // operator = admin for devnet
        admin.publicKey, // treasury = admin for devnet
        PROTOCOL_FEE_BPS,
        MIN_ESCAPE_DELAY,
        JUPITER_PROGRAM
      )
      .accounts({ payer: admin.publicKey })
      .rpc()
  );
  await tryRpc("whitelistMaker(admin)", () =>
    batchSettler.methods
      .whitelistMaker(admin.publicKey, true)
      .accounts({ owner: admin.publicKey })
      .rpc()
  );

  const [vaultCounterPda] = findPda(
    [Buffer.from("vault_counter"), settlerConfigPda.toBuffer()],
    controller.programId
  );
  await tryRpc("initVaultCounter", () =>
    batchSettler.methods
      .initVaultCounter()
      .accounts({
        settlerConfig: settlerConfigPda,
        owner: admin.publicKey,
        vaultCounter: vaultCounterPda,
        controllerProgram: controller.programId,
        systemProgram: SystemProgram.programId,
      })
      .rpc()
  );
  console.log("BatchSettler configured");

  // ── Summary ─────────────────────────────────────────────
  console.log("\n========================================");
  console.log("Devnet deployment complete!");
  console.log("========================================");
  console.log("\nProgram IDs:");
  console.log(`  address_book:    ${addressBook.programId.toBase58()}`);
  console.log(`  whitelist:       ${whitelist.programId.toBase58()}`);
  console.log(`  oracle:          ${oracle.programId.toBase58()}`);
  console.log(`  controller:      ${controller.programId.toBase58()}`);
  console.log(`  margin_pool:     ${marginPool.programId.toBase58()}`);
  console.log(`  otoken_factory:  ${otokenFactory.programId.toBase58()}`);
  console.log(`  batch_settler:   ${batchSettler.programId.toBase58()}`);
  console.log("\nMock Tokens:");
  console.log(`  USDC:  ${mockUSDC.toBase58()}`);
  console.log(`  JUP:   ${mockJUP.toBase58()}`);
  console.log(`  XAU:   ${mockXAU.toBase58()}`);
  console.log(`  wSOL:  ${NATIVE_SOL_MINT.toBase58()}`);
  console.log("\nAdmin/Operator:", admin.publicKey.toBase58());
  console.log(
    "Remaining balance:",
    (await connection.getBalance(admin.publicKey)) / LAMPORTS_PER_SOL,
    "SOL"
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
