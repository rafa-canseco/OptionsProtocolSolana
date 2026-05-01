use anchor_lang::prelude::*;

declare_id!("EMgyserXHEQz4dYTT9LoSa5KNszXnTruV6LL5w63dvJd");

const BPS_DENOMINATOR: u64 = 10_000;

#[program]
pub mod oracle {
    use super::*;

    pub fn initialize(
        ctx: Context<InitializeOracle>,
        admin: Pubkey,
        operator: Pubkey,
        pyth_receiver_program: Pubkey,
        max_staleness_secs: u64,
        max_confidence_bps: u16,
        price_deviation_threshold_bps: u16,
    ) -> Result<()> {
        require!(admin != Pubkey::default(), OracleError::ZeroAddress);
        let config = &mut ctx.accounts.config;
        config.admin = admin;
        config.pending_admin = Pubkey::default();
        config.operator = operator;
        config.pyth_receiver_program = pyth_receiver_program;
        config.max_staleness_secs = max_staleness_secs;
        config.max_confidence_bps = max_confidence_bps;
        config.price_deviation_threshold_bps = price_deviation_threshold_bps;
        config.bump = ctx.bumps.config;
        emit!(OracleInitialized { admin, operator });
        Ok(())
    }

    pub fn register_feed(
        ctx: Context<RegisterFeed>,
        underlying: Pubkey,
        pyth_feed_id: [u8; 32],
    ) -> Result<()> {
        let feed = &mut ctx.accounts.feed;
        feed.underlying = underlying;
        feed.pyth_feed_id = pyth_feed_id;
        feed.active = true;
        feed.bump = ctx.bumps.feed;
        emit!(PriceFeedRegistered {
            underlying,
            pyth_feed_id,
        });
        Ok(())
    }

    pub fn deregister_feed(ctx: Context<DeregisterFeed>) -> Result<()> {
        let feed = &mut ctx.accounts.feed;
        require!(feed.active, OracleError::FeedNotActive);
        feed.active = false;
        emit!(PriceFeedDeregistered {
            underlying: feed.underlying,
        });
        Ok(())
    }

    pub fn set_feed_active(ctx: Context<DeregisterFeed>, active: bool) -> Result<()> {
        let feed = &mut ctx.accounts.feed;
        feed.active = active;
        emit!(PriceFeedStatusUpdated {
            underlying: feed.underlying,
            active,
        });
        Ok(())
    }

    /// Read and validate Pyth price for a registered underlying.
    /// Returns the price normalized to 8 decimal places.
    pub fn get_price(ctx: Context<GetPrice>) -> Result<u64> {
        let config = &ctx.accounts.config;
        let feed = &ctx.accounts.feed;
        require!(feed.active, OracleError::FeedNotActive);

        let pyth = parse_pyth_price_update(
            &ctx.accounts.pyth_price_update,
            &config.pyth_receiver_program,
            &feed.pyth_feed_id,
        )?;

        validate_staleness(pyth.publish_time, config.max_staleness_secs)?;
        validate_confidence(pyth.price, pyth.conf, config.max_confidence_bps)?;

        let normalized = normalize_to_8_decimals(pyth.price, pyth.exponent)?;

        emit!(PriceQueried {
            underlying: feed.underlying,
            price: normalized,
        });
        Ok(normalized)
    }

    /// Lock expiry price for settlement. The PDA [expiry_price,
    /// underlying, expiry] can only be created once — attempting to
    /// set the same underlying+expiry again fails (Anchor `init`).
    /// Validates submitted price against Pyth live feed when
    /// deviation threshold > 0 and feed is active.
    pub fn set_expiry_price(
        ctx: Context<SetExpiryPrice>,
        underlying: Pubkey,
        expiry: i64,
        price: u64,
    ) -> Result<()> {
        require!(price > 0, OracleError::InvalidPrice);

        let clock = Clock::get()?;
        require!(
            clock.unix_timestamp >= expiry,
            OracleError::ExpiryNotReached
        );

        let config = &ctx.accounts.config;
        let feed = &ctx.accounts.feed;

        require!(feed.active, OracleError::FeedNotActive);
        // Validate against Pyth if threshold set. A deregistered feed
        // must not be usable to bypass the deviation guard.
        if config.price_deviation_threshold_bps > 0 {
            let pyth = parse_pyth_price_update(
                &ctx.accounts.pyth_price_update,
                &config.pyth_receiver_program,
                &feed.pyth_feed_id,
            )?;

            validate_staleness(pyth.publish_time, config.max_staleness_secs)?;

            let pyth_normalized = normalize_to_8_decimals(pyth.price, pyth.exponent)?;

            validate_price_deviation(price, pyth_normalized, config.price_deviation_threshold_bps)?;
        }

        let ep = &mut ctx.accounts.expiry_price;
        ep.underlying = underlying;
        ep.expiry = expiry;
        ep.price = price;
        ep.is_finalized = true;
        ep.bump = ctx.bumps.expiry_price;

        emit!(ExpiryPriceSet {
            underlying,
            expiry,
            price,
        });
        Ok(())
    }

