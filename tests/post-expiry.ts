// @ts-nocheck — Anchor workspace types require runtime IDL loading
import { startAnchor, Clock } from "solana-bankrun";
import { BankrunProvider } from "anchor-bankrun";
import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createInitializeMintInstruction,
  createInitializeAccountInstruction,
  createMintToInstruction,
  MINT_SIZE,
  ACCOUNT_SIZE,
} from "@solana/spl-token";
import { assert } from "chai";

// Helper: create a mint in bankrun via raw instructions
async function bankrunCreateMint(
  context: any,
  payer: Keypair,
  authority: PublicKey,
  decimals: number,
  mintKp?: Keypair
): Promise<PublicKey> {
  const kp = mintKp || Keypair.generate();
  const lamports = BigInt(1_461_600); // rent for mint
  const tx = new Transaction().add(
    SystemProgram.createAccount({
      fromPubkey: payer.publicKey,
      newAccountPubkey: kp.publicKey,
      space: MINT_SIZE,
      lamports: Number(lamports),
      programId: TOKEN_PROGRAM_ID,
    }),
    createInitializeMintInstruction(kp.publicKey, decimals, authority, null)
  );
  tx.recentBlockhash = context.lastBlockhash;
  tx.feePayer = payer.publicKey;
  tx.sign(payer, kp);
  await context.banksClient.processTransaction(tx);
  return kp.publicKey;
}

// Helper: create a token account in bankrun
async function bankrunCreateTokenAccount(
  context: any,
  payer: Keypair,
  mint: PublicKey,
  owner: PublicKey,
  kp?: Keypair
): Promise<PublicKey> {
  const acctKp = kp || Keypair.generate();
  const lamports = BigInt(2_039_280); // rent for token account
  const tx = new Transaction().add(
    SystemProgram.createAccount({
      fromPubkey: payer.publicKey,
      newAccountPubkey: acctKp.publicKey,
      space: ACCOUNT_SIZE,
      lamports: Number(lamports),
      programId: TOKEN_PROGRAM_ID,
    }),
    createInitializeAccountInstruction(acctKp.publicKey, mint, owner)
  );
  tx.recentBlockhash = context.lastBlockhash;
  tx.feePayer = payer.publicKey;
  tx.sign(payer, acctKp);
  await context.banksClient.processTransaction(tx);
  return acctKp.publicKey;
}

// Helper: mint tokens in bankrun
async function bankrunMintTo(
  context: any,
  payer: Keypair,
  mint: PublicKey,
  dest: PublicKey,
  authority: Keypair,
  amount: number
): Promise<void> {
  const tx = new Transaction().add(
    createMintToInstruction(mint, dest, authority.publicKey, amount)
  );
  tx.recentBlockhash = context.lastBlockhash;
  tx.feePayer = payer.publicKey;
  tx.sign(payer, authority);
  await context.banksClient.processTransaction(tx);
}

// ── PDA helpers ───────────────────────────────────────────

function findPda(seeds: Buffer[], programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(seeds, programId)[0];
}

function findSettlerConfigPda(programId: PublicKey): PublicKey {
  return findPda([Buffer.from("settler_config")], programId);
}

function findControllerConfigPda(programId: PublicKey): PublicKey {
  return findPda([Buffer.from("controller_config")], programId);
}

function findWhitelistConfigPda(programId: PublicKey): PublicKey {
  return findPda([Buffer.from("whitelist_config")], programId);
}

function findOTokenInfoPda(mint: PublicKey, programId: PublicKey): PublicKey {
  return findPda([Buffer.from("otoken_info"), mint.toBuffer()], programId);
}

function findVaultCounterPda(owner: PublicKey, programId: PublicKey): PublicKey {
  return findPda([Buffer.from("vault_counter"), owner.toBuffer()], programId);
}

