import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  LAMPORTS_PER_SOL,
  Ed25519Program,
  Transaction,
  TransactionMessage,
  VersionedTransaction,
  SYSVAR_INSTRUCTIONS_PUBKEY,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createMint,
  createAccount,
  mintTo,
  getAccount,
  getMint,
  approve,
} from "@solana/spl-token";
import { assert } from "chai";
import { AddressBook } from "../target/types/address_book";
import { MarginPool } from "../target/types/margin_pool";
import { Controller } from "../target/types/controller";
import { OtokenFactory } from "../target/types/otoken_factory";
import { BatchSettler } from "../target/types/batch_settler";
import { Whitelist } from "../target/types/whitelist";

const ZERO_PUBKEY = PublicKey.default;

function findRegistryPda(programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("registry")],
    programId
  );
}

function findMarginPoolConfigPda(
  programId: PublicKey
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("margin_pool_config")],
    programId
  );
}

function findPoolVaultPda(
  mint: PublicKey,
  programId: PublicKey
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("pool_vault"), mint.toBuffer()],
    programId
  );
}

function findPoolVaultAuthPda(
  mint: PublicKey,
  programId: PublicKey
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("pool_vault_auth"), mint.toBuffer()],
    programId
  );
}

function findControllerConfigPda(
  programId: PublicKey
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("controller_config")],
    programId
  );
}

function findVaultCounterPda(
  owner: PublicKey,
  programId: PublicKey
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("vault_counter"), owner.toBuffer()],
    programId
  );
}

function findOTokenInfoPda(
  otokenMint: PublicKey,
  programId: PublicKey
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("otoken_info"), otokenMint.toBuffer()],
    programId
  );
}

function findVaultPda(
  owner: PublicKey,
  vaultId: BN,
  programId: PublicKey
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from("vault"),
      owner.toBuffer(),
      vaultId.toArrayLike(Buffer, "le", 8),
    ],
    programId
  );
}

function findFactoryConfigPda(
  programId: PublicKey
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("factory_config")],
    programId
  );
}

function findOTokenPda(
  underlying: PublicKey,
  strikeAsset: PublicKey,
  collateral: PublicKey,
  strikePrice: BN,
  expiry: BN,
  isPut: boolean,
  programId: PublicKey
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from("otoken"),
      underlying.toBuffer(),
      strikeAsset.toBuffer(),
      collateral.toBuffer(),
      strikePrice.toArrayLike(Buffer, "le", 8),
      expiry.toArrayLike(Buffer, "le", 8),
      Buffer.from([isPut ? 1 : 0]),
    ],
    programId
  );
}

function findOTokenMintPda(
  underlying: PublicKey,
  strikeAsset: PublicKey,
  collateral: PublicKey,
  strikePrice: BN,
  expiry: BN,
  isPut: boolean,
  programId: PublicKey
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from("otoken_mint"),
      underlying.toBuffer(),
      strikeAsset.toBuffer(),
      collateral.toBuffer(),
      strikePrice.toArrayLike(Buffer, "le", 8),
      expiry.toArrayLike(Buffer, "le", 8),
      Buffer.from([isPut ? 1 : 0]),
    ],
    programId
  );
}

function findSettlerConfigPda(
  programId: PublicKey
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("settler_config")],
    programId
  );
}

function findMakerStatePda(
  maker: PublicKey,
  programId: PublicKey
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("maker"), maker.toBuffer()],
    programId
  );
}

function findQuoteFillPda(
  maker: PublicKey,
  quoteId: BN,
  programId: PublicKey
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from("quote_fill"),
      maker.toBuffer(),
      quoteId.toArrayLike(Buffer, "le", 8),
    ],
    programId
  );
}

function findWhitelistConfigPda(
  programId: PublicKey
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("whitelist_config")],
    programId
  );
}

function findWhitelistedOTokenPda(
  otokenMint: PublicKey,
  programId: PublicKey
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("whitelisted_otoken"), otokenMint.toBuffer()],
    programId
  );
}

function findVaultMMPda(
  vault: PublicKey,
  programId: PublicKey
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("vault_mm"), vault.toBuffer()],
    programId
  );
}

function findMakerOTokenBalancePda(
  maker: PublicKey,
  otokenMint: PublicKey,
  programId: PublicKey
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from("mm_balance"),
      maker.toBuffer(),
      otokenMint.toBuffer(),
    ],
    programId
  );
}

async function fundAccount(
  provider: anchor.AnchorProvider,
  pubkey: PublicKey,
  lamports: number
) {
  const tx = new anchor.web3.Transaction().add(
    SystemProgram.transfer({
      fromPubkey: provider.wallet.publicKey,
      toPubkey: pubkey,
      lamports,
    })
  );
  await provider.sendAndConfirm(tx);
}

/** Far future expiry for minting tests (year ~2286). */
const FAR_FUTURE_EXPIRY = new BN("9999999999");

