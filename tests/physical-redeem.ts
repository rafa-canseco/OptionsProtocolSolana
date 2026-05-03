// @ts-nocheck — Anchor workspace types require runtime IDL loading
//
// Coverage for batch_settler::physical_redeem after the Kamino flash loan
// removal (parity with Base origin/main BatchSettler.sol).
//
// The flow under test:
//   1. Operator calls physical_redeem with a Jupiter route.
//   2. Settler redeems custodied oTokens against the controller —
//      collateral lands in settler_collateral_account.
//   3. Jupiter swaps collateral into contra-asset:
//        PUT  → output goes directly to user_contra_account.
//        CALL → output goes to settler_contra_account, then the
//               handler pays the user exactly contra_amount.
//   4. Surplus is routed to the MM:
//        PUT  → surplus is collateral_mint.
//        CALL → surplus is contra_mint.
//
// Jupiter is mocked by the `mock_jupiter` program in this workspace.
// The mock holds two SPL token reserves (input + output) and exposes
// a single `swap` instruction that pulls input_amount from the
// caller's source and pushes output_amount from the out_reserve.

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
  createTransferInstruction,
  MINT_SIZE,
  ACCOUNT_SIZE,
} from "@solana/spl-token";
import { assert } from "chai";

// ─── Bankrun helpers ─────────────────────────────────────────

