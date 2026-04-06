use anchor_lang::prelude::*;
use anchor_lang::solana_program;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

declare_id!("Hp7XDp9USyoid2f7cJKPxmDrvHM2D8izeeGzkViPiy5r");

#[program]
pub mod margin_pool {
    use super::*;

    pub fn initialize(
        ctx: Context<Initialize>,
        controller: Pubkey,
        operator: Pubkey,
        yield_recipient: Pubkey,
        kamino_program: Pubkey,
    ) -> Result<()> {
        require!(
            controller != Pubkey::default(),
            MarginPoolError::ZeroAddress
        );
        let config = &mut ctx.accounts.config;
        config.admin = ctx.accounts.admin.key();
        config.controller = controller;
        config.operator = operator;
        config.yield_recipient = yield_recipient;
        config.kamino_program = kamino_program;
        config.bump = ctx.bumps.config;
        emit!(PoolInitialized {
            admin: config.admin,
            controller,
        });
        Ok(())
    }

    pub fn create_pool_vault(ctx: Context<CreatePoolVault>) -> Result<()> {
        let pool_vault = &mut ctx.accounts.pool_vault;
        pool_vault.collateral_mint = ctx.accounts.collateral_mint.key();
        pool_vault.token_account = ctx.accounts.vault_token_account.key();
        pool_vault.total_deposited = 0;
        pool_vault.lending_enabled = false;
        pool_vault.total_in_lending = 0;
        pool_vault.lending_collateral_account = Pubkey::default();
        pool_vault.bump = ctx.bumps.pool_vault;
        pool_vault.vault_authority_bump = ctx.bumps.vault_authority;
        emit!(PoolVaultCreated {
            collateral_mint: pool_vault.collateral_mint,
        });
        Ok(())
    }

