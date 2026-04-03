use anchor_lang::prelude::*;

declare_id!("FH3z4BYRZMFU8YzpJoFXUbrdoYksdERnWbZvDAEc3qcC");

#[program]
pub mod controller {
    use super::*;

    pub fn open_vault(
        ctx: Context<OpenVault>,
        otoken: Pubkey,
    ) -> Result<()> {
        let vault = &mut ctx.accounts.vault;
        let counter = &mut ctx.accounts.vault_counter;

        vault.owner = ctx.accounts.owner.key();
        vault.vault_id = counter.next_id;
        vault.otoken = otoken;
        vault.collateral_amount = 0;
        vault.short_amount = 0;
        vault.settled = false;

        counter.next_id = counter.next_id.checked_add(1).unwrap();
        msg!("Vault {} opened", vault.vault_id);
        Ok(())
    }

    pub fn deposit_collateral(
        ctx: Context<DepositCollateral>,
        amount: u64,
    ) -> Result<()> {
        let vault = &mut ctx.accounts.vault;
        vault.collateral_amount = vault
            .collateral_amount
            .checked_add(amount)
            .unwrap();
        msg!("Deposited {} collateral", amount);
        Ok(())
    }

    pub fn mint_otoken(
        ctx: Context<MintOtoken>,
        amount: u64,
    ) -> Result<()> {
        let vault = &mut ctx.accounts.vault;
        vault.short_amount = vault
            .short_amount
            .checked_add(amount)
            .unwrap();
        msg!("Minted {} oTokens", amount);
        Ok(())
    }

    pub fn settle_vault(ctx: Context<SettleVault>) -> Result<()> {
        let vault = &mut ctx.accounts.vault;
        vault.settled = true;
        msg!("Vault {} settled", vault.vault_id);
        Ok(())
    }

    pub fn redeem(ctx: Context<Redeem>, _amount: u64) -> Result<()> {
        msg!(
            "Redeem from vault {}",
            ctx.accounts.vault.vault_id
        );
        Ok(())
    }

    pub fn initialize_counter(
        ctx: Context<InitializeCounter>,
    ) -> Result<()> {
        ctx.accounts.vault_counter.next_id = 0;
        ctx.accounts.vault_counter.owner =
            ctx.accounts.owner.key();
        Ok(())
    }
}

// PDA seeds: [b"vault", owner, vault_id.to_le_bytes()]
#[account]
pub struct Vault {
    pub owner: Pubkey,
    pub vault_id: u64,
    pub otoken: Pubkey,
    pub collateral_amount: u64,
    pub short_amount: u64,
    pub settled: bool,
}

// PDA seeds: [b"vault_counter", owner]
#[account]
pub struct VaultCounter {
    pub owner: Pubkey,
    pub next_id: u64,
}

#[derive(Accounts)]
pub struct InitializeCounter<'info> {
    #[account(
        init,
        payer = owner,
        space = 8 + 32 + 8,
        seeds = [b"vault_counter", owner.key().as_ref()],
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
        init,
        payer = owner,
        space = 8 + 32 + 8 + 32 + 8 + 8 + 1,
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
        seeds = [b"vault_counter", owner.key().as_ref()],
        bump,
        has_one = owner,
    )]
    pub vault_counter: Account<'info, VaultCounter>,
    #[account(mut)]
    pub owner: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct DepositCollateral<'info> {
    #[account(mut, has_one = owner)]
    pub vault: Account<'info, Vault>,
    pub owner: Signer<'info>,
}

#[derive(Accounts)]
pub struct MintOtoken<'info> {
    #[account(mut, has_one = owner)]
    pub vault: Account<'info, Vault>,
    pub owner: Signer<'info>,
}

#[derive(Accounts)]
pub struct SettleVault<'info> {
    #[account(mut)]
    pub vault: Account<'info, Vault>,
    pub settler: Signer<'info>,
}

#[derive(Accounts)]
pub struct Redeem<'info> {
    #[account(mut)]
    pub vault: Account<'info, Vault>,
    pub redeemer: Signer<'info>,
}
