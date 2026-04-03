use anchor_lang::prelude::*;

declare_id!("4gJ1QmshidSWf3qqJk7pnythWtMtdpR4robr15oL3JUb");

#[program]
pub mod address_book {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>, admin: Pubkey) -> Result<()> {
        let registry = &mut ctx.accounts.registry;
        registry.admin = admin;
        registry.controller = Pubkey::default();
        registry.margin_pool = Pubkey::default();
        registry.otoken_factory = Pubkey::default();
        registry.oracle = Pubkey::default();
        registry.whitelist = Pubkey::default();
        registry.batch_settler = Pubkey::default();
        msg!("AddressBook initialized");
        Ok(())
    }

    pub fn set_address(
        ctx: Context<SetAddress>,
        key: AddressKey,
        address: Pubkey,
    ) -> Result<()> {
        let registry = &mut ctx.accounts.registry;
        match key {
            AddressKey::Controller => registry.controller = address,
            AddressKey::MarginPool => registry.margin_pool = address,
            AddressKey::OtokenFactory => registry.otoken_factory = address,
            AddressKey::Oracle => registry.oracle = address,
            AddressKey::Whitelist => registry.whitelist = address,
            AddressKey::BatchSettler => registry.batch_settler = address,
        }
        msg!("Address set: {:?} = {}", key, address);
        Ok(())
    }
}

// PDA seeds: [b"registry"]
#[account]
pub struct Registry {
    pub admin: Pubkey,
    pub controller: Pubkey,
    pub margin_pool: Pubkey,
    pub otoken_factory: Pubkey,
    pub oracle: Pubkey,
    pub whitelist: Pubkey,
    pub batch_settler: Pubkey,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub enum AddressKey {
    Controller,
    MarginPool,
    OtokenFactory,
    Oracle,
    Whitelist,
    BatchSettler,
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(
        init,
        payer = payer,
        space = 8 + 32 * 7,
        seeds = [b"registry"],
        bump,
    )]
    pub registry: Account<'info, Registry>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetAddress<'info> {
    #[account(
        mut,
        seeds = [b"registry"],
        bump,
        has_one = admin,
    )]
    pub registry: Account<'info, Registry>,
    pub admin: Signer<'info>,
}
