use anchor_lang::prelude::*;
use anchor_spl::token::{self, Burn, Mint, MintTo, Token, TokenAccount};

declare_id!("FH3z4BYRZMFU8YzpJoFXUbrdoYksdERnWbZvDAEc3qcC");

#[program]
pub mod controller {
    use super::*;

    pub fn initialize(ctx: Context<InitializeConfig>, admin: Pubkey) -> Result<()> {
        require!(admin != Pubkey::default(), ControllerError::ZeroAddress);
        let config = &mut ctx.accounts.config;
        config.admin = admin;
        config.partial_pauser = Pubkey::default();
        config.partially_paused = false;
        config.fully_paused = false;
        config.bump = ctx.bumps.config;
        emit!(ControllerInitialized { admin });
        Ok(())
    }

    pub fn initialize_counter(ctx: Context<InitializeCounter>) -> Result<()> {
        let counter = &mut ctx.accounts.vault_counter;
        counter.owner = ctx.accounts.owner.key();
        counter.next_id = 0;
        counter.bump = ctx.bumps.vault_counter;
        Ok(())
    }

    pub fn open_vault(ctx: Context<OpenVault>, collateral_mint: Pubkey, beneficiary: Pubkey) -> Result<()> {
        let config = &ctx.accounts.config;
        require!(!config.fully_paused, ControllerError::SystemFullyPaused);
        require!(
            !config.partially_paused,
            ControllerError::SystemPartiallyPaused
        );

        let counter = &mut ctx.accounts.vault_counter;
        let vault = &mut ctx.accounts.vault;

        vault.owner = ctx.accounts.owner.key();
        vault.vault_id = counter.next_id;
        vault.collateral_mint = collateral_mint;
        vault.collateral_amount = 0;
        vault.otoken_mint = Pubkey::default();
        vault.short_amount = 0;
        vault.settled = false;
        vault.beneficiary = beneficiary;
        vault.bump = ctx.bumps.vault;

        let vault_id = counter.next_id;
        counter.next_id = counter
            .next_id
            .checked_add(1)
            .ok_or(ControllerError::MathOverflow)?;

        emit!(VaultOpened {
            owner: vault.owner,
            vault_id,
        });
        Ok(())
    }