    pub fn transfer_to_pool(ctx: Context<TransferToPool>, amount: u64) -> Result<()> {
        require!(amount > 0, MarginPoolError::ZeroAmount);

        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.user_token_account.to_account_info(),
                    to: ctx.accounts.vault_token_account.to_account_info(),
                    authority: ctx.accounts.user_authority.to_account_info(),
                },
            ),
            amount,
        )?;

        let pool_vault = &mut ctx.accounts.pool_vault;
        pool_vault.total_deposited = pool_vault
            .total_deposited
            .checked_add(amount)
            .ok_or(MarginPoolError::MathOverflow)?;

        emit!(CollateralDeposited {
            collateral_mint: pool_vault.collateral_mint,
            from: ctx.accounts.user_authority.key(),
            amount,
        });
        Ok(())
    }

    pub fn transfer_to_user(ctx: Context<TransferToUser>, amount: u64) -> Result<()> {
        require!(amount > 0, MarginPoolError::ZeroAmount);

        let pool_vault = &mut ctx.accounts.pool_vault;
        require!(
            pool_vault.total_deposited >= amount,
            MarginPoolError::InsufficientBalance
        );

        let mint_key = pool_vault.collateral_mint;
        let seeds = &[
            b"pool_vault_auth".as_ref(),
            mint_key.as_ref(),
            &[pool_vault.vault_authority_bump],
        ];
        let signer_seeds = &[&seeds[..]];

        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.vault_token_account.to_account_info(),
                    to: ctx.accounts.user_token_account.to_account_info(),
                    authority: ctx.accounts.vault_authority.to_account_info(),
                },
                signer_seeds,
            ),
            amount,
        )?;

        pool_vault.total_deposited = pool_vault
            .total_deposited
            .checked_sub(amount)
            .ok_or(MarginPoolError::MathOverflow)?;

        emit!(CollateralWithdrawn {
            collateral_mint: pool_vault.collateral_mint,
            to: ctx.accounts.recipient.key(),
            amount,
        });
        Ok(())
    }

    // ── Admin config setters ──────────────────────────────

    pub fn set_controller(ctx: Context<AdminOnly>, new_controller: Pubkey) -> Result<()> {
        require!(
            new_controller != Pubkey::default(),
            MarginPoolError::ZeroAddress
        );
        ctx.accounts.config.controller = new_controller;
        Ok(())
    }

    pub fn set_operator(ctx: Context<AdminOnly>, operator: Pubkey) -> Result<()> {
        require!(operator != Pubkey::default(), MarginPoolError::ZeroAddress);
        ctx.accounts.config.operator = operator;
        Ok(())
    }

    pub fn set_yield_recipient(ctx: Context<AdminOnly>, recipient: Pubkey) -> Result<()> {
        require!(recipient != Pubkey::default(), MarginPoolError::ZeroAddress);
        ctx.accounts.config.yield_recipient = recipient;
        Ok(())
    }

    pub fn set_kamino_program(ctx: Context<AdminOnly>, program_id: Pubkey) -> Result<()> {
        require!(
            program_id != Pubkey::default(),
            MarginPoolError::ZeroAddress
        );
        ctx.accounts.config.kamino_program = program_id;
        Ok(())
    }

    // ── Per-vault lending config ──────────────────────────

    pub fn set_lending_enabled(ctx: Context<VaultAdmin>, enabled: bool) -> Result<()> {
        let vault = &mut ctx.accounts.pool_vault;
        if enabled {
            require!(
                vault.lending_collateral_account != Pubkey::default(),
                MarginPoolError::LendingNotConfigured
            );
            require!(
                ctx.accounts.config.kamino_program != Pubkey::default(),
                MarginPoolError::LendingNotConfigured
            );
        }
        vault.lending_enabled = enabled;
        emit!(LendingToggled {
            collateral_mint: vault.collateral_mint,
            enabled,
        });
        Ok(())
    }

    pub fn set_lending_collateral_account(ctx: Context<VaultAdmin>, account: Pubkey) -> Result<()> {
        require!(account != Pubkey::default(), MarginPoolError::ZeroAddress);
        ctx.accounts.pool_vault.lending_collateral_account = account;
        Ok(())
    }

    // ── Lending operations ────────────────────────────────

    /// Operator moves tokens from pool vault to Kamino lending.
    /// Kamino accounts passed via remaining_accounts (12 accounts).
    pub fn supply_to_lending<'info>(
        ctx: Context<'_, '_, 'info, 'info, LendingOperation<'info>>,
        amount: u64,
        kamino_ix_data: Vec<u8>,
    ) -> Result<()> {
        require!(amount > 0, MarginPoolError::ZeroAmount);
        let vault = &ctx.accounts.pool_vault;
        require!(vault.lending_enabled, MarginPoolError::LendingNotEnabled);

        let kamino_program = &ctx.accounts.kamino_program;
        require!(
            kamino_program.key() == ctx.accounts.config.kamino_program,
            MarginPoolError::InvalidKaminoProgram
        );

        let balance_before = ctx.accounts.vault_token_account.amount;

        let mint_key = vault.collateral_mint;
        let auth_bump = vault.vault_authority_bump;
        let seeds = &[b"pool_vault_auth".as_ref(), mint_key.as_ref(), &[auth_bump]];
        let signer_seeds = &[&seeds[..]];

        invoke_with_remaining(
            kamino_program.key,
            ctx.remaining_accounts,
            &ctx.accounts.vault_authority,
            signer_seeds,
            kamino_ix_data,
        )?;

        // Verify actual tokens left the vault
        ctx.accounts.vault_token_account.reload()?;
        let actual_sent = balance_before
            .checked_sub(ctx.accounts.vault_token_account.amount)
            .ok_or(MarginPoolError::MathOverflow)?;

        let vault = &mut ctx.accounts.pool_vault;
        vault.total_in_lending = vault
            .total_in_lending
            .checked_add(actual_sent)
            .ok_or(MarginPoolError::MathOverflow)?;

        emit!(SuppliedToLending {
            collateral_mint: vault.collateral_mint,
            amount: actual_sent,
        });
        Ok(())
    }

    /// Operator withdraws tokens from Kamino back to pool vault.
    pub fn withdraw_from_lending<'info>(
        ctx: Context<'_, '_, 'info, 'info, LendingOperation<'info>>,
        amount: u64,
        kamino_ix_data: Vec<u8>,
    ) -> Result<()> {
        require!(amount > 0, MarginPoolError::ZeroAmount);

        let kamino_program = &ctx.accounts.kamino_program;
        require!(
            kamino_program.key() == ctx.accounts.config.kamino_program,
            MarginPoolError::InvalidKaminoProgram
        );

        let balance_before = ctx.accounts.vault_token_account.amount;

        let vault = &ctx.accounts.pool_vault;
        let mint_key = vault.collateral_mint;
        let auth_bump = vault.vault_authority_bump;
        let seeds = &[b"pool_vault_auth".as_ref(), mint_key.as_ref(), &[auth_bump]];
        let signer_seeds = &[&seeds[..]];

        invoke_with_remaining(
            kamino_program.key,
            ctx.remaining_accounts,
            &ctx.accounts.vault_authority,
            signer_seeds,
            kamino_ix_data,
        )?;

        // Verify actual tokens received
        ctx.accounts.vault_token_account.reload()?;
        let actual_received = ctx
            .accounts
            .vault_token_account
            .amount
            .checked_sub(balance_before)
            .ok_or(MarginPoolError::MathOverflow)?;

        let vault = &mut ctx.accounts.pool_vault;
        vault.total_in_lending = vault
            .total_in_lending
            .checked_sub(actual_received)
            .ok_or(MarginPoolError::MathOverflow)?;

        emit!(WithdrawnFromLending {
            collateral_mint: vault.collateral_mint,
            amount: actual_received,
        });
        Ok(())
    }

    /// Harvest yield: withdraw from lending + transfer to yield_recipient.
    /// yield_amount is computed off-chain (cToken value - total_in_lending).
    pub fn harvest_yield<'info>(
        ctx: Context<'_, '_, 'info, 'info, HarvestYield<'info>>,
        yield_amount: u64,
        kamino_ix_data: Vec<u8>,
    ) -> Result<()> {
        require!(yield_amount > 0, MarginPoolError::ZeroAmount);
        require!(
            ctx.accounts.pool_vault.lending_enabled,
            MarginPoolError::LendingNotEnabled
        );
        require!(
            ctx.accounts.config.yield_recipient != Pubkey::default(),
            MarginPoolError::ZeroAddress
        );

        let kamino_program = &ctx.accounts.kamino_program;
        require!(
            kamino_program.key() == ctx.accounts.config.kamino_program,
            MarginPoolError::InvalidKaminoProgram
        );

        // Snapshot balance before Kamino CPI
        let balance_before = ctx.accounts.vault_token_account.amount;

        let vault = &ctx.accounts.pool_vault;
        let mint_key = vault.collateral_mint;
        let auth_bump = vault.vault_authority_bump;
        let seeds = &[b"pool_vault_auth".as_ref(), mint_key.as_ref(), &[auth_bump]];
        let signer_seeds = &[&seeds[..]];

        // 1. Withdraw yield from Kamino → vault token account
        invoke_with_remaining(
            kamino_program.key,
            ctx.remaining_accounts,
            &ctx.accounts.vault_authority,
            signer_seeds,
            kamino_ix_data,
        )?;

        // Verify Kamino actually returned enough tokens
        ctx.accounts.vault_token_account.reload()?;
        let actual_received = ctx
            .accounts
            .vault_token_account
            .amount
            .checked_sub(balance_before)
            .ok_or(MarginPoolError::MathOverflow)?;
        require!(
            yield_amount <= actual_received,
            MarginPoolError::InsufficientYield
        );

        // 2. Transfer yield from vault → yield_recipient
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.vault_token_account.to_account_info(),
                    to: ctx.accounts.yield_recipient_account.to_account_info(),
                    authority: ctx.accounts.vault_authority.to_account_info(),
                },
                signer_seeds,
            ),
            yield_amount,
        )?;

        emit!(YieldHarvested {
            collateral_mint: vault.collateral_mint,
            recipient: ctx.accounts.config.yield_recipient,
            amount: yield_amount,
        });
        Ok(())
    }

    /// Owner drains all from Kamino and disables lending for vault.
    /// Admin-only (not operator) — this is a destructive operation.
    pub fn drain_lending<'info>(
        ctx: Context<'_, '_, 'info, 'info, LendingOperation<'info>>,
        kamino_ix_data: Vec<u8>,
    ) -> Result<()> {
        require!(
            ctx.accounts.caller.key() == ctx.accounts.config.admin,
            MarginPoolError::Unauthorized
        );
        let vault = &ctx.accounts.pool_vault;
        require!(vault.total_in_lending > 0, MarginPoolError::ZeroAmount);

        let kamino_program = &ctx.accounts.kamino_program;
        require!(
            kamino_program.key() == ctx.accounts.config.kamino_program,
            MarginPoolError::InvalidKaminoProgram
        );

        let mint_key = vault.collateral_mint;
        let auth_bump = vault.vault_authority_bump;
        let seeds = &[b"pool_vault_auth".as_ref(), mint_key.as_ref(), &[auth_bump]];
        let signer_seeds = &[&seeds[..]];

        invoke_with_remaining(
            kamino_program.key,
            ctx.remaining_accounts,
            &ctx.accounts.vault_authority,
            signer_seeds,
            kamino_ix_data,
        )?;

        let vault = &mut ctx.accounts.pool_vault;
        vault.total_in_lending = 0;
        vault.lending_enabled = false;

        emit!(LendingDrained {
            collateral_mint: vault.collateral_mint,
        });
        Ok(())
    }
}

