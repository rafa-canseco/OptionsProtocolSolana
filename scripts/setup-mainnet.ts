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
 *   MAINNET_SEED_NONCE=<random-secret-string> \
 *   ANCHOR_PROVIDER_URL=https://api.mainnet-beta.solana.com \
 *   ANCHOR_WALLET='usb://ledger?key=0/0' \
 *   OPERATOR_PUBKEY=<hot-wallet> \
 *   TREASURY_PUBKEY=<treasury> \
 *   MM_PUBKEY=<mm-hot-wallet> \
 *   npx ts-node scripts/setup-mainnet.ts
 *
 * MAINNET_SEED_NONCE: a private string mixed into the deterministic
 * keypairs used for vault token accounts. Keep it secret and reuse the
 * same value on re-runs so the script stays idempotent. Without it,
 * the keypairs would be derivable from the public repo and an attacker
 * could front-run the deploy by initializing the same accounts first.
 *
 * Current whitelist program only supports oToken allowlisting. Asset
 * and product allowlists were removed from the on-chain surface, so
 * this setup only initializes whitelist config and records the factory.
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
  Connection,
  AddressLookupTableProgram,
  Ed25519Program,
  SYSVAR_INSTRUCTIONS_PUBKEY,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createApproveCheckedInstruction,
  createInitializeAccountInstruction,
  getAccount,
  getAccountLenForMint,
  getAssociatedTokenAddressSync,
  getMint,
} from "@solana/spl-token";
import * as crypto from "crypto";
import TransportNodeHid from "@ledgerhq/hw-transport-node-hid";
import SolanaLedger from "@ledgerhq/hw-app-solana";

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

const PYTH_RECEIVER_PROGRAM = new PublicKey(
  "rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ"
);
const JUPITER_PROGRAM = new PublicKey(
  "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4"
);

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
const LEDGER_DEFAULT_PATH = "44'/501'/0'/0'";
const LEDGER_EXPECTED_ADMIN = new PublicKey(
  "DPPoFZypoJ8tfRGGxCdoLo1uLZ4qhf6xypzaCftybsX6"
);

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

async function accountExists(
  connection: Connection,
  pubkey: PublicKey
): Promise<boolean> {
  return (await connection.getAccountInfo(pubkey)) !== null;
}

async function fetchOrNull(
  program: Program,
  accountName: string,
  pubkey: PublicKey
) {
  try {
    return await program.account[accountName].fetch(pubkey);
  } catch (e) {
    return null;
  }
}

async function createVaultAccount(
  connection,
  payer,
  program,
  mintCfg,
  label: string
) {
  const poolVault = findPda(
    [Buffer.from("pool_vault"), mintCfg.mint.toBuffer()],
    program.programId
  );
  const vaultAuth = findPda(
    [Buffer.from("lending_vault_auth"), mintCfg.mint.toBuffer()],
    program.programId
  );
  // Seed nonce comes from env so the keypair can't be pre-computed from the
  // public repo. Idempotent across re-runs as long as the same nonce is used.
  const seedNonce = process.env.MAINNET_SEED_NONCE;
  if (!seedNonce) {
    throw new Error(
      "MAINNET_SEED_NONCE env var is required (use the same value across re-runs to keep idempotence)"
    );
  }
  const tokenKp = keypairFromSeed(
    `${seedNonce}:b1nary-mainnet-vault-${label.toLowerCase()}-v1`
  );
  let tokenAccount = tokenKp.publicKey;

  if (!(await accountExists(connection, tokenAccount))) {
    try {
      const mint = await getMint(
        connection,
        mintCfg.mint,
        undefined,
        mintCfg.tokenProgram
      );
      const space = getAccountLenForMint(mint);
      const lamports = await connection.getMinimumBalanceForRentExemption(
        space
      );
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
          mintCfg.tokenProgram
        )
      );
      await providerSend(connection, payer, tx, [tokenKp]);
    } catch (e: any) {
      if (
        !String(e).includes("already in use") &&
        !String(e).includes("custom program error: 0x0")
      )
        throw e;
    }
  }

  return { poolVault, vaultAuth, tokenAccount };
}

async function providerSend(connection, wallet, tx: Transaction, signers = []) {
  const provider = anchor.getProvider() as anchor.AnchorProvider;
  return provider.sendAndConfirm(tx, signers);
}