    /// Read stored expiry price (convenience for off-chain callers).
    pub fn get_expiry_price(ctx: Context<GetExpiryPrice>) -> Result<u64> {
        let ep = &ctx.accounts.expiry_price;
        require!(ep.is_finalized, OracleError::ExpiryPriceNotSet);
        Ok(ep.price)
    }

    // ── Admin functions ─────────────────────────────────────────

    pub fn set_operator(ctx: Context<AdminAction>, operator: Pubkey) -> Result<()> {
        require!(operator != Pubkey::default(), OracleError::ZeroAddress);
        emit!(OperatorUpdated {
            old: ctx.accounts.config.operator,
            new: operator,
        });
        ctx.accounts.config.operator = operator;
        Ok(())
    }

    pub fn set_price_deviation_threshold(
        ctx: Context<AdminAction>,
        threshold_bps: u16,
    ) -> Result<()> {
        emit!(PriceDeviationThresholdUpdated {
            old: ctx.accounts.config.price_deviation_threshold_bps,
            new: threshold_bps,
        });
        ctx.accounts.config.price_deviation_threshold_bps = threshold_bps;
        Ok(())
    }

    pub fn set_max_staleness(ctx: Context<AdminAction>, max_staleness_secs: u64) -> Result<()> {
        emit!(MaxStalenessUpdated {
            old: ctx.accounts.config.max_staleness_secs,
            new: max_staleness_secs,
        });
        ctx.accounts.config.max_staleness_secs = max_staleness_secs;
        Ok(())
    }

    pub fn set_max_confidence(ctx: Context<AdminAction>, max_confidence_bps: u16) -> Result<()> {
        emit!(MaxConfidenceUpdated {
            old: ctx.accounts.config.max_confidence_bps,
            new: max_confidence_bps,
        });
        ctx.accounts.config.max_confidence_bps = max_confidence_bps;
        Ok(())
    }

    pub fn transfer_ownership(ctx: Context<AdminAction>, new_admin: Pubkey) -> Result<()> {
        require!(new_admin != Pubkey::default(), OracleError::ZeroAddress);
        emit!(OwnershipTransferStarted {
            current: ctx.accounts.config.admin,
            pending: new_admin,
        });
        ctx.accounts.config.pending_admin = new_admin;
        Ok(())
    }

    pub fn accept_ownership(ctx: Context<AcceptOwnership>) -> Result<()> {
        let config = &mut ctx.accounts.config;
        emit!(OwnershipTransferred {
            old: config.admin,
            new: config.pending_admin,
        });
        config.admin = config.pending_admin;
        config.pending_admin = Pubkey::default();
        Ok(())
    }
}

// ============================================================
// State
// ============================================================

/// PDA seeds: [b"oracle_config"]
#[account]
pub struct OracleConfig {
    pub admin: Pubkey,
    pub pending_admin: Pubkey,
    pub operator: Pubkey,
    pub pyth_receiver_program: Pubkey,
    pub max_staleness_secs: u64,
    pub max_confidence_bps: u16,
    pub price_deviation_threshold_bps: u16,
    pub bump: u8,
}

/// PDA seeds: [b"feed", underlying.as_ref()]
#[account]
pub struct PriceFeed {
    pub underlying: Pubkey,
    pub pyth_feed_id: [u8; 32],
    pub active: bool,
    pub bump: u8,
}

/// PDA seeds: [b"expiry_price", underlying.as_ref(),
///             expiry.to_le_bytes().as_ref()]
#[account]
pub struct ExpiryPrice {
    pub underlying: Pubkey,
    pub expiry: i64,
    pub price: u64,
    pub is_finalized: bool,
    pub bump: u8,
}