// ============================================================
// State
// ============================================================

/// PDA seeds: [b"margin_pool_config"]
#[account]
pub struct MarginPoolConfig {
    pub admin: Pubkey,
    pub controller: Pubkey,
    pub operator: Pubkey,
    pub yield_recipient: Pubkey,
    pub kamino_program: Pubkey,
    pub bump: u8,
}

/// PDA seeds: [b"pool_vault", collateral_mint]
#[account]
pub struct PoolVault {
    pub collateral_mint: Pubkey,
    pub token_account: Pubkey,
    pub total_deposited: u64,
    pub lending_enabled: bool,
    pub total_in_lending: u64,
    pub lending_collateral_account: Pubkey,
    pub bump: u8,
    pub vault_authority_bump: u8,
}

// ============================================================
// Contexts
// ============================================================

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(
        init,
        payer = admin,
        space = 8 + 32 * 5 + 1,
        seeds = [b"margin_pool_config"],
        bump,
    )]
    pub config: Account<'info, MarginPoolConfig>,
    #[account(mut)]
    pub admin: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CreatePoolVault<'info> {
    #[account(
        seeds = [b"margin_pool_config"],
        bump = config.bump,
        has_one = admin,
    )]
    pub config: Account<'info, MarginPoolConfig>,
    #[account(
        init,
        payer = admin,
        space = 8 + 32 + 32 + 8 + 1 + 8 + 32 + 1 + 1,
        seeds = [b"pool_vault", collateral_mint.key().as_ref()],
        bump,
    )]
    pub pool_vault: Account<'info, PoolVault>,
    #[account(
        constraint = vault_token_account.mint == collateral_mint.key(),
        constraint = vault_token_account.owner == vault_authority.key(),
    )]
    pub vault_token_account: Account<'info, TokenAccount>,
    /// CHECK: PDA used as token authority
    #[account(
        seeds = [b"pool_vault_auth", collateral_mint.key().as_ref()],
        bump,
    )]
    pub vault_authority: AccountInfo<'info>,
    pub collateral_mint: Account<'info, Mint>,
    #[account(mut)]
    pub admin: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct TransferToPool<'info> {
    #[account(seeds = [b"margin_pool_config"], bump = config.bump)]
    pub config: Account<'info, MarginPoolConfig>,
    #[account(
        mut,
        seeds = [b"pool_vault", pool_vault.collateral_mint.as_ref()],
        bump = pool_vault.bump,
    )]
    pub pool_vault: Account<'info, PoolVault>,
    #[account(mut, constraint = user_token_account.mint == pool_vault.collateral_mint)]
    pub user_token_account: Account<'info, TokenAccount>,
    #[account(mut, address = pool_vault.token_account)]
    pub vault_token_account: Account<'info, TokenAccount>,
    pub user_authority: Signer<'info>,
    /// CHECK: Recipient address for event logging
    pub recipient: AccountInfo<'info>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct TransferToUser<'info> {
    #[account(seeds = [b"margin_pool_config"], bump = config.bump)]
    pub config: Account<'info, MarginPoolConfig>,
    #[account(
        mut,
        seeds = [b"pool_vault", pool_vault.collateral_mint.as_ref()],
        bump = pool_vault.bump,
    )]
    pub pool_vault: Account<'info, PoolVault>,
    #[account(mut, address = pool_vault.token_account)]
    pub vault_token_account: Account<'info, TokenAccount>,
    #[account(mut, constraint = user_token_account.mint == pool_vault.collateral_mint)]
    pub user_token_account: Account<'info, TokenAccount>,
    /// CHECK: PDA authority for pool token account
    #[account(
        seeds = [b"pool_vault_auth", pool_vault.collateral_mint.as_ref()],
        bump,
    )]
    pub vault_authority: AccountInfo<'info>,
    /// CHECK: Recipient address for event logging
    pub recipient: AccountInfo<'info>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct AdminOnly<'info> {
    #[account(
        mut,
        seeds = [b"margin_pool_config"],
        bump = config.bump,
        has_one = admin,
    )]
    pub config: Account<'info, MarginPoolConfig>,
    pub admin: Signer<'info>,
}

