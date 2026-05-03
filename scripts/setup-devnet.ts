/**
 * Devnet setup script: initialize all programs + configure markets.
 *
 * Usage:
 *   ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
 *   ANCHOR_WALLET=~/.config/solana/devnet-deploy.json \
 *   npx ts-node scripts/setup-devnet.ts
 *
 * Idempotent: uses deterministic keypairs for mock tokens so
 * re-runs skip already-created accounts.
 */
// @ts-nocheck — Anchor workspace types require runtime IDL loading
import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import { createMint, createAccount } from "@solana/spl-token";
import * as crypto from "crypto";

import { Whitelist } from "../target/types/whitelist";
import { Oracle } from "../target/types/oracle";
import { Controller } from "../target/types/controller";
import { MarginPool } from "../target/types/margin_pool";
import { OtokenFactory } from "../target/types/otoken_factory";
import { BatchSettler } from "../target/types/batch_settler";

// ── Constants ─────────────────────────────────────────────
const PYTH_FEEDS = {
  SOL_USD: "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d",
  TSLAX_USD: "47a156470288850a440df3a6ce85a55917b813a19bb5b31128a33a986566a362",
};

const PYTH_RECEIVER_PROGRAM = new PublicKey(
  "rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ"
);
const JUPITER_PROGRAM = new PublicKey(
  "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4"
);
const NATIVE_SOL_MINT = new PublicKey(
  "So11111111111111111111111111111111111111112"
);

const MIN_ESCAPE_DELAY = new BN(259200);
const PROTOCOL_FEE_BPS = 400;
const MAX_ORACLE_STALENESS = new BN(3600);
const MAX_CONFIDENCE_BPS = 200;
const PRICE_DEVIATION_BPS = 1000;

// ── Helpers ───────────────────────────────────────────────

/** Deterministic keypair from a seed string (idempotent mints). */
function keypairFromSeed(seed: string): Keypair {
  const hash = crypto.createHash("sha256").update(seed).digest();
  return Keypair.fromSeed(hash);
}