    pub fn deposit_collateral(ctx: Context<DepositCollateral>, amount: u64) -> Result<()> {
        let config = &ctx.accounts.config;
        require!(!config.fully_paused, ControllerError::SystemFullyPaused);
        require!(
            !config.partially_paused,
            ControllerError::SystemPartiallyPaused
        );
        require!(amount > 0, ControllerError::ZeroAmount);

        let vault = &mut ctx.accounts.vault;
        require!(!vault.settled, ControllerError::VaultSettled);
        require!(
            ctx.accounts.user_token_account.mint == vault.collateral_mint,
            ControllerError::CollateralMismatch
        );

        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                anchor_spl::token::Transfer {
                    from: ctx.accounts.user_token_account.to_account_info(),
                    to: ctx.accounts.pool_token_account.to_account_info(),
                    authority: ctx.accounts.owner.to_account_info(),
                },
            ),
            amount,
        )?;

        vault.collateral_amount = vault
            .collateral_amount
            .checked_add(amount)
            .ok_or(ControllerError::MathOverflow)?;

        emit!(CollateralDeposited {
            owner: vault.owner,
            vault_id: vault.vault_id,
            asset: vault.collateral_mint,
            amount,
        });
        Ok(())
    }

    pub fn mint_otoken(ctx: Context<MintOtoken>, amount: u64) -> Result<()> {
        let config = &ctx.accounts.config;
        require!(!config.fully_paused, ControllerError::SystemFullyPaused);
        require!(
            !config.partially_paused,
            ControllerError::SystemPartiallyPaused
        );
        require!(amount > 0, ControllerError::ZeroAmount);

        let clock = Clock::get()?;
        require!(
            clock.unix_timestamp < ctx.accounts.otoken_info.expiry,
            ControllerError::OptionExpired
        );

        let vault = &mut ctx.accounts.vault;
        require!(!vault.settled, ControllerError::VaultSettled);

        let otoken_key = ctx.accounts.otoken_mint.key();
        if vault.otoken_mint == Pubkey::default() {
            vault.otoken_mint = otoken_key;
        } else {
            require!(
                vault.otoken_mint == otoken_key,
                ControllerError::OtokenMismatch
            );
        }

        let new_short = vault
            .short_amount
            .checked_add(amount)
            .ok_or(ControllerError::MathOverflow)?;

        let otoken_info = &ctx.accounts.otoken_info;
        let required = get_required_collateral(
            otoken_info.strike_price,
            otoken_info.is_put,
            otoken_info.collateral_decimals,
            new_short,
        )?;
        require!(
            vault.collateral_amount >= required,
            ControllerError::InsufficientCollateral
        );

        let config_bump = config.bump;
        let seeds = &[b"controller_config".as_ref(), &[config_bump]];
        let signer_seeds = &[&seeds[..]];

        token::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                MintTo {
                    mint: ctx.accounts.otoken_mint.to_account_info(),
                    to: ctx.accounts.destination.to_account_info(),
                    authority: ctx.accounts.config.to_account_info(),
                },
                signer_seeds,
            ),
            amount,
        )?;

        vault.short_amount = new_short;

        emit!(OTokenMinted {
            owner: vault.owner,
            vault_id: vault.vault_id,
            otoken: otoken_key,
            amount,
        });
        Ok(())
    }

    pub fn settle_vault(ctx: Context<SettleVault>) -> Result<()> {
        let config = &ctx.accounts.config;
        require!(!config.fully_paused, ControllerError::SystemFullyPaused);

        // Read values before mutable borrow
        let vault_ref = &ctx.accounts.vault;
        require!(!vault_ref.settled, ControllerError::VaultSettled);
        require!(vault_ref.short_amount > 0, ControllerError::EmptyVault);
        let short_amount = vault_ref.short_amount;
        let collateral_amount = vault_ref.collateral_amount;
        let collateral_mint = vault_ref.collateral_mint;
        let vault_owner = vault_ref.owner;
        let vault_id = vault_ref.vault_id;

        let otoken_info = &ctx.accounts.otoken_info;
        let clock = Clock::get()?;
        require!(
            clock.unix_timestamp >= otoken_info.expiry,
            ControllerError::NotExpired
        );

        let expiry_price = otoken_info.expiry_price;
        require!(expiry_price > 0, ControllerError::ExpiryPriceNotSet);

        let payout = get_payout(
            otoken_info.strike_price,
            expiry_price,
            otoken_info.is_put,
            otoken_info.collateral_decimals,
            short_amount,
        )?;

        let collateral_returned = collateral_amount
            .checked_sub(payout)
            .ok_or(ControllerError::MathOverflow)?;

        if collateral_returned > 0 {
            let pool_auth_bump = ctx.bumps.pool_vault_authority;
            let seeds = &[
                b"pool_vault_auth".as_ref(),
                collateral_mint.as_ref(),
                &[pool_auth_bump],
            ];
            let signer_seeds = &[&seeds[..]];

            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    anchor_spl::token::Transfer {
                        from: ctx.accounts.pool_token_account.to_account_info(),
                        to: ctx.accounts.beneficiary_token_account.to_account_info(),
                        authority: ctx.accounts.pool_vault_authority.to_account_info(),
                    },
                    signer_seeds,
                ),
                collateral_returned,
            )?;
        }

        let vault = &mut ctx.accounts.vault;
        vault.settled = true;

        emit!(VaultSettled {
            owner: vault_owner,
            vault_id,
            collateral_returned,
            payout_reserved: payout,
        });
        Ok(())
    }

    pub fn redeem(ctx: Context<Redeem>, amount: u64) -> Result<()> {
        let config = &ctx.accounts.config;
        require!(!config.fully_paused, ControllerError::SystemFullyPaused);
        require!(amount > 0, ControllerError::ZeroAmount);

        let otoken_info = &ctx.accounts.otoken_info;
        let clock = Clock::get()?;
        require!(
            clock.unix_timestamp >= otoken_info.expiry,
            ControllerError::NotExpired
        );

        let expiry_price = otoken_info.expiry_price;
        require!(expiry_price > 0, ControllerError::ExpiryPriceNotSet);

        let payout = get_payout(
            otoken_info.strike_price,
            expiry_price,
            otoken_info.is_put,
            otoken_info.collateral_decimals,
            amount,
        )?;

        token::burn(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Burn {
                    mint: ctx.accounts.otoken_mint.to_account_info(),
                    from: ctx.accounts.redeemer_otoken_account.to_account_info(),
                    authority: ctx.accounts.redeemer.to_account_info(),
                },
            ),
            amount,
        )?;

        if payout > 0 {
            let mint_key = ctx.accounts.pool_token_account.mint;
            let pool_auth_bump = ctx.bumps.pool_vault_authority;
            let seeds = &[
                b"pool_vault_auth".as_ref(),
                mint_key.as_ref(),
                &[pool_auth_bump],
            ];
            let signer_seeds = &[&seeds[..]];

            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    anchor_spl::token::Transfer {
                        from: ctx.accounts.pool_token_account.to_account_info(),
                        to: ctx.accounts.redeemer_collateral_account.to_account_info(),
                        authority: ctx.accounts.pool_vault_authority.to_account_info(),
                    },
                    signer_seeds,
                ),
                payout,
            )?;
        }

        emit!(Redeemed {
            otoken: ctx.accounts.otoken_mint.key(),
            redeemer: ctx.accounts.redeemer.key(),
            otoken_amount: amount,
            payout,
        });
        Ok(())
    }

    pub fn set_partial_pauser(ctx: Context<AdminAction>, pauser: Pubkey) -> Result<()> {
        require!(pauser != Pubkey::default(), ControllerError::ZeroAddress);
        ctx.accounts.config.partial_pauser = pauser;
        Ok(())
    }

    pub fn set_partially_paused(ctx: Context<PauseAction>, paused: bool) -> Result<()> {
        ctx.accounts.config.partially_paused = paused;
        if paused {
            emit!(SystemPartiallyPaused {
                caller: ctx.accounts.caller.key(),
            });
        }
        Ok(())
    }

    pub fn set_fully_paused(ctx: Context<AdminAction>, paused: bool) -> Result<()> {
        ctx.accounts.config.fully_paused = paused;
        if paused {
            emit!(SystemFullyPaused {
                caller: ctx.accounts.admin.key(),
            });
        }
        Ok(())
    }

    pub fn emergency_withdraw_vault(
        ctx: Context<EmergencyWithdrawVault>,
    ) -> Result<()> {
        let config = &ctx.accounts.config;
        require!(config.fully_paused, ControllerError::NotFullyPaused);

        let vault = &ctx.accounts.vault;
        require!(!vault.settled, ControllerError::VaultSettled);

        let collateral_amount = vault.collateral_amount;
        let collateral_mint = vault.collateral_mint;
        let beneficiary = vault.beneficiary;
        let vault_id = vault.vault_id;

        let vault = &mut ctx.accounts.vault;
        vault.settled = true;

        if collateral_amount > 0 {
            let pool_auth_bump = ctx.bumps.pool_vault_authority;
            let seeds = &[
                b"pool_vault_auth".as_ref(),
                collateral_mint.as_ref(),
                &[pool_auth_bump],
            ];
            let signer_seeds = &[&seeds[..]];

            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    anchor_spl::token::Transfer {
                        from: ctx.accounts.pool_token_account.to_account_info(),
                        to: ctx
                            .accounts
                            .beneficiary_token_account
                            .to_account_info(),
                        authority: ctx
                            .accounts
                            .pool_vault_authority
                            .to_account_info(),
                    },
                    signer_seeds,
                ),
                collateral_amount,
            )?;
        }

        emit!(EmergencyWithdraw {
            beneficiary,
            vault_id,
            collateral_amount,
        });
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    pub fn create_otoken_info(
        ctx: Context<CreateOTokenInfo>,
        otoken_mint: Pubkey,
        underlying: Pubkey,
        strike_asset: Pubkey,
        collateral_mint: Pubkey,
        strike_price: u64,
        expiry: i64,
        is_put: bool,
        collateral_decimals: u8,
    ) -> Result<()> {
        require!(strike_price > 0, ControllerError::ZeroAmount);
        require!(collateral_decimals <= 18, ControllerError::InvalidDecimals);
        let info = &mut ctx.accounts.otoken_info;
        info.otoken_mint = otoken_mint;
        info.underlying = underlying;
        info.strike_asset = strike_asset;
        info.collateral_mint = collateral_mint;
        info.strike_price = strike_price;
        info.expiry = expiry;
        info.is_put = is_put;
        info.collateral_decimals = collateral_decimals;
        info.expiry_price = 0;
        Ok(())
    }

    pub fn set_expiry_price(ctx: Context<SetExpiryPrice>, price: u64) -> Result<()> {
        require!(price > 0, ControllerError::ZeroAmount);
        require!(
            ctx.accounts.otoken_info.expiry_price == 0,
            ControllerError::ExpiryPriceAlreadySet
        );
        ctx.accounts.otoken_info.expiry_price = price;
        Ok(())
    }
}

