use anchor_lang::prelude::*;

declare_id!("F759VGDWkcxjjGByWZTTdDKJwj1RFzH2VHZS3p4VXnts");

#[program]
pub mod whitelist {
    use super::*;

    pub fn initialize(ctx: Context<InitializeWhitelist>, admin: Pubkey) -> Result<()> {
        require!(admin != Pubkey::default(), WhitelistError::ZeroAddress);
        let config = &mut ctx.accounts.config;
        config.admin = admin;
        config.factory = Pubkey::default();
        config.bump = ctx.bumps.config;
        msg!("Whitelist initialized");
        Ok(())
    }

    pub fn set_factory(ctx: Context<AdminAction>, factory: Pubkey) -> Result<()> {
        require!(factory != Pubkey::default(), WhitelistError::ZeroAddress);
        ctx.accounts.config.factory = factory;
        Ok(())
    }

    /// Register an oToken as whitelisted. Callable by admin or factory.
    pub fn whitelist_otoken(ctx: Context<WhitelistOToken>, otoken_mint: Pubkey) -> Result<()> {
        let config = &ctx.accounts.config;
        require!(
            ctx.accounts.caller.key() == config.admin
                || (config.factory != Pubkey::default()
                    && ctx.accounts.caller.key() == config.factory),
            WhitelistError::Unauthorized
        );

        let entry = &mut ctx.accounts.whitelisted_otoken;
        entry.otoken_mint = otoken_mint;
        entry.active = true;
        entry.bump = ctx.bumps.whitelisted_otoken;
        emit!(OTokenWhitelisted { otoken_mint });
        Ok(())
    }
}

// ============================================================
// State
// ============================================================

/// PDA seeds: [b"whitelist_config"]
#[account]
pub struct WhitelistConfig {
    pub admin: Pubkey,
    pub factory: Pubkey,
    pub bump: u8,
}

/// PDA seeds: [b"whitelisted_otoken", otoken_mint]
#[account]
pub struct WhitelistedOToken {
    pub otoken_mint: Pubkey,
    pub active: bool,
    pub bump: u8,
}

// ============================================================
// Contexts
// ============================================================

#[derive(Accounts)]
pub struct InitializeWhitelist<'info> {
    #[account(
        init,
        payer = payer,
        space = 8 + 32 + 32 + 1,
        seeds = [b"whitelist_config"],
        bump,
    )]
    pub config: Account<'info, WhitelistConfig>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AdminAction<'info> {
    #[account(
        mut,
        seeds = [b"whitelist_config"],
        bump = config.bump,
        has_one = admin,
    )]
    pub config: Account<'info, WhitelistConfig>,
    pub admin: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(otoken_mint: Pubkey)]
pub struct WhitelistOToken<'info> {
    #[account(
        init,
        payer = caller,
        space = 8 + 32 + 1 + 1,
        seeds = [b"whitelisted_otoken", otoken_mint.as_ref()],
        bump,
    )]
    pub whitelisted_otoken: Account<'info, WhitelistedOToken>,
    #[account(
        seeds = [b"whitelist_config"],
        bump = config.bump,
    )]
    pub config: Account<'info, WhitelistConfig>,
    #[account(mut)]
    pub caller: Signer<'info>,
    pub system_program: Program<'info, System>,
}

// ============================================================
// Events
// ============================================================

#[event]
pub struct OTokenWhitelisted {
    pub otoken_mint: Pubkey,
}

// ============================================================
// Errors
// ============================================================

#[error_code]
pub enum WhitelistError {
    #[msg("Address cannot be zero")]
    ZeroAddress,
    #[msg("Unauthorized")]
    Unauthorized,
}
