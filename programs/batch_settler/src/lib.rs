use anchor_lang::prelude::*;
use anchor_lang::solana_program::sysvar::instructions as ixs_sysvar;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};
use controller::program::Controller as ControllerProgram;
use solana_sdk_ids::ed25519_program;

declare_id!("GpR6id2cHu5fUGsFm7NUKkB4NzfuEDa6brPzkSrgAzvS");

const MAX_FEE_BPS: u16 = 2000;
const PRICE_SCALE: u128 = 100_000_000; // 10^8

#[program]
pub mod batch_settler {
    use super::*;

    pub fn initialize(
        ctx: Context<Initialize>,
        operator: Pubkey,
        treasury: Pubkey,
        protocol_fee_bps: u16,
    ) -> Result<()> {
        require!(operator != Pubkey::default(), SettlerError::ZeroAddress);
        require!(treasury != Pubkey::default(), SettlerError::ZeroAddress);
        require!(protocol_fee_bps <= MAX_FEE_BPS, SettlerError::FeeTooHigh);
        let config = &mut ctx.accounts.settler_config;
        config.owner = ctx.accounts.payer.key();
        config.operator = operator;
        config.treasury = treasury;
        config.protocol_fee_bps = protocol_fee_bps;
        config.paused = false;
        config.bump = ctx.bumps.settler_config;
        emit!(SettlerInitialized {
            owner: config.owner,
            operator,
            treasury,
        });
        Ok(())
    }

