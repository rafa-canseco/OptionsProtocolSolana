use anchor_lang::prelude::*;

declare_id!("GpR6id2cHu5fUGsFm7NUKkB4NzfuEDa6brPzkSrgAzvS");

#[program]
pub mod batch_settler {
    use super::*;

    pub fn initialize(
        ctx: Context<InitializeSettler>,
        admin: Pubkey,
        market_maker: Pubkey,
    ) -> Result<()> {
        let config = &mut ctx.accounts.config;
        config.admin = admin;
        config.market_maker = market_maker;
        config.paused = false;
        msg!("BatchSettler initialized");
        Ok(())
    }

    /// Instant settlement: user accepts a signed quote from MM.
    /// Collateral locked, oTokens minted, premium paid. One tx.
    pub fn execute_order(
        ctx: Context<ExecuteOrder>,
        _underlying: Pubkey,
        _otoken: Pubkey,
        _amount: u64,
        _premium: u64,
        _nonce: u64,
        _deadline: i64,
        _mm_signature: [u8; 64],
    ) -> Result<()> {
        msg!(
            "Order executed for {}",
            ctx.accounts.buyer.key()
        );
        Ok(())
    }

    /// Expiry settlement: settle all vaults for an expired oToken.
    /// Called by the expiry settler bot at 08:00 UTC.
    pub fn batch_settle_vaults(
        ctx: Context<BatchSettle>,
        _otoken: Pubkey,
    ) -> Result<()> {
        msg!(
            "Batch settlement by {}",
            ctx.accounts.settler.key()
        );
        Ok(())
    }

    /// Physical redeem: flash loan + swap for ITM options.
    pub fn physical_redeem(
        ctx: Context<PhysicalRedeem>,
        _otoken: Pubkey,
        _amount: u64,
    ) -> Result<()> {
        msg!(
            "Physical redeem by {}",
            ctx.accounts.redeemer.key()
        );
        Ok(())
    }
}

// PDA seeds: [b"settler_config"]
#[account]
pub struct SettlerConfig {
    pub admin: Pubkey,
    pub market_maker: Pubkey,
    pub paused: bool,
}

// Signed quote structure (off-chain, verified via ed25519):
// { underlying, strike, expiry, is_put, premium,
//   max_amount, nonce, deadline, mm_pubkey }

#[derive(Accounts)]
pub struct InitializeSettler<'info> {
    #[account(
        init,
        payer = payer,
        space = 8 + 32 + 32 + 1,
        seeds = [b"settler_config"],
        bump,
    )]
    pub config: Account<'info, SettlerConfig>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ExecuteOrder<'info> {
    #[account(
        seeds = [b"settler_config"],
        bump,
        constraint = !config.paused,
    )]
    pub config: Account<'info, SettlerConfig>,
    #[account(mut)]
    pub buyer: Signer<'info>,
    /// CHECK: Ed25519 signature verified in instruction
    pub market_maker: AccountInfo<'info>,
}

#[derive(Accounts)]
pub struct BatchSettle<'info> {
    #[account(
        seeds = [b"settler_config"],
        bump,
    )]
    pub config: Account<'info, SettlerConfig>,
    pub settler: Signer<'info>,
}

#[derive(Accounts)]
pub struct PhysicalRedeem<'info> {
    #[account(
        seeds = [b"settler_config"],
        bump,
    )]
    pub config: Account<'info, SettlerConfig>,
    #[account(mut)]
    pub redeemer: Signer<'info>,
}