// ============================================================
// Contexts
// ============================================================

#[derive(Accounts)]
pub struct InitializeOracle<'info> {
    #[account(
        init,
        payer = payer,
        space = 8 + 32 * 4 + 8 + 2 + 2 + 1,
        seeds = [b"oracle_config"],
        bump,
    )]
    pub config: Account<'info, OracleConfig>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(underlying: Pubkey)]
pub struct RegisterFeed<'info> {
    #[account(
        init,
        payer = admin,
        space = 8 + 32 + 32 + 1 + 1,
        seeds = [b"feed", underlying.as_ref()],
        bump,
    )]
    pub feed: Account<'info, PriceFeed>,
    #[account(
        seeds = [b"oracle_config"],
        bump = config.bump,
        has_one = admin,
    )]
    pub config: Account<'info, OracleConfig>,
    #[account(mut)]
    pub admin: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct DeregisterFeed<'info> {
    #[account(
        mut,
        seeds = [b"feed", feed.underlying.as_ref()],
        bump = feed.bump,
    )]
    pub feed: Account<'info, PriceFeed>,
    #[account(
        seeds = [b"oracle_config"],
        bump = config.bump,
        has_one = admin,
    )]
    pub config: Account<'info, OracleConfig>,
    pub admin: Signer<'info>,
}

#[derive(Accounts)]
pub struct GetPrice<'info> {
    #[account(
        seeds = [b"oracle_config"],
        bump = config.bump,
    )]
    pub config: Account<'info, OracleConfig>,
    #[account(
        seeds = [b"feed", feed.underlying.as_ref()],
        bump = feed.bump,
    )]
    pub feed: Account<'info, PriceFeed>,
    /// CHECK: Pyth PriceUpdateV2 account — validated in
    /// parse_pyth_price_update (owner + feed_id).
    pub pyth_price_update: AccountInfo<'info>,
}

#[derive(Accounts)]
#[instruction(underlying: Pubkey, expiry: i64)]
pub struct SetExpiryPrice<'info> {
    #[account(
        init,
        payer = caller,
        space = 8 + 32 + 8 + 8 + 1 + 1,
        seeds = [
            b"expiry_price",
            underlying.as_ref(),
            expiry.to_le_bytes().as_ref(),
        ],
        bump,
    )]
    pub expiry_price: Account<'info, ExpiryPrice>,
    #[account(
        seeds = [b"oracle_config"],
        bump = config.bump,
        constraint = caller.key() == config.admin
            || caller.key() == config.operator
            @ OracleError::Unauthorized,
    )]
    pub config: Account<'info, OracleConfig>,
    #[account(
        seeds = [b"feed", underlying.as_ref()],
        bump = feed.bump,
    )]
    pub feed: Account<'info, PriceFeed>,
    /// CHECK: Pyth PriceUpdateV2 — validated if deviation check runs.
    pub pyth_price_update: AccountInfo<'info>,
    #[account(mut)]
    pub caller: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(underlying: Pubkey, expiry: i64)]
pub struct GetExpiryPrice<'info> {
    #[account(
        seeds = [
            b"expiry_price",
            underlying.as_ref(),
            expiry.to_le_bytes().as_ref(),
        ],
        bump = expiry_price.bump,
    )]
    pub expiry_price: Account<'info, ExpiryPrice>,
}

#[derive(Accounts)]
pub struct AdminAction<'info> {
    #[account(
        mut,
        seeds = [b"oracle_config"],
        bump = config.bump,
        has_one = admin,
    )]
    pub config: Account<'info, OracleConfig>,
    pub admin: Signer<'info>,
}

#[derive(Accounts)]
pub struct AcceptOwnership<'info> {
    #[account(
        mut,
        seeds = [b"oracle_config"],
        bump = config.bump,
        constraint = new_admin.key() == config.pending_admin
            @ OracleError::NotPendingAdmin,
    )]
    pub config: Account<'info, OracleConfig>,
    pub new_admin: Signer<'info>,
}

// ============================================================
// Events
// ============================================================

#[event]
pub struct OracleInitialized {
    pub admin: Pubkey,
    pub operator: Pubkey,
}

#[event]
pub struct PriceFeedRegistered {
    pub underlying: Pubkey,
    pub pyth_feed_id: [u8; 32],
}