    /// One-time: create a vault counter for the settler PDA
    /// inside the controller so settler can open vaults via CPI.
    pub fn init_vault_counter(ctx: Context<InitVaultCounter>) -> Result<()> {
        let rent = Rent::get()?;
        let lamports = rent.minimum_balance(8 + 32 + 8 + 1);
        // Pre-fund vault_counter PDA directly so Anchor's init
        // skips transfer from settler PDA (which has data).
        anchor_lang::system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                anchor_lang::system_program::Transfer {
                    from: ctx.accounts.owner.to_account_info(),
                    to: ctx.accounts.vault_counter.to_account_info(),
                },
            ),
            lamports,
        )?;
        let bump = ctx.accounts.settler_config.bump;
        let seeds: &[&[u8]] = &[b"settler_config", &[bump]];
        controller::cpi::initialize_counter(CpiContext::new_with_signer(
            ctx.accounts.controller_program.to_account_info(),
            controller::cpi::accounts::InitializeCounter {
                vault_counter: ctx.accounts.vault_counter.to_account_info(),
                owner: ctx.accounts.settler_config.to_account_info(),
                system_program: ctx.accounts.system_program.to_account_info(),
            },
            &[seeds],
        ))?;
        Ok(())
    }

    pub fn whitelist_maker(
        ctx: Context<WhitelistMaker>,
        _maker: Pubkey,
        whitelisted: bool,
    ) -> Result<()> {
        let state = &mut ctx.accounts.maker_state;
        if state.maker == Pubkey::default() {
            state.maker = _maker;
            state.nonce = 0;
        }
        state.whitelisted = whitelisted;
        state.bump = ctx.bumps.maker_state;
        emit!(MakerWhitelisted {
            maker: _maker,
            whitelisted,
        });
        Ok(())
    }

    pub fn increment_maker_nonce(ctx: Context<IncrementNonce>) -> Result<()> {
        let state = &mut ctx.accounts.maker_state;
        let old = state.nonce;
        state.nonce = old.checked_add(1).ok_or(SettlerError::MathOverflow)?;
        emit!(NonceIncremented {
            maker: state.maker,
            old_nonce: old,
            new_nonce: state.nonce,
        });
        Ok(())
    }

    pub fn cancel_quote(ctx: Context<CancelQuote>, _quote_id: u64) -> Result<()> {
        let fill = &mut ctx.accounts.quote_fill;
        require!(!fill.cancelled, SettlerError::QuoteAlreadyCancelled);
        fill.cancelled = true;
        fill.bump = ctx.bumps.quote_fill;
        emit!(QuoteCancelled {
            maker: ctx.accounts.maker.key(),
            quote_id: _quote_id,
        });
        Ok(())
    }

    /// Instant settlement: buyer accepts MM's signed quote.
    /// Opens vault, deposits MM collateral, mints oTokens to buyer,
    /// transfers premium (net to MM, fee to treasury).
    #[allow(clippy::too_many_arguments)]
    pub fn execute_order(
        ctx: Context<ExecuteOrder>,
        amount: u64,
        bid_price: u64,
        deadline: i64,
        quote_id: u64,
        max_amount: u64,
        maker_nonce: u64,
        collateral_amount: u64,
        collateral_mint: Pubkey,
    ) -> Result<()> {
        require!(amount > 0, SettlerError::ZeroAmount);
        require!(!ctx.accounts.settler_config.paused, SettlerError::Paused);

        validate_maker(&ctx.accounts.maker_state, maker_nonce)?;
        let message = build_quote_message(
            &ctx.accounts.otoken_mint.key(),
            bid_price,
            deadline,
            quote_id,
            max_amount,
            maker_nonce,
        );
        verify_ed25519_signature(
            &ctx.accounts.instructions_sysvar,
            &ctx.accounts.maker.key().to_bytes(),
            &message,
        )?;
        let clock = Clock::get()?;
        require!(clock.unix_timestamp <= deadline, SettlerError::QuoteExpired);

        update_fill(&mut ctx.accounts.quote_fill, amount, max_amount)?;
        ctx.accounts.quote_fill.bump = ctx.bumps.quote_fill;

        let (premium, fee, net) = compute_premium_split(
            amount,
            bid_price,
            ctx.accounts.settler_config.protocol_fee_bps,
        )?;

        fund_vault_rent(&ctx)?;
        let bump = ctx.accounts.settler_config.bump;
        let signer_seeds: &[&[&[u8]]] = &[&[b"settler_config", &[bump]]];

        cpi_open_vault(&ctx, signer_seeds, collateral_mint)?;
        cpi_deposit_collateral(&ctx, signer_seeds, collateral_amount)?;
        cpi_mint_otoken(&ctx, signer_seeds, amount)?;
        transfer_premium(&ctx, net, fee)?;

        emit!(OrderExecuted {
            buyer: ctx.accounts.buyer.key(),
            maker: ctx.accounts.maker.key(),
            otoken_mint: ctx.accounts.otoken_mint.key(),
            amount,
            premium,
            fee,
            quote_id,
        });
        Ok(())
    }

    /// Settle an expired vault. Requires controller admin to co-sign.
    /// Returned collateral goes to settler's token account.
    pub fn settle_vault(ctx: Context<SettleVaultForMaker>) -> Result<()> {
        controller::cpi::settle_vault(CpiContext::new(
            ctx.accounts.controller_program.to_account_info(),
            controller::cpi::accounts::SettleVault {
                config: ctx.accounts.controller_config.to_account_info(),
                vault: ctx.accounts.vault.to_account_info(),
                otoken_info: ctx.accounts.otoken_info.to_account_info(),
                pool_token_account: ctx.accounts.pool_token_account.to_account_info(),
                owner_token_account: ctx.accounts.settler_collateral_account.to_account_info(),
                pool_vault_authority: ctx.accounts.pool_vault_authority.to_account_info(),
                admin: ctx.accounts.controller_admin.to_account_info(),
                token_program: ctx.accounts.token_program.to_account_info(),
            },
        ))?;
        emit!(VaultSettledEvent {
            vault: ctx.accounts.vault.key(),
            operator: ctx.accounts.operator.key(),
        });
        Ok(())
    }

    pub fn set_treasury(ctx: Context<OwnerAction>, treasury: Pubkey) -> Result<()> {
        require!(treasury != Pubkey::default(), SettlerError::ZeroAddress);
        ctx.accounts.settler_config.treasury = treasury;
        Ok(())
    }

    pub fn set_protocol_fee(ctx: Context<OwnerAction>, protocol_fee_bps: u16) -> Result<()> {
        require!(protocol_fee_bps <= MAX_FEE_BPS, SettlerError::FeeTooHigh);
        ctx.accounts.settler_config.protocol_fee_bps = protocol_fee_bps;
        Ok(())
    }

    pub fn set_operator(ctx: Context<OwnerAction>, operator: Pubkey) -> Result<()> {
        require!(operator != Pubkey::default(), SettlerError::ZeroAddress);
        ctx.accounts.settler_config.operator = operator;
        Ok(())
    }

    pub fn pause(ctx: Context<OwnerAction>, paused: bool) -> Result<()> {
        ctx.accounts.settler_config.paused = paused;
        emit!(PauseToggled { paused });
        Ok(())
    }
}

