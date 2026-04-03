use anchor_lang::prelude::*;

declare_id!("84hBdboukYWVg7DoBu5Z22vCgodG4B1PFSMXrBZAivZ1");

#[program]
pub mod otoken_factory {
    use super::*;

    pub fn create_otoken(
        ctx: Context<CreateOtoken>,
        underlying: Pubkey,
        strike_asset: Pubkey,
        collateral: Pubkey,
        strike_price: u64,
        expiry: i64,
        is_put: bool,
    ) -> Result<()> {
        let otoken = &mut ctx.accounts.otoken;
        otoken.underlying = underlying;
        otoken.strike_asset = strike_asset;
        otoken.collateral = collateral;
        otoken.strike_price = strike_price;
        otoken.expiry = expiry;
        otoken.is_put = is_put;
        otoken.mint = ctx.accounts.otoken_mint.key();
        msg!(
            "oToken created: strike={} expiry={} is_put={}",
            strike_price,
            expiry,
            is_put
        );
        Ok(())
    }
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
}

// PDA seeds for mint authority: [b"otoken_mint_authority"]
// The oToken SPL mint's mint_authority is this PDA.
// Only the Controller can CPI into this program to mint.

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
        init,
        payer = payer,
        space = 8 + 32 + 32 + 32 + 8 + 8 + 1 + 32,
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
    /// CHECK: SPL token mint created externally
    pub otoken_mint: AccountInfo<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}