#[event]
pub struct PriceFeedDeregistered {
    pub underlying: Pubkey,
}

#[event]
pub struct PriceFeedStatusUpdated {
    pub underlying: Pubkey,
    pub active: bool,
}

#[event]
pub struct PriceQueried {
    pub underlying: Pubkey,
    pub price: u64,
}

#[event]
pub struct ExpiryPriceSet {
    pub underlying: Pubkey,
    pub expiry: i64,
    pub price: u64,
}

#[event]
pub struct OperatorUpdated {
    pub old: Pubkey,
    pub new: Pubkey,
}

#[event]
pub struct PriceDeviationThresholdUpdated {
    pub old: u16,
    pub new: u16,
}

#[event]
pub struct MaxStalenessUpdated {
    pub old: u64,
    pub new: u64,
}

#[event]
pub struct MaxConfidenceUpdated {
    pub old: u16,
    pub new: u16,
}

#[event]
pub struct OwnershipTransferStarted {
    pub current: Pubkey,
    pub pending: Pubkey,
}

#[event]
pub struct OwnershipTransferred {
    pub old: Pubkey,
    pub new: Pubkey,
}

// ============================================================
// Errors
// ============================================================

#[error_code]
pub enum OracleError {
    #[msg("Address cannot be zero")]
    ZeroAddress,
    #[msg("Invalid Pyth price account")]
    InvalidPythAccount,
    #[msg("Pyth feed ID does not match registered feed")]
    FeedIdMismatch,
    #[msg("Feed is not active")]
    FeedNotActive,
    #[msg("Price is invalid (zero or negative)")]
    InvalidPrice,
    #[msg("Price is stale")]
    StalePrice,
    #[msg("Confidence interval too wide")]
    ConfidenceTooWide,
    #[msg("Price deviation exceeds threshold")]
    PriceDeviationTooHigh,
    #[msg("Expiry timestamp not reached")]
    ExpiryNotReached,
    #[msg("Expiry price not set")]
    ExpiryPriceNotSet,
    #[msg("Unauthorized")]
    Unauthorized,
    #[msg("Not the pending admin")]
    NotPendingAdmin,
    #[msg("Arithmetic overflow")]
    MathOverflow,
}

// ============================================================
// Pyth deserialization (manual — avoids SDK dependency conflict
// with anchor-spl / solana-sdk version pinning)
// ============================================================

/// Fields we need from a Pyth PriceUpdateV2 account.
struct PythPriceData {
    pub price: i64,
    pub conf: u64,
    pub exponent: i32,
    pub publish_time: i64,
}

/// Parse a Pyth PriceUpdateV2 account.
///
/// Account layout (borsh, after 8-byte Anchor discriminator):
///   write_authority  : Pubkey   (32 bytes)
///   verification_level: enum    (1–2 bytes)
///     Partial(u8) → [0, n]     (2 bytes)
///     Full        → [1]        (1 byte)
///   price_message:
///     feed_id      : [u8; 32]
///     price        : i64
///     conf         : u64
///     exponent     : i32
///     publish_time : i64
///     ...remaining fields (not needed)
///   posted_slot    : u64
const DISCRIMINATOR_LEN: usize = 8;
const PRICE_UPDATE_V2_DISCRIMINATOR: [u8; 8] = [0x34, 0x2a, 0x89, 0x6f, 0xc1, 0xd0, 0x82, 0x04];
const PUBKEY_LEN: usize = 32;
const FEED_ID_LEN: usize = 32;
const MIN_PRICE_MSG_BYTES: usize = FEED_ID_LEN + 8 + 8 + 4 + 8;