// ============================================================
// State
// ============================================================

/// PDA seeds: [b"settler_config"]
#[account]
pub struct SettlerConfig {
    pub owner: Pubkey,
    pub operator: Pubkey,
    pub treasury: Pubkey,
    pub protocol_fee_bps: u16,
    pub paused: bool,
    pub bump: u8,
}

/// PDA seeds: [b"maker", maker.as_ref()]
#[account]
pub struct MakerState {
    pub maker: Pubkey,
    pub nonce: u64,
    pub whitelisted: bool,
    pub bump: u8,
}

/// PDA seeds: [b"quote_fill", maker.as_ref(), quote_id.to_le_bytes()]
#[account]
pub struct QuoteFill {
    pub filled_amount: u64,
    pub cancelled: bool,
    pub bump: u8,
}

// ============================================================
// Account structs
// ============================================================

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(
        init,
        payer = payer,
        space = 8 + 32 + 32 + 32 + 2 + 1 + 1,
        seeds = [b"settler_config"],
        bump,
    )]
    pub settler_config: Account<'info, SettlerConfig>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct InitVaultCounter<'info> {
    #[account(
        mut,
        seeds = [b"settler_config"],
        bump = settler_config.bump,
        has_one = owner,
    )]
    pub settler_config: Account<'info, SettlerConfig>,
    #[account(mut)]
    pub owner: Signer<'info>,
    /// CHECK: Created by controller CPI (vault_counter PDA)
    #[account(mut)]
    pub vault_counter: AccountInfo<'info>,
    pub controller_program: Program<'info, ControllerProgram>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(maker: Pubkey, whitelisted: bool)]
pub struct WhitelistMaker<'info> {
    #[account(
        seeds = [b"settler_config"],
        bump = settler_config.bump,
        has_one = owner,
    )]
    pub settler_config: Account<'info, SettlerConfig>,
    #[account(
        init_if_needed,
        payer = owner,
        space = 8 + 32 + 8 + 1 + 1,
        seeds = [b"maker", maker.as_ref()],
        bump,
    )]
    pub maker_state: Account<'info, MakerState>,
    #[account(mut)]
    pub owner: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct IncrementNonce<'info> {
    #[account(
        mut,
        seeds = [b"maker", maker.key().as_ref()],
        bump = maker_state.bump,
        has_one = maker,
    )]
    pub maker_state: Account<'info, MakerState>,
    pub maker: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(quote_id: u64)]
pub struct CancelQuote<'info> {
    #[account(
        init_if_needed,
        payer = maker,
        space = 8 + 8 + 1 + 1,
        seeds = [
            b"quote_fill",
            maker.key().as_ref(),
            &quote_id.to_le_bytes(),
        ],
        bump,
    )]
    pub quote_fill: Account<'info, QuoteFill>,
    #[account(
        seeds = [b"maker", maker.key().as_ref()],
        bump = maker_state.bump,
        has_one = maker,
    )]
    pub maker_state: Account<'info, MakerState>,
    #[account(mut)]
    pub maker: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(
    amount: u64,
    bid_price: u64,
    deadline: i64,
    quote_id: u64,
    max_amount: u64,
    maker_nonce: u64,
    collateral_amount: u64,
    collateral_mint: Pubkey,
)]
pub struct ExecuteOrder<'info> {
    #[account(
        mut,
        seeds = [b"settler_config"],
        bump = settler_config.bump,
    )]
    pub settler_config: Account<'info, SettlerConfig>,
    #[account(
        seeds = [b"maker", maker.key().as_ref()],
        bump = maker_state.bump,
    )]
    pub maker_state: Account<'info, MakerState>,
    #[account(
        init_if_needed,
        payer = buyer,
        space = 8 + 8 + 1 + 1,
        seeds = [
            b"quote_fill",
            maker.key().as_ref(),
            &quote_id.to_le_bytes(),
        ],
        bump,
    )]
    pub quote_fill: Account<'info, QuoteFill>,

    /// CHECK: Validated by controller program
    pub controller_config: AccountInfo<'info>,
    /// CHECK: Initialized by controller CPI (open_vault)
    #[account(mut)]
    pub vault: AccountInfo<'info>,
    /// CHECK: Validated by controller CPI
    #[account(mut)]
    pub vault_counter: AccountInfo<'info>,
    /// CHECK: Validated by controller CPI (mint_otoken)
    pub otoken_info: AccountInfo<'info>,
    #[account(mut)]
    pub otoken_mint: Box<Account<'info, Mint>>,

    /// MM's collateral token account (delegated to settler PDA)
    #[account(mut)]
    pub mm_collateral_account: Box<Account<'info, TokenAccount>>,
    /// Controller pool receiving collateral
    #[account(mut)]
    pub pool_token_account: Box<Account<'info, TokenAccount>>,
    /// Buyer receives minted oTokens here
    #[account(mut)]
    pub buyer_otoken_account: Box<Account<'info, TokenAccount>>,
    /// Buyer pays premium from here
    #[account(mut)]
    pub buyer_premium_account: Box<Account<'info, TokenAccount>>,
    /// MM receives net premium here
    #[account(mut)]
    pub mm_premium_account: Box<Account<'info, TokenAccount>>,
    /// Treasury receives protocol fee here
    #[account(
        mut,
        constraint = treasury_account.owner
            == settler_config.treasury
            @ SettlerError::InvalidTreasury,
    )]
    pub treasury_account: Box<Account<'info, TokenAccount>>,

    #[account(mut)]
    pub buyer: Signer<'info>,
    /// CHECK: Ed25519 signature verified via instruction introspection
    pub maker: AccountInfo<'info>,

    pub controller_program: Program<'info, ControllerProgram>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    /// CHECK: Instructions sysvar for ed25519 verification
    #[account(address = ixs_sysvar::ID)]
    pub instructions_sysvar: AccountInfo<'info>,
}