/// Collateral metadata for an oToken series.
/// In production, this comes from the OTokenFactory/Oracle.
/// Stored separately to keep vault accounts small.
// PDA seeds: [b"otoken_info", otoken_mint]
#[account]
pub struct OTokenInfo {
    pub otoken_mint: Pubkey,
    pub underlying: Pubkey,
    pub strike_asset: Pubkey,
    pub collateral_mint: Pubkey,
    pub strike_price: u64,
    pub expiry: i64,
    pub is_put: bool,
    pub collateral_decimals: u8,
    pub expiry_price: u64,
}

// PDA seeds: [b"controller_config"]
#[account]
pub struct ControllerConfig {
    pub admin: Pubkey,
    pub partial_pauser: Pubkey,
    pub partially_paused: bool,
    pub fully_paused: bool,
    pub bump: u8,
}

// PDA seeds: [b"vault_counter", owner]
#[account]
pub struct VaultCounter {
    pub owner: Pubkey,
    pub next_id: u64,
    pub bump: u8,
}

// PDA seeds: [b"vault", owner, vault_id.to_le_bytes()]
#[account]
pub struct Vault {
    pub owner: Pubkey,
    pub vault_id: u64,
    pub collateral_mint: Pubkey,
    pub collateral_amount: u64,
    pub otoken_mint: Pubkey,
    pub short_amount: u64,
    pub settled: bool,
    pub beneficiary: Pubkey,
    pub bump: u8,
}