function controllerPoolVaultAuth(
  controllerProgramId: PublicKey,
  mint: PublicKey
): PublicKey {
  return findPda(
    [Buffer.from("pool_vault_auth"), mint.toBuffer()],
    controllerProgramId
  );
}

function controllerPoolTokenAccount(
  controllerProgramId: PublicKey,
  mintCfg
): PublicKey {
  return getAssociatedTokenAddressSync(
    mintCfg.mint,
    controllerPoolVaultAuth(controllerProgramId, mintCfg.mint),
    true,
    mintCfg.tokenProgram,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
}

function ledgerPathFromWallet(walletPath?: string): string {
  if (!walletPath?.startsWith("usb://ledger")) {
    return LEDGER_DEFAULT_PATH;
  }

  const keyMatch = walletPath.match(/[?&]key=([^&]+)/);
  if (!keyMatch) {
    return LEDGER_DEFAULT_PATH;
  }

  const key = decodeURIComponent(keyMatch[1]);
  const parts = key.split("/");
  if (parts.length === 2) {
    // solana-cli usb://ledger?key=account/change maps to 44'/501'/account'/change'.
    return `44'/501'/${parts[0]}'/${parts[1]}'`;
  }
  if (parts.length === 3) {
    return `44'/501'/${parts[0]}'/${parts[1]}'/${parts[2]}'`;
  }
  throw new Error(
    `Unsupported Ledger key derivation in ANCHOR_WALLET: ${walletPath}`
  );
}

class LedgerWallet {
  public publicKey: PublicKey;
  private transport: any;
  private solana: any;

  private constructor(
    private path: string,
    publicKey: PublicKey,
    transport: any,
    solana: any
  ) {
    this.publicKey = publicKey;
    this.transport = transport;
    this.solana = solana;
  }

  static async create(path: string) {
    const transport = await TransportNodeHid.create();
    const solana = new SolanaLedger(transport);
    const { address } = await solana.getAddress(path, false);
    const publicKey = new PublicKey(address);
    if (!publicKey.equals(LEDGER_EXPECTED_ADMIN)) {
      await transport.close();
      throw new Error(
        `Ledger path ${path} derived ${publicKey.toBase58()}, expected ${LEDGER_EXPECTED_ADMIN.toBase58()}`
      );
    }
    return new LedgerWallet(path, publicKey, transport, solana);
  }

  async signTransaction(tx) {
    if (!("serializeMessage" in tx)) {
      throw new Error(
        "LedgerWallet only supports legacy transactions in this setup script"
      );
    }
    const message = tx.serializeMessage();
    const { signature } = await this.solana.signTransaction(this.path, message);
    tx.addSignature(this.publicKey, Buffer.from(signature));
    return tx;
  }

  async signAllTransactions(txs) {
    const signed = [];
    for (const tx of txs) {
      signed.push(await this.signTransaction(tx));
    }
    return signed;
  }

  async close() {
    await this.transport.close();
  }
}

async function buildProvider() {
  const url = process.env.ANCHOR_PROVIDER_URL;
  if (!url) throw new Error("ANCHOR_PROVIDER_URL is required");

  const walletPath = process.env.ANCHOR_WALLET;
  if (walletPath?.startsWith("usb://ledger")) {
    const ledgerPath = ledgerPathFromWallet(walletPath);
    const ledgerWallet = await LedgerWallet.create(ledgerPath);
    const connection = new Connection(
      url,
      anchor.AnchorProvider.defaultOptions().commitment
    );
    return patchProviderSendAndConfirm(
      new anchor.AnchorProvider(
        connection,
        ledgerWallet as any,
        anchor.AnchorProvider.defaultOptions()
      )
    );
  }

  return patchProviderSendAndConfirm(anchor.AnchorProvider.env());
}

function patchProviderSendAndConfirm(provider: anchor.AnchorProvider) {
  provider.sendAndConfirm = async function (
    tx,
    signers = [],
    opts = this.opts
  ) {
    const latest = await this.connection.getLatestBlockhash(
      opts.preflightCommitment ?? opts.commitment ?? "confirmed"
    );
    tx.feePayer = tx.feePayer ?? this.wallet.publicKey;
    tx.recentBlockhash = latest.blockhash;
    for (const signer of signers ?? []) {
      tx.partialSign(signer);
    }
    const signed = await this.wallet.signTransaction(tx);
    const raw = signed.serialize();
    const signature = await this.connection.sendRawTransaction(raw, opts);
    await this.connection.confirmTransaction(
      {
        signature,
        blockhash: latest.blockhash,
        lastValidBlockHeight: latest.lastValidBlockHeight,
      },
      opts.commitment ?? "confirmed"
    );
    return signature;
  };
  return provider;
}

async function assertJupiterLiquidity(
  label: string,
  inputMint: PublicKey,
  outputMint: PublicKey,
  amount: bigint
) {
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
  if (
    !quote.outAmount ||
    BigInt(quote.outAmount) === 0n ||
    !quote.routePlan?.length
  ) {
    throw new Error(`Jupiter ${label} quote has no route`);
  }
  console.log(
    `Jupiter ${label}: out=${quote.outAmount} priceImpact=${
      quote.priceImpactPct ?? "n/a"
    } routes=${quote.routePlan
      .map((r) => r.swapInfo?.label)
      .filter(Boolean)
      .join(",")}`
  );
}

async function main() {
  if (process.env.MAINNET_CONFIRM !== MAINNET_CONFIRM) {
    throw new Error(
      `Refusing mainnet setup. Set MAINNET_CONFIRM=${MAINNET_CONFIRM}`
    );
  }

  const provider = await buildProvider();
  anchor.setProvider(provider);
  const wallet = provider.wallet as anchor.Wallet;
  const admin = wallet.publicKey;
  const connection = provider.connection;

  const operator = requireEnv("OPERATOR_PUBKEY");
  const treasury = requireEnv("TREASURY_PUBKEY");
  const mm = process.env.MM_PUBKEY
    ? new PublicKey(process.env.MM_PUBKEY)
    : operator;
  const approvalsOnly = process.env.RUN_APPROVALS_ONLY === "1";

  console.log("Cluster: mainnet-beta");
  console.log("Signer:", admin.toBase58());
  console.log("Operator:", operator.toBase58());
  console.log("Treasury:", treasury.toBase58());
  console.log("MM:", mm.toBase58());
  console.log(
    "Balance SOL:",
    (await connection.getBalance(admin)) / LAMPORTS_PER_SOL
  );
  await assertJupiterLiquidity(
    "TSLAx->USDC",
    MINTS.TSLAX.mint,
    MINTS.USDC.mint,
    100000000n
  );
  await assertJupiterLiquidity(
    "USDC->TSLAx",
    MINTS.USDC.mint,
    MINTS.TSLAX.mint,
    1000000000n
  );

  const programs = {
    whitelist: anchor.workspace.whitelist,
    oracle: anchor.workspace.oracle,
    controller: anchor.workspace.controller,
    marginPool: anchor.workspace.marginPool,
    otokenFactory: anchor.workspace.otokenFactory,
    batchSettler: anchor.workspace.batchSettler,
  };

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
    factoryOperator: findPda(
      [Buffer.from("factory_operator_config")],
      programs.otokenFactory.programId
    ),
    settler: findPda(
      [Buffer.from("settler_config")],
      programs.batchSettler.programId
    ),
  };

  if (!approvalsOnly) {
    const whitelistConfig = await fetchOrNull(
      programs.whitelist,
      "whitelistConfig",
      pdas.whitelist
    );
    if (!whitelistConfig) {
      await tryRpc("whitelist.initialize", () =>
        programs.whitelist.methods
          .initialize(admin)
          .accounts({ payer: admin })
          .rpc()
      );
    } else {
      console.log("  whitelist.initialize: already done");
    }
    const refreshedWhitelistConfig =
      (await fetchOrNull(
        programs.whitelist,
        "whitelistConfig",
        pdas.whitelist
      )) ?? whitelistConfig;
    if (
      !refreshedWhitelistConfig.factory?.equals(
        programs.otokenFactory.programId
      )
    ) {
      await tryRpc("whitelist.setFactory", () =>
        programs.whitelist.methods
          .setFactory(programs.otokenFactory.programId)
          .accounts({ admin })
          .rpc()
      );
    } else {
      console.log("  whitelist.setFactory: already correct");
    }

    if (!(await accountExists(connection, pdas.oracle))) {
      await tryRpc("oracle.initialize", () =>
        programs.oracle.methods
          .initialize(
            admin,
            operator,
            PYTH_RECEIVER_PROGRAM,
            MAX_ORACLE_STALENESS,
            MAX_CONFIDENCE_BPS,
            PRICE_DEVIATION_BPS
          )
          .accounts({ payer: admin })
          .rpc()
      );
    } else {
      console.log("  oracle.initialize: already done");
    }
    for (const [name, mint, feed] of [
      ["SOL/USD", MINTS.WSOL.mint, PYTH_FEEDS.SOL_USD],
      ["TSLAx/USD", MINTS.TSLAX.mint, PYTH_FEEDS.TSLAX_USD],
    ]) {
      const feedPda = findPda(
        [Buffer.from("feed"), mint.toBuffer()],
        programs.oracle.programId
      );
      if (!(await accountExists(connection, feedPda))) {
        await tryRpc(`oracle.registerFeed(${name})`, () =>
          programs.oracle.methods
            .registerFeed(mint, hexToBytes(feed))
            .accounts({ admin })
            .rpc()
        );
      } else {
        console.log(`  oracle.registerFeed(${name}): already done`);
      }
    }

    if (!(await accountExists(connection, pdas.controller))) {
      await tryRpc("controller.initialize", () =>
        programs.controller.methods
          .initialize(admin)
          .accounts({ payer: admin })
          .rpc()
      );
    } else {
      console.log("  controller.initialize: already done");
    }
    if (!(await accountExists(connection, pdas.marginPool))) {
      await tryRpc("marginPool.initialize", () =>
        programs.marginPool.methods
          .initialize(pdas.controller, operator, operator)
          .accounts({ admin })
          .rpc()
      );
    } else {
      console.log("  marginPool.initialize: already done");
    }
    for (const [name, cfg] of Object.entries(MINTS)) {
      const poolVault = findPda(
        [Buffer.from("pool_vault"), cfg.mint.toBuffer()],
        programs.marginPool.programId
      );
      if (!(await accountExists(connection, poolVault))) {
        const vault = await createVaultAccount(
          connection,
          wallet,
          programs.marginPool,
          cfg,
          name
        );
        await tryRpc(`marginPool.createPoolVault(${name})`, () =>
          programs.marginPool.methods
            .createPoolVault()
            .accounts({
              config: pdas.marginPool,
              poolVault: vault.poolVault,
              vaultTokenAccount: vault.tokenAccount,
              vaultAuthority: vault.vaultAuth,
              collateralMint: cfg.mint,
              admin,
              systemProgram: SystemProgram.programId,
            })
            .rpc()
        );
      } else {
        console.log(`  marginPool.createPoolVault(${name}): already done`);
      }
    }

    for (const [name, cfg] of Object.entries(MINTS)) {
      const poolAuth = controllerPoolVaultAuth(
        programs.controller.programId,
        cfg.mint
      );
      const poolToken = controllerPoolTokenAccount(
        programs.controller.programId,
        cfg
      );
      if (!(await accountExists(connection, poolToken))) {
        await tryRpc(`controller pool token ATA(${name})`, () =>
          provider.sendAndConfirm(
            new Transaction().add(
              createAssociatedTokenAccountIdempotentInstruction(
                admin,
                poolToken,
                poolAuth,
                cfg.mint,
                cfg.tokenProgram,
                ASSOCIATED_TOKEN_PROGRAM_ID
              )
            ),
            []
          )
        );
      } else {
        console.log(`  controller pool token ATA(${name}): already done`);
      }
      console.log(
        `Controller ${name} pool token account:`,
        poolToken.toBase58()
      );
    }

    if (!(await accountExists(connection, pdas.factory))) {
      await tryRpc("factory.initialize", () =>
        programs.otokenFactory.methods
          .initialize(admin)
          .accounts({ payer: admin })
          .rpc()
      );
    } else {
      console.log("  factory.initialize: already done");
    }
    const factoryConfig = await fetchOrNull(
      programs.otokenFactory,
      "factoryConfig",
      pdas.factory
    );
    if (!factoryConfig?.controller?.equals(pdas.controller)) {
      await tryRpc("factory.setController", () =>
        programs.otokenFactory.methods
          .setController(pdas.controller)
          .accounts({ admin })
          .rpc()
      );
    } else {
      console.log("  factory.setController: already correct");
    }
    const factoryOperatorConfig = await fetchOrNull(
      programs.otokenFactory,
      "factoryOperatorConfig",
      pdas.factoryOperator
    );
    if (!factoryOperatorConfig?.operator?.equals(operator)) {
      await tryRpc("factory.setOperator", () =>
        programs.otokenFactory.methods
          .setOperator(operator)
          .accounts({
            factoryConfig: pdas.factory,
            operatorConfig: pdas.factoryOperator,
            admin,
            systemProgram: SystemProgram.programId,
          })
          .rpc()
      );
    } else {
      console.log("  factory.setOperator: already correct");
    }
    if (!(await accountExists(connection, pdas.settler))) {
      await tryRpc("settler.initialize", () =>
        programs.batchSettler.methods
          .initialize(
            operator,
            treasury,
            PROTOCOL_FEE_BPS,
            MIN_ESCAPE_DELAY,
            JUPITER_PROGRAM
          )
          .accounts({ payer: admin })
          .rpc()
      );
    } else {
      console.log("  settler.initialize: already done");
    }
    const makerState = findPda(
      [Buffer.from("maker"), mm.toBuffer()],
      programs.batchSettler.programId
    );
    const makerStateAccount = await fetchOrNull(
      programs.batchSettler,
      "makerState",
      makerState
    );
    if (!makerStateAccount?.whitelisted) {
      await tryRpc("settler.whitelistMaker(mm)", () =>
        programs.batchSettler.methods
          .whitelistMaker(mm, true)
          .accounts({ owner: admin })
          .rpc()
      );
    } else {
      console.log("  settler.whitelistMaker(mm): already done");
    }
    const vaultCounter = findPda(
      [Buffer.from("vault_counter"), pdas.settler.toBuffer()],
      programs.controller.programId
    );
    if (!(await accountExists(connection, vaultCounter))) {
      await tryRpc("settler.initVaultCounter", () =>
        programs.batchSettler.methods
          .initVaultCounter()
          .accounts({
            settlerConfig: pdas.settler,
            owner: admin,
            vaultCounter,
            controllerProgram: programs.controller.programId,
            systemProgram: SystemProgram.programId,
          })
          .rpc()
      );
    } else {
      console.log("  settler.initVaultCounter: already done");
    }
  }

  const treasuryUsdc = getAssociatedTokenAddressSync(
    MINTS.USDC.mint,
    treasury,
    true,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
  const mmUsdc = getAssociatedTokenAddressSync(
    MINTS.USDC.mint,
    mm,
    false,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
  if (!(await accountExists(connection, treasuryUsdc))) {
    await tryRpc("create treasury USDC ATA", () =>
      provider.sendAndConfirm(
        new Transaction().add(
          createAssociatedTokenAccountIdempotentInstruction(
            admin,
            treasuryUsdc,
            treasury,
            MINTS.USDC.mint,
            TOKEN_PROGRAM_ID,
            ASSOCIATED_TOKEN_PROGRAM_ID
          )
        ),
        []
      )
    );
  } else {
    console.log("  create treasury USDC ATA: already done");
  }
  if (!(await accountExists(connection, mmUsdc))) {
    await tryRpc("create MM USDC ATA", () =>
      provider.sendAndConfirm(
        new Transaction().add(
          createAssociatedTokenAccountIdempotentInstruction(
            admin,
            mmUsdc,
            mm,
            MINTS.USDC.mint,
            TOKEN_PROGRAM_ID,
            ASSOCIATED_TOKEN_PROGRAM_ID
          )
        ),
        []
      )
    );
  } else {
    console.log("  create MM USDC ATA: already done");
  }
  console.log("Treasury USDC ATA:", treasuryUsdc.toBase58());
  console.log("MM USDC ATA:", mmUsdc.toBase58());

  if (admin.equals(mm)) {
    const mmAccount = await getAccount(
      connection,
      mmUsdc,
      undefined,
      TOKEN_PROGRAM_ID
    );
    if (
      mmAccount.delegate?.equals(pdas.settler) &&
      mmAccount.delegatedAmount >= MAX_MM_USDC_DELEGATION
    ) {
      console.log("  MM USDC approve settler_config delegate: already done");
    } else {
      const approveIx = createApproveCheckedInstruction(
        mmUsdc,
        MINTS.USDC.mint,
        pdas.settler,
        mm,
        MAX_MM_USDC_DELEGATION,
        MINTS.USDC.decimals,
        [],
        TOKEN_PROGRAM_ID
      );
      await tryRpc("MM USDC approve settler_config delegate", () =>
        provider.sendAndConfirm(new Transaction().add(approveIx), [])
      );
    }
  } else {
    console.log(
      "MM approval skipped: rerun with ANCHOR_WALLET set to the MM hot wallet and RUN_APPROVALS_ONLY=1."
    );
  }

  if (!approvalsOnly) {
    const vaultCounter = findPda(
      [Buffer.from("vault_counter"), pdas.settler.toBuffer()],
      programs.controller.programId
    );
    const makerState = findPda(
      [Buffer.from("maker"), mm.toBuffer()],
      programs.batchSettler.programId
    );
    const controllerPoolEntries = Object.values(MINTS).flatMap((cfg) => [
      cfg.mint,
      controllerPoolVaultAuth(programs.controller.programId, cfg.mint),
      controllerPoolTokenAccount(programs.controller.programId, cfg),
      cfg.tokenProgram,
    ]);
    const lookupAddresses = Array.from(
      new Map(
        [
          programs.whitelist.programId,
          programs.oracle.programId,
          programs.marginPool.programId,
          programs.otokenFactory.programId,
          programs.batchSettler.programId,
          programs.controller.programId,
          pdas.whitelist,
          pdas.oracle,
          pdas.marginPool,
          pdas.factory,
          pdas.controller,
          pdas.settler,
          vaultCounter,
          makerState,
          treasuryUsdc,
          mmUsdc,
          JUPITER_PROGRAM,
          PYTH_RECEIVER_PROGRAM,
          TOKEN_PROGRAM_ID,
          TOKEN_2022_PROGRAM_ID,
          ASSOCIATED_TOKEN_PROGRAM_ID,
          SystemProgram.programId,
          SYSVAR_INSTRUCTIONS_PUBKEY,
          Ed25519Program.programId,
          ...controllerPoolEntries,
        ].map((pubkey) => [pubkey.toBase58(), pubkey])
      ).values()
    );

    if (process.env.MAINNET_ALT_ADDRESS) {
      const lookupTable = new PublicKey(process.env.MAINNET_ALT_ADDRESS);
      for (let i = 0; i < lookupAddresses.length; i += 20) {
        const chunk = lookupAddresses.slice(i, i + 20);
        await tryRpc(`ALT.extend(${i / 20 + 1})`, () =>
          provider.sendAndConfirm(
            new Transaction().add(
              AddressLookupTableProgram.extendLookupTable({
                authority: admin,
                payer: admin,
                lookupTable,
                addresses: chunk,
              })
            ),
            []
          )
        );
      }
      console.log("Address Lookup Table:", lookupTable.toBase58());
    } else {
      const recentSlot = Math.max(
        (await connection.getSlot("confirmed")) - 1,
        0
      );
      const [createLookupIx, lookupTable] =
        AddressLookupTableProgram.createLookupTable({
          authority: admin,
          payer: admin,
          recentSlot,
        });
      await tryRpc("ALT.create", () =>
        provider.sendAndConfirm(new Transaction().add(createLookupIx), [])
      );
      for (let i = 0; i < lookupAddresses.length; i += 20) {
        const chunk = lookupAddresses.slice(i, i + 20);
        await tryRpc(`ALT.extend(${i / 20 + 1})`, () =>
          provider.sendAndConfirm(
            new Transaction().add(
              AddressLookupTableProgram.extendLookupTable({
                authority: admin,
                payer: admin,
                lookupTable,
                addresses: chunk,
              })
            ),
            []
          )
        );
      }
      console.log("Address Lookup Table:", lookupTable.toBase58());
    }
  }

  console.log("Mainnet setup script complete.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