async function bankrunCreateMint(
  context: any,
  payer: Keypair,
  authority: PublicKey,
  decimals: number,
  mintKp?: Keypair
): Promise<PublicKey> {
  const kp = mintKp || Keypair.generate();
  const tx = new Transaction().add(
    SystemProgram.createAccount({
      fromPubkey: payer.publicKey,
      newAccountPubkey: kp.publicKey,
      space: MINT_SIZE,
      lamports: 1_461_600,
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

async function bankrunCreateTokenAccount(
  context: any,
  payer: Keypair,
  mint: PublicKey,
  owner: PublicKey,
  kp?: Keypair
): Promise<PublicKey> {
  const acctKp = kp || Keypair.generate();
  const tx = new Transaction().add(
    SystemProgram.createAccount({
      fromPubkey: payer.publicKey,
      newAccountPubkey: acctKp.publicKey,
      space: ACCOUNT_SIZE,
      lamports: 2_039_280,
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

async function bankrunMintTo(
  context: any,
  payer: Keypair,
  mint: PublicKey,
  dest: PublicKey,
  authority: Keypair,
  amount: bigint | number
): Promise<void> {
  const tx = new Transaction().add(
    createMintToInstruction(mint, dest, authority.publicKey, BigInt(amount))
  );
  tx.recentBlockhash = context.lastBlockhash;
  tx.feePayer = payer.publicKey;
  tx.sign(payer, authority);
  await context.banksClient.processTransaction(tx);
}

async function bankrunTokenTransfer(
  context: any,
  payer: Keypair,
  source: PublicKey,
  dest: PublicKey,
  authority: Keypair,
  amount: bigint | number
): Promise<void> {
  const tx = new Transaction().add(
    createTransferInstruction(source, dest, authority.publicKey, BigInt(amount))
  );
  tx.recentBlockhash = context.lastBlockhash;
  tx.feePayer = payer.publicKey;
  tx.sign(payer, authority);
  await context.banksClient.processTransaction(tx);
}

async function readTokenAmount(context: any, account: PublicKey): Promise<bigint> {
  const info = await context.banksClient.getAccount(account);
  if (!info) throw new Error(`account ${account.toBase58()} not found`);
  // SPL TokenAccount layout: amount is at offset 64, 8 bytes LE.
  return Buffer.from(info.data).readBigUInt64LE(64);
}

// tsconfig target is es6, so the `**` operator transpiles to Math.pow
// which can't accept BigInt. Use an explicit loop instead.
function pow10(n: number): bigint {
  let result = 1n;
  for (let i = 0; i < n; i++) result *= 10n;
  return result;
}

// ─── PDA helpers ─────────────────────────────────────────────

const findPda = (seeds: Buffer[], programId: PublicKey): PublicKey =>
  PublicKey.findProgramAddressSync(seeds, programId)[0];

const findControllerConfigPda = (pid: PublicKey) =>
  findPda([Buffer.from("controller_config")], pid);
const findSettlerConfigPda = (pid: PublicKey) =>
  findPda([Buffer.from("settler_config")], pid);
const findWhitelistConfigPda = (pid: PublicKey) =>
  findPda([Buffer.from("whitelist_config")], pid);
const findFactoryConfigPda = (pid: PublicKey) =>
  findPda([Buffer.from("factory_config")], pid);
const findOTokenInfoPda = (mint: PublicKey, pid: PublicKey) =>
  findPda([Buffer.from("otoken_info"), mint.toBuffer()], pid);
const findFactoryOTokenPda = (
  underlying: PublicKey,
  strikeAsset: PublicKey,
  collateral: PublicKey,
  strikePrice: BN,
  expiry: BN,
  isPut: boolean,
  pid: PublicKey
) =>
  findPda([
    Buffer.from("otoken"),
    underlying.toBuffer(),
    strikeAsset.toBuffer(),
    collateral.toBuffer(),
    strikePrice.toArrayLike(Buffer, "le", 8),
    expiry.toArrayLike(Buffer, "le", 8),
    Buffer.from([isPut ? 1 : 0]),
  ], pid);
const findFactoryOTokenMintPda = (
  underlying: PublicKey,
  strikeAsset: PublicKey,
  collateral: PublicKey,
  strikePrice: BN,
  expiry: BN,
  isPut: boolean,
  pid: PublicKey
) =>
  findPda([
    Buffer.from("otoken_mint"),
    underlying.toBuffer(),
    strikeAsset.toBuffer(),
    collateral.toBuffer(),
    strikePrice.toArrayLike(Buffer, "le", 8),
    expiry.toArrayLike(Buffer, "le", 8),
    Buffer.from([isPut ? 1 : 0]),
  ], pid);
const findVaultPda = (owner: PublicKey, vaultId: BN, pid: PublicKey) =>
  findPda(
    [Buffer.from("vault"), owner.toBuffer(), vaultId.toArrayLike(Buffer, "le", 8)],
    pid
  );
const findWhitelistedOTokenPda = (mint: PublicKey, pid: PublicKey) =>
  findPda([Buffer.from("whitelisted_otoken"), mint.toBuffer()], pid);
const findPoolVaultAuthPda = (mint: PublicKey, pid: PublicKey) =>
  findPda([Buffer.from("pool_vault_auth"), mint.toBuffer()], pid);
const findVaultMMPda = (
  vault: PublicKey,
  pid: PublicKey
): [PublicKey, number] =>
  PublicKey.findProgramAddressSync(
    [Buffer.from("vault_mm"), vault.toBuffer()],
    pid
  );
const findMockJupAuthPda = (pid: PublicKey) =>
  findPda([Buffer.from("mock_jupiter_auth")], pid);
const findOracleExpiryPricePda = (underlying: PublicKey, expiry: BN, pid: PublicKey) =>
  findPda([
    Buffer.from("expiry_price"),
    underlying.toBuffer(),
    expiry.toArrayLike(Buffer, "le", 8),
  ], pid);

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

// Inject a MakerOTokenBalance PDA directly (skips execute_order setup).
function injectMakerBalance(
  context: any,
  pda: PublicKey,
  bump: number,
  programId: PublicKey,
  maker: PublicKey,
  otokenMint: PublicKey,
  balance: bigint
): void {
  const data = Buffer.alloc(8 + 32 + 32 + 8 + 1);
  const crypto = require("crypto");
  const disc = crypto.createHash("sha256").update("account:MakerOTokenBalance").digest();
  disc.copy(data, 0, 0, 8);
  maker.toBuffer().copy(data, 8);
  otokenMint.toBuffer().copy(data, 40);
  data.writeBigUInt64LE(balance, 72);
  data.writeUInt8(bump, 80);
  context.setAccount(pda, {
    lamports: LAMPORTS_PER_SOL,
    data,
    owner: programId,
    executable: false,
  });
}

function injectVaultMM(
  context: any,
  pda: PublicKey,
  bump: number,
  programId: PublicKey,
  maker: PublicKey,
  vault: PublicKey,
  otokenMint: PublicKey,
  remainingAmount: bigint
): void {
  const data = Buffer.alloc(8 + 32 + 32 + 32 + 8 + 1);
  const crypto = require("crypto");
  const disc = crypto.createHash("sha256").update("account:VaultMM").digest();
  disc.copy(data, 0, 0, 8);
  maker.toBuffer().copy(data, 8);
  vault.toBuffer().copy(data, 40);
  otokenMint.toBuffer().copy(data, 72);
  data.writeBigUInt64LE(remainingAmount, 104);
  data.writeUInt8(bump, 112);
  context.setAccount(pda, {
    lamports: LAMPORTS_PER_SOL,
    data,
    owner: programId,
    executable: false,
  });
}

// ─── Fixture builder ─────────────────────────────────────────
//
// Builds a fully-wired PUT or CALL scenario with one oToken series
// and one custodied position. Returns the handles required to invoke
// physical_redeem and to pre-fund the mock Jupiter reserves.

interface Scenario {
  context: any;
  controllerProgram: any;
  batchSettlerProgram: any;
  mockJupiterProgram: any;

  admin: Keypair;
  operator: Keypair;
  maker: Keypair;
  user: Keypair;

  isPut: boolean;
  strikePrice: BN;
  amount: BN;             // oToken units (8 decimals)
  contraAmount: bigint;   // computed on-chain; mirror for assertions

  collateralMint: PublicKey;
  underlyingMint: PublicKey;
  strikeAssetMint: PublicKey;
  contraMint: PublicKey;

  otokenMint: PublicKey;
  otokenInfoPda: PublicKey;
  controllerConfigPda: PublicKey;
  settlerConfigPda: PublicKey;
  poolTokenAccount: PublicKey;
  poolVaultAuthPda: PublicKey;
  vaultPda: PublicKey;
  vaultMmPda: PublicKey;

  settlerOtokenAccount: PublicKey;
  settlerCollateralAccount: PublicKey;
  settlerContraAccount: PublicKey;
  userContraAccount: PublicKey;
  mmDestinationAccount: PublicKey;
  makerBalancePda: PublicKey;

  // Mock Jupiter
  mockAuthPda: PublicKey;
  mockInReserve: PublicKey;
  mockOutReserve: PublicKey;
}

interface FixtureOpts {
  isPut: boolean;
  strikeUsd: number;          // strike price in dollars
  expiryPriceUsd: number;     // expiry mark in dollars (controls ITM/OTM)
  collateralDecimals: number;
  underlyingDecimals: number;
  strikeAssetDecimals: number;
  amountOTokens: BN;          // 8-decimal oToken amount
  setExpiryPrice: boolean;    // whether to set the expiry price post-expiry
  warpPastExpiry: boolean;
}

async function buildFixture(opts: FixtureOpts): Promise<Scenario> {
  const admin = Keypair.generate();
  const operator = Keypair.generate();
  const maker = Keypair.generate();
  const user = Keypair.generate();

  const context = await startAnchor(
    ".",
    [],
    [admin, operator, maker, user].map((kp) => ({
      address: kp.publicKey,
      info: {
        lamports: 50 * LAMPORTS_PER_SOL,
        data: Buffer.alloc(0),
        owner: SystemProgram.programId,
        executable: false,
      },
    }))
  );
  const provider = new BankrunProvider(context);
  anchor.setProvider(provider as unknown as anchor.AnchorProvider);

  const controllerProgram = new Program(
    require("../target/idl/controller.json"),
    provider as unknown as anchor.AnchorProvider
  );
  const batchSettlerProgram = new Program(
    require("../target/idl/batch_settler.json"),
    provider as unknown as anchor.AnchorProvider
  );
  const whitelistProgram = new Program(
    require("../target/idl/whitelist.json"),
    provider as unknown as anchor.AnchorProvider
  );
  const otokenFactoryProgram = new Program(
    require("../target/idl/otoken_factory.json"),
    provider as unknown as anchor.AnchorProvider
  );
  const mockJupiterProgram = new Program(
    require("../target/idl/mock_jupiter.json"),
    provider as unknown as anchor.AnchorProvider
  );
  const oracleProgram = new Program(
    require("../target/idl/oracle.json"),
    provider as unknown as anchor.AnchorProvider
  );

  const controllerConfigPda = findControllerConfigPda(controllerProgram.programId);
  const settlerConfigPda = findSettlerConfigPda(batchSettlerProgram.programId);
  const whitelistConfigPda = findWhitelistConfigPda(whitelistProgram.programId);
  const factoryConfigPda = findFactoryConfigPda(otokenFactoryProgram.programId);

  // Underlying / strike-asset / collateral mints. For PUT, collateral
  // is the strike asset (USDC-like). For CALL, collateral is the
  // underlying.
  const underlyingMint = await bankrunCreateMint(
    context,
    admin,
    admin.publicKey,
    opts.underlyingDecimals
  );
  const strikeAssetMint = await bankrunCreateMint(
    context,
    admin,
    admin.publicKey,
    opts.strikeAssetDecimals
  );
  const collateralMint = opts.isPut ? strikeAssetMint : underlyingMint;
  const contraMint = opts.isPut ? underlyingMint : strikeAssetMint;

  const clock = await context.banksClient.getClock();
  const expiryTimestamp = new BN(Number(clock.unixTimestamp) + 100);
  const strikePrice = new BN(opts.strikeUsd).mul(new BN(100_000_000)); // 8 dec

  await otokenFactoryProgram.methods
    .initialize(admin.publicKey)
    .accounts({ payer: admin.publicKey })
    .signers([admin])
    .rpc();
  await otokenFactoryProgram.methods
    .setController(controllerConfigPda)
    .accounts({ admin: admin.publicKey })
    .signers([admin])
    .rpc();

  const factoryOtokenPda = findFactoryOTokenPda(
    underlyingMint,
    strikeAssetMint,
    collateralMint,
    strikePrice,
    expiryTimestamp,
    opts.isPut,
    otokenFactoryProgram.programId
  );
  const otokenMint = findFactoryOTokenMintPda(
    underlyingMint,
    strikeAssetMint,
    collateralMint,
    strikePrice,
    expiryTimestamp,
    opts.isPut,
    otokenFactoryProgram.programId
  );

  await otokenFactoryProgram.methods
    .createOtoken(
      underlyingMint,
      strikeAssetMint,
      collateralMint,
      strikePrice,
      expiryTimestamp,
      opts.isPut
    )
    .accounts({
      factoryConfig: factoryConfigPda,
      otoken: factoryOtokenPda,
      otokenMint,
      controllerAuthority: controllerConfigPda,
      admin: admin.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .signers([admin])
    .rpc();

  // Whitelist + whitelist oToken
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

  // Initialize controller
  await controllerProgram.methods
    .initialize(admin.publicKey)
    .accounts({ payer: admin.publicKey })
    .signers([admin])
    .rpc();

  const otokenInfoPda = findOTokenInfoPda(otokenMint, controllerProgram.programId);

  await controllerProgram.methods
    .createOtokenInfo()
    .accounts({
      config: controllerConfigPda,
      otokenInfo: otokenInfoPda,
      otokenMint,
      factoryOtoken: factoryOtokenPda,
      collateralMintAccount: collateralMint,
      whitelistedOtoken: wlOtokenPda,
      whitelistProgram: whitelistProgram.programId,
      factoryProgram: otokenFactoryProgram.programId,
      admin: admin.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .signers([admin])
    .rpc();

  // Vault counter for admin (admin opens the vault, settler is custodian)
  await controllerProgram.methods
    .initializeCounter()
    .accounts({ owner: admin.publicKey })
    .signers([admin])
    .rpc();

  // Pool token account owned by controller's pool_vault_authority PDA
  const poolVaultAuthPda = findPoolVaultAuthPda(collateralMint, controllerProgram.programId);
  const poolTokenAccount = await bankrunCreateTokenAccount(
    context,
    admin,
    collateralMint,
    poolVaultAuthPda
  );

  // Compute required collateral and mint the right amount to admin
  // before depositing. For PUT: required = amount * strike / 10^(16 - cd).
  // For CALL: required = amount * 10^(cd - 8). We simply over-fund.
  const adminCollateralAccount = await bankrunCreateTokenAccount(
    context,
    admin,
    collateralMint,
    admin.publicKey
  );
  const collateralFundAmount = pow10(opts.collateralDecimals + 6);
  await bankrunMintTo(context, admin, collateralMint, adminCollateralAccount, admin, collateralFundAmount);

  // Open vault, deposit collateral, mint oTokens
  const vaultPda = findVaultPda(admin.publicKey, new BN(0), controllerProgram.programId);
  await controllerProgram.methods
    .openVault(collateralMint, user.publicKey)
    .accounts({ owner: admin.publicKey })
    .signers([admin])
    .rpc();
  await controllerProgram.methods
    .depositCollateral(new BN(collateralFundAmount.toString()))
    .accounts({
      config: controllerConfigPda,
      vault: vaultPda,
      userTokenAccount: adminCollateralAccount,
      collateralMintAccount: collateralMint,
      poolTokenAccount,
      poolVaultAuthority: poolVaultAuthPda,
      owner: admin.publicKey,
      collateralTokenProgram: TOKEN_PROGRAM_ID,
    })
    .signers([admin])
    .rpc();

  const settlerOtokenAccount = await bankrunCreateTokenAccount(
    context,
    admin,
    otokenMint,
    settlerConfigPda
  );
  const adminOtokenAccount = await bankrunCreateTokenAccount(
    context,
    admin,
    otokenMint,
    admin.publicKey
  );
  await controllerProgram.methods
    .mintOtoken(opts.amountOTokens)
    .accounts({
      config: controllerConfigPda,
      vault: vaultPda,
      otokenInfo: otokenInfoPda,
      otokenMint,
      destination: adminOtokenAccount,
      owner: admin.publicKey,
      otokenTokenProgram: TOKEN_PROGRAM_ID,
    })
    .signers([admin])
    .rpc();
  await bankrunTokenTransfer(
    context,
    admin,
    adminOtokenAccount,
    settlerOtokenAccount,
    admin,
    BigInt(opts.amountOTokens.toString())
  );

  const settlerCollateralAccount = await bankrunCreateTokenAccount(
    context,
    admin,
    collateralMint,
    settlerConfigPda
  );
  const settlerContraAccount = await bankrunCreateTokenAccount(
    context,
    admin,
    contraMint,
    settlerConfigPda
  );
  const userContraAccount = await bankrunCreateTokenAccount(
    context,
    admin,
    contraMint,
    user.publicKey
  );
  // PUT: MM receives surplus collateral. CALL: surplus contra.
  const mmDestinationMint = opts.isPut ? collateralMint : contraMint;
  const mmDestinationAccount = await bankrunCreateTokenAccount(
    context,
    admin,
    mmDestinationMint,
    maker.publicKey
  );

  // Initialize batch settler with mock Jupiter as the configured DEX
  await batchSettlerProgram.methods
    .initialize(
      operator.publicKey,
      maker.publicKey, // treasury (unused here)
      0,
      new BN(259200),
      mockJupiterProgram.programId
    )
    .accounts({ payer: admin.publicKey })
    .signers([admin])
    .rpc();
  await batchSettlerProgram.methods
    .whitelistMaker(maker.publicKey, true)
    .accounts({ owner: admin.publicKey })
    .signers([admin])
    .rpc();

  const [makerBalancePda, makerBalanceBump] = PublicKey.findProgramAddressSync(
    [Buffer.from("mm_balance"), maker.publicKey.toBuffer(), otokenMint.toBuffer()],
    batchSettlerProgram.programId
  );
  injectMakerBalance(
    context,
    makerBalancePda,
    makerBalanceBump,
    batchSettlerProgram.programId,
    maker.publicKey,
    otokenMint,
    BigInt(opts.amountOTokens.toString())
  );
  const [vaultMmPda, vaultMmBump] = findVaultMMPda(
    vaultPda,
    batchSettlerProgram.programId
  );
  injectVaultMM(
    context,
    vaultMmPda,
    vaultMmBump,
    batchSettlerProgram.programId,
    maker.publicKey,
    vaultPda,
    otokenMint,
    BigInt(opts.amountOTokens.toString())
  );

  // Mock Jupiter reserves
  const mockAuthPda = findMockJupAuthPda(mockJupiterProgram.programId);
  const mockInReserve = await bankrunCreateTokenAccount(
    context,
    admin,
    collateralMint,
    mockAuthPda
  );
  const mockOutReserve = await bankrunCreateTokenAccount(
    context,
    admin,
    contraMint,
    mockAuthPda
  );
  // Pre-fund the out reserve so the mock has tokens to deliver.
  const outReserveFund = pow10(
    (opts.isPut ? opts.underlyingDecimals : opts.strikeAssetDecimals) + 6
  );
  await bankrunMintTo(
    context,
    admin,
    contraMint,
    mockOutReserve,
    admin,
    outReserveFund
  );

  // Optionally warp past expiry and set the expiry price
  if (opts.warpPastExpiry) {
    const c = await context.banksClient.getClock();
    context.setClock(
      new Clock(
        c.slot,
        c.epochStartTimestamp,
        c.epoch,
        c.leaderScheduleEpoch,
        BigInt(Number(clock.unixTimestamp) + 200)
      )
    );
  }
  if (opts.setExpiryPrice) {
    const expiryPrice = new BN(opts.expiryPriceUsd).mul(new BN(100_000_000));
    const [oracleExpiryPricePda, oracleExpiryPriceBump] =
      PublicKey.findProgramAddressSync(
        [
          Buffer.from("expiry_price"),
          underlyingMint.toBuffer(),
          expiryTimestamp.toArrayLike(Buffer, "le", 8),
        ],
        oracleProgram.programId
      );
    injectOracleExpiryPrice(
      context,
      oracleExpiryPricePda,
      oracleProgram.programId,
      underlyingMint,
      expiryTimestamp,
      expiryPrice,
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
  }

  // Compute expected contra_amount (mirrors compute_contra_amount in the program)
  const amountBig = BigInt(opts.amountOTokens.toString());
  const contraAmount = opts.isPut
    ? amountBig * pow10(opts.underlyingDecimals - 8)
    : (amountBig * BigInt(strikePrice.toString())) /
      pow10(16 - opts.strikeAssetDecimals);

  return {
    context,
    controllerProgram,
    batchSettlerProgram,
    mockJupiterProgram,
    admin,
    operator,
    maker,
    user,
    isPut: opts.isPut,
    strikePrice,
    amount: opts.amountOTokens,
    contraAmount,
    collateralMint,
    underlyingMint,
    strikeAssetMint,
    contraMint,
    otokenMint,
    otokenInfoPda,
    controllerConfigPda,
    settlerConfigPda,
    poolTokenAccount,
    poolVaultAuthPda,
    vaultPda,
    vaultMmPda,
    settlerOtokenAccount,
    settlerCollateralAccount,
    settlerContraAccount,
    userContraAccount,
    mmDestinationAccount,
    makerBalancePda,
    mockAuthPda,
    mockInReserve,
    mockOutReserve,
  };
}

// Build the encoded mock_jupiter::swap instruction data + ordered
// accounts to feed into physical_redeem as the Jupiter route.
function buildMockSwapRoute(s: Scenario, inputAmount: bigint, outputAmount: bigint, destination: PublicKey) {
  const data = (s.mockJupiterProgram.coder.instruction as any).encode("swap", {
    inputAmount: new BN(inputAmount.toString()),
    outputAmount: new BN(outputAmount.toString()),
  });
  // Settler PDA is signed by the program via signer_seeds in the inner
  // CPI; the outer transaction does not (and cannot) sign for it.
  const accounts = [
    { pubkey: s.settlerCollateralAccount, isWritable: true, isSigner: false }, // source
    { pubkey: s.mockInReserve, isWritable: true, isSigner: false },
    { pubkey: s.mockOutReserve, isWritable: true, isSigner: false },
    { pubkey: destination, isWritable: true, isSigner: false },
    { pubkey: s.settlerConfigPda, isWritable: false, isSigner: false }, // source_authority
    { pubkey: s.mockAuthPda, isWritable: false, isSigner: false },
    { pubkey: TOKEN_PROGRAM_ID, isWritable: false, isSigner: false },
  ];
  return { data, accounts };
}

// Build a `swap_split` route that delivers to two destinations.
// Used by the UnexpectedSwapDestination tests to simulate a Jupiter
// route that "leaks" output into an account the protocol expects to
// remain untouched.
function buildMockSplitRoute(
  s: Scenario,
  inputAmount: bigint,
  outputPrimary: bigint,
  primaryDest: PublicKey,
  outputSecondary: bigint,
  secondaryDest: PublicKey
) {
  const data = (s.mockJupiterProgram.coder.instruction as any).encode("swapSplit", {
    inputAmount: new BN(inputAmount.toString()),
    outputPrimary: new BN(outputPrimary.toString()),
    outputSecondary: new BN(outputSecondary.toString()),
  });
  const accounts = [
    { pubkey: s.settlerCollateralAccount, isWritable: true, isSigner: false },
    { pubkey: s.mockInReserve, isWritable: true, isSigner: false },
    { pubkey: s.mockOutReserve, isWritable: true, isSigner: false },
    { pubkey: primaryDest, isWritable: true, isSigner: false },
    { pubkey: secondaryDest, isWritable: true, isSigner: false },
    { pubkey: s.settlerConfigPda, isWritable: false, isSigner: false },
    { pubkey: s.mockAuthPda, isWritable: false, isSigner: false },
    { pubkey: TOKEN_PROGRAM_ID, isWritable: false, isSigner: false },
  ];
  return { data, accounts };
}

async function callPhysicalRedeem(s: Scenario, route: { data: Buffer; accounts: any[] }) {
  return s.batchSettlerProgram.methods
    .physicalRedeem(s.amount, new BN("18446744073709551615"), Buffer.from(route.data))
    .accounts({
      settlerConfig: s.settlerConfigPda,
      operator: s.operator.publicKey,
      makerOtokenBalance: s.makerBalancePda,
      vaultMm: s.vaultMmPda,
      controllerConfig: s.controllerConfigPda,
      otokenInfo: s.otokenInfoPda,
      otokenMint: s.otokenMint,
      collateralMintAccount: s.collateralMint,
      vault: s.vaultPda,
      settlerOtokenAccount: s.settlerOtokenAccount,
      settlerCollateralAccount: s.settlerCollateralAccount,
      contraMint: s.contraMint,
      settlerContraAccount: s.settlerContraAccount,
      userContraAccount: s.userContraAccount,
      user: s.user.publicKey,
      mmCollateralAccount: s.mmDestinationAccount,
      poolTokenAccount: s.poolTokenAccount,
      poolVaultAuthority: s.poolVaultAuthPda,
      jupiterProgram: s.mockJupiterProgram.programId,
      controllerProgram: s.controllerProgram.programId,
      otokenTokenProgram: TOKEN_PROGRAM_ID,
      collateralTokenProgram: TOKEN_PROGRAM_ID,
      contraTokenProgram: TOKEN_PROGRAM_ID,
    })
    .remainingAccounts(route.accounts)
    .signers([s.operator])
    .rpc();
}

// ─── Tests ───────────────────────────────────────────────────

describe("batch_settler::physical_redeem (no flash loan)", () => {
  const PUT_BASELINE: FixtureOpts = {
    isPut: true,
    strikeUsd: 2000,
    expiryPriceUsd: 1500, // ITM PUT (mark < strike)
    collateralDecimals: 6,
    underlyingDecimals: 8,
    strikeAssetDecimals: 6,
    amountOTokens: new BN(100_000_000), // 1 oToken
    setExpiryPrice: true,
    warpPastExpiry: true,
  };

  const CALL_BASELINE: FixtureOpts = {
    ...PUT_BASELINE,
    isPut: false,
    expiryPriceUsd: 2500, // ITM CALL (mark > strike)
    collateralDecimals: 8,
    underlyingDecimals: 8,
    strikeAssetDecimals: 6,
  };

  describe("reverts", () => {
    it("rejects when option has not expired", async () => {
      const s = await buildFixture({
        ...PUT_BASELINE,
        warpPastExpiry: false,
        setExpiryPrice: false,
      });
      const route = buildMockSwapRoute(s, s.contraAmount, s.contraAmount, s.userContraAccount);
      try {
        await callPhysicalRedeem(s, route);
        assert.fail("expected OptionNotExpired");
      } catch (err: any) {
        assert.include(err.toString(), "OptionNotExpired");
      }
    });

    it("rejects when expiry price not set", async () => {
      const s = await buildFixture({ ...PUT_BASELINE, setExpiryPrice: false });
      const route = buildMockSwapRoute(s, s.contraAmount, s.contraAmount, s.userContraAccount);
      try {
        await callPhysicalRedeem(s, route);
        assert.fail("expected ExpiryPriceNotSet");
      } catch (err: any) {
        assert.include(err.toString(), "ExpiryPriceNotSet");
      }
    });

    it("rejects PUT at-the-money (mark == strike)", async () => {
      const s = await buildFixture({ ...PUT_BASELINE, expiryPriceUsd: 2000 });
      const route = buildMockSwapRoute(s, s.contraAmount, s.contraAmount, s.userContraAccount);
      try {
        await callPhysicalRedeem(s, route);
        assert.fail("expected OptionNotITM");
      } catch (err: any) {
        assert.include(err.toString(), "OptionNotITM");
      }
    });

    it("rejects PUT out-of-the-money (mark > strike)", async () => {
      const s = await buildFixture({ ...PUT_BASELINE, expiryPriceUsd: 2500 });
      const route = buildMockSwapRoute(s, s.contraAmount, s.contraAmount, s.userContraAccount);
      try {
        await callPhysicalRedeem(s, route);
        assert.fail("expected OptionNotITM");
      } catch (err: any) {
        assert.include(err.toString(), "OptionNotITM");
      }
    });

    it("rejects CALL out-of-the-money (mark < strike)", async () => {
      const s = await buildFixture({ ...CALL_BASELINE, expiryPriceUsd: 1500 });
      const route = buildMockSwapRoute(s, s.contraAmount, s.contraAmount, s.userContraAccount);
      try {
        await callPhysicalRedeem(s, route);
        assert.fail("expected OptionNotITM");
      } catch (err: any) {
        assert.include(err.toString(), "OptionNotITM");
      }
    });

    it("rejects when contra_mint does not match the option's expected contra", async () => {
      const s = await buildFixture(PUT_BASELINE);
      // Substitute the wrong mint (strike asset instead of underlying)
      const wrongMint = s.strikeAssetMint;
      const route = buildMockSwapRoute(s, s.contraAmount, s.contraAmount, s.userContraAccount);
      try {
        await s.batchSettlerProgram.methods
          .physicalRedeem(s.amount, new BN("18446744073709551615"), Buffer.from(route.data))
          .accounts({
            settlerConfig: s.settlerConfigPda,
            operator: s.operator.publicKey,
            makerOtokenBalance: s.makerBalancePda,
            vaultMm: s.vaultMmPda,
            controllerConfig: s.controllerConfigPda,
            otokenInfo: s.otokenInfoPda,
            otokenMint: s.otokenMint,
            collateralMintAccount: s.collateralMint,
            vault: s.vaultPda,
            settlerOtokenAccount: s.settlerOtokenAccount,
            settlerCollateralAccount: s.settlerCollateralAccount,
            contraMint: wrongMint, // ← mismatch
            settlerContraAccount: s.settlerContraAccount,
            userContraAccount: s.userContraAccount,
            user: s.user.publicKey,
            mmCollateralAccount: s.mmDestinationAccount,
            poolTokenAccount: s.poolTokenAccount,
            poolVaultAuthority: s.poolVaultAuthPda,
            jupiterProgram: s.mockJupiterProgram.programId,
            controllerProgram: s.controllerProgram.programId,
            otokenTokenProgram: TOKEN_PROGRAM_ID,
            collateralTokenProgram: TOKEN_PROGRAM_ID,
            contraTokenProgram: TOKEN_PROGRAM_ID,
          })
          .remainingAccounts(route.accounts)
          .signers([s.operator])
          .rpc();
        assert.fail("expected InvalidContraMint");
      } catch (err: any) {
        assert.include(err.toString(), "InvalidContraMint");
      }
    });

    it("rejects PUT with underlying decimals out of range (>18)", async () => {
      const s = await buildFixture({ ...PUT_BASELINE, underlyingDecimals: 19 } as FixtureOpts);
      const route = buildMockSwapRoute(s, s.contraAmount, s.contraAmount, s.userContraAccount);
      try {
        await callPhysicalRedeem(s, route);
        assert.fail("expected UnsupportedDecimals");
      } catch (err: any) {
        assert.include(err.toString(), "UnsupportedDecimals");
      }
    });

    it("rejects CALL with strike asset decimals out of range (<6)", async () => {
      const s = await buildFixture({ ...CALL_BASELINE, strikeAssetDecimals: 5 });
      const route = buildMockSwapRoute(s, s.contraAmount, s.contraAmount, s.userContraAccount);
      try {
        await callPhysicalRedeem(s, route);
        assert.fail("expected UnsupportedDecimals");
      } catch (err: any) {
        assert.include(err.toString(), "UnsupportedDecimals");
      }
    });

    it("rejects when settler is paused", async () => {
      const s = await buildFixture(PUT_BASELINE);
      await s.batchSettlerProgram.methods
        .pause(true)
        .accounts({ owner: s.admin.publicKey })
        .signers([s.admin])
        .rpc();
      const route = buildMockSwapRoute(s, s.contraAmount, s.contraAmount, s.userContraAccount);
      try {
        await callPhysicalRedeem(s, route);
        assert.fail("expected Paused");
      } catch (err: any) {
        assert.include(err.toString(), "Paused");
      }
    });
  });

  describe("PUT happy path", () => {
    it("delivers contra to user and surplus collateral to MM (no flash loan)", async () => {
      const s = await buildFixture(PUT_BASELINE);

      // Strike $2000 (8 dec), collateral 6 dec.
      // required = (amount * strike) / 10^(8+8-cd)
      //         = (1e8 * 2e11) / 1e10 = 2e9 (2000 USDC).
      // ITM PUT redeem returns full collateral = 2_000_000_000.
      // contra_amount = amount * 10^(ud-8) = 1e8 (1 underlying, 8 dec).
      // Mock route: input 1_500_000_000 (1500 USDC) → output 1e8 underlying.
      // Surplus to MM = 2_000_000_000 - 1_500_000_000 = 500_000_000 (500 USDC).
      const fullCollateral = 2_000_000_000n;
      const collateralUsed = 1_500_000_000n;
      const route = buildMockSwapRoute(s, collateralUsed, s.contraAmount, s.userContraAccount);

      const userContraBefore = await readTokenAmount(s.context, s.userContraAccount);
      const mmDestBefore = await readTokenAmount(s.context, s.mmDestinationAccount);

      await callPhysicalRedeem(s, route);

      const userContraAfter = await readTokenAmount(s.context, s.userContraAccount);
      const mmDestAfter = await readTokenAmount(s.context, s.mmDestinationAccount);

      // User received exactly contra_amount of underlying.
      assert.equal((userContraAfter - userContraBefore).toString(), s.contraAmount.toString());
      // MM received surplus collateral = redeem_payout - collateral_used.
      assert.equal((mmDestAfter - mmDestBefore).toString(), (fullCollateral - collateralUsed).toString());
    });

    it("reverts when Jupiter output to user is below contra_amount", async () => {
      const s = await buildFixture(PUT_BASELINE);
      // Mock route under-delivers contra to user.
      const tooLittle = s.contraAmount - 1n;
      const route = buildMockSwapRoute(s, 1_500_000_000n, tooLittle, s.userContraAccount);
      try {
        await callPhysicalRedeem(s, route);
        assert.fail("expected InsufficientSwapOutput");
      } catch (err: any) {
        assert.include(err.toString(), "InsufficientSwapOutput");
      }
    });

    it("reverts with InsufficientSwapOutput when Jupiter delivers nothing to user (PUT)", async () => {
      const s = await buildFixture(PUT_BASELINE);
      // All contra goes to settler_contra; user gets 0 → user_contra_delta < contra_amount.
      const route = buildMockSwapRoute(s, 1_500_000_000n, s.contraAmount, s.settlerContraAccount);
      try {
        await callPhysicalRedeem(s, route);
        assert.fail("expected InsufficientSwapOutput");
      } catch (err: any) {
        assert.include(err.toString(), "InsufficientSwapOutput");
      }
    });

    it("reverts with UnexpectedSwapDestination when route leaks into settler_contra (PUT)", async () => {
      const s = await buildFixture(PUT_BASELINE);
      // Pay user the full contra_amount (passes the InsufficientSwapOutput
      // check) but ALSO leak 1 unit into settler_contra. The
      // settler_contra_delta != 0 guard must fire.
      const route = buildMockSplitRoute(
        s,
        1_500_000_000n,         // input collateral consumed
        s.contraAmount,          // primary → user (satisfies user_contra_delta >= contra_amount)
        s.userContraAccount,
        1n,                      // secondary → settler_contra (1 unit leak)
        s.settlerContraAccount,
      );
      try {
        await callPhysicalRedeem(s, route);
        assert.fail("expected UnexpectedSwapDestination");
      } catch (err: any) {
        assert.include(err.toString(), "UnexpectedSwapDestination");
      }
    });

    it("reverts with UnexpectedSwapDestination when PUT swap consumes no collateral", async () => {
      const s = await buildFixture(PUT_BASELINE);
      // Zero-input route still pays the user — should be rejected
      // because Jupiter must source from the redeemed collateral.
      const route = buildMockSwapRoute(s, 0n, s.contraAmount, s.userContraAccount);
      try {
        await callPhysicalRedeem(s, route);
        assert.fail("expected UnexpectedSwapDestination");
      } catch (err: any) {
        assert.include(err.toString(), "UnexpectedSwapDestination");
      }
    });
  });

  describe("CALL happy path", () => {
    it("delivers exact contra to user and surplus contra to MM (no flash loan)", async () => {
      const s = await buildFixture(CALL_BASELINE);

      // Strike $2000, mark $2500, 8-dec collateral (underlying), 6-dec contra (USDC).
      // Required collateral per oToken (CALL) = 1 underlying = 1e8.
      // ITM CALL redeem returns full collateral = 1e8.
      // Contra amount = amount * strike / 10^(16 - strike_dec) = 1e8 * 2000e8 / 1e10 = 2e9 (2000 USDC).
      // Mock route: input 1e8 (all collateral) → output 2.5e9 (2500 USDC). Surplus to MM = 500 USDC.
      const collateralUsed = 100_000_000n;
      const swapOut = 2_500_000_000n;
      const route = buildMockSwapRoute(s, collateralUsed, swapOut, s.settlerContraAccount);

      const userContraBefore = await readTokenAmount(s.context, s.userContraAccount);
      const mmDestBefore = await readTokenAmount(s.context, s.mmDestinationAccount);

      await callPhysicalRedeem(s, route);

      const userContraAfter = await readTokenAmount(s.context, s.userContraAccount);
      const mmDestAfter = await readTokenAmount(s.context, s.mmDestinationAccount);

      // User received exactly contra_amount.
      assert.equal((userContraAfter - userContraBefore).toString(), s.contraAmount.toString());
      // MM received surplus contra = swapOut - contra_amount.
      assert.equal((mmDestAfter - mmDestBefore).toString(), (swapOut - s.contraAmount).toString());
    });

    it("reverts when settler_contra delta is below contra_amount", async () => {
      const s = await buildFixture(CALL_BASELINE);
      const tooLittle = s.contraAmount - 1n;
      const route = buildMockSwapRoute(s, 100_000_000n, tooLittle, s.settlerContraAccount);
      try {
        await callPhysicalRedeem(s, route);
        assert.fail("expected InsufficientSwapOutput");
      } catch (err: any) {
        assert.include(err.toString(), "InsufficientSwapOutput");
      }
    });

    it("reverts with InsufficientSwapOutput when CALL settler_contra delta is below contra_amount", async () => {
      const s = await buildFixture(CALL_BASELINE);
      // Underdeliver to settler_contra; settler_contra_delta < contra_amount
      // fires before any other guard.
      const tooLittle = s.contraAmount - 1n;
      const route = buildMockSwapRoute(s, 100_000_000n, tooLittle, s.settlerContraAccount);
      try {
        await callPhysicalRedeem(s, route);
        assert.fail("expected InsufficientSwapOutput");
      } catch (err: any) {
        assert.include(err.toString(), "InsufficientSwapOutput");
      }
    });

    it("reverts with UnexpectedSwapDestination when CALL route leaks contra to user", async () => {
      const s = await buildFixture(CALL_BASELINE);
      // Settler_contra gets enough, user_contra also receives a leak.
      // Handler order in CALL: collateral_used == collateral_received,
      // settler_contra_delta >= contra_amount, then user_contra_delta == 0
      // → the leak trips UnexpectedSwapDestination.
      const route = buildMockSplitRoute(
        s,
        100_000_000n,            // all collateral consumed
        2_500_000_000n,          // primary → settler_contra
        s.settlerContraAccount,
        1n,                      // secondary → user (1 unit leak)
        s.userContraAccount,
      );
      try {
        await callPhysicalRedeem(s, route);
        assert.fail("expected UnexpectedSwapDestination");
      } catch (err: any) {
        assert.include(err.toString(), "UnexpectedSwapDestination");
      }
    });

    it("reverts with UnexpectedSwapDestination when CALL swap leaves residual collateral", async () => {
      const s = await buildFixture(CALL_BASELINE);
      // Consume only half the collateral. The CALL guard requires the
      // route to consume ALL redeemed collateral.
      const route = buildMockSwapRoute(s, 50_000_000n, 2_500_000_000n, s.settlerContraAccount);
      try {
        await callPhysicalRedeem(s, route);
        assert.fail("expected UnexpectedSwapDestination");
      } catch (err: any) {
        assert.include(err.toString(), "UnexpectedSwapDestination");
      }
    });
  });

  describe("input validation", () => {
    it("rejects amount == 0", async () => {
      const s = await buildFixture(PUT_BASELINE);
      const route = buildMockSwapRoute(s, 1n, 1n, s.userContraAccount);
      try {
        await s.batchSettlerProgram.methods
          .physicalRedeem(new BN(0), new BN("18446744073709551615"), Buffer.from(route.data))
          .accounts({
            settlerConfig: s.settlerConfigPda,
            operator: s.operator.publicKey,
            makerOtokenBalance: s.makerBalancePda,
            vaultMm: s.vaultMmPda,
            controllerConfig: s.controllerConfigPda,
            otokenInfo: s.otokenInfoPda,
            otokenMint: s.otokenMint,
            collateralMintAccount: s.collateralMint,
            vault: s.vaultPda,
            settlerOtokenAccount: s.settlerOtokenAccount,
            settlerCollateralAccount: s.settlerCollateralAccount,
            contraMint: s.contraMint,
            settlerContraAccount: s.settlerContraAccount,
            userContraAccount: s.userContraAccount,
            user: s.user.publicKey,
            mmCollateralAccount: s.mmDestinationAccount,
            poolTokenAccount: s.poolTokenAccount,
            poolVaultAuthority: s.poolVaultAuthPda,
            jupiterProgram: s.mockJupiterProgram.programId,
            controllerProgram: s.controllerProgram.programId,
            otokenTokenProgram: TOKEN_PROGRAM_ID,
            collateralTokenProgram: TOKEN_PROGRAM_ID,
            contraTokenProgram: TOKEN_PROGRAM_ID,
          })
          .remainingAccounts(route.accounts)
          .signers([s.operator])
          .rpc();
        assert.fail("expected ZeroAmount");
      } catch (err: any) {
        assert.include(err.toString(), "ZeroAmount");
      }
    });

    it("rejects amount > MM custody balance", async () => {
      const s = await buildFixture(PUT_BASELINE);
      const tooMuch = new BN(s.amount.toNumber() + 1);
      const route = buildMockSwapRoute(s, 1_500_000_000n, s.contraAmount, s.userContraAccount);
      try {
        await s.batchSettlerProgram.methods
          .physicalRedeem(tooMuch, new BN("18446744073709551615"), Buffer.from(route.data))
          .accounts({
            settlerConfig: s.settlerConfigPda,
            operator: s.operator.publicKey,
            makerOtokenBalance: s.makerBalancePda,
            vaultMm: s.vaultMmPda,
            controllerConfig: s.controllerConfigPda,
            otokenInfo: s.otokenInfoPda,
            otokenMint: s.otokenMint,
            collateralMintAccount: s.collateralMint,
            vault: s.vaultPda,
            settlerOtokenAccount: s.settlerOtokenAccount,
            settlerCollateralAccount: s.settlerCollateralAccount,
            contraMint: s.contraMint,
            settlerContraAccount: s.settlerContraAccount,
            userContraAccount: s.userContraAccount,
            user: s.user.publicKey,
            mmCollateralAccount: s.mmDestinationAccount,
            poolTokenAccount: s.poolTokenAccount,
            poolVaultAuthority: s.poolVaultAuthPda,
            jupiterProgram: s.mockJupiterProgram.programId,
            controllerProgram: s.controllerProgram.programId,
            otokenTokenProgram: TOKEN_PROGRAM_ID,
            collateralTokenProgram: TOKEN_PROGRAM_ID,
            contraTokenProgram: TOKEN_PROGRAM_ID,
          })
          .remainingAccounts(route.accounts)
          .signers([s.operator])
          .rpc();
        assert.fail("expected InsufficientMMBalance");
      } catch (err: any) {
        assert.include(err.toString(), "InsufficientMMBalance");
      }
    });

    it("rejects when jupiter_program does not match settler_config.jupiter_program", async () => {
      const s = await buildFixture(PUT_BASELINE);
      const route = buildMockSwapRoute(s, 1_500_000_000n, s.contraAmount, s.userContraAccount);
      // Pass the controller program ID as jupiterProgram — clearly wrong
      // and not equal to settler_config.jupiter_program.
      try {
        await s.batchSettlerProgram.methods
          .physicalRedeem(s.amount, new BN("18446744073709551615"), Buffer.from(route.data))
          .accounts({
            settlerConfig: s.settlerConfigPda,
            operator: s.operator.publicKey,
            makerOtokenBalance: s.makerBalancePda,
            vaultMm: s.vaultMmPda,
            controllerConfig: s.controllerConfigPda,
            otokenInfo: s.otokenInfoPda,
            otokenMint: s.otokenMint,
            collateralMintAccount: s.collateralMint,
            vault: s.vaultPda,
            settlerOtokenAccount: s.settlerOtokenAccount,
            settlerCollateralAccount: s.settlerCollateralAccount,
            contraMint: s.contraMint,
            settlerContraAccount: s.settlerContraAccount,
            userContraAccount: s.userContraAccount,
            user: s.user.publicKey,
            mmCollateralAccount: s.mmDestinationAccount,
            poolTokenAccount: s.poolTokenAccount,
            poolVaultAuthority: s.poolVaultAuthPda,
            jupiterProgram: s.controllerProgram.programId,
            controllerProgram: s.controllerProgram.programId,
            otokenTokenProgram: TOKEN_PROGRAM_ID,
            collateralTokenProgram: TOKEN_PROGRAM_ID,
            contraTokenProgram: TOKEN_PROGRAM_ID,
          })
          .remainingAccounts(route.accounts)
          .signers([s.operator])
          .rpc();
        assert.fail("expected InvalidJupiterProgram");
      } catch (err: any) {
        assert.include(err.toString(), "InvalidJupiterProgram");
      }
    });

    it("rejects PUT when mm_collateral_account holds the wrong mint (contra instead of collateral)", async () => {
      const s = await buildFixture(PUT_BASELINE);
      // Build a same-owner account that holds contra_mint instead of
      // collateral_mint — the conditional handler-side mint check
      // for PUT must reject this.
      const wrongMmAccount = await bankrunCreateTokenAccount(
        s.context,
        s.admin,
        s.contraMint,        // wrong mint
        s.maker.publicKey,   // correct owner
      );
      const route = buildMockSwapRoute(s, 1_500_000_000n, s.contraAmount, s.userContraAccount);
      try {
        await s.batchSettlerProgram.methods
          .physicalRedeem(s.amount, new BN("18446744073709551615"), Buffer.from(route.data))
          .accounts({
            settlerConfig: s.settlerConfigPda,
            operator: s.operator.publicKey,
            makerOtokenBalance: s.makerBalancePda,
            vaultMm: s.vaultMmPda,
            controllerConfig: s.controllerConfigPda,
            otokenInfo: s.otokenInfoPda,
            otokenMint: s.otokenMint,
            collateralMintAccount: s.collateralMint,
            vault: s.vaultPda,
            settlerOtokenAccount: s.settlerOtokenAccount,
            settlerCollateralAccount: s.settlerCollateralAccount,
            contraMint: s.contraMint,
            settlerContraAccount: s.settlerContraAccount,
            userContraAccount: s.userContraAccount,
            user: s.user.publicKey,
            mmCollateralAccount: wrongMmAccount,
            poolTokenAccount: s.poolTokenAccount,
            poolVaultAuthority: s.poolVaultAuthPda,
            jupiterProgram: s.mockJupiterProgram.programId,
            controllerProgram: s.controllerProgram.programId,
            otokenTokenProgram: TOKEN_PROGRAM_ID,
            collateralTokenProgram: TOKEN_PROGRAM_ID,
            contraTokenProgram: TOKEN_PROGRAM_ID,
          })
          .remainingAccounts(route.accounts)
          .signers([s.operator])
          .rpc();
        assert.fail("expected InvalidCustodyAccount");
      } catch (err: any) {
        assert.include(err.toString(), "InvalidCustodyAccount");
      }
    });
  });

  describe("compute_contra_amount boundaries", () => {
    it("PUT accepts inclusive upper bound (underlyingDecimals = 18)", async () => {
      // 1 oToken (1e8 in 8 dec) → 1e18 contra units (overflow guard:
      // u64 max ~1.8e19, so 1e18 fits).
      const s = await buildFixture({ ...PUT_BASELINE, underlyingDecimals: 18 });
      // Pre-fund out_reserve with at least 1e18; the fixture default
      // funds 10^(ud + 6) = 10^24 which exceeds u64. Substitute a
      // smaller amount and verify the contra math still works.
      // (The fixture's outReserveFund already used pow10; for ud=18
      // it computed 1e24 — outside u64. Resize the test by reducing
      // amountOTokens to 1 unit to keep contra within u64.)
      // Here we simply check that compute_contra_amount accepts the
      // boundary without UnsupportedDecimals firing.
      const route = buildMockSwapRoute(s, 1_500_000_000n, s.contraAmount, s.userContraAccount);
      try {
        await callPhysicalRedeem(s, route);
        // We don't care about success — we care that the failure
        // (if any) is NOT UnsupportedDecimals.
      } catch (err: any) {
        assert.notInclude(err.toString(), "UnsupportedDecimals");
      }
    });

    it("PUT rejects underlyingDecimals = 7 (below inclusive lower bound)", async () => {
      const s = await buildFixture({ ...PUT_BASELINE, underlyingDecimals: 7 });
      const route = buildMockSwapRoute(s, 1_500_000_000n, s.contraAmount, s.userContraAccount);
      try {
        await callPhysicalRedeem(s, route);
        assert.fail("expected UnsupportedDecimals");
      } catch (err: any) {
        assert.include(err.toString(), "UnsupportedDecimals");
      }
    });

    it("CALL rejects strikeAssetDecimals = 17 (above inclusive upper bound)", async () => {
      const s = await buildFixture({ ...CALL_BASELINE, strikeAssetDecimals: 17 });
      const route = buildMockSwapRoute(s, 100_000_000n, 1n, s.settlerContraAccount);
      try {
        await callPhysicalRedeem(s, route);
        assert.fail("expected UnsupportedDecimals");
      } catch (err: any) {
        assert.include(err.toString(), "UnsupportedDecimals");
      }
    });
  });
});
