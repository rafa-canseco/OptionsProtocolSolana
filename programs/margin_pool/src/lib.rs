use anchor_lang::prelude::*;

declare_id!("Hp7XDp9USyoid2f7cJKPxmDrvHM2D8izeeGzkViPiy5r");

#[program]
pub mod margin_pool {
    use super::*;

    pub fn initialize_pool(
        ctx: Context<InitializePool>,
    ) -> Result<()> {
        let pool = &mut ctx.accounts.pool;
        pool.collateral_mint = ctx.accounts.collateral_mint.key();
        pool.vault_token_account =
            ctx.accounts.vault_token_account.key();
        pool.admin = ctx.accounts.admin.key();
        pool.total_deposited = 0;
        msg!("MarginPool initialized");
        Ok(())
    }

    pub fn deposit(
        ctx: Context<PoolDeposit>,
        amount: u64,
    ) -> Result<()> {
        let pool = &mut ctx.accounts.pool;
        pool.total_deposited = pool
            .total_deposited
            .checked_add(amount)
            .unwrap();
        // TODO: SPL token CPI transfer (anchor-spl)
        msg!("Deposited {} to margin pool", amount);
        Ok(())
    }

    pub fn withdraw(
        ctx: Context<PoolWithdraw>,
        amount: u64,
    ) -> Result<()> {
        let pool = &mut ctx.accounts.pool;
        pool.total_deposited = pool
            .total_deposited
            .checked_sub(amount)
            .unwrap();
        // TODO: SPL token CPI transfer out (anchor-spl)
        msg!("Withdrew {} from margin pool", amount);
        Ok(())
    }
}

// PDA seeds: [b"margin_pool", collateral_mint]
#[account]
pub struct MarginPool {
    pub collateral_mint: Pubkey,
    pub vault_token_account: Pubkey,
    pub admin: Pubkey,
    pub total_deposited: u64,
}

#[derive(Accounts)]
pub struct InitializePool<'info> {
    #[account(
        init,
        payer = admin,
        space = 8 + 32 + 32 + 32 + 8,
        seeds = [
            b"margin_pool",
            collateral_mint.key().as_ref(),
        ],
        bump,
    )]
    pub pool: Account<'info, MarginPool>,
    /// CHECK: Validated by SPL token program
    pub collateral_mint: AccountInfo<'info>,
    /// CHECK: Pool vault token account
    pub vault_token_account: AccountInfo<'info>,
    #[account(mut)]
    pub admin: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct PoolDeposit<'info> {
    #[account(
        mut,
        seeds = [
            b"margin_pool",
            pool.collateral_mint.as_ref(),
        ],
        bump,
    )]
    pub pool: Account<'info, MarginPool>,
    pub depositor: Signer<'info>,
}

#[derive(Accounts)]
pub struct PoolWithdraw<'info> {
    #[account(
        mut,
        seeds = [
            b"margin_pool",
            pool.collateral_mint.as_ref(),
        ],
        bump,
        has_one = admin,
    )]
    pub pool: Account<'info, MarginPool>,
    pub admin: Signer<'info>,
}
