use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    self, Mint, TokenAccount, TokenInterface, TransferChecked,
};

declare_id!("Hp7XDp9USyoid2f7cJKPxmDrvHM2D8izeeGzkViPiy5r");

#[program]
pub mod margin_pool {
    use super::*;

    pub fn initialize(
        ctx: Context<Initialize>,
        controller: Pubkey,
        operator: Pubkey,
        yield_recipient: Pubkey,
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
        pool_vault.bump = ctx.bumps.pool_vault;
        pool_vault.vault_authority_bump = ctx.bumps.vault_authority;
        emit!(PoolVaultCreated {
            collateral_mint: pool_vault.collateral_mint,
        });
        Ok(())
    }

    pub fn transfer_to_pool(ctx: Context<TransferToPool>, amount: u64) -> Result<()> {
        require!(amount > 0, MarginPoolError::ZeroAmount);

        token_interface::transfer_checked(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.user_token_account.to_account_info(),
                    mint: ctx.accounts.collateral_mint.to_account_info(),
                    to: ctx.accounts.vault_token_account.to_account_info(),
                    authority: ctx.accounts.user_authority.to_account_info(),
                },
            ),
            amount,
            ctx.accounts.collateral_mint.decimals,
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
            b"lending_vault_auth".as_ref(),
            mint_key.as_ref(),
            &[pool_vault.vault_authority_bump],
        ];
        let signer_seeds = &[&seeds[..]];

        token_interface::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.vault_token_account.to_account_info(),
                    mint: ctx.accounts.collateral_mint.to_account_info(),
                    to: ctx.accounts.user_token_account.to_account_info(),
                    authority: ctx.accounts.vault_authority.to_account_info(),
                },
                signer_seeds,
            ),
            amount,
            ctx.accounts.collateral_mint.decimals,
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
    pub bump: u8,
}

/// PDA seeds: [b"pool_vault", collateral_mint]
///
/// The associated SPL token account (`token_account`) is owned by
/// the PDA derived from [b"lending_vault_auth", collateral_mint]
/// in this program. This is intentionally a different namespace
/// from the controller's [b"pool_vault_auth", collateral_mint] PDA:
/// margin_pool tracks direct pool funds, controller
/// tracks vault collateral. The two pools are independent and must
/// not be conflated.
#[account]
pub struct PoolVault {
    pub collateral_mint: Pubkey,
    pub token_account: Pubkey,
    pub total_deposited: u64,
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
        space = 8 + 32 * 4 + 1,
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
        space = 8 + 32 + 32 + 8 + 1 + 1,
        seeds = [b"pool_vault", collateral_mint.key().as_ref()],
        bump,
    )]
    pub pool_vault: Account<'info, PoolVault>,
    #[account(
        constraint = vault_token_account.mint == collateral_mint.key(),
        constraint = vault_token_account.owner == vault_authority.key(),
    )]
    pub vault_token_account: InterfaceAccount<'info, TokenAccount>,
    /// CHECK: PDA used as token authority
    #[account(
        seeds = [b"lending_vault_auth", collateral_mint.key().as_ref()],
        bump,
    )]
    pub vault_authority: AccountInfo<'info>,
    pub collateral_mint: InterfaceAccount<'info, Mint>,
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
    pub user_token_account: InterfaceAccount<'info, TokenAccount>,
    #[account(
        constraint = collateral_mint.key()
            == pool_vault.collateral_mint
            @ MarginPoolError::CollateralMismatch,
    )]
    pub collateral_mint: InterfaceAccount<'info, Mint>,
    #[account(mut, address = pool_vault.token_account)]
    pub vault_token_account: InterfaceAccount<'info, TokenAccount>,
    pub user_authority: Signer<'info>,
    /// CHECK: Recipient address for event logging
    pub recipient: AccountInfo<'info>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct TransferToUser<'info> {
    #[account(
        seeds = [b"margin_pool_config"],
        bump = config.bump,
        has_one = admin,
    )]
    pub config: Account<'info, MarginPoolConfig>,
    pub admin: Signer<'info>,
    #[account(
        mut,
        seeds = [b"pool_vault", pool_vault.collateral_mint.as_ref()],
        bump = pool_vault.bump,
    )]
    pub pool_vault: Account<'info, PoolVault>,
    #[account(mut, address = pool_vault.token_account)]
    pub vault_token_account: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, constraint = user_token_account.mint == pool_vault.collateral_mint)]
    pub user_token_account: InterfaceAccount<'info, TokenAccount>,
    #[account(
        constraint = collateral_mint.key()
            == pool_vault.collateral_mint
            @ MarginPoolError::CollateralMismatch,
    )]
    pub collateral_mint: InterfaceAccount<'info, Mint>,
    /// CHECK: PDA authority for pool token account
    #[account(
        seeds = [b"lending_vault_auth", pool_vault.collateral_mint.as_ref()],
        bump,
    )]
    pub vault_authority: AccountInfo<'info>,
    /// CHECK: Recipient address for event logging
    pub recipient: AccountInfo<'info>,
    pub token_program: Interface<'info, TokenInterface>,
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
    #[msg("Collateral mint mismatch")]
    CollateralMismatch,
}