#[derive(Accounts)]
pub struct SettleVaultForMaker<'info> {
    #[account(
        seeds = [b"settler_config"],
        bump = settler_config.bump,
        constraint = operator.key() == settler_config.operator
            @ SettlerError::Unauthorized,
    )]
    pub settler_config: Account<'info, SettlerConfig>,
    pub operator: Signer<'info>,

    /// CHECK: Validated by controller CPI
    pub controller_config: AccountInfo<'info>,
    /// CHECK: Validated by controller CPI
    #[account(mut)]
    pub vault: AccountInfo<'info>,
    /// CHECK: Validated by controller CPI
    pub otoken_info: AccountInfo<'info>,
    #[account(mut)]
    pub pool_token_account: Account<'info, TokenAccount>,
    /// Settler's account receiving returned collateral
    #[account(mut)]
    pub settler_collateral_account: Account<'info, TokenAccount>,
    /// CHECK: Pool vault authority PDA
    pub pool_vault_authority: AccountInfo<'info>,
    /// Controller admin must co-sign for settlement
    pub controller_admin: Signer<'info>,

    pub controller_program: Program<'info, ControllerProgram>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct OwnerAction<'info> {
    #[account(
        mut,
        seeds = [b"settler_config"],
        bump = settler_config.bump,
        has_one = owner,
    )]
    pub settler_config: Account<'info, SettlerConfig>,
    pub owner: Signer<'info>,
}

// ============================================================
// Events
// ============================================================

#[event]
pub struct SettlerInitialized {
    pub owner: Pubkey,
    pub operator: Pubkey,
    pub treasury: Pubkey,
}

#[event]
pub struct MakerWhitelisted {
    pub maker: Pubkey,
    pub whitelisted: bool,
}

#[event]
pub struct NonceIncremented {
    pub maker: Pubkey,
    pub old_nonce: u64,
    pub new_nonce: u64,
}

#[event]
pub struct QuoteCancelled {
    pub maker: Pubkey,
    pub quote_id: u64,
}

#[event]
pub struct OrderExecuted {
    pub buyer: Pubkey,
    pub maker: Pubkey,
    pub otoken_mint: Pubkey,
    pub amount: u64,
    pub premium: u64,
    pub fee: u64,
    pub quote_id: u64,
}

#[event]
pub struct VaultSettledEvent {
    pub vault: Pubkey,
    pub operator: Pubkey,
}

#[event]
pub struct PauseToggled {
    pub paused: bool,
}

// ============================================================
// Errors
// ============================================================

