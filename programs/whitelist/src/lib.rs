use anchor_lang::prelude::*;

declare_id!("F759VGDWkcxjjGByWZTTdDKJwj1RFzH2VHZS3p4VXnts");

#[program]
pub mod whitelist {
    use super::*;

    pub fn initialize(ctx: Context<InitializeWhitelist>, admin: Pubkey) -> Result<()> {
        let config = &mut ctx.accounts.config;
        config.admin = admin;
        msg!("Whitelist initialized");
        Ok(())
    }

    pub fn whitelist_underlying(
        ctx: Context<WhitelistAsset>,
        mint: Pubkey,
        symbol: [u8; 8],
    ) -> Result<()> {
        let asset = &mut ctx.accounts.asset;
        asset.mint = mint;
        asset.symbol = symbol;
        asset.asset_type = AssetType::Underlying;
        asset.active = true;
        msg!("Underlying whitelisted: {}", mint);
        Ok(())
    }

    pub fn whitelist_collateral(
        ctx: Context<WhitelistAsset>,
        mint: Pubkey,
        symbol: [u8; 8],
    ) -> Result<()> {
        let asset = &mut ctx.accounts.asset;
        asset.mint = mint;
        asset.symbol = symbol;
        asset.asset_type = AssetType::Collateral;
        asset.active = true;
        msg!("Collateral whitelisted: {}", mint);
        Ok(())
    }

    pub fn whitelist_product(
        ctx: Context<WhitelistProduct>,
        underlying: Pubkey,
        strike_asset: Pubkey,
        collateral: Pubkey,
        is_put: bool,
    ) -> Result<()> {
        let product = &mut ctx.accounts.product;
        product.underlying = underlying;
        product.strike_asset = strike_asset;
        product.collateral = collateral;
        product.is_put = is_put;
        product.active = true;
        msg!("Product whitelisted");
        Ok(())
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq)]
pub enum AssetType {
    Underlying,
    Collateral,
}

// PDA seeds: [b"whitelist_config"]
#[account]
pub struct WhitelistConfig {
    pub admin: Pubkey,
}

// PDA seeds: [b"asset", mint]
#[account]
pub struct WhitelistedAsset {
    pub mint: Pubkey,
    pub symbol: [u8; 8],
    pub asset_type: AssetType,
    pub active: bool,
}

// PDA seeds: [b"product", underlying, collateral, [is_put as u8]]
#[account]
pub struct WhitelistedProduct {
    pub underlying: Pubkey,
    pub strike_asset: Pubkey,
    pub collateral: Pubkey,
    pub is_put: bool,
    pub active: bool,
}

#[derive(Accounts)]
pub struct InitializeWhitelist<'info> {
    #[account(
        init,
        payer = payer,
        space = 8 + 32,
        seeds = [b"whitelist_config"],
        bump,
    )]
    pub config: Account<'info, WhitelistConfig>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(mint: Pubkey)]
pub struct WhitelistAsset<'info> {
    #[account(
        init,
        payer = admin,
        space = 8 + 32 + 8 + 1 + 1,
        seeds = [b"asset", mint.as_ref()],
        bump,
    )]
    pub asset: Account<'info, WhitelistedAsset>,
    #[account(
        seeds = [b"whitelist_config"],
        bump,
        has_one = admin,
    )]
    pub config: Account<'info, WhitelistConfig>,
    #[account(mut)]
    pub admin: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(
    underlying: Pubkey,
    _strike_asset: Pubkey,
    collateral: Pubkey,
    is_put: bool,
)]
pub struct WhitelistProduct<'info> {
    #[account(
        init,
        payer = admin,
        space = 8 + 32 + 32 + 32 + 1 + 1,
        seeds = [
            b"product",
            underlying.as_ref(),
            collateral.as_ref(),
            &[is_put as u8],
        ],
        bump,
    )]
    pub product: Account<'info, WhitelistedProduct>,
    #[account(
        seeds = [b"whitelist_config"],
        bump,
        has_one = admin,
    )]
    pub config: Account<'info, WhitelistConfig>,
    #[account(mut)]
    pub admin: Signer<'info>,
    pub system_program: Program<'info, System>,
}