#[derive(Accounts)]
pub struct VaultAdmin<'info> {
    #[account(
        seeds = [b"margin_pool_config"],
        bump = config.bump,
        has_one = admin,
    )]
    pub config: Account<'info, MarginPoolConfig>,
    #[account(
        mut,
        seeds = [b"pool_vault", pool_vault.collateral_mint.as_ref()],
        bump = pool_vault.bump,
    )]
    pub pool_vault: Account<'info, PoolVault>,
    pub admin: Signer<'info>,
}

#[derive(Accounts)]
pub struct LendingOperation<'info> {
    #[account(
        seeds = [b"margin_pool_config"],
        bump = config.bump,
        constraint = caller.key() == config.admin
            || caller.key() == config.operator
            @ MarginPoolError::Unauthorized,
    )]
    pub config: Account<'info, MarginPoolConfig>,
    #[account(
        mut,
        seeds = [b"pool_vault", pool_vault.collateral_mint.as_ref()],
        bump = pool_vault.bump,
    )]
    pub pool_vault: Account<'info, PoolVault>,
    #[account(mut, address = pool_vault.token_account)]
    pub vault_token_account: Account<'info, TokenAccount>,
    /// CHECK: PDA authority for pool token account
    #[account(
        seeds = [b"pool_vault_auth", pool_vault.collateral_mint.as_ref()],
        bump = pool_vault.vault_authority_bump,
    )]
    pub vault_authority: AccountInfo<'info>,
    /// CHECK: Kamino program, validated against config
    pub kamino_program: AccountInfo<'info>,
    #[account(mut)]
    pub caller: Signer<'info>,
    // remaining_accounts: Kamino CPI accounts (12)
}

