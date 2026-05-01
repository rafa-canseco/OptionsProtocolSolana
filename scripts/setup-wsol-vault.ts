// @ts-nocheck
/**
 * Create wSOL PoolVault + supporting token account on devnet.
 *
 * Creates:
 *   1. Token account for canonical wSOL owned by lending_vault_auth PDA
 *   2. PoolVault PDA via margin_pool.createPoolVault()
 *
 * Usage:
 *   ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
 *   ANCHOR_WALLET=~/.config/solana/devnet-deploy.json \
 *   npx ts-node scripts/setup-wsol-vault.ts
 */
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { createAccount } from "@solana/spl-token";
import * as crypto from "crypto";

import { MarginPool } from "../target/types/margin_pool";

const WSOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");

function findPda(seeds: Buffer[], programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(seeds, programId);
}

function keypairFromSeed(seed: string): Keypair {
  const hash = crypto.createHash("sha256").update(seed).digest();
  return Keypair.fromSeed(hash);
}

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const admin = provider.wallet as anchor.Wallet;
  const connection = provider.connection;

  const marginPool = anchor.workspace.marginPool as Program<MarginPool>;

  console.log("Admin:", admin.publicKey.toBase58());
  console.log("wSOL mint:", WSOL_MINT.toBase58());
  console.log("margin_pool:", marginPool.programId.toBase58());

  const [mpConfigPda] = findPda(
    [Buffer.from("margin_pool_config")],
    marginPool.programId
  );
  const [poolVaultPda] = findPda(
    [Buffer.from("pool_vault"), WSOL_MINT.toBuffer()],
    marginPool.programId
  );
  const [vaultAuthPda] = findPda(
    [Buffer.from("lending_vault_auth"), WSOL_MINT.toBuffer()],
    marginPool.programId
  );

  console.log("\nPDAs:");
  console.log("  pool_vault:", poolVaultPda.toBase58());
  console.log("  vault_auth:", vaultAuthPda.toBase58());
  console.log("  mp_config:", mpConfigPda.toBase58());

  console.log("\n=== Creating wSOL vault token account ===");
  const vaultTokenKp = keypairFromSeed("b1nary-devnet-vault-wsol-v1");
  let vaultTokenAddr = vaultTokenKp.publicKey;
  try {
    vaultTokenAddr = await createAccount(
      connection,
      admin.payer,
      WSOL_MINT,
      vaultAuthPda,
      vaultTokenKp
    );
    console.log("  Created:", vaultTokenAddr.toBase58());
  } catch (e: any) {
    if (e.toString().includes("already in use")) {
      console.log("  Already exists:", vaultTokenAddr.toBase58());
    } else {
      throw e;
    }
  }

  console.log("\n=== Creating wSOL PoolVault ===");
  try {
    const tx = await marginPool.methods
      .createPoolVault()
      .accounts({
        config: mpConfigPda,
        poolVault: poolVaultPda,
        vaultTokenAccount: vaultTokenAddr,
        vaultAuthority: vaultAuthPda,
        collateralMint: WSOL_MINT,
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

  const vault = await marginPool.account.poolVault.fetch(poolVaultPda);
  console.log("\nVerified:");
  console.log("  collateral_mint:", vault.collateralMint.toBase58());
  console.log("  token_account:", vault.tokenAccount.toBase58());
  console.log("  total_deposited:", vault.totalDeposited.toString());
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