fn get_required_collateral(
    strike_price: u64,
    is_put: bool,
    collateral_decimals: u8,
    amount: u64,
) -> Result<u64> {
    if is_put {
        // Put: required = (amount * strikePrice) / 10^8
        // strike_price is in 8 decimals, amount is in 8 decimals
        // result should be in collateral_decimals
        let numerator = (amount as u128)
            .checked_mul(strike_price as u128)
            .ok_or(ControllerError::MathOverflow)?;
        let base: u128 = 10u128.pow(8 + 8 - collateral_decimals as u32);
        let result = numerator
            .checked_div(base)
            .ok_or(ControllerError::MathOverflow)?;
        let result_u64: u64 = result
            .try_into()
            .map_err(|_| ControllerError::MathOverflow)?;
        Ok(result_u64)
    } else {
        // Call: required = amount (1:1 in underlying terms)
        // Adjust for decimal difference
        let base_decimals: u32 = 8;
        if collateral_decimals as u32 >= base_decimals {
            let factor = 10u64.pow(collateral_decimals as u32 - base_decimals);
            amount
                .checked_mul(factor)
                .ok_or(ControllerError::MathOverflow.into())
        } else {
            let factor = 10u64.pow(base_decimals - collateral_decimals as u32);
            amount
                .checked_div(factor)
                .ok_or(ControllerError::MathOverflow.into())
        }
    }
}

/// Physical delivery payout: if ITM, full collateral is forfeited.
/// The actual cash settlement difference is handled by the physical
/// delivery mechanism (flash loan + swap in batch_settler).
fn get_payout(
    strike_price: u64,
    expiry_price: u64,
    is_put: bool,
    collateral_decimals: u8,
    amount: u64,
) -> Result<u64> {
    if is_put {
        if expiry_price >= strike_price {
            return Ok(0);
        }
    } else if expiry_price <= strike_price {
        return Ok(0);
    }
    // ITM: full collateral forfeited
    get_required_collateral(strike_price, is_put, collateral_decimals, amount)
}