#[derive(Accounts)]
pub struct HarvestYield<'info> {
    #[account(
        seeds = [b"margin_pool_config"],
        bump = config.bump,
        constraint = caller.key() == config.admin
            || caller.key() == config.operator
            @ MarginPoolError::Unauthorized,
    )]
    pub config: Account<'info, MarginPoolConfig>,
    #[account(
        mut,
        seeds = [b"pool_vault", pool_vault.collateral_mint.as_ref()],
        bump = pool_vault.bump,
    )]
    pub pool_vault: Account<'info, PoolVault>,
    #[account(mut, address = pool_vault.token_account)]
    pub vault_token_account: Account<'info, TokenAccount>,
    /// CHECK: PDA authority
    #[account(
        seeds = [b"pool_vault_auth", pool_vault.collateral_mint.as_ref()],
        bump = pool_vault.vault_authority_bump,
    )]
    pub vault_authority: AccountInfo<'info>,
    /// Yield recipient token account
    #[account(
        mut,
        constraint = yield_recipient_account.owner == config.yield_recipient
            @ MarginPoolError::Unauthorized,
    )]
    pub yield_recipient_account: Box<Account<'info, TokenAccount>>,
    /// CHECK: Kamino program
    pub kamino_program: AccountInfo<'info>,
    #[account(mut)]
    pub caller: Signer<'info>,
    pub token_program: Program<'info, Token>,
    // remaining_accounts: Kamino CPI accounts
}

