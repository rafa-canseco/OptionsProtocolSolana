//! Test-only Jupiter-shaped swap program.
//!
//! Used by physical_redeem tests to simulate Jupiter routing without
//! a real DEX. The mock holds two SPL token reserves (one per mint)
//! and offers a fixed-rate `swap` instruction:
//!
//!   take `input_amount` from `source` (signed by `source_authority`)
//!   send `output_amount` from `out_reserve` (signed by mock PDA) to `destination`
//!
//! The two reserves are pre-funded by the test before invocation.
//! The mock is **not** a sound swap implementation; it does no price
//! discovery and does not enforce solvency. It exists only to give the
//! batch_settler integration tests a real CPI target to invoke.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

declare_id!("47PWVPu1ARAy82XGuzdTcfV9mckm5DWiGh2Sgfn1fSQn");

#[program]
pub mod mock_jupiter {
    use super::*;

    pub fn swap(ctx: Context<Swap>, input_amount: u64, output_amount: u64) -> Result<()> {
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.source.to_account_info(),
                    to: ctx.accounts.in_reserve.to_account_info(),
                    authority: ctx.accounts.source_authority.to_account_info(),
                },
            ),
            input_amount,
        )?;

        let bump = ctx.bumps.mock_authority;
        let seeds: &[&[u8]] = &[b"mock_jupiter_auth", &[bump]];
        let signer_seeds = &[seeds];

        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.out_reserve.to_account_info(),
                    to: ctx.accounts.destination.to_account_info(),
                    authority: ctx.accounts.mock_authority.to_account_info(),
                },
                signer_seeds,
            ),
            output_amount,
        )?;

        Ok(())
    }

    /// Same flow as `swap`, but the output is split between two
    /// destinations. Used by tests to simulate Jupiter routes that
    /// "leak" extra output into an account the production protocol
    /// expects to remain untouched (e.g. a PUT route delivering the
    /// expected output to the user but also depositing dust into
    /// settler_contra). Lets the test exercise the
    /// UnexpectedSwapDestination guard deterministically.
    pub fn swap_split(
        ctx: Context<SwapSplit>,
        input_amount: u64,
        output_primary: u64,
        output_secondary: u64,
    ) -> Result<()> {
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.source.to_account_info(),
                    to: ctx.accounts.in_reserve.to_account_info(),
                    authority: ctx.accounts.source_authority.to_account_info(),
                },
            ),
            input_amount,
        )?;

        let bump = ctx.bumps.mock_authority;
        let seeds: &[&[u8]] = &[b"mock_jupiter_auth", &[bump]];
        let signer_seeds = &[seeds];

        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.out_reserve.to_account_info(),
                    to: ctx.accounts.primary_destination.to_account_info(),
                    authority: ctx.accounts.mock_authority.to_account_info(),
                },
                signer_seeds,
            ),
            output_primary,
        )?;

        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.out_reserve.to_account_info(),
                    to: ctx.accounts.secondary_destination.to_account_info(),
                    authority: ctx.accounts.mock_authority.to_account_info(),
                },
                signer_seeds,
            ),
            output_secondary,
        )?;

        Ok(())
    }
}

#[derive(Accounts)]
pub struct Swap<'info> {
    #[account(mut)]
    pub source: Account<'info, TokenAccount>,
    #[account(mut)]
    pub in_reserve: Account<'info, TokenAccount>,
    #[account(mut)]
    pub out_reserve: Account<'info, TokenAccount>,
    #[account(mut)]
    pub destination: Account<'info, TokenAccount>,
    /// CHECK: signer for `source`. May be a PDA from the calling program.
    pub source_authority: AccountInfo<'info>,
    /// CHECK: PDA authority for `out_reserve`.
    #[account(seeds = [b"mock_jupiter_auth"], bump)]
    pub mock_authority: AccountInfo<'info>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct SwapSplit<'info> {
    #[account(mut)]
    pub source: Account<'info, TokenAccount>,
    #[account(mut)]
    pub in_reserve: Account<'info, TokenAccount>,
    #[account(mut)]
    pub out_reserve: Account<'info, TokenAccount>,
    #[account(mut)]
    pub primary_destination: Account<'info, TokenAccount>,
    #[account(mut)]
    pub secondary_destination: Account<'info, TokenAccount>,
    /// CHECK: signer for `source`. May be a PDA from the calling program.
    pub source_authority: AccountInfo<'info>,
    /// CHECK: PDA authority for `out_reserve`.
    #[account(seeds = [b"mock_jupiter_auth"], bump)]
    pub mock_authority: AccountInfo<'info>,
    pub token_program: Program<'info, Token>,
}
