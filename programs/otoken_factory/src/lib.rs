use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenInterface};

declare_id!("84hBdboukYWVg7DoBu5Z22vCgodG4B1PFSMXrBZAivZ1");

const MIN_OTOKEN_LIFETIME_SECS: i64 = 60;

#[program]
pub mod otoken_factory {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>, admin: Pubkey) -> Result<()> {
        require!(admin != Pubkey::default(), FactoryError::ZeroAddress);
        let config = &mut ctx.accounts.factory_config;
        config.admin = admin;
        config.controller = Pubkey::default();
        config.otoken_count = 0;
        config.bump = ctx.bumps.factory_config;
        emit!(FactoryInitialized { admin });
        Ok(())
    }

    pub fn set_controller(ctx: Context<AdminAction>, controller: Pubkey) -> Result<()> {
        require!(controller != Pubkey::default(), FactoryError::ZeroAddress);
        let old = ctx.accounts.factory_config.controller;
        ctx.accounts.factory_config.controller = controller;
        emit!(ControllerUpdated {
            old_controller: old,
            new_controller: controller,
        });
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    pub fn create_otoken(
        ctx: Context<CreateOtoken>,
        underlying: Pubkey,
        strike_asset: Pubkey,
        collateral: Pubkey,
        strike_price: u64,
        expiry: i64,
        is_put: bool,
    ) -> Result<()> {
        require!(underlying != Pubkey::default(), FactoryError::ZeroAddress);
        require!(strike_asset != Pubkey::default(), FactoryError::ZeroAddress);
        require!(collateral != Pubkey::default(), FactoryError::ZeroAddress);
        require!(strike_price > 0, FactoryError::InvalidStrikePrice);
        let clock = Clock::get()?;
        require!(
            expiry > clock.unix_timestamp + MIN_OTOKEN_LIFETIME_SECS,
            FactoryError::InvalidExpiry
        );

        let otoken = &mut ctx.accounts.otoken;
        otoken.underlying = underlying;
        otoken.strike_asset = strike_asset;
        otoken.collateral = collateral;
        otoken.strike_price = strike_price;
        otoken.expiry = expiry;
        otoken.is_put = is_put;
        otoken.mint = ctx.accounts.otoken_mint.key();
        otoken.bump = ctx.bumps.otoken;

        let config = &mut ctx.accounts.factory_config;
        config.otoken_count = config
            .otoken_count
            .checked_add(1)
            .ok_or(FactoryError::MathOverflow)?;

        msg!(
            "oToken created: mint={} strike={} expiry={}",
            otoken.mint,
            strike_price,
            expiry,
        );

        emit!(OTokenCreated {
            mint: otoken.mint,
            underlying,
            strike_asset,
            collateral,
            strike_price,
            expiry,
            is_put,
        });
        Ok(())
    }
}

// PDA seeds: [b"factory_config"]
#[account]
pub struct FactoryConfig {
    pub admin: Pubkey,
    pub controller: Pubkey,
    pub otoken_count: u64,
    pub bump: u8,
}

// PDA seeds: [b"otoken", underlying, strike_asset,
//   collateral, strike_price.to_le_bytes(),
//   expiry.to_le_bytes(), [is_put as u8]]
#[account]
pub struct OToken {
    pub underlying: Pubkey,
    pub strike_asset: Pubkey,
    pub collateral: Pubkey,
    pub strike_price: u64,
    pub expiry: i64,
    pub is_put: bool,
    pub mint: Pubkey,
    pub bump: u8,
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(
        init,
        payer = payer,
        space = 8 + 32 + 32 + 8 + 1,
        seeds = [b"factory_config"],
        bump,
    )]
    pub factory_config: Account<'info, FactoryConfig>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AdminAction<'info> {
    #[account(
        mut,
        seeds = [b"factory_config"],
        bump = factory_config.bump,
        has_one = admin,
    )]
    pub factory_config: Account<'info, FactoryConfig>,
    pub admin: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(
    underlying: Pubkey,
    strike_asset: Pubkey,
    collateral: Pubkey,
    strike_price: u64,
    expiry: i64,
    is_put: bool,
)]
pub struct CreateOtoken<'info> {
    #[account(
        mut,
        seeds = [b"factory_config"],
        bump = factory_config.bump,
        has_one = admin,
        constraint = factory_config.controller
            != Pubkey::default()
            @ FactoryError::ControllerNotSet,
    )]
    pub factory_config: Account<'info, FactoryConfig>,
    #[account(
        init,
        payer = admin,
        space = 8 + 32 + 32 + 32 + 8 + 8 + 1 + 32 + 1,
        seeds = [
            b"otoken",
            underlying.as_ref(),
            strike_asset.as_ref(),
            collateral.as_ref(),
            strike_price.to_le_bytes().as_ref(),
            expiry.to_le_bytes().as_ref(),
            &[is_put as u8],
        ],
        bump,
    )]
    pub otoken: Account<'info, OToken>,
    #[account(
        init,
        payer = admin,
        seeds = [
            b"otoken_mint",
            underlying.as_ref(),
            strike_asset.as_ref(),
            collateral.as_ref(),
            strike_price.to_le_bytes().as_ref(),
            expiry.to_le_bytes().as_ref(),
            &[is_put as u8],
        ],
        bump,
        mint::decimals = 8,
        mint::authority = controller_authority,
        mint::token_program = token_program,
    )]
    pub otoken_mint: InterfaceAccount<'info, Mint>,
    /// CHECK: Validated against factory_config.controller.
    /// Controller's config PDA, set as the mint authority
    /// so the controller can mint oTokens directly.
    #[account(
        constraint = controller_authority.key()
            == factory_config.controller
            @ FactoryError::InvalidController,
    )]
    pub controller_authority: AccountInfo<'info>,
    #[account(mut)]
    pub admin: Signer<'info>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[event]
pub struct FactoryInitialized {
    pub admin: Pubkey,
}

#[event]
pub struct ControllerUpdated {
    pub old_controller: Pubkey,
    pub new_controller: Pubkey,
}

#[event]
pub struct OTokenCreated {
    pub mint: Pubkey,
    pub underlying: Pubkey,
    pub strike_asset: Pubkey,
    pub collateral: Pubkey,
    pub strike_price: u64,
    pub expiry: i64,
    pub is_put: bool,
}

#[error_code]
pub enum FactoryError {
    #[msg("Address cannot be zero")]
    ZeroAddress,
    #[msg("Controller not set")]
    ControllerNotSet,
    #[msg("Invalid controller authority")]
    InvalidController,
    #[msg("Strike price must be greater than zero")]
    InvalidStrikePrice,
    #[msg("Arithmetic overflow")]
    MathOverflow,
    #[msg("Expiry must be in the future")]
    InvalidExpiry,
}