// ============================================================
// Helpers
// ============================================================

fn invoke_with_remaining<'info>(
    program_id: &Pubkey,
    remaining_accounts: &[AccountInfo<'info>],
    signer_account: &AccountInfo<'info>,
    signer_seeds: &[&[&[u8]]],
    ix_data: Vec<u8>,
) -> Result<()> {
    let mut accounts_meta = Vec::new();
    for acct in remaining_accounts {
        let is_signer = acct.key == signer_account.key;
        if acct.is_writable {
            accounts_meta.push(solana_program::instruction::AccountMeta::new(
                *acct.key, is_signer,
            ));
        } else {
            accounts_meta.push(solana_program::instruction::AccountMeta::new_readonly(
                *acct.key, is_signer,
            ));
        }
    }

    let ix = solana_program::instruction::Instruction {
        program_id: *program_id,
        accounts: accounts_meta,
        data: ix_data,
    };

    let infos: Vec<AccountInfo> = remaining_accounts.to_vec();
    solana_program::program::invoke_signed(&ix, &infos, signer_seeds).map_err(Into::into)
}

// ============================================================
// Events
// ============================================================

#[event]
pub struct PoolInitialized {
    pub admin: Pubkey,
    pub controller: Pubkey,
}

#[event]
pub struct PoolVaultCreated {
    pub collateral_mint: Pubkey,
}

#[event]
pub struct CollateralDeposited {
    pub collateral_mint: Pubkey,
    pub from: Pubkey,
    pub amount: u64,
}

#[event]
pub struct CollateralWithdrawn {
    pub collateral_mint: Pubkey,
    pub to: Pubkey,
    pub amount: u64,
}

#[event]
pub struct LendingToggled {
    pub collateral_mint: Pubkey,
    pub enabled: bool,
}

#[event]
pub struct SuppliedToLending {
    pub collateral_mint: Pubkey,
    pub amount: u64,
}

#[event]
pub struct WithdrawnFromLending {
    pub collateral_mint: Pubkey,
    pub amount: u64,
}

#[event]
pub struct YieldHarvested {
    pub collateral_mint: Pubkey,
    pub recipient: Pubkey,
    pub amount: u64,
}

#[event]
pub struct LendingDrained {
    pub collateral_mint: Pubkey,
}

// ============================================================
// Errors
// ============================================================

#[error_code]
pub enum MarginPoolError {
    #[msg("Address cannot be zero")]
    ZeroAddress,
    #[msg("Amount must be greater than zero")]
    ZeroAmount,
    #[msg("Insufficient pool balance")]
    InsufficientBalance,
    #[msg("Arithmetic overflow")]
    MathOverflow,
    #[msg("Unauthorized")]
    Unauthorized,
    #[msg("Lending not enabled for this vault")]
    LendingNotEnabled,
    #[msg("Lending not configured (missing cToken account or Kamino program)")]
    LendingNotConfigured,
    #[msg("Invalid Kamino program")]
    InvalidKaminoProgram,
    #[msg("Yield amount exceeds actual Kamino return")]
    InsufficientYield,
}
