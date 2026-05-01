// @ts-nocheck
/**
 * Create USDC PoolVault + supporting token accounts on devnet.
 *
 * Creates:
 *   1. Token account for USDC owned by lending_vault_auth PDA
 *   2. PoolVault PDA via margin_pool.createPoolVault()
 *   3. Treasury USDC token account (owned by treasury)
 *   4. Maker USDC ATA with delegation to settler_config PDA
 *
 * Usage:
 *   ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
 *   ANCHOR_WALLET=~/.config/solana/devnet-deploy.json \
 *   npx ts-node scripts/setup-usdc-vault.ts
 */
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  Keypair,
  PublicKey,
  SystemProgram,
} from "@solana/web3.js";
import {
  createAccount,
  getOrCreateAssociatedTokenAccount,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import * as crypto from "crypto";

import { MarginPool } from "../target/types/margin_pool";
import { BatchSettler } from "../target/types/batch_settler";

const USDC_MINT = new PublicKey(
  "Af4AVeWCZgd8Az6sKN2enEPLJm8f88pH5DrkNndJ3CNL"
);
const MAKER_PUBKEY = new PublicKey(
  "6JK3LrBvjJaKwCuaJPyg7S4NTHvk2Nx7rBpU4YViBa8S"
);

function findPda(
  seeds: Buffer[],
  programId: PublicKey,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(seeds, programId);
}

function keypairFromSeed(seed: string): Keypair {
  const hash = crypto
    .createHash("sha256")
    .update(seed)
    .digest();
  return Keypair.fromSeed(hash);
}

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const admin = provider.wallet as anchor.Wallet;
  const connection = provider.connection;

  const marginPool = anchor.workspace
    .marginPool as Program<MarginPool>;
  const batchSettler = anchor.workspace
    .batchSettler as Program<BatchSettler>;

  console.log("Admin:", admin.publicKey.toBase58());
  console.log("USDC mint:", USDC_MINT.toBase58());

  // ── 1. Derive PDAs ─────────────────────────────────────
  const [mpConfigPda] = findPda(
    [Buffer.from("margin_pool_config")],
    marginPool.programId,
  );
  const [poolVaultPda] = findPda(
    [Buffer.from("pool_vault"), USDC_MINT.toBuffer()],
    marginPool.programId,
  );
  const [vaultAuthPda] = findPda(
    [Buffer.from("lending_vault_auth"), USDC_MINT.toBuffer()],
    marginPool.programId,
  );
  const [settlerConfigPda] = findPda(
    [Buffer.from("settler_config")],
    batchSettler.programId,
  );

  console.log("\nPDAs:");
  console.log("  pool_vault:", poolVaultPda.toBase58());
  console.log("  vault_auth:", vaultAuthPda.toBase58());
  console.log("  settler_config:", settlerConfigPda.toBase58());
  console.log("  mp_config:", mpConfigPda.toBase58());

  // Fetch settler config for treasury address
  const settlerConfig =
    await batchSettler.account.settlerConfig.fetch(
      settlerConfigPda,
    );
  const treasury = settlerConfig.treasury;
  console.log("  treasury:", treasury.toBase58());

  // ── 2. Create vault token account ──────────────────────
  console.log("\n=== Creating vault token account ===");
  const vaultTokenKp = keypairFromSeed(
    "b1nary-devnet-vault-usdc-real-v1",
  );
  let vaultTokenAddr = vaultTokenKp.publicKey;
  try {
    vaultTokenAddr = await createAccount(
      connection,
      admin.payer,
      USDC_MINT,
      vaultAuthPda,
      vaultTokenKp,
    );
    console.log("  Created:", vaultTokenAddr.toBase58());
  } catch (e: any) {
    if (e.toString().includes("already in use")) {
      console.log(
        "  Already exists:",
        vaultTokenAddr.toBase58(),
      );
    } else {
      throw e;
    }
  }

  // ── 3. Create PoolVault ────────────────────────────────
  console.log("\n=== Creating PoolVault ===");
  try {
    const tx = await marginPool.methods
      .createPoolVault()
      .accounts({
        config: mpConfigPda,
        poolVault: poolVaultPda,
        vaultTokenAccount: vaultTokenAddr,
        vaultAuthority: vaultAuthPda,
        collateralMint: USDC_MINT,
        admin: admin.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    console.log("  Tx:", tx);
  } catch (e: any) {
    const msg = e.toString();
    if (
      msg.includes("already in use") ||
      msg.includes("already been initialized") ||
      msg.includes("custom program error: 0x0")
    ) {
      console.log("  Already exists, skipping");
    } else {
      throw e;
    }
  }

  // Verify
  try {
    const vault =
      await marginPool.account.poolVault.fetch(poolVaultPda);
    console.log("  Verified:");
    console.log(
      "    collateral_mint:",
      vault.collateralMint.toBase58(),
    );
    console.log(
      "    token_account:",
      vault.tokenAccount.toBase58(),
    );
    console.log(
      "    total_deposited:",
      vault.totalDeposited.toString(),
    );
  } catch {
    console.error("  ERROR: Could not fetch pool vault");
  }

  // ── 4. Treasury USDC account ───────────────────────────
  console.log("\n=== Creating treasury USDC account ===");
  const treasuryAta = await getOrCreateAssociatedTokenAccount(
    connection,
    admin.payer,
    USDC_MINT,
    treasury,
    true, // allowOwnerOffCurve (treasury may be PDA)
  );
  console.log("  Treasury ATA:", treasuryAta.address.toBase58());

  // ── 5. Maker USDC ATA ─────────────────────────────────
  console.log("\n=== Creating maker USDC ATA ===");
  const makerAta = await getOrCreateAssociatedTokenAccount(
    connection,
    admin.payer,
    USDC_MINT,
    MAKER_PUBKEY,
  );
  console.log("  Maker ATA:", makerAta.address.toBase58());

  console.log("\n========================================");
  console.log("USDC vault setup complete!");
  console.log("========================================");
  console.log("\nAddresses for frontend/backend config:");
  console.log(
    "  poolVaultPda:",
    poolVaultPda.toBase58(),
  );
  console.log(
    "  vaultTokenAccount:",
    vaultTokenAddr.toBase58(),
  );
  console.log(
    "  treasuryAta:",
    treasuryAta.address.toBase58(),
  );
  console.log("  makerAta:", makerAta.address.toBase58());
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