#[error_code]
pub enum SettlerError {
    #[msg("Address cannot be zero")]
    ZeroAddress,
    #[msg("Protocol fee exceeds maximum (2000 bps)")]
    FeeTooHigh,
    #[msg("System is paused")]
    Paused,
    #[msg("Maker is not whitelisted")]
    MakerNotWhitelisted,
    #[msg("Maker nonce does not match")]
    InvalidNonce,
    #[msg("Quote has expired")]
    QuoteExpired,
    #[msg("Quote has been cancelled")]
    QuoteCancelled,
    #[msg("Quote already cancelled")]
    QuoteAlreadyCancelled,
    #[msg("Fill exceeds max quote amount")]
    QuoteExceeded,
    #[msg("Amount must be greater than zero")]
    ZeroAmount,
    #[msg("Arithmetic overflow")]
    MathOverflow,
    #[msg("Invalid ed25519 instruction")]
    InvalidEd25519Instruction,
    #[msg("Invalid ed25519 instruction data")]
    InvalidEd25519Data,
    #[msg("Signature verification failed")]
    InvalidSignature,
    #[msg("Invalid treasury account")]
    InvalidTreasury,
    #[msg("Unauthorized")]
    Unauthorized,
}

// ============================================================
// Helpers
// ============================================================

fn validate_maker(maker_state: &MakerState, expected_nonce: u64) -> Result<()> {
    require!(maker_state.whitelisted, SettlerError::MakerNotWhitelisted);
    require!(
        maker_state.nonce == expected_nonce,
        SettlerError::InvalidNonce
    );
    Ok(())
}

fn update_fill(fill: &mut QuoteFill, amount: u64, max_amount: u64) -> Result<()> {
    require!(!fill.cancelled, SettlerError::QuoteCancelled);
    let new_filled = fill
        .filled_amount
        .checked_add(amount)
        .ok_or(SettlerError::MathOverflow)?;
    require!(new_filled <= max_amount, SettlerError::QuoteExceeded);
    fill.filled_amount = new_filled;
    Ok(())
}

fn compute_premium_split(amount: u64, bid_price: u64, fee_bps: u16) -> Result<(u64, u64, u64)> {
    let raw = (amount as u128)
        .checked_mul(bid_price as u128)
        .ok_or(SettlerError::MathOverflow)?
        .checked_div(PRICE_SCALE)
        .ok_or(SettlerError::MathOverflow)?;
    let premium = u64::try_from(raw).map_err(|_| error!(SettlerError::MathOverflow))?;
    let fee = premium
        .checked_mul(fee_bps as u64)
        .ok_or(SettlerError::MathOverflow)?
        .checked_div(10_000)
        .ok_or(SettlerError::MathOverflow)?;
    let net = premium.checked_sub(fee).ok_or(SettlerError::MathOverflow)?;
    Ok((premium, fee, net))
}

fn build_quote_message(
    otoken_mint: &Pubkey,
    bid_price: u64,
    deadline: i64,
    quote_id: u64,
    max_amount: u64,
    maker_nonce: u64,
) -> Vec<u8> {
    let mut msg = Vec::with_capacity(72);
    msg.extend_from_slice(otoken_mint.as_ref());
    msg.extend_from_slice(&bid_price.to_le_bytes());
    msg.extend_from_slice(&deadline.to_le_bytes());
    msg.extend_from_slice(&quote_id.to_le_bytes());
    msg.extend_from_slice(&max_amount.to_le_bytes());
    msg.extend_from_slice(&maker_nonce.to_le_bytes());
    msg
}

fn verify_ed25519_signature(
    ix_sysvar: &AccountInfo,
    pubkey: &[u8; 32],
    message: &[u8],
) -> Result<()> {
    let ix = ixs_sysvar::load_instruction_at_checked(0, ix_sysvar)
        .map_err(|_| error!(SettlerError::InvalidEd25519Instruction))?;
    require!(
        ix.program_id == ed25519_program::ID,
        SettlerError::InvalidEd25519Instruction
    );
    require!(ix.data.len() >= 16, SettlerError::InvalidEd25519Data);
    require!(ix.data[0] == 1, SettlerError::InvalidEd25519Data);

    let pk_off = u16::from_le_bytes(ix.data[6..8].try_into().unwrap()) as usize;
    let msg_off = u16::from_le_bytes(ix.data[10..12].try_into().unwrap()) as usize;
    let msg_sz = u16::from_le_bytes(ix.data[12..14].try_into().unwrap()) as usize;

    require!(
        pk_off + 32 <= ix.data.len(),
        SettlerError::InvalidEd25519Data
    );
    require!(
        msg_off + msg_sz <= ix.data.len(),
        SettlerError::InvalidEd25519Data
    );
    require!(
        &ix.data[pk_off..pk_off + 32] == pubkey,
        SettlerError::InvalidSignature
    );
    require!(msg_sz == message.len(), SettlerError::InvalidSignature);
    require!(
        &ix.data[msg_off..msg_off + msg_sz] == message,
        SettlerError::InvalidSignature
    );
    Ok(())
}