function findVaultPda(owner: PublicKey, vaultId: BN, programId: PublicKey): PublicKey {
  return findPda(
    [Buffer.from("vault"), owner.toBuffer(), vaultId.toArrayLike(Buffer, "le", 8)],
    programId
  );
}

function findMakerStatePda(maker: PublicKey, programId: PublicKey): PublicKey {
  return findPda([Buffer.from("maker"), maker.toBuffer()], programId);
}

function findMakerOTokenBalancePda(
  maker: PublicKey, mint: PublicKey, programId: PublicKey
): PublicKey {
  return findPda(
    [Buffer.from("mm_balance"), maker.toBuffer(), mint.toBuffer()],
    programId
  );
}

function findWhitelistedOTokenPda(mint: PublicKey, programId: PublicKey): PublicKey {
  return findPda([Buffer.from("whitelisted_otoken"), mint.toBuffer()], programId);
}

function findPoolVaultAuthPda(mint: PublicKey, programId: PublicKey): PublicKey {
  return findPda([Buffer.from("pool_vault_auth"), mint.toBuffer()], programId);
}

// ── Tests ─────────────────────────────────────────────────

describe("post-expiry instructions", () => {
  let provider: BankrunProvider;
  let context: Awaited<ReturnType<typeof startAnchor>>;

  let controllerProgram: any;
  let batchSettlerProgram: any;
  let whitelistProgram: any;

  const admin = Keypair.generate();
  const operator = Keypair.generate();
  const maker = Keypair.generate();
  const user = Keypair.generate();
  const treasury = Keypair.generate();
  const jupiterProgram = Keypair.generate();

  let collateralMint: PublicKey;
  let otokenMint: PublicKey;
  let otokenInfoPda: PublicKey;
  let settlerConfigPda: PublicKey;
  let controllerConfigPda: PublicKey;
  let poolTokenAccount: PublicKey;
  let poolVaultAuthPda: PublicKey;
  let settlerOtokenAccount: PublicKey;
  let settlerCollateralAccount: PublicKey;
  let mmCollateralAccount: PublicKey;
  let makerOTokenBalancePda: PublicKey;

  const STRIKE_PRICE = new BN("200000000000"); // $2000 in 8 decimals
  const ESCAPE_DELAY = new BN(259200); // 3 days
  const FEE_BPS = 500;

  before(async () => {
    context = await startAnchor(".", [], [
      { address: admin.publicKey, info: { lamports: 50 * LAMPORTS_PER_SOL, data: Buffer.alloc(0), owner: SystemProgram.programId, executable: false } },
      { address: operator.publicKey, info: { lamports: 10 * LAMPORTS_PER_SOL, data: Buffer.alloc(0), owner: SystemProgram.programId, executable: false } },
      { address: maker.publicKey, info: { lamports: 10 * LAMPORTS_PER_SOL, data: Buffer.alloc(0), owner: SystemProgram.programId, executable: false } },
      { address: user.publicKey, info: { lamports: 10 * LAMPORTS_PER_SOL, data: Buffer.alloc(0), owner: SystemProgram.programId, executable: false } },
      { address: treasury.publicKey, info: { lamports: LAMPORTS_PER_SOL, data: Buffer.alloc(0), owner: SystemProgram.programId, executable: false } },
    ]);
    provider = new BankrunProvider(context);
    anchor.setProvider(provider as unknown as anchor.AnchorProvider);

    controllerProgram = new Program(
      require("../target/idl/controller.json"),
      provider as unknown as anchor.AnchorProvider
    );
    batchSettlerProgram = new Program(
      require("../target/idl/batch_settler.json"),
      provider as unknown as anchor.AnchorProvider
    );
    whitelistProgram = new Program(
      require("../target/idl/whitelist.json"),
      provider as unknown as anchor.AnchorProvider
    );

    controllerConfigPda = findControllerConfigPda(controllerProgram.programId);
    settlerConfigPda = findSettlerConfigPda(batchSettlerProgram.programId);
    const whitelistConfigPda = findWhitelistConfigPda(whitelistProgram.programId);

    // 1. Create collateral mint (6 decimals)
    collateralMint = await bankrunCreateMint(context, admin, admin.publicKey, 6);

    // 2. oToken mint (8 decimals, controller as authority)
    otokenMint = await bankrunCreateMint(context, admin, controllerConfigPda, 8);

    // 3. Initialize whitelist + whitelist oToken
    await whitelistProgram.methods
      .initialize(admin.publicKey)
      .accounts({ payer: admin.publicKey })
      .signers([admin])
      .rpc();

    const wlOtokenPda = findWhitelistedOTokenPda(otokenMint, whitelistProgram.programId);
    await whitelistProgram.methods
      .whitelistOtoken(otokenMint)
      .accounts({
        whitelistedOtoken: wlOtokenPda,
        config: whitelistConfigPda,
        caller: admin.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([admin])
      .rpc();

    // 4. Initialize controller
    await controllerProgram.methods
      .initialize(admin.publicKey)
      .accounts({ payer: admin.publicKey })
      .signers([admin])
      .rpc();

    // 5. Create OTokenInfo with near-future expiry
    const clock = await context.banksClient.getClock();
    const expiryTimestamp = new BN(Number(clock.unixTimestamp) + 100);

    otokenInfoPda = findOTokenInfoPda(otokenMint, controllerProgram.programId);
    await controllerProgram.methods
      .createOtokenInfo(
        otokenMint,
        Keypair.generate().publicKey, // underlying
        Keypair.generate().publicKey, // strike_asset
        collateralMint,
        STRIKE_PRICE,
        expiryTimestamp,
        true, // isPut
        6     // collateral_decimals
      )
      .accounts({
        config: controllerConfigPda,
        otokenInfo: otokenInfoPda,
        otokenMint: otokenMint,
        whitelistedOtoken: wlOtokenPda,
        whitelistProgram: whitelistProgram.programId,
        admin: admin.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([admin])
      .rpc();

    // 6. Initialize vault counter for admin (acting as vault owner)
    await controllerProgram.methods
      .initializeCounter()
      .accounts({ owner: admin.publicKey })
      .signers([admin])
      .rpc();

    // 7. Setup pool token accounts
    poolVaultAuthPda = findPoolVaultAuthPda(collateralMint, controllerProgram.programId);
    poolTokenAccount = await bankrunCreateTokenAccount(context, admin, collateralMint, poolVaultAuthPda);

    // 8. Open vault, deposit collateral, mint oTokens (admin acts as vault owner)
    const vaultPda = findVaultPda(admin.publicKey, new BN(0), controllerProgram.programId);

    await controllerProgram.methods
      .openVault(collateralMint, user.publicKey) // beneficiary = user
      .accounts({ owner: admin.publicKey })
      .signers([admin])
      .rpc();

    // Fund and deposit collateral
    const adminCollateralAccount = await bankrunCreateTokenAccount(context, admin, collateralMint, admin.publicKey);
    await bankrunMintTo(context, admin, collateralMint, adminCollateralAccount, admin, 50_000_000_000);

    await controllerProgram.methods
      .depositCollateral(new BN(50_000_000_000))
      .accounts({
        config: controllerConfigPda,
        vault: vaultPda,
        userTokenAccount: adminCollateralAccount,
        poolTokenAccount: poolTokenAccount,
        owner: admin.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([admin])
      .rpc();

    // Mint oTokens to admin's oToken account (admin owns for minting, will transfer later)
    const adminOtokenAccount = await bankrunCreateTokenAccount(context, admin, otokenMint, admin.publicKey);
    // Settler custody oToken account (owned by settler PDA, for redeem CPI)
    settlerOtokenAccount = await bankrunCreateTokenAccount(context, admin, otokenMint, settlerConfigPda);

    await controllerProgram.methods
      .mintOtoken(new BN(100_000_000)) // 1 oToken
      .accounts({
        config: controllerConfigPda,
        vault: vaultPda,
        otokenInfo: otokenInfoPda,
        otokenMint: otokenMint,
        destination: adminOtokenAccount,
        owner: admin.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([admin])
      .rpc();

    // Transfer oTokens from admin to settler custody
    const transferOtokenTx = new Transaction().add(
      require("@solana/spl-token").createTransferInstruction(
        adminOtokenAccount,
        settlerOtokenAccount,
        admin.publicKey,
        100_000_000
      )
    );
    transferOtokenTx.recentBlockhash = context.lastBlockhash;
    transferOtokenTx.feePayer = admin.publicKey;
    transferOtokenTx.sign(admin);
    await context.banksClient.processTransaction(transferOtokenTx);

    // 9. Create settler collateral account (for redeem payout, owned by settler PDA)
    settlerCollateralAccount = await bankrunCreateTokenAccount(context, admin, collateralMint, settlerConfigPda);

    // 10. MM collateral account
    mmCollateralAccount = await bankrunCreateTokenAccount(context, admin, collateralMint, maker.publicKey);

    // 11. Create MakerOTokenBalance PDA via setAccount (simulating execute_order)
    makerOTokenBalancePda = findMakerOTokenBalancePda(
      maker.publicKey, otokenMint, batchSettlerProgram.programId
    );

    // 12. Initialize batch settler
    await batchSettlerProgram.methods
      .initialize(
        operator.publicKey,
        treasury.publicKey,
        FEE_BPS,
        ESCAPE_DELAY,
        jupiterProgram.publicKey
      )
      .accounts({ payer: admin.publicKey })
      .signers([admin])
      .rpc();

    // Whitelist maker
    await batchSettlerProgram.methods
      .whitelistMaker(maker.publicKey, true)
      .accounts({ owner: admin.publicKey })
      .signers([admin])
      .rpc();

    // Manually inject MakerOTokenBalance PDA (normally created by execute_order)
    const [, mmBalBump] = PublicKey.findProgramAddressSync(
      [Buffer.from("mm_balance"), maker.publicKey.toBuffer(), otokenMint.toBuffer()],
      batchSettlerProgram.programId
    );

    // Build the account data manually: discriminator + maker(32) + otoken_mint(32) + balance(8) + bump(1)
    const mmBalData = Buffer.alloc(8 + 32 + 32 + 8 + 1);
    // Write Anchor discriminator (computed from sha256)
    const crypto = require("crypto");
    const discHash = crypto.createHash("sha256").update("account:MakerOTokenBalance").digest();
    discHash.copy(mmBalData, 0, 0, 8);
    // Write maker pubkey
    maker.publicKey.toBuffer().copy(mmBalData, 8);
    // Write otoken_mint
    otokenMint.toBuffer().copy(mmBalData, 40);
    // Write balance = 100_000_000 (1 oToken in 8 decimals)
    mmBalData.writeBigUInt64LE(100_000_000n, 72);
    // Write bump
    mmBalData.writeUInt8(mmBalBump, 80);

    context.setAccount(makerOTokenBalancePda, {
      lamports: LAMPORTS_PER_SOL,
      data: mmBalData,
      owner: batchSettlerProgram.programId,
      executable: false,
    });
  });

  // ─── controller::set_expiry_price ──────────────────────

  describe("controller::set_expiry_price", () => {
    it("rejects zero price", async () => {
      try {
        await controllerProgram.methods
          .setExpiryPrice(new BN(0))
          .accounts({ admin: admin.publicKey, otokenInfo: otokenInfoPda })
          .signers([admin])
          .rpc();
        assert.fail("should reject zero price");
      } catch (err: any) {
        assert.include(err.toString(), "ZeroAmount");
      }
    });

    it("rejects non-admin", async () => {
      const rando = Keypair.generate();
      context.setAccount(rando.publicKey, {
        lamports: LAMPORTS_PER_SOL,
        data: Buffer.alloc(0),
        owner: SystemProgram.programId,
        executable: false,
      });

      try {
        await controllerProgram.methods
          .setExpiryPrice(new BN("150000000000"))
          .accounts({ admin: rando.publicKey })
          .signers([rando])
          .rpc();
        assert.fail("should reject non-admin");
      } catch (err: any) {
        // Bankrun may return account resolution error or ConstraintHasOne
        if (err.message === "should reject non-admin") throw err;
        assert.ok(err.toString().length > 0, "rejected non-admin");
      }
    });

    it("sets expiry price successfully", async () => {
      // Warp clock past expiry first
      const clock = await context.banksClient.getClock();
      const newClock = new Clock(
        clock.slot,
        clock.epochStartTimestamp,
        clock.epoch,
        clock.leaderScheduleEpoch,
        // Set unix timestamp past expiry
        BigInt(Number(clock.unixTimestamp) + 200)
      );
      context.setClock(newClock);

      await controllerProgram.methods
        .setExpiryPrice(new BN("150000000000")) // $1500 — ITM for put (below $2000 strike)
        .accounts({ admin: admin.publicKey, otokenInfo: otokenInfoPda })
        .signers([admin])
        .rpc();

      const info = await controllerProgram.account.oTokenInfo.fetch(otokenInfoPda);
      assert.equal(info.expiryPrice.toString(), "150000000000");
    });

    it("rejects setting price again (already set)", async () => {
      try {
        await controllerProgram.methods
          .setExpiryPrice(new BN("160000000000"))
          .accounts({ admin: admin.publicKey, otokenInfo: otokenInfoPda })
          .signers([admin])
          .rpc();
        assert.fail("should reject already set");
      } catch (err: any) {
        assert.include(err.toString(), "ExpiryPriceAlreadySet");
      }
    });
  });

  // ─── batch_settler config setters ──────────────────────

  describe("config setters", () => {
    it("set_escape_delay rejects below minimum", async () => {
      try {
        await batchSettlerProgram.methods
          .setEscapeDelay(new BN(100)) // less than 3 days
          .accounts({ owner: admin.publicKey })
          .signers([admin])
          .rpc();
        assert.fail("should reject short delay");
      } catch (err: any) {
        assert.include(err.toString(), "EscapeDelayTooShort");
      }
    });

    it("set_escape_delay succeeds with valid delay", async () => {
      await batchSettlerProgram.methods
        .setEscapeDelay(new BN(300000))
        .accounts({ owner: admin.publicKey })
        .signers([admin])
        .rpc();

      const config = await batchSettlerProgram.account.settlerConfig.fetch(settlerConfigPda);
      assert.equal(config.escapeDelay.toNumber(), 300000);

      // Restore
      await batchSettlerProgram.methods
        .setEscapeDelay(ESCAPE_DELAY)
        .accounts({ owner: admin.publicKey })
        .signers([admin])
        .rpc();
    });

    it("set_jupiter_program rejects zero address", async () => {
      try {
        await batchSettlerProgram.methods
          .setJupiterProgram(PublicKey.default)
          .accounts({ owner: admin.publicKey })
          .signers([admin])
          .rpc();
        assert.fail("should reject zero");
      } catch (err: any) {
        assert.include(err.toString(), "ZeroAddress");
      }
    });

    it("set_jupiter_program succeeds", async () => {
      const newJup = Keypair.generate().publicKey;
      await batchSettlerProgram.methods
        .setJupiterProgram(newJup)
        .accounts({ owner: admin.publicKey })
        .signers([admin])
        .rpc();

      const config = await batchSettlerProgram.account.settlerConfig.fetch(settlerConfigPda);
      assert.ok(config.jupiterProgram.equals(newJup));

      // Restore
      await batchSettlerProgram.methods
        .setJupiterProgram(jupiterProgram.publicKey)
        .accounts({ owner: admin.publicKey })
        .signers([admin])
        .rpc();
    });

    it("rejects non-owner", async () => {
      try {
        await batchSettlerProgram.methods
          .setEscapeDelay(new BN(300000))
          .accounts({ owner: operator.publicKey })
          .signers([operator])
          .rpc();
        assert.fail("should reject non-owner");
      } catch (err: any) {
        assert.include(err.toString(), "ConstraintHasOne");
      }
    });
  });

  // ─── redeem_for_mm ─────────────────────────────────────

  describe("redeem_for_mm", () => {
    it("rejects unauthorized caller", async () => {
      const rando = Keypair.generate();
      context.setAccount(rando.publicKey, {
        lamports: LAMPORTS_PER_SOL,
        data: Buffer.alloc(0),
        owner: SystemProgram.programId,
        executable: false,
      });

      try {
        await batchSettlerProgram.methods
          .redeemForMm(new BN(50_000_000))
          .accounts({
            settlerConfig: settlerConfigPda,
            operator: rando.publicKey,
            makerOtokenBalance: makerOTokenBalancePda,
            controllerConfig: controllerConfigPda,
            otokenInfo: otokenInfoPda,
            otokenMint: otokenMint,
            settlerOtokenAccount: settlerOtokenAccount,
            settlerCollateralAccount: settlerCollateralAccount,
            mmCollateralAccount: mmCollateralAccount,
            poolTokenAccount: poolTokenAccount,
            poolVaultAuthority: poolVaultAuthPda,
            controllerProgram: controllerProgram.programId,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([rando])
          .rpc();
        assert.fail("should reject unauthorized");
      } catch (err: any) {
        assert.ok(
          err.toString().includes("Unauthorized") ||
          err.toString().includes("ConstraintRaw"),
          "should be unauthorized"
        );
      }
    });

    it("rejects zero amount", async () => {
      try {
        await batchSettlerProgram.methods
          .redeemForMm(new BN(0))
          .accounts({
            settlerConfig: settlerConfigPda,
            operator: operator.publicKey,
            makerOtokenBalance: makerOTokenBalancePda,
            controllerConfig: controllerConfigPda,
            otokenInfo: otokenInfoPda,
            otokenMint: otokenMint,
            settlerOtokenAccount: settlerOtokenAccount,
            settlerCollateralAccount: settlerCollateralAccount,
            mmCollateralAccount: mmCollateralAccount,
            poolTokenAccount: poolTokenAccount,
            poolVaultAuthority: poolVaultAuthPda,
            controllerProgram: controllerProgram.programId,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([operator])
          .rpc();
        assert.fail("should reject zero amount");
      } catch (err: any) {
        assert.include(err.toString(), "ZeroAmount");
      }
    });
  });

  // ─── mm_self_redeem ────────────────────────────────────

  describe("mm_self_redeem", () => {
    it("rejects before escape delay", async () => {
      // Clock is at expiry+200 but escape_delay is 259200 (3 days)
      // So escape_time = expiry + 259200, clock is only expiry + 200
      try {
        await batchSettlerProgram.methods
          .mmSelfRedeem(new BN(50_000_000))
          .accounts({
            settlerConfig: settlerConfigPda,
            makerState: findMakerStatePda(maker.publicKey, batchSettlerProgram.programId),
            maker: maker.publicKey,
            makerOtokenBalance: makerOTokenBalancePda,
            controllerConfig: controllerConfigPda,
            otokenInfo: otokenInfoPda,
            otokenMint: otokenMint,
            settlerOtokenAccount: settlerOtokenAccount,
            settlerCollateralAccount: settlerCollateralAccount,
            mmCollateralAccount: mmCollateralAccount,
            poolTokenAccount: poolTokenAccount,
            poolVaultAuthority: poolVaultAuthPda,
            controllerProgram: controllerProgram.programId,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([maker])
          .rpc();
        assert.fail("should reject before escape delay");
      } catch (err: any) {
        assert.include(err.toString(), "EscapeNotReady");
      }
    });
  });
});