#[derive(Accounts)]
pub struct InitializeConfig<'info> {
    #[account(
        init,
        payer = payer,
        space = 8 + 32 + 32 + 1 + 1 + 1,
        seeds = [b"controller_config"],
        bump,
    )]
    pub config: Account<'info, ControllerConfig>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct InitializeCounter<'info> {
    #[account(
        init,
        payer = owner,
        space = 8 + 32 + 8 + 1,
        seeds = [
            b"vault_counter",
            owner.key().as_ref(),
        ],
        bump,
    )]
    pub vault_counter: Account<'info, VaultCounter>,
    #[account(mut)]
    pub owner: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct OpenVault<'info> {
    #[account(
        seeds = [b"controller_config"],
        bump = config.bump,
    )]
    pub config: Account<'info, ControllerConfig>,
    #[account(
        init,
        payer = owner,
        space = 8 + 32 + 8 + 32 + 8 + 32 + 8 + 1 + 32 + 1,
        seeds = [
            b"vault",
            owner.key().as_ref(),
            vault_counter.next_id.to_le_bytes().as_ref(),
        ],
        bump,
    )]
    pub vault: Account<'info, Vault>,
    #[account(
        mut,
        seeds = [
            b"vault_counter",
            owner.key().as_ref(),
        ],
        bump = vault_counter.bump,
        has_one = owner,
    )]
    pub vault_counter: Account<'info, VaultCounter>,
    #[account(mut)]
    pub owner: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct DepositCollateral<'info> {
    #[account(
        seeds = [b"controller_config"],
        bump = config.bump,
    )]
    pub config: Account<'info, ControllerConfig>,
    #[account(
        mut,
        has_one = owner,
        seeds = [
            b"vault",
            owner.key().as_ref(),
            vault.vault_id.to_le_bytes().as_ref(),
        ],
        bump = vault.bump,
    )]
    pub vault: Account<'info, Vault>,
    #[account(mut)]
    pub user_token_account: Account<'info, TokenAccount>,
    #[account(
        mut,
        constraint = pool_token_account.mint
            == vault.collateral_mint
            @ ControllerError::CollateralMismatch,
    )]
    pub pool_token_account: Account<'info, TokenAccount>,
    #[account(mut)]
    pub owner: Signer<'info>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct MintOtoken<'info> {
    #[account(
        seeds = [b"controller_config"],
        bump = config.bump,
    )]
    pub config: Account<'info, ControllerConfig>,
    #[account(mut, has_one = owner)]
    pub vault: Account<'info, Vault>,
    #[account(
        constraint = otoken_info.collateral_mint
            == vault.collateral_mint
            @ ControllerError::CollateralMismatch,
        seeds = [
            b"otoken_info",
            otoken_mint.key().as_ref(),
        ],
        bump,
    )]
    pub otoken_info: Account<'info, OTokenInfo>,
    #[account(
        mut,
        constraint = otoken_mint.key()
            == otoken_info.otoken_mint,
    )]
    pub otoken_mint: Account<'info, Mint>,
    #[account(
        mut,
        constraint = destination.mint
            == otoken_mint.key()
            @ ControllerError::OtokenMismatch,
    )]
    pub destination: Account<'info, TokenAccount>,
    #[account(mut)]
    pub owner: Signer<'info>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct SettleVault<'info> {
    #[account(
        seeds = [b"controller_config"],
        bump = config.bump,
        has_one = admin,
    )]
    pub config: Account<'info, ControllerConfig>,
    #[account(
        mut,
        seeds = [
            b"vault",
            vault.owner.as_ref(),
            vault.vault_id.to_le_bytes().as_ref(),
        ],
        bump = vault.bump,
    )]
    pub vault: Account<'info, Vault>,
    #[account(
        constraint = otoken_info.otoken_mint
            == vault.otoken_mint
            @ ControllerError::OtokenMismatch,
        seeds = [
            b"otoken_info",
            vault.otoken_mint.as_ref(),
        ],
        bump,
    )]
    pub otoken_info: Account<'info, OTokenInfo>,
    #[account(
        mut,
        constraint = pool_token_account.mint
            == vault.collateral_mint
            @ ControllerError::CollateralMismatch,
        constraint = pool_token_account.owner
            == pool_vault_authority.key()
            @ ControllerError::Unauthorized,
    )]
    pub pool_token_account: Account<'info, TokenAccount>,
    #[account(
        mut,
        constraint = beneficiary_token_account.owner
            == vault.beneficiary
            @ ControllerError::Unauthorized,
        constraint = beneficiary_token_account.mint
            == vault.collateral_mint
            @ ControllerError::CollateralMismatch,
    )]
    pub beneficiary_token_account: Account<'info, TokenAccount>,
    /// CHECK: PDA authority for pool vault, validated by seeds
    #[account(
        seeds = [
            b"pool_vault_auth",
            vault.collateral_mint.as_ref(),
        ],
        bump,
    )]
    pub pool_vault_authority: AccountInfo<'info>,
    pub admin: Signer<'info>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct Redeem<'info> {
    #[account(
        seeds = [b"controller_config"],
        bump = config.bump,
    )]
    pub config: Account<'info, ControllerConfig>,
    #[account(
        seeds = [
            b"otoken_info",
            otoken_mint.key().as_ref(),
        ],
        bump,
    )]
    pub otoken_info: Account<'info, OTokenInfo>,
    #[account(
        mut,
        constraint = otoken_mint.key()
            == otoken_info.otoken_mint,
    )]
    pub otoken_mint: Account<'info, Mint>,
    #[account(
        mut,
        constraint = redeemer_otoken_account.mint
            == otoken_mint.key(),
    )]
    pub redeemer_otoken_account: Account<'info, TokenAccount>,
    #[account(
        mut,
        constraint = redeemer_collateral_account.mint
            == otoken_info.collateral_mint
            @ ControllerError::CollateralMismatch,
    )]
    pub redeemer_collateral_account: Account<'info, TokenAccount>,
    #[account(
        mut,
        constraint = pool_token_account.mint
            == otoken_info.collateral_mint
            @ ControllerError::CollateralMismatch,
        constraint = pool_token_account.owner
            == pool_vault_authority.key()
            @ ControllerError::Unauthorized,
    )]
    pub pool_token_account: Account<'info, TokenAccount>,
    /// CHECK: PDA authority for pool vault, validated by seeds
    #[account(
        seeds = [
            b"pool_vault_auth",
            otoken_info.collateral_mint.as_ref(),
        ],
        bump,
    )]
    pub pool_vault_authority: AccountInfo<'info>,
    #[account(mut)]
    pub redeemer: Signer<'info>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct CreateOTokenInfo<'info> {
    #[account(
        seeds = [b"controller_config"],
        bump = config.bump,
        has_one = admin,
    )]
    pub config: Account<'info, ControllerConfig>,
    #[account(
        init,
        payer = admin,
        space = 8 + 32 + 32 + 32 + 32 + 8 + 8 + 1 + 1 + 8,
        seeds = [
            b"otoken_info",
            otoken_mint.key().as_ref(),
        ],
        bump,
    )]
    pub otoken_info: Account<'info, OTokenInfo>,
    /// CHECK: oToken mint address used as PDA seed
    pub otoken_mint: AccountInfo<'info>,
    #[account(mut)]
    pub admin: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetExpiryPrice<'info> {
    #[account(
        seeds = [b"controller_config"],
        bump = config.bump,
        has_one = admin,
    )]
    pub config: Account<'info, ControllerConfig>,
    #[account(
        mut,
        seeds = [
            b"otoken_info",
            otoken_info.otoken_mint.as_ref(),
        ],
        bump,
    )]
    pub otoken_info: Account<'info, OTokenInfo>,
    pub admin: Signer<'info>,
}

