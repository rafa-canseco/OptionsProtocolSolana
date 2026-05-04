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

function findFactoryConfigPda(programId: PublicKey): PublicKey {
  return findPda([Buffer.from("factory_config")], programId);
}

function findFactoryOperatorConfigPda(programId: PublicKey): PublicKey {
  return findPda([Buffer.from("factory_operator_config")], programId);
}

function findFactoryOTokenPda(
  underlying: PublicKey,
  strikeAsset: PublicKey,
  collateral: PublicKey,
  strikePrice: BN,
  expiry: BN,
  isPut: boolean,
  programId: PublicKey
): PublicKey {
  return findPda([
    Buffer.from("otoken"),
    underlying.toBuffer(),
    strikeAsset.toBuffer(),
    collateral.toBuffer(),
    strikePrice.toArrayLike(Buffer, "le", 8),
    expiry.toArrayLike(Buffer, "le", 8),
    Buffer.from([isPut ? 1 : 0]),
  ], programId);
}

function findFactoryOTokenMintPda(
  underlying: PublicKey,
  strikeAsset: PublicKey,
  collateral: PublicKey,
  strikePrice: BN,
  expiry: BN,
  isPut: boolean,
  programId: PublicKey
): PublicKey {
  return findPda([
    Buffer.from("otoken_mint"),
    underlying.toBuffer(),
    strikeAsset.toBuffer(),
    collateral.toBuffer(),
    strikePrice.toArrayLike(Buffer, "le", 8),
    expiry.toArrayLike(Buffer, "le", 8),
    Buffer.from([isPut ? 1 : 0]),
  ], programId);
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

const EXPIRY_PRICE_DISCRIMINATOR = Buffer.from(
  require("crypto").createHash("sha256").update("account:ExpiryPrice").digest().subarray(0, 8)
);

function injectOracleExpiryPrice(
  context: any,
  pda: PublicKey,
  oracleProgramId: PublicKey,
  underlying: PublicKey,
  expiry: BN,
  price: BN,
  bump: number
): void {
  const data = Buffer.alloc(8 + 32 + 8 + 8 + 1 + 1);
  EXPIRY_PRICE_DISCRIMINATOR.copy(data, 0);
  underlying.toBuffer().copy(data, 8);
  data.writeBigInt64LE(BigInt(expiry.toString()), 40);
  data.writeBigUInt64LE(BigInt(price.toString()), 48);
  data.writeUInt8(1, 56);
  data.writeUInt8(bump, 57);
  context.setAccount(pda, {
    lamports: LAMPORTS_PER_SOL,
    data,
    owner: oracleProgramId,
    executable: false,
  });
}

// ── Tests ─────────────────────────────────────────────────

describe("post-expiry instructions", () => {
  let provider: BankrunProvider;
  let context: Awaited<ReturnType<typeof startAnchor>>;

  let controllerProgram: any;
  let batchSettlerProgram: any;
  let whitelistProgram: any;
  let otokenFactoryProgram: any;
  let oracleProgram: any;

  const admin = Keypair.generate();
  const operator = Keypair.generate();
  const maker = Keypair.generate();
  const user = Keypair.generate();
  const treasury = Keypair.generate();
  const jupiterProgram = Keypair.generate();

  let collateralMint: PublicKey;
  let underlying: PublicKey;
  let expiryTimestamp: BN;
  let otokenMint: PublicKey;
  let otokenInfoPda: PublicKey;
  let oracleExpiryPricePda: PublicKey;
  let oracleExpiryPriceBump: number;
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
    otokenFactoryProgram = new Program(
      require("../target/idl/otoken_factory.json"),
      provider as unknown as anchor.AnchorProvider
    );
    oracleProgram = new Program(
      require("../target/idl/oracle.json"),
      provider as unknown as anchor.AnchorProvider
    );

    controllerConfigPda = findControllerConfigPda(controllerProgram.programId);
    settlerConfigPda = findSettlerConfigPda(batchSettlerProgram.programId);
    const whitelistConfigPda = findWhitelistConfigPda(whitelistProgram.programId);
    const factoryConfigPda = findFactoryConfigPda(otokenFactoryProgram.programId);

    // 1. Create collateral mint (6 decimals)
    collateralMint = await bankrunCreateMint(context, admin, admin.publicKey, 6);

    // 2. Initialize whitelist/factory/controller
    await whitelistProgram.methods
      .initialize(admin.publicKey)
      .accounts({ payer: admin.publicKey })
      .signers([admin])
      .rpc();
    await otokenFactoryProgram.methods
      .initialize(admin.publicKey)
      .accounts({ payer: admin.publicKey })
      .signers([admin])
      .rpc();
    await controllerProgram.methods
      .initialize(admin.publicKey)
      .accounts({ payer: admin.publicKey })
      .signers([admin])
      .rpc();
    await otokenFactoryProgram.methods
      .setController(controllerConfigPda)
      .accounts({ admin: admin.publicKey })
      .signers([admin])
      .rpc();
    await otokenFactoryProgram.methods
      .setOperator(admin.publicKey)
      .accounts({
        factoryConfig: factoryConfigPda,
        operatorConfig: findFactoryOperatorConfigPda(otokenFactoryProgram.programId),
        admin: admin.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([admin])
      .rpc();

    // 3. Create canonical oToken + OTokenInfo with near-future expiry
    const clock = await context.banksClient.getClock();
    expiryTimestamp = new BN(Number(clock.unixTimestamp) + 100);
    underlying = Keypair.generate().publicKey;
    const strikeAsset = Keypair.generate().publicKey;
    const factoryOtokenPda = findFactoryOTokenPda(
      underlying,
      strikeAsset,
      collateralMint,
      STRIKE_PRICE,
      expiryTimestamp,
      true,
      otokenFactoryProgram.programId
    );
    otokenMint = findFactoryOTokenMintPda(
      underlying,
      strikeAsset,
      collateralMint,
      STRIKE_PRICE,
      expiryTimestamp,
      true,
      otokenFactoryProgram.programId
    );
    await otokenFactoryProgram.methods
      .createOtoken(
        underlying,
        strikeAsset,
        collateralMint,
        STRIKE_PRICE,
        expiryTimestamp,
        true
      )
      .accounts({
        factoryConfig: factoryConfigPda,
        operatorConfig: findFactoryOperatorConfigPda(otokenFactoryProgram.programId),
        otoken: factoryOtokenPda,
        otokenMint,
        controllerAuthority: controllerConfigPda,
        admin: admin.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([admin])
      .rpc();

    const wlOtokenPda = findWhitelistedOTokenPda(otokenMint, whitelistProgram.programId);
    await whitelistProgram.methods
      .whitelistOtoken(otokenMint)
      .accounts({
        whitelistedOtoken: wlOtokenPda,
        config: whitelistConfigPda,
        factoryOtoken: factoryOtokenPda,
        factoryOperatorConfig: findFactoryOperatorConfigPda(otokenFactoryProgram.programId),
        factoryProgram: otokenFactoryProgram.programId,
        caller: admin.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([admin])
      .rpc();

    otokenInfoPda = findOTokenInfoPda(otokenMint, controllerProgram.programId);
    [oracleExpiryPricePda, oracleExpiryPriceBump] =
      PublicKey.findProgramAddressSync(
        [
          Buffer.from("expiry_price"),
          underlying.toBuffer(),
          expiryTimestamp.toArrayLike(Buffer, "le", 8),
        ],
        oracleProgram.programId
      );
    await controllerProgram.methods
      .createOtokenInfo()
      .accounts({
        config: controllerConfigPda,
        otokenInfo: otokenInfoPda,
        otokenMint: otokenMint,
        factoryOtoken: factoryOtokenPda,
        collateralMintAccount: collateralMint,
        whitelistedOtoken: wlOtokenPda,
        whitelistProgram: whitelistProgram.programId,
        factoryProgram: otokenFactoryProgram.programId,
        factoryOperatorConfig: findFactoryOperatorConfigPda(otokenFactoryProgram.programId),
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
        collateralMintAccount: collateralMint,
        poolTokenAccount: poolTokenAccount,
        poolVaultAuthority: poolVaultAuthPda,
        owner: admin.publicKey,
        collateralTokenProgram: TOKEN_PROGRAM_ID,
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
        otokenTokenProgram: TOKEN_PROGRAM_ID,
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
      const clock = await context.banksClient.getClock();
      context.setClock(new Clock(
        clock.slot,
        clock.epochStartTimestamp,
        clock.epoch,
        clock.leaderScheduleEpoch,
        BigInt(expiryTimestamp.toNumber() + 200)
      ));
      injectOracleExpiryPrice(
        context,
        oracleExpiryPricePda,
        oracleProgram.programId,
        underlying,
        expiryTimestamp,
        new BN(0),
        oracleExpiryPriceBump
      );
      try {
        await controllerProgram.methods
          .setExpiryPrice()
          .accounts({
            admin: admin.publicKey,
            otokenInfo: otokenInfoPda,
            oracleExpiryPrice: oracleExpiryPricePda,
            oracleProgram: oracleProgram.programId,
          })
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
          .setExpiryPrice()
          .accounts({
            admin: rando.publicKey,
            otokenInfo: otokenInfoPda,
            oracleExpiryPrice: oracleExpiryPricePda,
            oracleProgram: oracleProgram.programId,
          })
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
      injectOracleExpiryPrice(
        context,
        oracleExpiryPricePda,
        oracleProgram.programId,
        underlying,
        expiryTimestamp,
        new BN("150000000000"),
        oracleExpiryPriceBump
      );

      await controllerProgram.methods
        .setExpiryPrice()
        .accounts({
          admin: admin.publicKey,
          otokenInfo: otokenInfoPda,
          oracleExpiryPrice: oracleExpiryPricePda,
          oracleProgram: oracleProgram.programId,
        })
        .signers([admin])
        .rpc();

      const info = await controllerProgram.account.oTokenInfo.fetch(otokenInfoPda);
      assert.equal(info.expiryPrice.toString(), "150000000000");
    });

    it("rejects setting price again (already set)", async () => {
      try {
        await controllerProgram.methods
          .setExpiryPrice()
          .accounts({
            admin: admin.publicKey,
            otokenInfo: otokenInfoPda,
            oracleExpiryPrice: oracleExpiryPricePda,
            oracleProgram: oracleProgram.programId,
          })
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
            collateralMintAccount: collateralMint,
            settlerOtokenAccount: settlerOtokenAccount,
            settlerCollateralAccount: settlerCollateralAccount,
            mmCollateralAccount: mmCollateralAccount,
            poolTokenAccount: poolTokenAccount,
            poolVaultAuthority: poolVaultAuthPda,
            controllerProgram: controllerProgram.programId,
            otokenTokenProgram: TOKEN_PROGRAM_ID,
            collateralTokenProgram: TOKEN_PROGRAM_ID,
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
            collateralMintAccount: collateralMint,
            settlerOtokenAccount: settlerOtokenAccount,
            settlerCollateralAccount: settlerCollateralAccount,
            mmCollateralAccount: mmCollateralAccount,
            poolTokenAccount: poolTokenAccount,
            poolVaultAuthority: poolVaultAuthPda,
            controllerProgram: controllerProgram.programId,
            otokenTokenProgram: TOKEN_PROGRAM_ID,
            collateralTokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([operator])
          .rpc();
        assert.fail("should reject zero amount");
      } catch (err: any) {
        assert.include(err.toString(), "ZeroAmount");
      }
    });

    // NM-004 regression: pre-existing residue / external donations
    // sitting in settler_collateral_account must NOT be swept to MM.
    // The handler now snapshots the balance before the redeem CPI
    // and transfers only the redeem delta.
    it("transfers only the redeem delta (not pre-existing residue) to MM", async () => {
      // Donate 7 USDC to settler_collateral_account before invoking.
      const donation = 7_000_000;
      const donorAccount = await bankrunCreateTokenAccount(
        context,
        admin,
        collateralMint,
        admin.publicKey
      );
      await bankrunMintTo(context, admin, collateralMint, donorAccount, admin, donation);

      const transferIx = require("@solana/spl-token").createTransferInstruction(
        donorAccount,
        settlerCollateralAccount,
        admin.publicKey,
        donation
      );
      const donationTx = new Transaction().add(transferIx);
      donationTx.recentBlockhash = context.lastBlockhash;
      donationTx.feePayer = admin.publicKey;
      donationTx.sign(admin);
      await context.banksClient.processTransaction(donationTx);

      const mmBefore = await context.banksClient.getAccount(mmCollateralAccount);
      const mmAmountBefore = Buffer.from(mmBefore!.data).readBigUInt64LE(64);

      // Redeem the full custodied amount (1 oToken = 100_000_000).
      // Strike $2000, mark $1500, 6-dec collateral → ITM PUT redeem
      // returns full collateral = 2_000_000_000 (2000 USDC).
      await batchSettlerProgram.methods
        .redeemForMm(new BN(50_000_000)) // 0.5 oToken
        .accounts({
          settlerConfig: settlerConfigPda,
          operator: operator.publicKey,
          makerOtokenBalance: makerOTokenBalancePda,
          controllerConfig: controllerConfigPda,
          otokenInfo: otokenInfoPda,
          otokenMint: otokenMint,
          collateralMintAccount: collateralMint,
          settlerOtokenAccount: settlerOtokenAccount,
          settlerCollateralAccount: settlerCollateralAccount,
          mmCollateralAccount: mmCollateralAccount,
          poolTokenAccount: poolTokenAccount,
          poolVaultAuthority: poolVaultAuthPda,
          controllerProgram: controllerProgram.programId,
          otokenTokenProgram: TOKEN_PROGRAM_ID,
          collateralTokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([operator])
        .rpc();

      const mmAfter = await context.banksClient.getAccount(mmCollateralAccount);
      const mmAmountAfter = Buffer.from(mmAfter!.data).readBigUInt64LE(64);
      const delta = mmAmountAfter - mmAmountBefore;

      // Expected redeem payout for 0.5 oToken at strike $2000 (8 dec)
      // with 6-dec collateral: 5e7 * 2e11 / 1e10 = 1e9 (1000 USDC).
      // Donation MUST stay in settler_collateral_account.
      assert.equal(
        delta.toString(),
        "1000000000",
        "MM received exactly the redeem delta, not delta + donation"
      );

      // Donation should still be sitting in the settler account.
      const settlerAfter = await context.banksClient.getAccount(settlerCollateralAccount);
      const settlerAmount = Buffer.from(settlerAfter!.data).readBigUInt64LE(64);
      assert.equal(
        settlerAmount.toString(),
        donation.toString(),
        "donation untouched in settler_collateral_account"
      );
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
            collateralMintAccount: collateralMint,
            settlerOtokenAccount: settlerOtokenAccount,
            settlerCollateralAccount: settlerCollateralAccount,
            mmCollateralAccount: mmCollateralAccount,
            poolTokenAccount: poolTokenAccount,
            poolVaultAuthority: poolVaultAuthPda,
            controllerProgram: controllerProgram.programId,
            otokenTokenProgram: TOKEN_PROGRAM_ID,
            collateralTokenProgram: TOKEN_PROGRAM_ID,
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