/** Skip "already in use" / "already initialized" errors. */
async function tryRpc(label: string, fn: () => Promise<unknown>) {
  try {
    await fn();
    console.log(`  ${label}: OK`);
  } catch (e: any) {
    const msg = e.toString();
    if (
      msg.includes("already in use") ||
      msg.includes("already been initialized") ||
      msg.includes("custom program error: 0x0")
    ) {
      console.log(`  ${label}: already done, skipping`);
    } else {
      console.error(`  ${label}: FAILED — ${msg.slice(0, 120)}`);
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

function findPda(seeds: Buffer[], programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(seeds, programId)[0];
}

// ── Step functions ────────────────────────────────────────

interface MockTokens {
  usdc: PublicKey;
  tslax: PublicKey;
}

async function createMockTokens(
  connection: anchor.web3.Connection,
  payer: Keypair,
  authority: PublicKey
): Promise<MockTokens> {
  console.log("\n=== Creating mock tokens ===");

  const mints = [
    { seed: "b1nary-devnet-mock-usdc-v1", decimals: 6, name: "USDC" },
    { seed: "b1nary-devnet-mock-tslax-v1", decimals: 8, name: "TSLAx" },
  ];

  const addresses: PublicKey[] = [];
  for (const m of mints) {
    const kp = keypairFromSeed(m.seed);
    try {
      const mint = await createMint(
        connection,
        payer,
        authority,
        null,
        m.decimals,
        kp
      );
      console.log(`  ${m.name}: ${mint.toBase58()} (created)`);
      addresses.push(mint);
    } catch (e: any) {
      if (e.toString().includes("already in use")) {
        console.log(`  ${m.name}: ${kp.publicKey.toBase58()} (exists)`);
        addresses.push(kp.publicKey);
      } else {
        throw e;
      }
    }
  }
  console.log(`  wSOL: ${NATIVE_SOL_MINT.toBase58()} (native)`);
  return { usdc: addresses[0], tslax: addresses[1] };
}

async function initWhitelist(
  program: Program<Whitelist>,
  admin: PublicKey,
  tokens: MockTokens
) {
  console.log("\n=== Initializing Whitelist ===");
  await tryRpc("initialize", () =>
    program.methods.initialize(admin).accounts({ payer: admin }).rpc()
  );

  const underlyings = [
    { mint: NATIVE_SOL_MINT, name: "SOL" },
    { mint: tokens.tslax, name: "TSLAx" },
  ];
  for (const u of underlyings) {
    const sym = Array.from(Buffer.from(u.name.padEnd(8, "\0")));
    await tryRpc(`underlying(${u.name})`, () =>
      program.methods.whitelistUnderlying(u.mint, sym).accounts({ admin }).rpc()
    );
  }

  // USDC as collateral (SOL/JUP/XAU already registered as underlying)
  const usdcSym = Array.from(Buffer.from("USDC\0\0\0\0"));
  await tryRpc("collateral(USDC)", () =>
    program.methods
      .whitelistCollateral(tokens.usdc, usdcSym)
      .accounts({ admin })
      .rpc()
  );

  const products = [
    {
      underlying: NATIVE_SOL_MINT,
      collateral: tokens.usdc,
      isPut: true,
      name: "SOL-put",
    },
    {
      underlying: NATIVE_SOL_MINT,
      collateral: NATIVE_SOL_MINT,
      isPut: false,
      name: "SOL-call",
    },
    {
      underlying: tokens.tslax,
      collateral: tokens.usdc,
      isPut: true,
      name: "TSLAx-put",
    },
    {
      underlying: tokens.tslax,
      collateral: tokens.tslax,
      isPut: false,
      name: "TSLAx-call",
    },
  ];
  for (const p of products) {
    const productPda = findPda(
      [
        Buffer.from("product"),
        p.underlying.toBuffer(),
        p.collateral.toBuffer(),
        Buffer.from([p.isPut ? 1 : 0]),
      ],
      program.programId
    );
    await tryRpc(`product(${p.name})`, () =>
      program.methods
        .whitelistProduct(p.underlying, tokens.usdc, p.collateral, p.isPut)
        .accounts({ product: productPda, admin })
        .rpc()
    );
  }
}

async function initOracle(
  program: Program<Oracle>,
  admin: PublicKey,
  tokens: MockTokens
) {
  console.log("\n=== Initializing Oracle ===");
  await tryRpc("initialize", () =>
    program.methods
      .initialize(
        admin,
        admin,
        PYTH_RECEIVER_PROGRAM,
        MAX_ORACLE_STALENESS,
        MAX_CONFIDENCE_BPS,
        PRICE_DEVIATION_BPS
      )
      .accounts({ payer: admin })
      .rpc()
  );

  const feeds = [
    {
      underlying: NATIVE_SOL_MINT,
      feedId: PYTH_FEEDS.SOL_USD,
      name: "SOL/USD",
    },
    {
      underlying: tokens.tslax,
      feedId: PYTH_FEEDS.TSLAX_USD,
      name: "TSLAx/USD",
    },
  ];
  for (const f of feeds) {
    await tryRpc(`feed(${f.name})`, () =>
      program.methods
        .registerFeed(f.underlying, hexToBytes(f.feedId))
        .accounts({ admin })
        .rpc()
    );
  }
}

async function initController(program: Program<Controller>, admin: PublicKey) {
  console.log("\n=== Initializing Controller ===");
  await tryRpc("initialize", () =>
    program.methods.initialize(admin).accounts({ payer: admin }).rpc()
  );
}

async function initMarginPool(
  program: Program<MarginPool>,
  connection: anchor.web3.Connection,
  payer: Keypair,
  admin: PublicKey,
  controllerConfigPda: PublicKey,
  tokens: MockTokens
) {
  console.log("\n=== Initializing MarginPool ===");
  const configPda = findPda(
    [Buffer.from("margin_pool_config")],
    program.programId
  );
  await tryRpc("initialize", () =>
    program.methods
      .initialize(controllerConfigPda, admin, admin)
      .accounts({ admin })
      .rpc()
  );

  const mints = [
    { mint: tokens.usdc, seed: "b1nary-devnet-vault-usdc-v1" },
    { mint: NATIVE_SOL_MINT, seed: "b1nary-devnet-vault-wsol-v1" },
    { mint: tokens.tslax, seed: "b1nary-devnet-vault-tslax-v1" },
  ];
  for (const m of mints) {
    const poolVaultPda = findPda(
      [Buffer.from("pool_vault"), m.mint.toBuffer()],
      program.programId
    );
    const vaultAuthPda = findPda(
      [Buffer.from("lending_vault_auth"), m.mint.toBuffer()],
      program.programId
    );

    // Deterministic keypair for vault token account
    const tokenAcctKp = keypairFromSeed(m.seed);
    let tokenAcctAddr = tokenAcctKp.publicKey;
    try {
      tokenAcctAddr = await createAccount(
        connection,
        payer,
        m.mint,
        vaultAuthPda,
        tokenAcctKp
      );
    } catch (e: any) {
      if (!e.toString().includes("already in use")) throw e;
    }

    await tryRpc(`poolVault(${m.mint.toBase58().slice(0, 8)})`, () =>
      program.methods
        .createPoolVault()
        .accounts({
          config: configPda,
          poolVault: poolVaultPda,
          vaultTokenAccount: tokenAcctAddr,
          vaultAuthority: vaultAuthPda,
          collateralMint: m.mint,
          admin,
          systemProgram: SystemProgram.programId,
        })
        .rpc()
    );
  }
}

async function initOtokenFactory(
  program: Program<OtokenFactory>,
  admin: PublicKey,
  controllerConfigPda: PublicKey
) {
  console.log("\n=== Initializing OTokenFactory ===");
  await tryRpc("initialize", () =>
    program.methods.initialize(admin).accounts({ payer: admin }).rpc()
  );
  await tryRpc("setController", () =>
    program.methods.setController(controllerConfigPda).accounts({ admin }).rpc()
  );
}

async function initBatchSettler(
  program: Program<BatchSettler>,
  admin: PublicKey,
  controllerProgramId: PublicKey,
  settlerConfigPda: PublicKey
) {
  console.log("\n=== Initializing BatchSettler ===");
  await tryRpc("initialize", () =>
    program.methods
      .initialize(
        admin,
        admin,
        PROTOCOL_FEE_BPS,
        MIN_ESCAPE_DELAY,
        JUPITER_PROGRAM
      )
      .accounts({ payer: admin })
      .rpc()
  );
  await tryRpc("whitelistMaker(admin)", () =>
    program.methods.whitelistMaker(admin, true).accounts({ owner: admin }).rpc()
  );

  const vaultCounterPda = findPda(
    [Buffer.from("vault_counter"), settlerConfigPda.toBuffer()],
    controllerProgramId
  );
  await tryRpc("initVaultCounter", () =>
    program.methods
      .initVaultCounter()
      .accounts({
        settlerConfig: settlerConfigPda,
        owner: admin,
        vaultCounter: vaultCounterPda,
        controllerProgram: controllerProgramId,
        systemProgram: SystemProgram.programId,
      })
      .rpc()
  );
}

// ── Main ──────────────────────────────────────────────────

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const admin = provider.wallet as anchor.Wallet;
  const connection = provider.connection;

  console.log("Admin:", admin.publicKey.toBase58());
  const balance = await connection.getBalance(admin.publicKey);
  const balSol = balance / LAMPORTS_PER_SOL;
  console.log("Balance:", balSol, "SOL");
  if (balSol < 0.5) {
    throw new Error(
      `Insufficient balance: ${balSol} SOL. Need >= 0.5 SOL for tx fees. ` +
        `Run: solana airdrop 1 ${admin.publicKey.toBase58()} --url devnet`
    );
  }

  const programs = {
    whitelist: anchor.workspace.whitelist as Program<Whitelist>,
    oracle: anchor.workspace.oracle as Program<Oracle>,
    controller: anchor.workspace.controller as Program<Controller>,
    marginPool: anchor.workspace.marginPool as Program<MarginPool>,
    otokenFactory: anchor.workspace.otokenFactory as Program<OtokenFactory>,
    batchSettler: anchor.workspace.batchSettler as Program<BatchSettler>,
  };

  console.log("\n=== Program IDs ===");
  for (const [name, prog] of Object.entries(programs)) {
    console.log(`  ${name}: ${prog.programId.toBase58()}`);
  }

  const pdas = {
    controller: findPda(
      [Buffer.from("controller_config")],
      programs.controller.programId
    ),
    marginPool: findPda(
      [Buffer.from("margin_pool_config")],
      programs.marginPool.programId
    ),
    oracle: findPda([Buffer.from("oracle_config")], programs.oracle.programId),
    whitelist: findPda(
      [Buffer.from("whitelist_config")],
      programs.whitelist.programId
    ),
    factory: findPda(
      [Buffer.from("factory_config")],
      programs.otokenFactory.programId
    ),
    settler: findPda(
      [Buffer.from("settler_config")],
      programs.batchSettler.programId
    ),
  };

  const tokens = await createMockTokens(
    connection,
    admin.payer,
    admin.publicKey
  );

  await initWhitelist(programs.whitelist, admin.publicKey, tokens);
  await initOracle(programs.oracle, admin.publicKey, tokens);
  await initController(programs.controller, admin.publicKey);
  await initMarginPool(
    programs.marginPool,
    connection,
    admin.payer,
    admin.publicKey,
    pdas.controller,
    tokens
  );
  await initOtokenFactory(
    programs.otokenFactory,
    admin.publicKey,
    pdas.controller
  );
  await initBatchSettler(
    programs.batchSettler,
    admin.publicKey,
    programs.controller.programId,
    pdas.settler
  );

  console.log("\n========================================");
  console.log("Devnet deployment complete!");
  console.log("========================================");
  console.log("\nMock Tokens:");
  console.log(`  USDC:  ${tokens.usdc.toBase58()}`);
  console.log(`  wSOL:  ${NATIVE_SOL_MINT.toBase58()}`);
  console.log(`  TSLAx: ${tokens.tslax.toBase58()}`);
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
