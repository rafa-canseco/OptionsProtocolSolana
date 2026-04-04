use anchor_lang::prelude::*;

declare_id!("EMgyserXHEQz4dYTT9LoSa5KNszXnTruV6LL5w63dvJd");

#[program]
pub mod oracle {
    use super::*;

    pub fn initialize(
        ctx: Context<InitializeOracle>,
        admin: Pubkey,
        max_staleness_secs: u64,
        max_confidence_bps: u16,
    ) -> Result<()> {
        let config = &mut ctx.accounts.config;
        config.admin = admin;
        config.max_staleness_secs = max_staleness_secs;
        config.max_confidence_bps = max_confidence_bps;
        msg!("Oracle initialized");
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
        msg!("Feed registered for {}", underlying);
        Ok(())
    }

    pub fn set_expiry_price(
        ctx: Context<SetExpiryPrice>,
        underlying: Pubkey,
        expiry: i64,
        price: u64,
    ) -> Result<()> {
        let expiry_price = &mut ctx.accounts.expiry_price;
        expiry_price.underlying = underlying;
        expiry_price.expiry = expiry;
        expiry_price.price = price;
        expiry_price.is_finalized = true;
        msg!("Expiry price set: expiry={} price={}", expiry, price);
        Ok(())
    }
}

// PDA seeds: [b"oracle_config"]
#[account]
pub struct OracleConfig {
    pub admin: Pubkey,
    pub max_staleness_secs: u64,
    pub max_confidence_bps: u16,
}

// PDA seeds: [b"feed", underlying]
#[account]
pub struct PriceFeed {
    pub underlying: Pubkey,
    pub pyth_feed_id: [u8; 32],
    pub active: bool,
}

// PDA seeds: [b"expiry_price", underlying, expiry.to_le_bytes()]
#[account]
pub struct ExpiryPrice {
    pub underlying: Pubkey,
    pub expiry: i64,
    pub price: u64,
    pub is_finalized: bool,
}

#[derive(Accounts)]
pub struct InitializeOracle<'info> {
    #[account(
        init,
        payer = payer,
        space = 8 + 32 + 8 + 2,
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
        space = 8 + 32 + 32 + 1,
        seeds = [b"feed", underlying.as_ref()],
        bump,
    )]
    pub feed: Account<'info, PriceFeed>,
    #[account(
        seeds = [b"oracle_config"],
        bump,
        has_one = admin,
    )]
    pub config: Account<'info, OracleConfig>,
    #[account(mut)]
    pub admin: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(underlying: Pubkey, expiry: i64)]
pub struct SetExpiryPrice<'info> {
    #[account(
        init,
        payer = admin,
        space = 8 + 32 + 8 + 8 + 1,
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
        bump,
        has_one = admin,
    )]
    pub config: Account<'info, OracleConfig>,
    #[account(mut)]
    pub admin: Signer<'info>,
    pub system_program: Program<'info, System>,
}