#[derive(Accounts)]
pub struct AdminAction<'info> {
    #[account(
        mut,
        seeds = [b"controller_config"],
        bump = config.bump,
        has_one = admin,
    )]
    pub config: Account<'info, ControllerConfig>,
    pub admin: Signer<'info>,
}

#[derive(Accounts)]
pub struct PauseAction<'info> {
    #[account(
        mut,
        seeds = [b"controller_config"],
        bump = config.bump,
        constraint = caller.key() == config.admin
            || caller.key() == config.partial_pauser
            @ ControllerError::Unauthorized,
    )]
    pub config: Account<'info, ControllerConfig>,
    pub caller: Signer<'info>,
}

#[derive(Accounts)]
pub struct EmergencyWithdrawVault<'info> {
    #[account(
        seeds = [b"controller_config"],
        bump = config.bump,
    )]
    pub config: Account<'info, ControllerConfig>,
    #[account(
        mut,
        has_one = owner,
        seeds = [
            b"vault",
            vault.owner.as_ref(),
            vault.vault_id.to_le_bytes().as_ref(),
        ],
        bump = vault.bump,
    )]
    pub vault: Account<'info, Vault>,
    #[account(
        mut,
        constraint = pool_token_account.mint
            == vault.collateral_mint
            @ ControllerError::CollateralMismatch,
        constraint = pool_token_account.owner
            == pool_vault_authority.key()
            @ ControllerError::Unauthorized,
    )]
    pub pool_token_account: Account<'info, TokenAccount>,
    #[account(
        mut,
        constraint = beneficiary_token_account.owner
            == vault.beneficiary
            @ ControllerError::Unauthorized,
        constraint = beneficiary_token_account.mint
            == vault.collateral_mint
            @ ControllerError::CollateralMismatch,
    )]
    pub beneficiary_token_account: Account<'info, TokenAccount>,
    /// CHECK: PDA authority for pool vault
    #[account(
        seeds = [
            b"pool_vault_auth",
            vault.collateral_mint.as_ref(),
        ],
        bump,
    )]
    pub pool_vault_authority: AccountInfo<'info>,
    pub owner: Signer<'info>,
    pub token_program: Program<'info, Token>,
}