fn fund_vault_rent(ctx: &Context<ExecuteOrder>) -> Result<()> {
    let rent = Rent::get()?;
    let vault_space = 8 + 32 + 8 + 32 + 8 + 32 + 8 + 1 + 1;
    let lamports = rent.minimum_balance(vault_space);
    // Pre-fund vault PDA directly so Anchor's init skips
    // transfer from settler PDA (which has data).
    anchor_lang::system_program::transfer(
        CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            anchor_lang::system_program::Transfer {
                from: ctx.accounts.buyer.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
            },
        ),
        lamports,
    )
}

fn cpi_open_vault(
    ctx: &Context<ExecuteOrder>,
    signer_seeds: &[&[&[u8]]],
    collateral_mint: Pubkey,
) -> Result<()> {
    controller::cpi::open_vault(
        CpiContext::new_with_signer(
            ctx.accounts.controller_program.to_account_info(),
            controller::cpi::accounts::OpenVault {
                config: ctx.accounts.controller_config.to_account_info(),
                vault: ctx.accounts.vault.to_account_info(),
                vault_counter: ctx.accounts.vault_counter.to_account_info(),
                owner: ctx.accounts.settler_config.to_account_info(),
                system_program: ctx.accounts.system_program.to_account_info(),
            },
            signer_seeds,
        ),
        collateral_mint,
    )
}

fn cpi_deposit_collateral(
    ctx: &Context<ExecuteOrder>,
    signer_seeds: &[&[&[u8]]],
    amount: u64,
) -> Result<()> {
    controller::cpi::deposit_collateral(
        CpiContext::new_with_signer(
            ctx.accounts.controller_program.to_account_info(),
            controller::cpi::accounts::DepositCollateral {
                config: ctx.accounts.controller_config.to_account_info(),
                vault: ctx.accounts.vault.to_account_info(),
                user_token_account: ctx.accounts.mm_collateral_account.to_account_info(),
                pool_token_account: ctx.accounts.pool_token_account.to_account_info(),
                owner: ctx.accounts.settler_config.to_account_info(),
                token_program: ctx.accounts.token_program.to_account_info(),
            },
            signer_seeds,
        ),
        amount,
    )
}

fn cpi_mint_otoken(
    ctx: &Context<ExecuteOrder>,
    signer_seeds: &[&[&[u8]]],
    amount: u64,
) -> Result<()> {
    controller::cpi::mint_otoken(
        CpiContext::new_with_signer(
            ctx.accounts.controller_program.to_account_info(),
            controller::cpi::accounts::MintOtoken {
                config: ctx.accounts.controller_config.to_account_info(),
                vault: ctx.accounts.vault.to_account_info(),
                otoken_info: ctx.accounts.otoken_info.to_account_info(),
                otoken_mint: ctx.accounts.otoken_mint.to_account_info(),
                destination: ctx.accounts.buyer_otoken_account.to_account_info(),
                owner: ctx.accounts.settler_config.to_account_info(),
                token_program: ctx.accounts.token_program.to_account_info(),
            },
            signer_seeds,
        ),
        amount,
    )
}

fn transfer_premium(ctx: &Context<ExecuteOrder>, net: u64, fee: u64) -> Result<()> {
    if net > 0 {
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.buyer_premium_account.to_account_info(),
                    to: ctx.accounts.mm_premium_account.to_account_info(),
                    authority: ctx.accounts.buyer.to_account_info(),
                },
            ),
            net,
        )?;
    }
    if fee > 0 {
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.buyer_premium_account.to_account_info(),
                    to: ctx.accounts.treasury_account.to_account_info(),
                    authority: ctx.accounts.buyer.to_account_info(),
                },
            ),
            fee,
        )?;
    }
    Ok(())
}
