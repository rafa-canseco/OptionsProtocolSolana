import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createMint,
  createAccount,
  mintTo,
  getAccount,
} from "@solana/spl-token";
import { assert } from "chai";
import { AddressBook } from "../target/types/address_book";
import { MarginPool } from "../target/types/margin_pool";
import { Controller } from "../target/types/controller";

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

describe("b1nary-options", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const addressBookProgram = anchor.workspace
    .addressBook as Program<AddressBook>;
  const marginPoolProgram = anchor.workspace
    .marginPool as Program<MarginPool>;
  const controllerProgram = anchor.workspace
    .controller as Program<Controller>;

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
      // Cannot re-init because PDA already exists.
      // Instead test set_address with zero address.
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

      // Create the vault token account owned by the PDA authority
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

    let collateralMint: PublicKey;
    let otokenMint: PublicKey;
    let otokenInfoPda: PublicKey;
    let vaultPda: PublicKey;
    let vaultCounterPda: PublicKey;
    let userCollateralAccount: PublicKey;
    let poolTokenAccount: PublicKey;
    let poolVaultAuthPda: PublicKey;
    let ownerOtokenAccount: PublicKey;

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

    it("opens a vault", async () => {
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
        .openVault(collateralMint)
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

      // Create a pool token account to receive the deposit.
      // In production the controller would CPI into margin_pool,
      // but here the controller does a direct SPL transfer.
      // pool_vault_auth PDA from the controller program is used
      // as authority for settle/redeem, but the pool token
      // account just needs to exist for the deposit transfer.
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

    it("mints oTokens with collateral sufficiency check", async () => {
      // Create the oToken mint with controller config PDA as authority
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

      // Create OTokenInfo via the controller's create_otoken_info instruction.
      // Put option: strike $2000 (200_000_000_000 in 8 decimals),
      // expiry=0 (already expired), collateral_decimals=6.
      const underlying = Keypair.generate().publicKey;
      const strikeAsset = Keypair.generate().publicKey;

      [otokenInfoPda] = findOTokenInfoPda(
        otokenMint,
        controllerProgram.programId
      );

      await controllerProgram.methods
        .createOtokenInfo(
          otokenMint,
          underlying,
          strikeAsset,
          collateralMint,
          new BN("200000000000"),
          new BN(0),
          true,
          6
        )
        .accounts({
          config: configPda,
          otokenInfo: otokenInfoPda,
          otokenMint: otokenMint,
          admin: admin.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      // Set expiry price: $1800 in 8 decimals
      await controllerProgram.methods
        .setExpiryPrice(new BN("180000000000"))
        .accounts({
          config: configPda,
          otokenInfo: otokenInfoPda,
          admin: admin.publicKey,
        })
        .rpc();

      const otokenInfo =
        await controllerProgram.account.oTokenInfo.fetch(
          otokenInfoPda
        );
      assert.ok(
        otokenInfo.otokenMint.equals(otokenMint),
        "otoken mint matches"
      );
      assert.equal(
        otokenInfo.strikePrice.toNumber(),
        200_000_000_000,
        "strike price"
      );
      assert.equal(
        otokenInfo.expiryPrice.toNumber(),
        180_000_000_000,
        "expiry price set"
      );

      // Mint 1 oToken (1e8 units). Required collateral for a put:
      // (100_000_000 * 200_000_000_000) / 10^10 = 2_000_000
      // We have 5_000_000 deposited, so this should succeed.
      const mintAmount = new BN(100_000_000);

      await controllerProgram.methods
        .mintOtoken(mintAmount)
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

    it("rejects minting with insufficient collateral", async () => {
      // 5_000_000_000 collateral. Each oToken needs 2_000_000_000.
      // Already minted 1, trying 4 more = 5 total.
      // 5 * 2_000_000_000 = 10_000_000_000 > 5_000_000_000.
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

    it("settles vault after expiry", async () => {
      // expiry=0 so the option is already expired.
      // Put option: strike=$2000, expiry_price=$1800 (ITM)
      // payout = (100_000_000 * (200_000_000_000 - 180_000_000_000))
      //          / 10^10
      //        = (100_000_000 * 20_000_000_000) / 10^10
      //        = 200_000
      // collateral_returned = 5_000_000_000 - 200_000_000 = 4_800_000_000

      const ownerCollateralAccount = await createAccount(
        connection,
        admin.payer,
        collateralMint,
        admin.publicKey,
        Keypair.generate()
      );

      await controllerProgram.methods
        .settleVault(new BN("180000000000"))
        .accounts({
          config: configPda,
          vault: vaultPda,
          otokenInfo: otokenInfoPda,
          poolTokenAccount: poolTokenAccount,
          ownerTokenAccount: ownerCollateralAccount,
          poolVaultAuthority: poolVaultAuthPda,
          settler: admin.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();

      const vault =
        await controllerProgram.account.vault.fetch(vaultPda);
      assert.equal(vault.settled, true, "vault settled");

      const ownerAcct = await getAccount(
        connection,
        ownerCollateralAccount
      );
      assert.equal(
        Number(ownerAcct.amount),
        4_800_000_000,
        "collateral returned to owner"
      );

      const poolAcct = await getAccount(
        connection,
        poolTokenAccount
      );
      assert.equal(
        Number(poolAcct.amount),
        200_000_000,
        "payout reserved in pool"
      );
    });

    it("rejects settling an already-settled vault", async () => {
      const dummyOwnerAcct = await createAccount(
        connection,
        admin.payer,
        collateralMint,
        admin.publicKey,
        Keypair.generate()
      );

      try {
        await controllerProgram.methods
          .settleVault(new BN("180000000000"))
          .accounts({
            config: configPda,
            vault: vaultPda,
            otokenInfo: otokenInfoPda,
            poolTokenAccount: poolTokenAccount,
            ownerTokenAccount: dummyOwnerAcct,
            poolVaultAuthority: poolVaultAuthPda,
            settler: admin.publicKey,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .rpc();
        assert.fail("should reject re-settlement");
      } catch (err: any) {
        assert.include(
          err.toString(),
          "Vault already settled"
        );
      }
    });

    it("redeems oTokens for payout", async () => {
      // The redeemer holds 100_000_000 oTokens (minted earlier).
      // Put ITM: payout for 100_000_000 units at expiry_price stored
      // in otoken_info = 200_000_000 (same math as settle).
      // Pool has 200_000_000 remaining.
      const redeemerCollateralAccount = await createAccount(
        connection,
        admin.payer,
        collateralMint,
        admin.publicKey,
        Keypair.generate()
      );

      await controllerProgram.methods
        .redeem(new BN(100_000_000))
        .accounts({
          config: configPda,
          otokenInfo: otokenInfoPda,
          otokenMint: otokenMint,
          redeemerOtokenAccount: ownerOtokenAccount,
          redeemerCollateralAccount: redeemerCollateralAccount,
          poolTokenAccount: poolTokenAccount,
          poolVaultAuthority: poolVaultAuthPda,
          redeemer: admin.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();

      const redeemerAcct = await getAccount(
        connection,
        redeemerCollateralAccount
      );
      assert.equal(
        Number(redeemerAcct.amount),
        200_000_000,
        "payout received by redeemer"
      );

      const otokenAcct = await getAccount(
        connection,
        ownerOtokenAccount
      );
      assert.equal(
        Number(otokenAcct.amount),
        0,
        "oTokens burned"
      );

      const poolAcct = await getAccount(
        connection,
        poolTokenAccount
      );
      assert.equal(
        Number(poolAcct.amount),
        0,
        "pool drained after full redeem"
      );
    });

    it("opens a second vault and increments counter", async () => {
      const [vaultPda2] = findVaultPda(
        admin.publicKey,
        new BN(1),
        controllerProgram.programId
      );

      await controllerProgram.methods
        .openVault(collateralMint)
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
      // Re-set partial pauser to admin for simplicity
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
          .openVault(collateralMint)
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
          .openVault(collateralMint)
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

      // Verify we can open a vault again
      const [vaultPda3] = findVaultPda(
        admin.publicKey,
        new BN(2),
        controllerProgram.programId
      );

      await controllerProgram.methods
        .openVault(collateralMint)
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
        // The constraint checks caller == admin || caller == partial_pauser
        assert.include(err.toString(), "nauthorized");
      }
    });
  });
});