#[event]
pub struct ControllerInitialized {
    pub admin: Pubkey,
}

#[event]
pub struct VaultOpened {
    pub owner: Pubkey,
    pub vault_id: u64,
}

#[event]
pub struct CollateralDeposited {
    pub owner: Pubkey,
    pub vault_id: u64,
    pub asset: Pubkey,
    pub amount: u64,
}

#[event]
pub struct OTokenMinted {
    pub owner: Pubkey,
    pub vault_id: u64,
    pub otoken: Pubkey,
    pub amount: u64,
}

#[event]
pub struct VaultSettled {
    pub owner: Pubkey,
    pub vault_id: u64,
    pub collateral_returned: u64,
    pub payout_reserved: u64,
}

#[event]
pub struct Redeemed {
    pub otoken: Pubkey,
    pub redeemer: Pubkey,
    pub otoken_amount: u64,
    pub payout: u64,
}

#[event]
pub struct SystemPartiallyPaused {
    pub caller: Pubkey,
}

#[event]
pub struct SystemFullyPaused {
    pub caller: Pubkey,
}

#[event]
pub struct EmergencyWithdraw {
    pub beneficiary: Pubkey,
    pub vault_id: u64,
    pub collateral_amount: u64,
}

#[error_code]
pub enum ControllerError {
    #[msg("Address cannot be zero")]
    ZeroAddress,
    #[msg("Amount must be greater than zero")]
    ZeroAmount,
    #[msg("Vault already settled")]
    VaultSettled,
    #[msg("Collateral asset mismatch")]
    CollateralMismatch,
    #[msg("oToken mismatch for vault")]
    OtokenMismatch,
    #[msg("Insufficient collateral")]
    InsufficientCollateral,
    #[msg("Option has not expired")]
    NotExpired,
    #[msg("Expiry price not set")]
    ExpiryPriceNotSet,
    #[msg("Empty vault")]
    EmptyVault,
    #[msg("System partially paused")]
    SystemPartiallyPaused,
    #[msg("System fully paused")]
    SystemFullyPaused,
    #[msg("Unauthorized")]
    Unauthorized,
    #[msg("Arithmetic overflow")]
    MathOverflow,
    #[msg("Expiry price already set")]
    ExpiryPriceAlreadySet,
    #[msg("Invalid collateral decimals")]
    InvalidDecimals,
    #[msg("Option has expired")]
    OptionExpired,
    #[msg("System not fully paused")]
    NotFullyPaused,
}