describe("b1nary-options", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const addressBookProgram = anchor.workspace
    .addressBook as Program<AddressBook>;
  const marginPoolProgram = anchor.workspace
    .marginPool as Program<MarginPool>;
  const controllerProgram = anchor.workspace
    .controller as Program<Controller>;
  const otokenFactoryProgram = anchor.workspace
    .otokenFactory as Program<OtokenFactory>;
  const batchSettlerProgram = anchor.workspace
    .batchSettler as Program<BatchSettler>;
  const whitelistProgram = anchor.workspace
    .whitelist as Program<Whitelist>;

  const admin = provider.wallet as anchor.Wallet;
  const connection = provider.connection;

  // ───────────────────────────────────────────
  // AddressBook tests
  // ───────────────────────────────────────────
  describe("address_book", () => {
    const [registryPda] = findRegistryPda(
      addressBookProgram.programId
    );

    it("initializes registry with admin", async () => {
      await addressBookProgram.methods
        .initialize(admin.publicKey)
        .accounts({
          payer: admin.publicKey,
        })
        .rpc();

      const registry =
        await addressBookProgram.account.registry.fetch(
          registryPda
        );
      assert.ok(
        registry.admin.equals(admin.publicKey),
        "admin matches"
      );
      assert.ok(
        registry.pendingAdmin.equals(ZERO_PUBKEY),
        "pending admin is zero"
      );
      assert.ok(
        registry.controller.equals(ZERO_PUBKEY),
        "controller starts zero"
      );
    });

    it("rejects zero address on initialize", async () => {
      try {
        await addressBookProgram.methods
          .setAddress({ controller: {} }, ZERO_PUBKEY)
          .accounts({
            admin: admin.publicKey,
          })
          .rpc();
        assert.fail("should have rejected zero address");
      } catch (err: any) {
        assert.include(
          err.toString(),
          "Address cannot be zero"
        );
      }
    });

    it("sets controller address and verifies storage", async () => {
      const controllerAddr = Keypair.generate().publicKey;
      await addressBookProgram.methods
        .setAddress({ controller: {} }, controllerAddr)
        .accounts({
          admin: admin.publicKey,
        })
        .rpc();

      const registry =
        await addressBookProgram.account.registry.fetch(
          registryPda
        );
      assert.ok(
        registry.controller.equals(controllerAddr),
        "controller stored"
      );
    });

    it("sets margin pool address", async () => {
      const marginPoolAddr = Keypair.generate().publicKey;
      await addressBookProgram.methods
        .setAddress({ marginPool: {} }, marginPoolAddr)
        .accounts({
          admin: admin.publicKey,
        })
        .rpc();

      const registry =
        await addressBookProgram.account.registry.fetch(
          registryPda
        );
      assert.ok(
        registry.marginPool.equals(marginPoolAddr),
        "margin pool stored"
      );
    });

    it("sets oracle address", async () => {
      const oracleAddr = Keypair.generate().publicKey;
      await addressBookProgram.methods
        .setAddress({ oracle: {} }, oracleAddr)
        .accounts({
          admin: admin.publicKey,
        })
        .rpc();

      const registry =
        await addressBookProgram.account.registry.fetch(
          registryPda
        );
      assert.ok(
        registry.oracle.equals(oracleAddr),
        "oracle stored"
      );
    });

    it("rejects set_address from non-admin", async () => {
      const imposter = Keypair.generate();
      await fundAccount(
        provider,
        imposter.publicKey,
        LAMPORTS_PER_SOL
      );

      try {
        await addressBookProgram.methods
          .setAddress(
            { controller: {} },
            Keypair.generate().publicKey
          )
          .accounts({
            admin: imposter.publicKey,
          })
          .signers([imposter])
          .rpc();
        assert.fail("should reject non-admin");
      } catch (err: any) {
        assert.include(
          err.toString(),
          "AnchorError caused by account: registry"
        );
      }
    });

    it("transfers ownership (two-step: start + accept)", async () => {
      const newAdmin = Keypair.generate();
      await fundAccount(
        provider,
        newAdmin.publicKey,
        LAMPORTS_PER_SOL
      );

      await addressBookProgram.methods
        .transferOwnership(newAdmin.publicKey)
        .accounts({
          admin: admin.publicKey,
        })
        .rpc();

      let registry =
        await addressBookProgram.account.registry.fetch(
          registryPda
        );
      assert.ok(
        registry.pendingAdmin.equals(newAdmin.publicKey),
        "pending admin set"
      );
      assert.ok(
        registry.admin.equals(admin.publicKey),
        "admin unchanged until accepted"
      );

      await addressBookProgram.methods
        .acceptOwnership()
        .accounts({
          newAdmin: newAdmin.publicKey,
        })
        .signers([newAdmin])
        .rpc();

      registry =
        await addressBookProgram.account.registry.fetch(
          registryPda
        );
      assert.ok(
        registry.admin.equals(newAdmin.publicKey),
        "ownership transferred"
      );
      assert.ok(
        registry.pendingAdmin.equals(ZERO_PUBKEY),
        "pending admin cleared"
      );

      // Transfer back for remaining tests
      await addressBookProgram.methods
        .transferOwnership(admin.publicKey)
        .accounts({
          admin: newAdmin.publicKey,
        })
        .signers([newAdmin])
        .rpc();

      await addressBookProgram.methods
        .acceptOwnership()
        .accounts({
          newAdmin: admin.publicKey,
        })
        .rpc();
    });
  });

  // ───────────────────────────────────────────
  // MarginPool tests
  // ───────────────────────────────────────────
  describe("margin_pool", () => {
    const [configPda] = findMarginPoolConfigPda(
      marginPoolProgram.programId
    );
    let collateralMint: PublicKey;
    let poolVaultPda: PublicKey;
    let vaultAuthPda: PublicKey;
    let vaultTokenAccount: PublicKey;
    let userTokenAccount: PublicKey;

    it("initializes pool config", async () => {
      const controllerPk = Keypair.generate().publicKey;

      await marginPoolProgram.methods
        .initialize(controllerPk)
        .accounts({
          admin: admin.publicKey,
        })
        .rpc();

      const config =
        await marginPoolProgram.account.marginPoolConfig.fetch(
          configPda
        );
      assert.ok(
        config.admin.equals(admin.publicKey),
        "admin set"
      );
      assert.ok(
        config.controller.equals(controllerPk),
        "controller set"
      );
    });

    it("creates pool vault with SPL token mint", async () => {
      collateralMint = await createMint(
        connection,
        admin.payer,
        admin.publicKey,
        null,
        6
      );

      [poolVaultPda] = findPoolVaultPda(
        collateralMint,
        marginPoolProgram.programId
      );
      [vaultAuthPda] = findPoolVaultAuthPda(
        collateralMint,
        marginPoolProgram.programId
      );

      vaultTokenAccount = await createAccount(
        connection,
        admin.payer,
        collateralMint,
        vaultAuthPda,
        Keypair.generate()
      );

      await marginPoolProgram.methods
        .createPoolVault()
        .accounts({
          config: configPda,
          poolVault: poolVaultPda,
          vaultTokenAccount: vaultTokenAccount,
          vaultAuthority: vaultAuthPda,
          collateralMint: collateralMint,
          admin: admin.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      const vault =
        await marginPoolProgram.account.poolVault.fetch(
          poolVaultPda
        );
      assert.ok(
        vault.collateralMint.equals(collateralMint),
        "mint matches"
      );
      assert.ok(
        vault.tokenAccount.equals(vaultTokenAccount),
        "token account matches"
      );
      assert.equal(
        vault.totalDeposited.toNumber(),
        0,
        "zero deposited"
      );
    });

    it("transfers collateral to pool (deposit)", async () => {
      userTokenAccount = await createAccount(
        connection,
        admin.payer,
        collateralMint,
        admin.publicKey,
        Keypair.generate()
      );

      await mintTo(
        connection,
        admin.payer,
        collateralMint,
        userTokenAccount,
        admin.publicKey,
        1_000_000
      );

      const depositAmount = new BN(500_000);

      await marginPoolProgram.methods
        .transferToPool(depositAmount)
        .accounts({
          config: configPda,
          poolVault: poolVaultPda,
          userTokenAccount: userTokenAccount,
          vaultTokenAccount: vaultTokenAccount,
          userAuthority: admin.publicKey,
          recipient: admin.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();

      const vaultInfo =
        await marginPoolProgram.account.poolVault.fetch(
          poolVaultPda
        );
      assert.equal(
        vaultInfo.totalDeposited.toNumber(),
        500_000,
        "total deposited updated"
      );

      const vaultAcct = await getAccount(
        connection,
        vaultTokenAccount
      );
      assert.equal(
        Number(vaultAcct.amount),
        500_000,
        "vault token balance"
      );
    });

    it("rejects zero amount on transfer_to_pool", async () => {
      try {
        await marginPoolProgram.methods
          .transferToPool(new BN(0))
          .accounts({
            config: configPda,
            poolVault: poolVaultPda,
            userTokenAccount: userTokenAccount,
            vaultTokenAccount: vaultTokenAccount,
            userAuthority: admin.publicKey,
            recipient: admin.publicKey,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .rpc();
        assert.fail("should reject zero amount");
      } catch (err: any) {
        assert.include(
          err.toString(),
          "Amount must be greater than zero"
        );
      }
    });

    it("transfers collateral from pool to user (withdraw)", async () => {
      const withdrawAmount = new BN(200_000);

      await marginPoolProgram.methods
        .transferToUser(withdrawAmount)
        .accounts({
          config: configPda,
          poolVault: poolVaultPda,
          vaultTokenAccount: vaultTokenAccount,
          userTokenAccount: userTokenAccount,
          vaultAuthority: vaultAuthPda,
          recipient: admin.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();

      const vaultInfo =
        await marginPoolProgram.account.poolVault.fetch(
          poolVaultPda
        );
      assert.equal(
        vaultInfo.totalDeposited.toNumber(),
        300_000,
        "total deposited after withdraw"
      );

      const userAcct = await getAccount(
        connection,
        userTokenAccount
      );
      assert.equal(
        Number(userAcct.amount),
        700_000,
        "user balance after withdraw"
      );
    });

    it("rejects withdraw exceeding balance", async () => {
      try {
        await marginPoolProgram.methods
          .transferToUser(new BN(999_999_999))
          .accounts({
            config: configPda,
            poolVault: poolVaultPda,
            vaultTokenAccount: vaultTokenAccount,
            userTokenAccount: userTokenAccount,
            vaultAuthority: vaultAuthPda,
            recipient: admin.publicKey,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .rpc();
        assert.fail("should reject excessive withdraw");
      } catch (err: any) {
        assert.include(
          err.toString(),
          "Insufficient pool balance"
        );
      }
    });

    it("rejects zero amount on transfer_to_user", async () => {
      try {
        await marginPoolProgram.methods
          .transferToUser(new BN(0))
          .accounts({
            config: configPda,
            poolVault: poolVaultPda,
            vaultTokenAccount: vaultTokenAccount,
            userTokenAccount: userTokenAccount,
            vaultAuthority: vaultAuthPda,
            recipient: admin.publicKey,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .rpc();
        assert.fail("should reject zero amount");
      } catch (err: any) {
        assert.include(
          err.toString(),
          "Amount must be greater than zero"
        );
      }
    });
  });

  // ───────────────────────────────────────────
  // Controller tests
  // ───────────────────────────────────────────
  describe("controller", () => {
    const [configPda] = findControllerConfigPda(
      controllerProgram.programId
    );
    const [whitelistConfigPda] = findWhitelistConfigPda(
      whitelistProgram.programId
    );

    let collateralMint: PublicKey;
    let otokenMint: PublicKey;
    let otokenInfoPda: PublicKey;
    let vaultPda: PublicKey;
    let vaultCounterPda: PublicKey;
    let userCollateralAccount: PublicKey;
    let poolTokenAccount: PublicKey;
    let poolVaultAuthPda: PublicKey;
    let ownerOtokenAccount: PublicKey;

    // Helper: whitelist an oToken so controller accepts it
    async function whitelistOToken(mint: PublicKey) {
      const [wlPda] = findWhitelistedOTokenPda(
        mint, whitelistProgram.programId
      );
      await whitelistProgram.methods
        .whitelistOtoken(mint)
        .accounts({
          whitelistedOtoken: wlPda,
          config: whitelistConfigPda,
          caller: admin.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      return wlPda;
    }

    it("initializes whitelist", async () => {
      await whitelistProgram.methods
        .initialize(admin.publicKey)
        .accounts({ payer: admin.publicKey })
        .rpc();
    });

    it("initializes controller config", async () => {
      await controllerProgram.methods
        .initialize(admin.publicKey)
        .accounts({
          payer: admin.publicKey,
        })
        .rpc();

      const config =
        await controllerProgram.account.controllerConfig.fetch(
          configPda
        );
      assert.ok(
        config.admin.equals(admin.publicKey),
        "admin set"
      );
      assert.equal(
        config.partiallyPaused,
        false,
        "not partially paused"
      );
      assert.equal(
        config.fullyPaused,
        false,
        "not fully paused"
      );
    });

    it("initializes vault counter", async () => {
      [vaultCounterPda] = findVaultCounterPda(
        admin.publicKey,
        controllerProgram.programId
      );

      await controllerProgram.methods
        .initializeCounter()
        .accounts({
          owner: admin.publicKey,
        })
        .rpc();

      const counter =
        await controllerProgram.account.vaultCounter.fetch(
          vaultCounterPda
        );
      assert.ok(
        counter.owner.equals(admin.publicKey),
        "counter owner"
      );
      assert.equal(
        counter.nextId.toNumber(),
        0,
        "starts at 0"
      );
    });

    it("opens a vault with beneficiary", async () => {
      collateralMint = await createMint(
        connection,
        admin.payer,
        admin.publicKey,
        null,
        6
      );

      [vaultPda] = findVaultPda(
        admin.publicKey,
        new BN(0),
        controllerProgram.programId
      );

      await controllerProgram.methods
        .openVault(collateralMint, admin.publicKey)
        .accounts({
          owner: admin.publicKey,
        })
        .rpc();

      const vault =
        await controllerProgram.account.vault.fetch(vaultPda);
      assert.ok(
        vault.owner.equals(admin.publicKey),
        "vault owner"
      );
      assert.equal(
        vault.vaultId.toNumber(),
        0,
        "vault id 0"
      );
      assert.ok(
        vault.collateralMint.equals(collateralMint),
        "collateral mint"
      );
      assert.equal(
        vault.collateralAmount.toNumber(),
        0,
        "zero collateral"
      );
      assert.ok(
        vault.beneficiary.equals(admin.publicKey),
        "beneficiary set"
      );
      assert.equal(vault.settled, false, "not settled");

      const counter =
        await controllerProgram.account.vaultCounter.fetch(
          vaultCounterPda
        );
      assert.equal(
        counter.nextId.toNumber(),
        1,
        "counter incremented"
      );
    });

    it("deposits collateral into vault", async () => {
      userCollateralAccount = await createAccount(
        connection,
        admin.payer,
        collateralMint,
        admin.publicKey,
        Keypair.generate()
      );

      [poolVaultAuthPda] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("pool_vault_auth"),
          collateralMint.toBuffer(),
        ],
        controllerProgram.programId
      );

      poolTokenAccount = await createAccount(
        connection,
        admin.payer,
        collateralMint,
        poolVaultAuthPda,
        Keypair.generate()
      );

      await mintTo(
        connection,
        admin.payer,
        collateralMint,
        userCollateralAccount,
        admin.publicKey,
        10_000_000_000
      );

      const depositAmount = new BN(5_000_000_000);

      await controllerProgram.methods
        .depositCollateral(depositAmount)
        .accounts({
          config: configPda,
          vault: vaultPda,
          userTokenAccount: userCollateralAccount,
          poolTokenAccount: poolTokenAccount,
          owner: admin.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();

      const vault =
        await controllerProgram.account.vault.fetch(vaultPda);
      assert.equal(
        vault.collateralAmount.toNumber(),
        5_000_000_000,
        "collateral deposited"
      );

      const poolAcct = await getAccount(
        connection,
        poolTokenAccount
      );
      assert.equal(
        Number(poolAcct.amount),
        5_000_000_000,
        "pool token account received funds"
      );
    });

    it("rejects zero deposit", async () => {
      try {
        await controllerProgram.methods
          .depositCollateral(new BN(0))
          .accounts({
            config: configPda,
            vault: vaultPda,
            userTokenAccount: userCollateralAccount,
            poolTokenAccount: poolTokenAccount,
            owner: admin.publicKey,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .rpc();
        assert.fail("should reject zero deposit");
      } catch (err: any) {
        assert.include(
          err.toString(),
          "Amount must be greater than zero"
        );
      }
    });

    it("mints oTokens with collateral check (future expiry)", async () => {
      // oToken with far future expiry so mint_otoken passes expiry check
      const otokenMintKp = Keypair.generate();
      otokenMint = await createMint(
        connection,
        admin.payer,
        configPda,
        null,
        8,
        otokenMintKp
      );

      ownerOtokenAccount = await createAccount(
        connection,
        admin.payer,
        otokenMint,
        admin.publicKey,
        Keypair.generate()
      );

      const underlying = Keypair.generate().publicKey;
      const strikeAsset = Keypair.generate().publicKey;

      [otokenInfoPda] = findOTokenInfoPda(
        otokenMint,
        controllerProgram.programId
      );

      // Whitelist the oToken before creating info
      const wlPda = await whitelistOToken(otokenMint);

      // Put option, strike=$2000, far future expiry, 6 decimals
      await controllerProgram.methods
        .createOtokenInfo(
          otokenMint,
          underlying,
          strikeAsset,
          collateralMint,
          new BN("200000000000"),
          FAR_FUTURE_EXPIRY,
          true,
          6
        )
        .accounts({
          config: configPda,
          otokenInfo: otokenInfoPda,
          otokenMint: otokenMint,
          whitelistedOtoken: wlPda,
          whitelistProgram: whitelistProgram.programId,
          admin: admin.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      // Mint 1 oToken (1e8 units). Required collateral for a put:
      // (100_000_000 * 200_000_000_000) / 10^10 = 2_000_000_000
      // We have 5_000_000_000 deposited, so this should succeed.
      const mintAmount = new BN(100_000_000);

      await controllerProgram.methods
        .mintOtoken(mintAmount)
        .accounts({
          config: configPda,
          vault: vaultPda,
          otokenInfo: otokenInfoPda,
          otokenMint: otokenMint,
          destination: ownerOtokenAccount,
          whitelistedOtoken: wlPda,
          whitelistProgram: whitelistProgram.programId,
          owner: admin.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();

      const vault =
        await controllerProgram.account.vault.fetch(vaultPda);
      assert.equal(
        vault.shortAmount.toNumber(),
        100_000_000,
        "short amount recorded"
      );
      assert.ok(
        vault.otokenMint.equals(otokenMint),
        "vault otoken mint set"
      );

      const otokenAcct = await getAccount(
        connection,
        ownerOtokenAccount
      );
      assert.equal(
        Number(otokenAcct.amount),
        100_000_000,
        "oTokens minted to destination"
      );
    });

    it("rejects minting expired oTokens", async () => {
      // Create a separate oToken with expiry=0 (already expired)
      const expiredMintKp = Keypair.generate();
      const expiredMint = await createMint(
        connection,
        admin.payer,
        configPda,
        null,
        8,
        expiredMintKp
      );
      const [expiredInfoPda] = findOTokenInfoPda(
        expiredMint,
        controllerProgram.programId
      );

      const expiredWlPda = await whitelistOToken(expiredMint);

      await controllerProgram.methods
        .createOtokenInfo(
          expiredMint,
          Keypair.generate().publicKey,
          Keypair.generate().publicKey,
          collateralMint,
          new BN("200000000000"),
          new BN(0), // already expired
          true,
          6
        )
        .accounts({
          config: configPda,
          otokenInfo: expiredInfoPda,
          otokenMint: expiredMint,
          whitelistedOtoken: expiredWlPda,
          whitelistProgram: whitelistProgram.programId,
          admin: admin.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      const expiredDest = await createAccount(
        connection,
        admin.payer,
        expiredMint,
        admin.publicKey,
        Keypair.generate()
      );

      try {
        await controllerProgram.methods
          .mintOtoken(new BN(100_000_000))
          .accounts({
            config: configPda,
            vault: vaultPda,
            otokenInfo: expiredInfoPda,
            otokenMint: expiredMint,
            destination: expiredDest,
            owner: admin.publicKey,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .rpc();
        assert.fail("should reject minting expired oToken");
      } catch (err: any) {
        assert.include(
          err.toString(),
          "Option has expired"
        );
      }
    });

    it("rejects minting with insufficient collateral", async () => {
      // 5B collateral. Each oToken needs 2B.
      // Already minted 1 (=2B used). Trying 4 more = 5 total = 10B > 5B
      const [wlPda] = findWhitelistedOTokenPda(
        otokenMint, whitelistProgram.programId
      );
      try {
        await controllerProgram.methods
          .mintOtoken(new BN(400_000_000))
          .accounts({
            config: configPda,
            vault: vaultPda,
            otokenInfo: otokenInfoPda,
            otokenMint: otokenMint,
            destination: ownerOtokenAccount,
            owner: admin.publicKey,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .rpc();
        assert.fail("should reject insufficient collateral");
      } catch (err: any) {
        assert.include(
          err.toString(),
          "Insufficient collateral"
        );
      }
    });

    it("rejects settling a non-expired vault", async () => {
      // Can't test positive settle standalone: mint_otoken requires
      // future expiry, but settle requires past expiry. Full settle
      // flow is tested via batch_settler integration path.
      try {
        const tempBeneficiaryAcct = await createAccount(
          connection,
          admin.payer,
          collateralMint,
          admin.publicKey,
          Keypair.generate()
        );

        await controllerProgram.methods
          .settleVault()
          .accounts({
            config: configPda,
            vault: vaultPda,
            otokenInfo: otokenInfoPda,
            poolTokenAccount: poolTokenAccount,
            beneficiaryTokenAccount: tempBeneficiaryAcct,
            poolVaultAuthority: poolVaultAuthPda,
            admin: admin.publicKey,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .rpc();
        assert.fail("should reject non-expired vault");
      } catch (err: any) {
        assert.include(
          err.toString(),
          "Option has not expired"
        );
      }
    });

    it("opens a second vault and increments counter", async () => {
      const [vaultPda2] = findVaultPda(
        admin.publicKey,
        new BN(1),
        controllerProgram.programId
      );

      await controllerProgram.methods
        .openVault(collateralMint, admin.publicKey)
        .accounts({
          owner: admin.publicKey,
        })
        .rpc();

      const vault2 =
        await controllerProgram.account.vault.fetch(vaultPda2);
      assert.equal(
        vault2.vaultId.toNumber(),
        1,
        "second vault id"
      );

      const counter =
        await controllerProgram.account.vaultCounter.fetch(
          vaultCounterPda
        );
      assert.equal(
        counter.nextId.toNumber(),
        2,
        "counter is 2"
      );
    });

    it("sets partial pauser", async () => {
      const pauser = Keypair.generate();
      await fundAccount(
        provider,
        pauser.publicKey,
        LAMPORTS_PER_SOL
      );

      await controllerProgram.methods
        .setPartialPauser(pauser.publicKey)
        .accounts({
          admin: admin.publicKey,
        })
        .rpc();

      const config =
        await controllerProgram.account.controllerConfig.fetch(
          configPda
        );
      assert.ok(
        config.partialPauser.equals(pauser.publicKey),
        "pauser set"
      );
    });

    it("partially pauses system", async () => {
      await controllerProgram.methods
        .setPartialPauser(admin.publicKey)
        .accounts({
          admin: admin.publicKey,
        })
        .rpc();

      await controllerProgram.methods
        .setPartiallyPaused(true)
        .accounts({
          caller: admin.publicKey,
        })
        .rpc();

      const config =
        await controllerProgram.account.controllerConfig.fetch(
          configPda
        );
      assert.equal(
        config.partiallyPaused,
        true,
        "partially paused"
      );
    });

    it("rejects open_vault when partially paused", async () => {
      try {
        await controllerProgram.methods
          .openVault(collateralMint, admin.publicKey)
          .accounts({
            owner: admin.publicKey,
          })
          .rpc();
        assert.fail(
          "should reject vault creation when paused"
        );
      } catch (err: any) {
        assert.include(
          err.toString(),
          "System partially paused"
        );
      }
    });

    it("rejects deposit_collateral when partially paused", async () => {
      try {
        await controllerProgram.methods
          .depositCollateral(new BN(100))
          .accounts({
            config: configPda,
            vault: vaultPda,
            userTokenAccount: userCollateralAccount,
            poolTokenAccount: poolTokenAccount,
            owner: admin.publicKey,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .rpc();
        assert.fail("should reject deposit when paused");
      } catch (err: any) {
        assert.include(
          err.toString(),
          "System partially paused"
        );
      }
    });

    it("unpauses partial pause", async () => {
      await controllerProgram.methods
        .setPartiallyPaused(false)
        .accounts({
          caller: admin.publicKey,
        })
        .rpc();

      const config =
        await controllerProgram.account.controllerConfig.fetch(
          configPda
        );
      assert.equal(
        config.partiallyPaused,
        false,
        "unpaused"
      );
    });

    it("fully pauses system", async () => {
      await controllerProgram.methods
        .setFullyPaused(true)
        .accounts({
          admin: admin.publicKey,
        })
        .rpc();

      const config =
        await controllerProgram.account.controllerConfig.fetch(
          configPda
        );
      assert.equal(
        config.fullyPaused,
        true,
        "fully paused"
      );
    });

    it("rejects open_vault when fully paused", async () => {
      try {
        await controllerProgram.methods
          .openVault(collateralMint, admin.publicKey)
          .accounts({
            owner: admin.publicKey,
          })
          .rpc();
        assert.fail("should reject when fully paused");
      } catch (err: any) {
        assert.include(
          err.toString(),
          "System fully paused"
        );
      }
    });

    it("rejects deposit when fully paused", async () => {
      try {
        await controllerProgram.methods
          .depositCollateral(new BN(100))
          .accounts({
            config: configPda,
            vault: vaultPda,
            userTokenAccount: userCollateralAccount,
            poolTokenAccount: poolTokenAccount,
            owner: admin.publicKey,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .rpc();
        assert.fail("should reject when fully paused");
      } catch (err: any) {
        assert.include(
          err.toString(),
          "System fully paused"
        );
      }
    });

    it("unpauses full pause and resumes operations", async () => {
      await controllerProgram.methods
        .setFullyPaused(false)
        .accounts({
          admin: admin.publicKey,
        })
        .rpc();

      const [vaultPda3] = findVaultPda(
        admin.publicKey,
        new BN(2),
        controllerProgram.programId
      );

      await controllerProgram.methods
        .openVault(collateralMint, admin.publicKey)
        .accounts({
          owner: admin.publicKey,
        })
        .rpc();

      const vault3 =
        await controllerProgram.account.vault.fetch(vaultPda3);
      assert.equal(
        vault3.vaultId.toNumber(),
        2,
        "vault created after unpause"
      );
    });

    it("rejects set_fully_paused from non-admin", async () => {
      const imposter = Keypair.generate();
      await fundAccount(
        provider,
        imposter.publicKey,
        LAMPORTS_PER_SOL
      );

      try {
        await controllerProgram.methods
          .setFullyPaused(true)
          .accounts({
            admin: imposter.publicKey,
          })
          .signers([imposter])
          .rpc();
        assert.fail("should reject non-admin pause");
      } catch (err: any) {
        assert.include(
          err.toString(),
          "AnchorError caused by account: config"
        );
      }
    });

    it("rejects set_partially_paused from unauthorized caller", async () => {
      const imposter = Keypair.generate();
      await fundAccount(
        provider,
        imposter.publicKey,
        LAMPORTS_PER_SOL
      );

      try {
        await controllerProgram.methods
          .setPartiallyPaused(true)
          .accounts({
            caller: imposter.publicKey,
          })
          .signers([imposter])
          .rpc();
        assert.fail("should reject unauthorized pauser");
      } catch (err: any) {
        assert.include(err.toString(), "nauthorized");
      }
    });
  });

  // ───────────────────────────────────────────
  // OTokenFactory tests
  // ───────────────────────────────────────────
  describe("otoken_factory", () => {
    const [factoryConfigPda] = findFactoryConfigPda(
      otokenFactoryProgram.programId
    );

    const [controllerConfigPda] = findControllerConfigPda(
      controllerProgram.programId
    );

    const underlying = Keypair.generate().publicKey;
    const strikeAsset = Keypair.generate().publicKey;
    const collateral = Keypair.generate().publicKey;
    const strikePrice = new BN("200000000000");
    const expiry = new BN(1735689600);
    const isPut = true;

    it("initializes factory with admin", async () => {
      await otokenFactoryProgram.methods
        .initialize(admin.publicKey)
        .accounts({
          payer: admin.publicKey,
        })
        .rpc();

      const config =
        await otokenFactoryProgram.account.factoryConfig.fetch(
          factoryConfigPda
        );
      assert.ok(
        config.admin.equals(admin.publicKey),
        "admin matches"
      );
      assert.ok(
        config.controller.equals(ZERO_PUBKEY),
        "controller starts zero"
      );
      assert.equal(
        config.otokenCount.toNumber(),
        0,
        "otoken count starts at 0"
      );
    });

    it("rejects create_otoken before controller is set", async () => {
      const [otokenPda] = findOTokenPda(
        underlying, strikeAsset, collateral,
        strikePrice, expiry, isPut,
        otokenFactoryProgram.programId
      );
      const [otokenMintPda] = findOTokenMintPda(
        underlying, strikeAsset, collateral,
        strikePrice, expiry, isPut,
        otokenFactoryProgram.programId
      );

      try {
        await otokenFactoryProgram.methods
          .createOtoken(
            underlying, strikeAsset, collateral,
            strikePrice, expiry, isPut
          )
          .accounts({
            factoryConfig: factoryConfigPda,
            otoken: otokenPda,
            otokenMint: otokenMintPda,
            controllerAuthority: controllerConfigPda,
            admin: admin.publicKey,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .rpc();
        assert.fail("should reject without controller");
      } catch (err: any) {
        assert.include(
          err.toString(),
          "Controller not set"
        );
      }
    });

    it("sets controller", async () => {
      await otokenFactoryProgram.methods
        .setController(controllerConfigPda)
        .accounts({
          admin: admin.publicKey,
        })
        .rpc();

      const config =
        await otokenFactoryProgram.account.factoryConfig.fetch(
          factoryConfigPda
        );
      assert.ok(
        config.controller.equals(controllerConfigPda),
        "controller set"
      );
    });

    it("rejects set_controller from non-admin", async () => {
      const imposter = Keypair.generate();
      await fundAccount(
        provider,
        imposter.publicKey,
        LAMPORTS_PER_SOL
      );

      try {
        await otokenFactoryProgram.methods
          .setController(Keypair.generate().publicKey)
          .accounts({
            admin: imposter.publicKey,
          })
          .signers([imposter])
          .rpc();
        assert.fail("should reject non-admin");
      } catch (err: any) {
        assert.include(
          err.toString(),
          "AnchorError caused by account: factory_config"
        );
      }
    });

    it("creates oToken with SPL mint and metadata", async () => {
      const [otokenPda] = findOTokenPda(
        underlying, strikeAsset, collateral,
        strikePrice, expiry, isPut,
        otokenFactoryProgram.programId
      );
      const [otokenMintPda] = findOTokenMintPda(
        underlying, strikeAsset, collateral,
        strikePrice, expiry, isPut,
        otokenFactoryProgram.programId
      );

      await otokenFactoryProgram.methods
        .createOtoken(
          underlying, strikeAsset, collateral,
          strikePrice, expiry, isPut
        )
        .accounts({
          factoryConfig: factoryConfigPda,
          otoken: otokenPda,
          otokenMint: otokenMintPda,
          controllerAuthority: controllerConfigPda,
          admin: admin.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      const otoken =
        await otokenFactoryProgram.account.oToken.fetch(
          otokenPda
        );
      assert.ok(otoken.underlying.equals(underlying));
      assert.ok(otoken.strikeAsset.equals(strikeAsset));
      assert.ok(otoken.collateral.equals(collateral));
      assert.equal(
        otoken.strikePrice.toString(),
        "200000000000"
      );
      assert.equal(otoken.expiry.toNumber(), 1735689600);
      assert.equal(otoken.isPut, true);
      assert.ok(otoken.mint.equals(otokenMintPda));

      const mintInfo = await getMint(connection, otokenMintPda);
      assert.equal(mintInfo.decimals, 8, "8 decimals");
      assert.ok(
        mintInfo.mintAuthority.equals(controllerConfigPda),
        "mint authority is controller config PDA"
      );
      assert.equal(Number(mintInfo.supply), 0);

      const config =
        await otokenFactoryProgram.account.factoryConfig.fetch(
          factoryConfigPda
        );
      assert.equal(config.otokenCount.toNumber(), 1);
    });

    it("prevents duplicate oToken creation", async () => {
      const [otokenPda] = findOTokenPda(
        underlying, strikeAsset, collateral,
        strikePrice, expiry, isPut,
        otokenFactoryProgram.programId
      );
      const [otokenMintPda] = findOTokenMintPda(
        underlying, strikeAsset, collateral,
        strikePrice, expiry, isPut,
        otokenFactoryProgram.programId
      );

      try {
        await otokenFactoryProgram.methods
          .createOtoken(
            underlying, strikeAsset, collateral,
            strikePrice, expiry, isPut
          )
          .accounts({
            factoryConfig: factoryConfigPda,
            otoken: otokenPda,
            otokenMint: otokenMintPda,
            controllerAuthority: controllerConfigPda,
            admin: admin.publicKey,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .rpc();
        assert.fail("should reject duplicate oToken");
      } catch (err: any) {
        assert.ok(
          err.toString().length > 0,
          "error thrown for duplicate"
        );
      }
    });

    it("creates a second oToken with different params", async () => {
      const underlying2 = Keypair.generate().publicKey;
      const strikePrice2 = new BN("300000000000");

      const [otokenPda2] = findOTokenPda(
        underlying2, strikeAsset, collateral,
        strikePrice2, expiry, false,
        otokenFactoryProgram.programId
      );
      const [otokenMintPda2] = findOTokenMintPda(
        underlying2, strikeAsset, collateral,
        strikePrice2, expiry, false,
        otokenFactoryProgram.programId
      );

      await otokenFactoryProgram.methods
        .createOtoken(
          underlying2, strikeAsset, collateral,
          strikePrice2, expiry, false
        )
        .accounts({
          factoryConfig: factoryConfigPda,
          otoken: otokenPda2,
          otokenMint: otokenMintPda2,
          controllerAuthority: controllerConfigPda,
          admin: admin.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      const otoken =
        await otokenFactoryProgram.account.oToken.fetch(
          otokenPda2
        );
      assert.ok(otoken.underlying.equals(underlying2));
      assert.equal(otoken.strikePrice.toString(), "300000000000");
      assert.equal(otoken.isPut, false);

      const config =
        await otokenFactoryProgram.account.factoryConfig.fetch(
          factoryConfigPda
        );
      assert.equal(config.otokenCount.toNumber(), 2);
    });

    it("rejects create_otoken from non-admin", async () => {
      const imposter = Keypair.generate();
      await fundAccount(
        provider,
        imposter.publicKey,
        LAMPORTS_PER_SOL
      );

      const newUnderlying = Keypair.generate().publicKey;
      const [otokenPda] = findOTokenPda(
        newUnderlying, strikeAsset, collateral,
        strikePrice, expiry, isPut,
        otokenFactoryProgram.programId
      );
      const [otokenMintPda] = findOTokenMintPda(
        newUnderlying, strikeAsset, collateral,
        strikePrice, expiry, isPut,
        otokenFactoryProgram.programId
      );

      try {
        await otokenFactoryProgram.methods
          .createOtoken(
            newUnderlying, strikeAsset, collateral,
            strikePrice, expiry, isPut
          )
          .accounts({
            factoryConfig: factoryConfigPda,
            otoken: otokenPda,
            otokenMint: otokenMintPda,
            controllerAuthority: controllerConfigPda,
            admin: imposter.publicKey,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .signers([imposter])
          .rpc();
        assert.fail("should reject non-admin");
      } catch (err: any) {
        assert.include(
          err.toString(),
          "AnchorError caused by account: factory_config"
        );
      }
    });

    it("rejects zero strike price", async () => {
      const newUnderlying = Keypair.generate().publicKey;
      const zeroStrike = new BN(0);

      const [otokenPda] = findOTokenPda(
        newUnderlying, strikeAsset, collateral,
        zeroStrike, expiry, isPut,
        otokenFactoryProgram.programId
      );
      const [otokenMintPda] = findOTokenMintPda(
        newUnderlying, strikeAsset, collateral,
        zeroStrike, expiry, isPut,
        otokenFactoryProgram.programId
      );

      try {
        await otokenFactoryProgram.methods
          .createOtoken(
            newUnderlying, strikeAsset, collateral,
            zeroStrike, expiry, isPut
          )
          .accounts({
            factoryConfig: factoryConfigPda,
            otoken: otokenPda,
            otokenMint: otokenMintPda,
            controllerAuthority: controllerConfigPda,
            admin: admin.publicKey,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .rpc();
        assert.fail("should reject zero strike");
      } catch (err: any) {
        assert.include(
          err.toString(),
          "Strike price must be greater than zero"
        );
      }
    });

    it("rejects wrong controller authority", async () => {
      const newUnderlying = Keypair.generate().publicKey;
      const wrongAuthority = Keypair.generate().publicKey;

      const [otokenPda] = findOTokenPda(
        newUnderlying, strikeAsset, collateral,
        strikePrice, expiry, isPut,
        otokenFactoryProgram.programId
      );
      const [otokenMintPda] = findOTokenMintPda(
        newUnderlying, strikeAsset, collateral,
        strikePrice, expiry, isPut,
        otokenFactoryProgram.programId
      );

      try {
        await otokenFactoryProgram.methods
          .createOtoken(
            newUnderlying, strikeAsset, collateral,
            strikePrice, expiry, isPut
          )
          .accounts({
            factoryConfig: factoryConfigPda,
            otoken: otokenPda,
            otokenMint: otokenMintPda,
            controllerAuthority: wrongAuthority,
            admin: admin.publicKey,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .rpc();
        assert.fail("should reject wrong controller");
      } catch (err: any) {
        assert.include(
          err.toString(),
          "Invalid controller authority"
        );
      }
    });
  });

  // ───────────────────────────────────────────
  // BatchSettler tests
  // ───────────────────────────────────────────
  describe("batch_settler", () => {
    const [settlerConfigPda] = findSettlerConfigPda(
      batchSettlerProgram.programId
    );

    const operator = Keypair.generate();
    const treasury = Keypair.generate();
    const maker = Keypair.generate();
    const user = Keypair.generate(); // option seller
    const feeBps = 500; // 5%

    before(async () => {
      await fundAccount(
        provider,
        operator.publicKey,
        5 * LAMPORTS_PER_SOL
      );
      await fundAccount(
        provider,
        maker.publicKey,
        5 * LAMPORTS_PER_SOL
      );
      await fundAccount(
        provider,
        user.publicKey,
        5 * LAMPORTS_PER_SOL
      );
      await fundAccount(
        provider,
        treasury.publicKey,
        LAMPORTS_PER_SOL
      );
    });

    it("initializes settler config", async () => {
      const jupiterProgram = Keypair.generate().publicKey;
      const escapeDelay = new BN(259200); // 3 days
      await batchSettlerProgram.methods
        .initialize(
          operator.publicKey,
          treasury.publicKey,
          feeBps,
          escapeDelay,
          jupiterProgram
        )
        .accounts({
          payer: admin.publicKey,
        })
        .rpc();

      const config =
        await batchSettlerProgram.account.settlerConfig.fetch(
          settlerConfigPda
        );
      assert.ok(config.owner.equals(admin.publicKey));
      assert.ok(config.operator.equals(operator.publicKey));
      assert.ok(config.treasury.equals(treasury.publicKey));
      assert.equal(config.protocolFeeBps, feeBps);
      assert.equal(config.paused, false);
    });

    it("rejects fee above 2000 bps", async () => {
      try {
        await batchSettlerProgram.methods
          .setProtocolFee(2001)
          .accounts({
            owner: admin.publicKey,
          })
          .rpc();
        assert.fail("should reject");
      } catch (err: any) {
        assert.include(err.toString(), "FeeTooHigh");
      }
    });

    it("whitelists a maker", async () => {
      await batchSettlerProgram.methods
        .whitelistMaker(maker.publicKey, true)
        .accounts({
          owner: admin.publicKey,
        })
        .rpc();

      const [makerStatePda] = findMakerStatePda(
        maker.publicKey,
        batchSettlerProgram.programId
      );
      const state =
        await batchSettlerProgram.account.makerState.fetch(
          makerStatePda
        );
      assert.ok(state.maker.equals(maker.publicKey));
      assert.equal(state.whitelisted, true);
      assert.equal(state.nonce.toNumber(), 0);
    });

    it("rejects non-owner whitelist", async () => {
      try {
        await batchSettlerProgram.methods
          .whitelistMaker(maker.publicKey, false)
          .accounts({
            owner: user.publicKey,
          })
          .signers([user])
          .rpc();
        assert.fail("should reject");
      } catch (err: any) {
        assert.include(err.toString(), "ConstraintHasOne");
      }
    });

    it("increments maker nonce", async () => {
      await batchSettlerProgram.methods
        .incrementMakerNonce()
        .accounts({
          maker: maker.publicKey,
        })
        .signers([maker])
        .rpc();

      const [makerStatePda] = findMakerStatePda(
        maker.publicKey,
        batchSettlerProgram.programId
      );
      const state =
        await batchSettlerProgram.account.makerState.fetch(
          makerStatePda
        );
      assert.equal(state.nonce.toNumber(), 1);
    });

    it("cancels a quote", async () => {
      const quoteId = new BN(42);
      await batchSettlerProgram.methods
        .cancelQuote(quoteId)
        .accounts({
          maker: maker.publicKey,
        })
        .signers([maker])
        .rpc();

      const [quoteFillPda] = findQuoteFillPda(
        maker.publicKey,
        quoteId,
        batchSettlerProgram.programId
      );
      const fill =
        await batchSettlerProgram.account.quoteFill.fetch(
          quoteFillPda
        );
      assert.equal(fill.cancelled, true);
      assert.equal(fill.filledAmount.toNumber(), 0);
    });

    it("rejects double cancellation", async () => {
      const quoteId = new BN(42);
      try {
        await batchSettlerProgram.methods
          .cancelQuote(quoteId)
          .accounts({
            maker: maker.publicKey,
          })
          .signers([maker])
          .rpc();
        assert.fail("should reject double cancel");
      } catch (err: any) {
        assert.include(err.toString(), "QuoteAlreadyCancelled");
      }
    });

    it("updates treasury", async () => {
      const newTreasury = Keypair.generate().publicKey;
      await batchSettlerProgram.methods
        .setTreasury(newTreasury)
        .accounts({ owner: admin.publicKey })
        .rpc();

      const config =
        await batchSettlerProgram.account.settlerConfig.fetch(
          settlerConfigPda
        );
      assert.ok(config.treasury.equals(newTreasury));

      await batchSettlerProgram.methods
        .setTreasury(treasury.publicKey)
        .accounts({ owner: admin.publicKey })
        .rpc();
    });

    it("updates protocol fee", async () => {
      await batchSettlerProgram.methods
        .setProtocolFee(1000)
        .accounts({ owner: admin.publicKey })
        .rpc();

      const config =
        await batchSettlerProgram.account.settlerConfig.fetch(
          settlerConfigPda
        );
      assert.equal(config.protocolFeeBps, 1000);

      await batchSettlerProgram.methods
        .setProtocolFee(feeBps)
        .accounts({ owner: admin.publicKey })
        .rpc();
    });

    it("pauses and unpauses", async () => {
      await batchSettlerProgram.methods
        .pause(true)
        .accounts({ owner: admin.publicKey })
        .rpc();

      let config =
        await batchSettlerProgram.account.settlerConfig.fetch(
          settlerConfigPda
        );
      assert.equal(config.paused, true);

      await batchSettlerProgram.methods
        .pause(false)
        .accounts({ owner: admin.publicKey })
        .rpc();

      config =
        await batchSettlerProgram.account.settlerConfig.fetch(
          settlerConfigPda
        );
      assert.equal(config.paused, false);
    });

    it("updates operator", async () => {
      const newOp = Keypair.generate().publicKey;
      await batchSettlerProgram.methods
        .setOperator(newOp)
        .accounts({ owner: admin.publicKey })
        .rpc();

      const config =
        await batchSettlerProgram.account.settlerConfig.fetch(
          settlerConfigPda
        );
      assert.ok(config.operator.equals(newOp));

      await batchSettlerProgram.methods
        .setOperator(operator.publicKey)
        .accounts({ owner: admin.publicKey })
        .rpc();
    });

    it("de-whitelists a maker", async () => {
      await batchSettlerProgram.methods
        .whitelistMaker(maker.publicKey, false)
        .accounts({ owner: admin.publicKey })
        .rpc();

      const [makerStatePda] = findMakerStatePda(
        maker.publicKey,
        batchSettlerProgram.programId
      );
      const state =
        await batchSettlerProgram.account.makerState.fetch(
          makerStatePda
        );
      assert.equal(state.whitelisted, false);

      // Re-whitelist for execute_order tests
      await batchSettlerProgram.methods
        .whitelistMaker(maker.publicKey, true)
        .accounts({ owner: admin.publicKey })
        .rpc();
    });

    describe("execute_order flow (user=seller, MM=buyer)", () => {
      let collateralMint: PublicKey;
      let premiumMint: PublicKey;
      let otokenMint: PublicKey;
      let otokenInfoPda: PublicKey;
      let poolTokenAccount: PublicKey;
      let poolVaultAuthPda: PublicKey;
      let userCollateralAccount: PublicKey;
      let settlerOtokenAccount: PublicKey;
      let mmPremiumAccount: PublicKey;
      let userPremiumAccount: PublicKey;
      let treasuryPremiumAccount: PublicKey;
      let vaultCounterForSettler: PublicKey;
      let vaultPda: PublicKey;
      let makerOTokenBalancePda: PublicKey;

      const [controllerConfigPda] = findControllerConfigPda(
        controllerProgram.programId
      );
      const strikePrice = new BN("200000000000");
      const underlying = Keypair.generate().publicKey;
      const strikeAsset = Keypair.generate().publicKey;

      // Order params
      const orderAmount = new BN(1_000_000);
      const bidPrice = new BN(100_000_000); // 1.0 in PRICE_SCALE
      const deadline = new BN(9_999_999_999);
      const quoteId = new BN(100);
      const maxAmount = new BN(10_000_000);
      const makerNonce = new BN(1); // after increment
      const collateralAmount = new BN(20_000_000);

      function buildQuoteMessage(
        mint: PublicKey,
        price: BN,
        dl: BN,
        qid: BN,
        maxAmt: BN,
        nonce: BN
      ): Buffer {
        const msg = Buffer.alloc(72);
        mint.toBuffer().copy(msg, 0);
        msg.writeBigUInt64LE(BigInt(price.toString()), 32);
        msg.writeBigInt64LE(BigInt(dl.toString()), 40);
        msg.writeBigUInt64LE(BigInt(qid.toString()), 48);
        msg.writeBigUInt64LE(BigInt(maxAmt.toString()), 56);
        msg.writeBigUInt64LE(BigInt(nonce.toString()), 64);
        return msg;
      }

      before(async () => {
        // Collateral mint (6 decimals)
        collateralMint = await createMint(
          connection, admin.payer,
          admin.publicKey, null, 6
        );

        // Premium mint (6 decimals)
        premiumMint = await createMint(
          connection, admin.payer,
          admin.publicKey, null, 6
        );

        // oToken mint: controller config PDA as mint authority
        const otokenMintKp = Keypair.generate();
        otokenMint = await createMint(
          connection, admin.payer,
          controllerConfigPda, null, 8, otokenMintKp
        );

        // OTokenInfo: put, strike=$2000, far future expiry
        [otokenInfoPda] = findOTokenInfoPda(
          otokenMint, controllerProgram.programId
        );

        // Whitelist the oToken BEFORE createOtokenInfo (enforced on-chain)
        const [wlConfigPda] = findWhitelistConfigPda(
          whitelistProgram.programId
        );
        const [wlOtokenPda] = findWhitelistedOTokenPda(
          otokenMint, whitelistProgram.programId
        );
        await whitelistProgram.methods
          .whitelistOtoken(otokenMint)
          .accounts({
            whitelistedOtoken: wlOtokenPda,
            config: wlConfigPda,
            caller: admin.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .rpc();

        await controllerProgram.methods
          .createOtokenInfo(
            otokenMint, underlying, strikeAsset,
            collateralMint, strikePrice,
            FAR_FUTURE_EXPIRY, true, 6
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
          .rpc();

        // Pool vault auth PDA + pool token account
        [poolVaultAuthPda] = PublicKey.findProgramAddressSync(
          [
            Buffer.from("pool_vault_auth"),
            collateralMint.toBuffer(),
          ],
          controllerProgram.programId
        );
        poolTokenAccount = await createAccount(
          connection, admin.payer, collateralMint,
          poolVaultAuthPda, Keypair.generate()
        );

        // User's collateral: owned by user, delegated to settler PDA
        userCollateralAccount = await createAccount(
          connection, admin.payer, collateralMint,
          user.publicKey, Keypair.generate()
        );
        await mintTo(
          connection, admin.payer, collateralMint,
          userCollateralAccount, admin.publicKey, 20_000_000
        );
        await approve(
          connection, admin.payer, userCollateralAccount,
          settlerConfigPda, user, 20_000_000
        );

        // Settler's oToken custody account (owned by settler PDA)
        settlerOtokenAccount = await createAccount(
          connection, admin.payer, otokenMint,
          settlerConfigPda, Keypair.generate()
        );

        // MM's premium account: owned by maker, delegated to settler PDA
        mmPremiumAccount = await createAccount(
          connection, admin.payer, premiumMint,
          maker.publicKey, Keypair.generate()
        );
        await mintTo(
          connection, admin.payer, premiumMint,
          mmPremiumAccount, admin.publicKey, 1_000_000
        );
        await approve(
          connection, admin.payer, mmPremiumAccount,
          settlerConfigPda, maker, 1_000_000
        );

        // User receives premium here
        userPremiumAccount = await createAccount(
          connection, admin.payer, premiumMint,
          user.publicKey, Keypair.generate()
        );

        // Treasury premium account
        treasuryPremiumAccount = await createAccount(
          connection, admin.payer, premiumMint,
          treasury.publicKey, Keypair.generate()
        );

        // Init vault counter for settler PDA
        [vaultCounterForSettler] = findVaultCounterPda(
          settlerConfigPda, controllerProgram.programId
        );
        await batchSettlerProgram.methods
          .initVaultCounter()
          .accounts({
            settlerConfig: settlerConfigPda,
            owner: admin.publicKey,
            vaultCounter: vaultCounterForSettler,
            controllerProgram: controllerProgram.programId,
            systemProgram: SystemProgram.programId,
          })
          .rpc();

        // Vault PDA (vault_id = 0 for settler PDA)
        [vaultPda] = findVaultPda(
          settlerConfigPda, new BN(0),
          controllerProgram.programId
        );

        // Maker oToken balance PDA
        [makerOTokenBalancePda] = findMakerOTokenBalancePda(
          maker.publicKey, otokenMint,
          batchSettlerProgram.programId
        );
      });

      it("executes order: user sells option, MM buys", async () => {
        const message = buildQuoteMessage(
          otokenMint, bidPrice, deadline,
          quoteId, maxAmount, makerNonce
        );

        const ed25519Ix =
          Ed25519Program.createInstructionWithPrivateKey({
            privateKey: maker.secretKey,
            message: message,
          });

        const [quoteFillPda] = findQuoteFillPda(
          maker.publicKey, quoteId,
          batchSettlerProgram.programId
        );
        const [makerStatePda] = findMakerStatePda(
          maker.publicKey, batchSettlerProgram.programId
        );

        const executeOrderIx =
          await batchSettlerProgram.methods
            .executeOrder(
              orderAmount, bidPrice, deadline,
              quoteId, maxAmount, makerNonce,
              collateralAmount, collateralMint
            )
            .accounts({
              settlerConfig: settlerConfigPda,
              makerState: makerStatePda,
              quoteFill: quoteFillPda,
              controllerConfig: controllerConfigPda,
              vault: vaultPda,
              vaultCounter: vaultCounterForSettler,
              otokenInfo: otokenInfoPda,
              otokenMint: otokenMint,
              userCollateralAccount: userCollateralAccount,
              poolTokenAccount: poolTokenAccount,
              settlerOtokenAccount: settlerOtokenAccount,
              mmPremiumAccount: mmPremiumAccount,
              userPremiumAccount: userPremiumAccount,
              treasuryAccount: treasuryPremiumAccount,
              makerOtokenBalance: makerOTokenBalancePda,
              vaultMm: findVaultMMPda(
                vaultPda, batchSettlerProgram.programId
              )[0],
              user: user.publicKey,
              maker: maker.publicKey,
              controllerProgram: controllerProgram.programId,
              tokenProgram: TOKEN_PROGRAM_ID,
              systemProgram: SystemProgram.programId,
              instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
            })
            .instruction();

        const { blockhash, lastValidBlockHeight } =
          await connection.getLatestBlockhash();
        const messageV0 = new TransactionMessage({
          payerKey: user.publicKey,
          recentBlockhash: blockhash,
          instructions: [ed25519Ix, executeOrderIx],
        }).compileToV0Message();
        const vtx = new VersionedTransaction(messageV0);
        vtx.sign([user]);

        const sig = await connection.sendRawTransaction(
          vtx.serialize()
        );
        await connection.confirmTransaction(
          { signature: sig, blockhash, lastValidBlockHeight }
        );

        // Vault created via CPI
        const vault =
          await controllerProgram.account.vault.fetch(vaultPda);
        assert.ok(vault.owner.equals(settlerConfigPda));
        assert.ok(
          vault.beneficiary.equals(user.publicKey),
          "beneficiary is user (seller)"
        );
        assert.equal(vault.collateralAmount.toNumber(), 20_000_000);
        assert.equal(vault.shortAmount.toNumber(), 1_000_000);

        // User's collateral went to pool
        const poolAcct = await getAccount(
          connection, poolTokenAccount
        );
        assert.equal(Number(poolAcct.amount), 20_000_000);
        const userColl = await getAccount(
          connection, userCollateralAccount
        );
        assert.equal(Number(userColl.amount), 0);

        // oTokens minted to settler custody (for MM)
        const settlerOt = await getAccount(
          connection, settlerOtokenAccount
        );
        assert.equal(Number(settlerOt.amount), 1_000_000);

        // MM custody ledger updated
        const mmBal =
          await batchSettlerProgram.account.makerOTokenBalance.fetch(
            makerOTokenBalancePda
          );
        assert.ok(mmBal.maker.equals(maker.publicKey));
        assert.ok(mmBal.otokenMint.equals(otokenMint));
        assert.equal(mmBal.balance.toNumber(), 1_000_000);

        // Premium flow: MM -> user (net), MM -> treasury (fee)
        // premium = 1M * 1e8 / 1e8 = 1M
        // fee = 1M * 500 / 10000 = 50k
        // net = 950k
        const userPrem = await getAccount(
          connection, userPremiumAccount
        );
        assert.equal(
          Number(userPrem.amount), 950_000,
          "user received net premium"
        );
        const mmPrem = await getAccount(
          connection, mmPremiumAccount
        );
        assert.equal(
          Number(mmPrem.amount), 0,
          "MM premium fully spent"
        );
        const treasuryPrem = await getAccount(
          connection, treasuryPremiumAccount
        );
        assert.equal(
          Number(treasuryPrem.amount), 50_000,
          "treasury received fee"
        );

        // Quote fill tracking
        const [quoteFillPda2] = findQuoteFillPda(
          maker.publicKey, quoteId,
          batchSettlerProgram.programId
        );
        const fill =
          await batchSettlerProgram.account.quoteFill.fetch(
            quoteFillPda2
          );
        assert.equal(fill.filledAmount.toNumber(), 1_000_000);
      });

      it("emergency withdraw: rejects wrong beneficiary", async () => {
        // Fully pause controller for emergency withdraw
        await controllerProgram.methods
          .setFullyPaused(true)
          .accounts({ admin: admin.publicKey })
          .rpc();

        try {
          // maker is NOT the vault beneficiary (user is)
          await batchSettlerProgram.methods
            .emergencyWithdraw()
            .accounts({
              settlerConfig: settlerConfigPda,
              beneficiary: maker.publicKey,
              controllerConfig: controllerConfigPda,
              vault: vaultPda,
              poolTokenAccount: poolTokenAccount,
              beneficiaryTokenAccount: userCollateralAccount,
              poolVaultAuthority: poolVaultAuthPda,
              maker: maker.publicKey,
              otokenMint: otokenMint,
              settlerOtokenAccount: settlerOtokenAccount,
              makerOtokenBalance: makerOTokenBalancePda,
              controllerProgram: controllerProgram.programId,
              tokenProgram: TOKEN_PROGRAM_ID,
            })
            .signers([maker])
            .rpc();
          assert.fail("should reject wrong beneficiary");
        } catch (err: any) {
          if (err.message === "should reject wrong beneficiary")
            throw err;
          assert.ok(
            err.toString().includes("nauthorized") ||
              err.toString().includes("ConstraintRaw"),
            "rejects wrong beneficiary"
          );
        }

        // Unpause for remaining tests
        await controllerProgram.methods
          .setFullyPaused(false)
          .accounts({ admin: admin.publicKey })
          .rpc();
      });

      it("emergency withdraw: returns collateral to beneficiary", async () => {
        // Fully pause controller
        await controllerProgram.methods
          .setFullyPaused(true)
          .accounts({ admin: admin.publicKey })
          .rpc();

        // user (beneficiary) calls emergency_withdraw
        await batchSettlerProgram.methods
          .emergencyWithdraw()
          .accounts({
            settlerConfig: settlerConfigPda,
            beneficiary: user.publicKey,
            controllerConfig: controllerConfigPda,
            vault: vaultPda,
            poolTokenAccount: poolTokenAccount,
            beneficiaryTokenAccount: userCollateralAccount,
            poolVaultAuthority: poolVaultAuthPda,
            maker: maker.publicKey,
            otokenMint: otokenMint,
            settlerOtokenAccount: settlerOtokenAccount,
            makerOtokenBalance: makerOTokenBalancePda,
            controllerProgram: controllerProgram.programId,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([user])
          .rpc();

        // oTokens burned from settler custody
        const settlerOt = await getAccount(
          connection, settlerOtokenAccount
        );
        assert.equal(
          Number(settlerOt.amount), 0,
          "oTokens burned from custody"
        );

        // MM balance cleared
        const mmBal =
          await batchSettlerProgram.account.makerOTokenBalance.fetch(
            makerOTokenBalancePda
          );
        assert.equal(
          mmBal.balance.toNumber(), 0,
          "MM balance cleared"
        );

        // Collateral returned to beneficiary (user)
        const userColl = await getAccount(
          connection, userCollateralAccount
        );
        assert.equal(
          Number(userColl.amount), 20_000_000,
          "collateral returned to beneficiary"
        );

        // Vault marked as settled
        const vault =
          await controllerProgram.account.vault.fetch(vaultPda);
        assert.equal(
          vault.settled, true,
          "vault settled after emergency withdraw"
        );
      });

      it("rejects order with stale nonce", async () => {
        // Increment nonce from 1 to 2
        await batchSettlerProgram.methods
          .incrementMakerNonce()
          .accounts({ maker: maker.publicKey })
          .signers([maker])
          .rpc();

        const staleNonce = new BN(1);
        const newQuoteId = new BN(200);
        const message = buildQuoteMessage(
          otokenMint, bidPrice, deadline,
          newQuoteId, maxAmount, staleNonce
        );

        const ed25519Ix =
          Ed25519Program.createInstructionWithPrivateKey({
            privateKey: maker.secretKey,
            message: message,
          });

        const [quoteFillPda] = findQuoteFillPda(
          maker.publicKey, newQuoteId,
          batchSettlerProgram.programId
        );
        const [makerStatePda] = findMakerStatePda(
          maker.publicKey, batchSettlerProgram.programId
        );
        const [newVaultPda] = findVaultPda(
          settlerConfigPda, new BN(1),
          controllerProgram.programId
        );
        const [newMmBalPda] = findMakerOTokenBalancePda(
          maker.publicKey, otokenMint,
          batchSettlerProgram.programId
        );

        const executeOrderIx =
          await batchSettlerProgram.methods
            .executeOrder(
              orderAmount, bidPrice, deadline,
              newQuoteId, maxAmount, staleNonce,
              collateralAmount, collateralMint
            )
            .accounts({
              settlerConfig: settlerConfigPda,
              makerState: makerStatePda,
              quoteFill: quoteFillPda,
              controllerConfig: controllerConfigPda,
              vault: newVaultPda,
              vaultCounter: vaultCounterForSettler,
              otokenInfo: otokenInfoPda,
              otokenMint: otokenMint,
              userCollateralAccount: userCollateralAccount,
              poolTokenAccount: poolTokenAccount,
              settlerOtokenAccount: settlerOtokenAccount,
              mmPremiumAccount: mmPremiumAccount,
              userPremiumAccount: userPremiumAccount,
              treasuryAccount: treasuryPremiumAccount,
              makerOtokenBalance: newMmBalPda,
              vaultMm: findVaultMMPda(
                newVaultPda, batchSettlerProgram.programId
              )[0],
              user: user.publicKey,
              maker: maker.publicKey,
              controllerProgram: controllerProgram.programId,
              tokenProgram: TOKEN_PROGRAM_ID,
              systemProgram: SystemProgram.programId,
              instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
            })
            .instruction();

        const { blockhash } =
          await connection.getLatestBlockhash();
        const msgV0 = new TransactionMessage({
          payerKey: user.publicKey,
          recentBlockhash: blockhash,
          instructions: [ed25519Ix, executeOrderIx],
        }).compileToV0Message();
        const vtx = new VersionedTransaction(msgV0);
        vtx.sign([user]);

        try {
          await connection.sendRawTransaction(vtx.serialize());
          assert.fail("should reject stale nonce");
        } catch (err: any) {
          if (err.message === "should reject stale nonce")
            throw err;
          const logs = (err.logs || []).join("\n");
          assert.ok(
            logs.includes("InvalidNonce") ||
              err.message.includes("0x1774"),
            "rejects with InvalidNonce"
          );
        }
      });
    });
  });
});