fn parse_pyth_price_update(
    account: &AccountInfo,
    expected_owner: &Pubkey,
    expected_feed_id: &[u8; 32],
) -> Result<PythPriceData> {
    require!(
        account.owner == expected_owner,
        OracleError::InvalidPythAccount
    );

    let data = account.try_borrow_data()?;

    // discriminator(8) + write_authority(32) + min verification(1) +
    // price_message(60) = 101 minimum
    require!(data.len() >= 101, OracleError::InvalidPythAccount);
    require!(
        data[..DISCRIMINATOR_LEN] == PRICE_UPDATE_V2_DISCRIMINATOR,
        OracleError::InvalidPythAccount
    );

    // Offset past discriminator + write_authority
    let base = DISCRIMINATOR_LEN + PUBKEY_LEN;

    // VerificationLevel borsh encoding:
    //   variant 0 (Partial) = 1 byte tag + 1 byte num_signatures
    //   variant 1 (Full)    = 1 byte tag
    let variant = data[base];
    let msg_start = if variant == 0 { base + 2 } else { base + 1 };

    require!(
        data.len() >= msg_start + MIN_PRICE_MSG_BYTES,
        OracleError::InvalidPythAccount
    );

    // Validate feed_id
    let feed_end = msg_start + FEED_ID_LEN;
    require!(
        &data[msg_start..feed_end] == expected_feed_id,
        OracleError::FeedIdMismatch
    );

    let mut off = feed_end;

    let price = i64::from_le_bytes(
        data[off..off + 8]
            .try_into()
            .map_err(|_| error!(OracleError::InvalidPythAccount))?,
    );
    off += 8;

    let conf = u64::from_le_bytes(
        data[off..off + 8]
            .try_into()
            .map_err(|_| error!(OracleError::InvalidPythAccount))?,
    );
    off += 8;

    let exponent = i32::from_le_bytes(
        data[off..off + 4]
            .try_into()
            .map_err(|_| error!(OracleError::InvalidPythAccount))?,
    );
    off += 4;

    let publish_time = i64::from_le_bytes(
        data[off..off + 8]
            .try_into()
            .map_err(|_| error!(OracleError::InvalidPythAccount))?,
    );

    require!(price > 0, OracleError::InvalidPrice);

    Ok(PythPriceData {
        price,
        conf,
        exponent,
        publish_time,
    })
}

fn validate_staleness(publish_time: i64, max_staleness_secs: u64) -> Result<()> {
    if max_staleness_secs == 0 {
        return Ok(());
    }
    let clock = Clock::get()?;
    let age = clock
        .unix_timestamp
        .checked_sub(publish_time)
        .ok_or(OracleError::MathOverflow)?;
    require!(
        age >= 0 && (age as u64) <= max_staleness_secs,
        OracleError::StalePrice
    );
    Ok(())
}

fn validate_confidence(price: i64, conf: u64, max_confidence_bps: u16) -> Result<()> {
    if max_confidence_bps == 0 {
        return Ok(());
    }
    let price_abs = price.unsigned_abs();
    require!(price_abs > 0, OracleError::InvalidPrice);
    let conf_bps = conf
        .checked_mul(BPS_DENOMINATOR)
        .ok_or(OracleError::MathOverflow)?
        .checked_div(price_abs)
        .ok_or(OracleError::MathOverflow)?;
    require!(
        conf_bps <= max_confidence_bps as u64,
        OracleError::ConfidenceTooWide
    );
    Ok(())
}

/// Normalize a Pyth price (variable exponent) to 8 decimal places.
///
/// Example: price = 16297000, exponent = -5
///   → 16297000 × 10^(−5 − (−8)) = 16297000 × 10^3 = 16_297_000_000
fn normalize_to_8_decimals(price: i64, exponent: i32) -> Result<u64> {
    require!(price > 0, OracleError::InvalidPrice);
    let target_exp: i32 = -8;
    let diff = exponent - target_exp; // positive → multiply, negative → divide
    let p = price as u64;
    if diff > 0 {
        let factor = 10u64
            .checked_pow(diff as u32)
            .ok_or(OracleError::MathOverflow)?;
        p.checked_mul(factor)
            .ok_or(OracleError::MathOverflow.into())
    } else if diff < 0 {
        let factor = 10u64
            .checked_pow((-diff) as u32)
            .ok_or(OracleError::MathOverflow)?;
        Ok(p / factor)
    } else {
        Ok(p)
    }
}

fn validate_price_deviation(submitted: u64, reference: u64, threshold_bps: u16) -> Result<()> {
    if threshold_bps == 0 || reference == 0 {
        return Ok(());
    }
    let diff = submitted.abs_diff(reference);
    let deviation_bps = diff
        .checked_mul(BPS_DENOMINATOR)
        .ok_or(OracleError::MathOverflow)?
        .checked_div(reference)
        .ok_or(OracleError::MathOverflow)?;
    require!(
        deviation_bps <= threshold_bps as u64,
        OracleError::PriceDeviationTooHigh
    );
    Ok(())
}
