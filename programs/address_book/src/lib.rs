use anchor_lang::prelude::*;

declare_id!("4gJ1QmshidSWf3qqJk7pnythWtMtdpR4robr15oL3JUb");

#[program]
pub mod address_book {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>, admin: Pubkey) -> Result<()> {
        require!(admin != Pubkey::default(), AddressBookError::ZeroAddress);
        let registry = &mut ctx.accounts.registry;
        registry.admin = admin;
        registry.pending_admin = Pubkey::default();
        registry.bump = ctx.bumps.registry;
        emit!(Initialized { admin });
        Ok(())
    }

    pub fn set_address(ctx: Context<SetAddress>, key: AddressKey, address: Pubkey) -> Result<()> {
        require!(address != Pubkey::default(), AddressBookError::ZeroAddress);
        let registry = &mut ctx.accounts.registry;
        let old = match key {
            AddressKey::Controller => {
                let old = registry.controller;
                registry.controller = address;
                old
            }
            AddressKey::MarginPool => {
                let old = registry.margin_pool;
                registry.margin_pool = address;
                old
            }
            AddressKey::OtokenFactory => {
                let old = registry.otoken_factory;
                registry.otoken_factory = address;
                old
            }
            AddressKey::Oracle => {
                let old = registry.oracle;
                registry.oracle = address;
                old
            }
            AddressKey::Whitelist => {
                let old = registry.whitelist;
                registry.whitelist = address;
                old
            }
            AddressKey::BatchSettler => {
                let old = registry.batch_settler;
                registry.batch_settler = address;
                old
            }
        };
        emit!(AddressUpdated {
            key,
            old_address: old,
            new_address: address,
        });
        Ok(())
    }

    pub fn transfer_ownership(ctx: Context<SetAddress>, new_admin: Pubkey) -> Result<()> {
        require!(
            new_admin != Pubkey::default(),
            AddressBookError::ZeroAddress
        );
        let registry = &mut ctx.accounts.registry;
        registry.pending_admin = new_admin;
        emit!(OwnershipTransferStarted {
            old_admin: registry.admin,
            new_admin,
        });
        Ok(())
    }

    pub fn accept_ownership(ctx: Context<AcceptOwnership>) -> Result<()> {
        let registry = &mut ctx.accounts.registry;
        let old_admin = registry.admin;
        registry.admin = registry.pending_admin;
        registry.pending_admin = Pubkey::default();
        emit!(OwnershipTransferred {
            old_admin,
            new_admin: registry.admin,
        });
        Ok(())
    }
}

// PDA seeds: [b"registry"]
#[account]
pub struct Registry {
    pub admin: Pubkey,
    pub pending_admin: Pubkey,
    pub controller: Pubkey,
    pub margin_pool: Pubkey,
    pub otoken_factory: Pubkey,
    pub oracle: Pubkey,
    pub whitelist: Pubkey,
    pub batch_settler: Pubkey,
    pub bump: u8,
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
        space = 8 + 32 * 8 + 1,
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
        bump = registry.bump,
        has_one = admin,
    )]
    pub registry: Account<'info, Registry>,
    pub admin: Signer<'info>,
}

#[derive(Accounts)]
pub struct AcceptOwnership<'info> {
    #[account(
        mut,
        seeds = [b"registry"],
        bump = registry.bump,
        constraint = registry.pending_admin
            == new_admin.key()
            @ AddressBookError::NotPendingAdmin,
    )]
    pub registry: Account<'info, Registry>,
    pub new_admin: Signer<'info>,
}

#[event]
pub struct Initialized {
    pub admin: Pubkey,
}

#[event]
pub struct AddressUpdated {
    pub key: AddressKey,
    pub old_address: Pubkey,
    pub new_address: Pubkey,
}

#[event]
pub struct OwnershipTransferStarted {
    pub old_admin: Pubkey,
    pub new_admin: Pubkey,
}

#[event]
pub struct OwnershipTransferred {
    pub old_admin: Pubkey,
    pub new_admin: Pubkey,
}

#[error_code]
pub enum AddressBookError {
    #[msg("Address cannot be zero")]
    ZeroAddress,
    #[msg("Caller is not the pending admin")]
    NotPendingAdmin,
}
