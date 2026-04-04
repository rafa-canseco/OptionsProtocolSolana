use anchor_lang::prelude::*;
use anchor_lang::solana_program::sysvar::instructions as ixs_sysvar;
use anchor_spl::token::{self, Burn, Mint, Token, TokenAccount, Transfer};
use controller::program::Controller as ControllerProgram;
use solana_sdk_ids::ed25519_program;

declare_id!("GpR6id2cHu5fUGsFm7NUKkB4NzfuEDa6brPzkSrgAzvS");

const MAX_FEE_BPS: u16 = 2000;
const PRICE_SCALE: u128 = 100_000_000; // 10^8
const MIN_ESCAPE_DELAY: i64 = 259_200; // 3 days in seconds

#[program]
pub mod batch_settler {
    use super::*;

    pub fn initialize(
        ctx: Context<Initialize>,
        operator: Pubkey,
        treasury: Pubkey,
        protocol_fee_bps: u16,
        escape_delay: i64,
        jupiter_program: Pubkey,
    ) -> Result<()> {
        require!(operator != Pubkey::default(), SettlerError::ZeroAddress);
        require!(treasury != Pubkey::default(), SettlerError::ZeroAddress);
        require!(protocol_fee_bps <= MAX_FEE_BPS, SettlerError::FeeTooHigh);
        require!(
            escape_delay >= MIN_ESCAPE_DELAY,
            SettlerError::EscapeDelayTooShort
        );
        let config = &mut ctx.accounts.settler_config;
        config.owner = ctx.accounts.payer.key();
        config.operator = operator;
        config.treasury = treasury;
        config.protocol_fee_bps = protocol_fee_bps;
        config.paused = false;
        config.escape_delay = escape_delay;
        config.batch_nonce = 0;
        config.jupiter_program = jupiter_program;
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

    /// Instant settlement: user (option seller) accepts MM's signed quote.
    /// Opens vault, deposits user's collateral, mints oTokens to settler
    /// custody (for MM), transfers premium from MM to user.
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
        require!(bid_price > 0, SettlerError::ZeroAmount);
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

        // Update MM custody ledger
        let mm_bal = &mut ctx.accounts.maker_otoken_balance;
        if mm_bal.maker == Pubkey::default() {
            mm_bal.maker = ctx.accounts.maker.key();
            mm_bal.otoken_mint = ctx.accounts.otoken_mint.key();
        }
        mm_bal.balance = mm_bal
            .balance
            .checked_add(amount)
            .ok_or(SettlerError::MathOverflow)?;
        mm_bal.bump = ctx.bumps.maker_otoken_balance;

        // Track vault→MM mapping for emergency ledger cleanup
        let vault_mm = &mut ctx.accounts.vault_mm;
        vault_mm.maker = ctx.accounts.maker.key();
        vault_mm.vault = ctx.accounts.vault.key();
        vault_mm.bump = ctx.bumps.vault_mm;

        transfer_premium(&ctx, signer_seeds, net, fee)?;

        emit!(OrderExecuted {
            user: ctx.accounts.user.key(),
            maker: ctx.accounts.maker.key(),
            otoken_mint: ctx.accounts.otoken_mint.key(),
            amount,
            premium,
            fee,
            quote_id,
        });
        Ok(())
    }

    /// Settle an expired vault. Returned collateral goes to vault
    /// beneficiary (the user who sold the option).
    pub fn settle_vault(ctx: Context<SettleVaultForMaker>) -> Result<()> {
        controller::cpi::settle_vault(CpiContext::new(
            ctx.accounts.controller_program.to_account_info(),
            controller::cpi::accounts::SettleVault {
                config: ctx.accounts.controller_config.to_account_info(),
                vault: ctx.accounts.vault.to_account_info(),
                otoken_info: ctx.accounts.otoken_info.to_account_info(),
                pool_token_account: ctx.accounts.pool_token_account.to_account_info(),
                beneficiary_token_account: ctx.accounts.beneficiary_token_account.to_account_info(),
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

    /// Emergency withdrawal when system is fully paused. Burns custodied
    /// oTokens, clears MM ledger, CPIs to controller to return full
    /// collateral to vault beneficiary.
    pub fn emergency_withdraw(ctx: Context<EmergencyWithdrawOrder>) -> Result<()> {
        let bump = ctx.accounts.settler_config.bump;
        let signer_seeds: &[&[&[u8]]] = &[&[b"settler_config", &[bump]]];

        // Burn only this MM's custodied oTokens, not entire account
        let burn_amount = ctx.accounts.maker_otoken_balance.balance;
        if burn_amount > 0 {
            token::burn(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Burn {
                        mint: ctx.accounts.otoken_mint.to_account_info(),
                        from: ctx.accounts.settler_otoken_account.to_account_info(),
                        authority: ctx.accounts.settler_config.to_account_info(),
                    },
                    signer_seeds,
                ),
                burn_amount,
            )?;
        }

        // Clear MM balance
        let mm_bal = &mut ctx.accounts.maker_otoken_balance;
        mm_bal.balance = 0;

        // CPI to controller: mark vault settled, return collateral
        controller::cpi::emergency_withdraw_vault(CpiContext::new_with_signer(
            ctx.accounts.controller_program.to_account_info(),
            controller::cpi::accounts::EmergencyWithdrawVault {
                config: ctx.accounts.controller_config.to_account_info(),
                vault: ctx.accounts.vault.to_account_info(),
                pool_token_account: ctx.accounts.pool_token_account.to_account_info(),
                beneficiary_token_account: ctx.accounts.beneficiary_token_account.to_account_info(),
                pool_vault_authority: ctx.accounts.pool_vault_authority.to_account_info(),
                owner: ctx.accounts.settler_config.to_account_info(),
                token_program: ctx.accounts.token_program.to_account_info(),
            },
            signer_seeds,
        ))?;

        emit!(EmergencyWithdrawEvent {
            beneficiary: ctx.accounts.beneficiary.key(),
            vault: ctx.accounts.vault.key(),
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

    pub fn set_escape_delay(ctx: Context<OwnerAction>, escape_delay: i64) -> Result<()> {
        require!(
            escape_delay >= MIN_ESCAPE_DELAY,
            SettlerError::EscapeDelayTooShort
        );
        emit!(EscapeDelayUpdated {
            old: ctx.accounts.settler_config.escape_delay,
            new: escape_delay,
        });
        ctx.accounts.settler_config.escape_delay = escape_delay;
        Ok(())
    }

    pub fn set_jupiter_program(ctx: Context<OwnerAction>, jupiter_program: Pubkey) -> Result<()> {
        require!(
            jupiter_program != Pubkey::default(),
            SettlerError::ZeroAddress
        );
        ctx.accounts.settler_config.jupiter_program = jupiter_program;
        Ok(())
    }

    /// Operator redeems custodied oTokens on behalf of MM after expiry.
    /// Collateral payout goes to MM's token account.
    pub fn redeem_for_mm(ctx: Context<RedeemForMM>, amount: u64) -> Result<()> {
        require!(amount > 0, SettlerError::ZeroAmount);
        let mm_bal = &ctx.accounts.maker_otoken_balance;
        require!(
            mm_bal.balance >= amount,
            SettlerError::InsufficientMMBalance
        );

        // CEI: decrement before external calls
        let mm_bal = &mut ctx.accounts.maker_otoken_balance;
        mm_bal.balance = mm_bal
            .balance
            .checked_sub(amount)
            .ok_or(SettlerError::MathOverflow)?;

        let bump = ctx.accounts.settler_config.bump;
        let signer_seeds: &[&[&[u8]]] = &[&[b"settler_config", &[bump]]];

        // CPI: redeem oTokens → collateral to settler
        controller::cpi::redeem(
            CpiContext::new_with_signer(
                ctx.accounts.controller_program.to_account_info(),
                controller::cpi::accounts::Redeem {
                    config: ctx.accounts.controller_config.to_account_info(),
                    otoken_info: ctx.accounts.otoken_info.to_account_info(),
                    otoken_mint: ctx.accounts.otoken_mint.to_account_info(),
                    redeemer_otoken_account: ctx.accounts.settler_otoken_account.to_account_info(),
                    redeemer_collateral_account: ctx
                        .accounts
                        .settler_collateral_account
                        .to_account_info(),
                    pool_token_account: ctx.accounts.pool_token_account.to_account_info(),
                    pool_vault_authority: ctx.accounts.pool_vault_authority.to_account_info(),
                    redeemer: ctx.accounts.settler_config.to_account_info(),
                    token_program: ctx.accounts.token_program.to_account_info(),
                },
                signer_seeds,
            ),
            amount,
        )?;

        // Transfer payout from settler's collateral account to MM
        let payout = ctx.accounts.settler_collateral_account.amount;
        if payout > 0 {
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.settler_collateral_account.to_account_info(),
                        to: ctx.accounts.mm_collateral_account.to_account_info(),
                        authority: ctx.accounts.settler_config.to_account_info(),
                    },
                    signer_seeds,
                ),
                payout,
            )?;
        }

        emit!(MMRedeemed {
            maker: ctx.accounts.maker_otoken_balance.maker,
            otoken_mint: ctx.accounts.otoken_mint.key(),
            amount,
            payout,
        });
        Ok(())
    }

    /// MM self-redeems custodied oTokens after expiry + escape_delay.
    /// Escape hatch when operator is offline.
    pub fn mm_self_redeem(ctx: Context<MMSelfRedeem>, amount: u64) -> Result<()> {
        require!(amount > 0, SettlerError::ZeroAmount);
        let config = &ctx.accounts.settler_config;
        require!(config.escape_delay > 0, SettlerError::EscapeNotReady);

        let clock = Clock::get()?;
        let expiry = ctx.accounts.otoken_info.expiry;
        let escape_time = expiry
            .checked_add(config.escape_delay)
            .ok_or(SettlerError::MathOverflow)?;
        require!(
            clock.unix_timestamp >= escape_time,
            SettlerError::EscapeNotReady
        );

        let mm_bal = &ctx.accounts.maker_otoken_balance;
        require!(
            mm_bal.balance >= amount,
            SettlerError::InsufficientMMBalance
        );

        // CEI: decrement before external calls
        let mm_bal = &mut ctx.accounts.maker_otoken_balance;
        mm_bal.balance = mm_bal
            .balance
            .checked_sub(amount)
            .ok_or(SettlerError::MathOverflow)?;

        let bump = ctx.accounts.settler_config.bump;
        let signer_seeds: &[&[&[u8]]] = &[&[b"settler_config", &[bump]]];

        // CPI: redeem oTokens → collateral to settler
        controller::cpi::redeem(
            CpiContext::new_with_signer(
                ctx.accounts.controller_program.to_account_info(),
                controller::cpi::accounts::Redeem {
                    config: ctx.accounts.controller_config.to_account_info(),
                    otoken_info: ctx.accounts.otoken_info.to_account_info(),
                    otoken_mint: ctx.accounts.otoken_mint.to_account_info(),
                    redeemer_otoken_account: ctx.accounts.settler_otoken_account.to_account_info(),
                    redeemer_collateral_account: ctx
                        .accounts
                        .settler_collateral_account
                        .to_account_info(),
                    pool_token_account: ctx.accounts.pool_token_account.to_account_info(),
                    pool_vault_authority: ctx.accounts.pool_vault_authority.to_account_info(),
                    redeemer: ctx.accounts.settler_config.to_account_info(),
                    token_program: ctx.accounts.token_program.to_account_info(),
                },
                signer_seeds,
            ),
            amount,
        )?;

        // Transfer payout to MM
        let payout = ctx.accounts.settler_collateral_account.amount;
        if payout > 0 {
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.settler_collateral_account.to_account_info(),
                        to: ctx.accounts.mm_collateral_account.to_account_info(),
                        authority: ctx.accounts.settler_config.to_account_info(),
                    },
                    signer_seeds,
                ),
                payout,
            )?;
        }

        emit!(MMSelfRedeemEvent {
            maker: ctx.accounts.maker.key(),
            otoken_mint: ctx.accounts.otoken_mint.key(),
            amount,
            payout,
        });
        Ok(())
    }

    /// Clear MM's custodied balance after emergency withdrawal.
    /// Uses VaultMM PDA to find the associated MM.
    pub fn clear_mm_balance_for_vault(ctx: Context<ClearMMBalance>) -> Result<()> {
        let vault_mm = &ctx.accounts.vault_mm;
        let mm_bal = &mut ctx.accounts.maker_otoken_balance;

        let to_clear = mm_bal.balance;
        if to_clear > 0 {
            mm_bal.balance = 0;
            emit!(MMBalanceCleared {
                maker: vault_mm.maker,
                otoken_mint: mm_bal.otoken_mint,
                amount: to_clear,
            });
        }
        Ok(())
    }

    /// Physical delivery for ITM options. Operator constructs a tx with:
    /// ix[0]: Kamino flash_borrow → contra-asset to settler
    /// ix[1]: this instruction (deliver + redeem + Jupiter swap)
    /// ix[2]: Kamino flash_repay
    #[allow(clippy::too_many_arguments)]
    pub fn physical_redeem(
        ctx: Context<PhysicalRedeem>,
        amount: u64,
        contra_amount: u64,
        jupiter_route_data: Vec<u8>,
    ) -> Result<()> {
        require!(amount > 0, SettlerError::ZeroAmount);
        require!(!ctx.accounts.settler_config.paused, SettlerError::Paused);

        let otoken_info = &ctx.accounts.otoken_info;
        let clock = Clock::get()?;
        require!(
            clock.unix_timestamp >= otoken_info.expiry,
            SettlerError::OptionNotExpired
        );
        require!(
            otoken_info.expiry_price > 0,
            SettlerError::ExpiryPriceNotSet
        );

        // ITM check
        if otoken_info.is_put {
            require!(
                otoken_info.expiry_price < otoken_info.strike_price,
                SettlerError::OptionNotITM
            );
        } else {
            require!(
                otoken_info.expiry_price > otoken_info.strike_price,
                SettlerError::OptionNotITM
            );
        }

        let mm_bal = &ctx.accounts.maker_otoken_balance;
        require!(
            mm_bal.balance >= amount,
            SettlerError::InsufficientMMBalance
        );

        // CEI: decrement MM balance before external calls
        let mm_bal = &mut ctx.accounts.maker_otoken_balance;
        mm_bal.balance = mm_bal
            .balance
            .checked_sub(amount)
            .ok_or(SettlerError::MathOverflow)?;

        let bump = ctx.accounts.settler_config.bump;
        let signer_seeds: &[&[&[u8]]] = &[&[b"settler_config", &[bump]]];

        // 1. Transfer contra-asset to user (borrowed via flash loan in ix[0])
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.settler_contra_account.to_account_info(),
                    to: ctx.accounts.user_contra_account.to_account_info(),
                    authority: ctx.accounts.settler_config.to_account_info(),
                },
                signer_seeds,
            ),
            contra_amount,
        )?;

        // 2. Redeem oTokens → collateral to settler
        controller::cpi::redeem(
            CpiContext::new_with_signer(
                ctx.accounts.controller_program.to_account_info(),
                controller::cpi::accounts::Redeem {
                    config: ctx.accounts.controller_config.to_account_info(),
                    otoken_info: ctx.accounts.otoken_info.to_account_info(),
                    otoken_mint: ctx.accounts.otoken_mint.to_account_info(),
                    redeemer_otoken_account: ctx.accounts.settler_otoken_account.to_account_info(),
                    redeemer_collateral_account: ctx
                        .accounts
                        .settler_collateral_account
                        .to_account_info(),
                    pool_token_account: ctx.accounts.pool_token_account.to_account_info(),
                    pool_vault_authority: ctx.accounts.pool_vault_authority.to_account_info(),
                    redeemer: ctx.accounts.settler_config.to_account_info(),
                    token_program: ctx.accounts.token_program.to_account_info(),
                },
                signer_seeds,
            ),
            amount,
        )?;

        // 3. Jupiter swap: collateral → contra-asset
        let jupiter_program = &ctx.accounts.jupiter_program;
        require!(
            jupiter_program.key() == ctx.accounts.settler_config.jupiter_program,
            SettlerError::InvalidJupiterProgram
        );

        let mut accounts_meta = Vec::new();
        for acct in ctx.remaining_accounts {
            let is_signer = acct.key() == ctx.accounts.settler_config.key();
            accounts_meta.push(if acct.is_writable {
                anchor_lang::solana_program::instruction::AccountMeta::new(*acct.key, is_signer)
            } else {
                anchor_lang::solana_program::instruction::AccountMeta::new_readonly(
                    *acct.key, is_signer,
                )
            });
        }

        let jupiter_ix = anchor_lang::solana_program::instruction::Instruction {
            program_id: jupiter_program.key(),
            accounts: accounts_meta,
            data: jupiter_route_data,
        };

        let account_infos: Vec<AccountInfo> = ctx.remaining_accounts.to_vec();
        anchor_lang::solana_program::program::invoke_signed(
            &jupiter_ix,
            &account_infos,
            signer_seeds,
        )?;

        // 4. Transfer surplus collateral to MM (if any remains)
        ctx.accounts.settler_collateral_account.reload()?;
        let surplus = ctx.accounts.settler_collateral_account.amount;
        if surplus > 0 {
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.settler_collateral_account.to_account_info(),
                        to: ctx.accounts.mm_collateral_account.to_account_info(),
                        authority: ctx.accounts.settler_config.to_account_info(),
                    },
                    signer_seeds,
                ),
                surplus,
            )?;
        }

        emit!(PhysicalDeliveryEvent {
            user: ctx.accounts.user.key(),
            maker: ctx.accounts.maker_otoken_balance.maker,
            otoken_mint: ctx.accounts.otoken_mint.key(),
            amount,
            contra_amount,
        });
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
    pub escape_delay: i64,
    pub batch_nonce: u64,
    pub jupiter_program: Pubkey,
    pub bump: u8,
}

/// Tracks which MM is associated with each vault (for emergency ledger cleanup).
/// PDA seeds: [b"vault_mm", vault.as_ref()]
#[account]
pub struct VaultMM {
    pub maker: Pubkey,
    pub vault: Pubkey,
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

/// Tracks custodied oToken balance per MM per oToken mint.
/// PDA seeds: [b"mm_balance", maker.as_ref(), otoken_mint.as_ref()]
#[account]
pub struct MakerOTokenBalance {
    pub maker: Pubkey,
    pub otoken_mint: Pubkey,
    pub balance: u64,
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
        space = 8 + 32 + 32 + 32 + 2 + 1 + 8 + 8 + 32 + 1,
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
        payer = user,
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

    /// User's collateral token account (delegated to settler PDA)
    #[account(mut)]
    pub user_collateral_account: Box<Account<'info, TokenAccount>>,
    /// Controller pool receiving collateral
    #[account(mut)]
    pub pool_token_account: Box<Account<'info, TokenAccount>>,
    /// Settler's oToken account (custody for MM, owned by settler PDA)
    #[account(
        mut,
        constraint = settler_otoken_account.mint
            == otoken_mint.key()
            @ SettlerError::InvalidCustodyAccount,
        constraint = settler_otoken_account.owner
            == settler_config.key()
            @ SettlerError::InvalidCustodyAccount,
    )]
    pub settler_otoken_account: Box<Account<'info, TokenAccount>>,
    /// MM's premium account (delegated to settler PDA, source of premium)
    #[account(mut)]
    pub mm_premium_account: Box<Account<'info, TokenAccount>>,
    /// User receives net premium here
    #[account(mut)]
    pub user_premium_account: Box<Account<'info, TokenAccount>>,
    /// Treasury receives protocol fee here
    #[account(
        mut,
        constraint = treasury_account.owner
            == settler_config.treasury
            @ SettlerError::InvalidTreasury,
    )]
    pub treasury_account: Box<Account<'info, TokenAccount>>,

    /// MM oToken balance tracking
    #[account(
        init_if_needed,
        payer = user,
        space = 8 + 32 + 32 + 8 + 1,
        seeds = [
            b"mm_balance",
            maker.key().as_ref(),
            otoken_mint.key().as_ref(),
        ],
        bump,
    )]
    pub maker_otoken_balance: Account<'info, MakerOTokenBalance>,

    /// Vault-to-MM mapping for emergency ledger cleanup
    #[account(
        init,
        payer = user,
        space = 8 + 32 + 32 + 1,
        seeds = [b"vault_mm", vault.key().as_ref()],
        bump,
    )]
    pub vault_mm: Account<'info, VaultMM>,

    /// User (option seller) provides collateral and receives premium
    #[account(mut)]
    pub user: Signer<'info>,
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
    /// Beneficiary's token account (receives returned collateral)
    #[account(mut)]
    pub beneficiary_token_account: Account<'info, TokenAccount>,
    /// CHECK: Pool vault authority PDA
    pub pool_vault_authority: AccountInfo<'info>,
    /// Controller admin must co-sign for settlement
    pub controller_admin: Signer<'info>,

    pub controller_program: Program<'info, ControllerProgram>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct EmergencyWithdrawOrder<'info> {
    #[account(
        seeds = [b"settler_config"],
        bump = settler_config.bump,
    )]
    pub settler_config: Account<'info, SettlerConfig>,

    /// Vault beneficiary triggers the emergency withdrawal
    #[account(
        constraint = beneficiary.key() == vault.beneficiary
            @ SettlerError::Unauthorized,
    )]
    pub beneficiary: Signer<'info>,

    /// CHECK: Validated by controller CPI
    pub controller_config: AccountInfo<'info>,
    /// Deserialized to validate beneficiary matches signer
    #[account(
        mut,
        constraint = vault.owner == settler_config.key()
            @ SettlerError::Unauthorized,
    )]
    pub vault: Account<'info, controller::Vault>,
    #[account(mut)]
    pub pool_token_account: Account<'info, TokenAccount>,
    /// Beneficiary's token account (receives collateral)
    #[account(mut)]
    pub beneficiary_token_account: Account<'info, TokenAccount>,
    /// CHECK: Pool vault authority PDA
    pub pool_vault_authority: AccountInfo<'info>,

    /// CHECK: MM whose custody balance is being cleared
    pub maker: AccountInfo<'info>,
    /// oToken mint for burning
    #[account(mut)]
    pub otoken_mint: Account<'info, Mint>,
    /// Settler's oToken custody account
    #[account(
        mut,
        constraint = settler_otoken_account.owner
            == settler_config.key()
            @ SettlerError::InvalidCustodyAccount,
        constraint = settler_otoken_account.mint
            == otoken_mint.key()
            @ SettlerError::InvalidCustodyAccount,
    )]
    pub settler_otoken_account: Account<'info, TokenAccount>,
    /// MM balance to clear (validated via PDA seeds)
    #[account(
        mut,
        seeds = [
            b"mm_balance",
            maker.key().as_ref(),
            otoken_mint.key().as_ref(),
        ],
        bump = maker_otoken_balance.bump,
    )]
    pub maker_otoken_balance: Account<'info, MakerOTokenBalance>,

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

#[derive(Accounts)]
pub struct RedeemForMM<'info> {
    #[account(
        seeds = [b"settler_config"],
        bump = settler_config.bump,
        constraint = operator.key() == settler_config.operator
            @ SettlerError::Unauthorized,
    )]
    pub settler_config: Account<'info, SettlerConfig>,
    pub operator: Signer<'info>,

    #[account(
        mut,
        seeds = [
            b"mm_balance",
            maker_otoken_balance.maker.as_ref(),
            otoken_mint.key().as_ref(),
        ],
        bump = maker_otoken_balance.bump,
    )]
    pub maker_otoken_balance: Account<'info, MakerOTokenBalance>,

    /// CHECK: Validated by controller CPI
    pub controller_config: AccountInfo<'info>,
    pub otoken_info: Account<'info, controller::OTokenInfo>,
    #[account(mut)]
    pub otoken_mint: Account<'info, Mint>,
    /// Settler's oToken custody (source of oTokens to burn)
    #[account(
        mut,
        constraint = settler_otoken_account.mint == otoken_mint.key()
            @ SettlerError::InvalidCustodyAccount,
        constraint = settler_otoken_account.owner == settler_config.key()
            @ SettlerError::InvalidCustodyAccount,
    )]
    pub settler_otoken_account: Box<Account<'info, TokenAccount>>,
    /// Settler's collateral account (receives redeem payout)
    #[account(
        mut,
        constraint = settler_collateral_account.owner == settler_config.key()
            @ SettlerError::InvalidCustodyAccount,
    )]
    pub settler_collateral_account: Box<Account<'info, TokenAccount>>,
    /// MM's collateral account (receives final payout)
    #[account(mut)]
    pub mm_collateral_account: Box<Account<'info, TokenAccount>>,
    #[account(mut)]
    pub pool_token_account: Box<Account<'info, TokenAccount>>,
    /// CHECK: Pool vault authority PDA
    pub pool_vault_authority: AccountInfo<'info>,

    pub controller_program: Program<'info, ControllerProgram>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct MMSelfRedeem<'info> {
    #[account(
        seeds = [b"settler_config"],
        bump = settler_config.bump,
    )]
    pub settler_config: Account<'info, SettlerConfig>,

    #[account(
        seeds = [b"maker", maker.key().as_ref()],
        bump = maker_state.bump,
        has_one = maker,
        constraint = maker_state.whitelisted @ SettlerError::MakerNotWhitelisted,
    )]
    pub maker_state: Account<'info, MakerState>,
    pub maker: Signer<'info>,

    #[account(
        mut,
        seeds = [
            b"mm_balance",
            maker.key().as_ref(),
            otoken_mint.key().as_ref(),
        ],
        bump = maker_otoken_balance.bump,
    )]
    pub maker_otoken_balance: Account<'info, MakerOTokenBalance>,

    /// CHECK: Validated by controller CPI
    pub controller_config: AccountInfo<'info>,
    pub otoken_info: Account<'info, controller::OTokenInfo>,
    #[account(mut)]
    pub otoken_mint: Account<'info, Mint>,
    #[account(
        mut,
        constraint = settler_otoken_account.mint == otoken_mint.key()
            @ SettlerError::InvalidCustodyAccount,
        constraint = settler_otoken_account.owner == settler_config.key()
            @ SettlerError::InvalidCustodyAccount,
    )]
    pub settler_otoken_account: Box<Account<'info, TokenAccount>>,
    #[account(
        mut,
        constraint = settler_collateral_account.owner == settler_config.key()
            @ SettlerError::InvalidCustodyAccount,
    )]
    pub settler_collateral_account: Box<Account<'info, TokenAccount>>,
    #[account(mut)]
    pub mm_collateral_account: Box<Account<'info, TokenAccount>>,
    #[account(mut)]
    pub pool_token_account: Box<Account<'info, TokenAccount>>,
    /// CHECK: Pool vault authority PDA
    pub pool_vault_authority: AccountInfo<'info>,

    pub controller_program: Program<'info, ControllerProgram>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct ClearMMBalance<'info> {
    #[account(
        seeds = [b"settler_config"],
        bump = settler_config.bump,
        constraint = caller.key() == settler_config.owner
            || caller.key() == settler_config.operator
            @ SettlerError::Unauthorized,
    )]
    pub settler_config: Account<'info, SettlerConfig>,
    pub caller: Signer<'info>,

    #[account(
        seeds = [b"vault_mm", vault_mm.vault.as_ref()],
        bump = vault_mm.bump,
    )]
    pub vault_mm: Account<'info, VaultMM>,

    #[account(
        mut,
        seeds = [
            b"mm_balance",
            vault_mm.maker.as_ref(),
            maker_otoken_balance.otoken_mint.as_ref(),
        ],
        bump = maker_otoken_balance.bump,
    )]
    pub maker_otoken_balance: Account<'info, MakerOTokenBalance>,
}

#[derive(Accounts)]
pub struct PhysicalRedeem<'info> {
    #[account(
        seeds = [b"settler_config"],
        bump = settler_config.bump,
        constraint = operator.key() == settler_config.operator
            @ SettlerError::Unauthorized,
    )]
    pub settler_config: Account<'info, SettlerConfig>,
    pub operator: Signer<'info>,

    #[account(
        mut,
        seeds = [
            b"mm_balance",
            maker_otoken_balance.maker.as_ref(),
            otoken_mint.key().as_ref(),
        ],
        bump = maker_otoken_balance.bump,
    )]
    pub maker_otoken_balance: Account<'info, MakerOTokenBalance>,

    /// CHECK: Validated by controller CPI
    pub controller_config: AccountInfo<'info>,
    pub otoken_info: Account<'info, controller::OTokenInfo>,
    #[account(mut)]
    pub otoken_mint: Account<'info, Mint>,
    #[account(
        mut,
        constraint = settler_otoken_account.mint == otoken_mint.key()
            @ SettlerError::InvalidCustodyAccount,
        constraint = settler_otoken_account.owner == settler_config.key()
            @ SettlerError::InvalidCustodyAccount,
    )]
    pub settler_otoken_account: Box<Account<'info, TokenAccount>>,
    /// Settler's collateral token account (receives redeem payout)
    #[account(
        mut,
        constraint = settler_collateral_account.owner == settler_config.key()
            @ SettlerError::InvalidCustodyAccount,
    )]
    pub settler_collateral_account: Box<Account<'info, TokenAccount>>,
    /// Settler's contra-asset token account (has borrowed flash loan funds)
    #[account(
        mut,
        constraint = settler_contra_account.owner == settler_config.key()
            @ SettlerError::InvalidCustodyAccount,
    )]
    pub settler_contra_account: Box<Account<'info, TokenAccount>>,
    /// User receives contra-asset (physical delivery)
    #[account(mut)]
    pub user_contra_account: Box<Account<'info, TokenAccount>>,
    /// CHECK: User identity for event emission
    pub user: AccountInfo<'info>,
    /// MM receives surplus collateral
    #[account(mut)]
    pub mm_collateral_account: Account<'info, TokenAccount>,
    #[account(mut)]
    pub pool_token_account: Account<'info, TokenAccount>,
    /// CHECK: Pool vault authority PDA
    pub pool_vault_authority: AccountInfo<'info>,

    /// CHECK: Jupiter aggregator program, validated against config
    pub jupiter_program: AccountInfo<'info>,

    pub controller_program: Program<'info, ControllerProgram>,
    pub token_program: Program<'info, Token>,
    // remaining_accounts: Jupiter route accounts
}

#[derive(Accounts)]
pub struct OperatorAction<'info> {
    #[account(
        mut,
        seeds = [b"settler_config"],
        bump = settler_config.bump,
        constraint = operator.key() == settler_config.operator
            @ SettlerError::Unauthorized,
    )]
    pub settler_config: Account<'info, SettlerConfig>,
    pub operator: Signer<'info>,
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
    pub user: Pubkey,
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
pub struct EmergencyWithdrawEvent {
    pub beneficiary: Pubkey,
    pub vault: Pubkey,
}

#[event]
pub struct PauseToggled {
    pub paused: bool,
}

#[event]
pub struct EscapeDelayUpdated {
    pub old: i64,
    pub new: i64,
}

#[event]
pub struct MMRedeemed {
    pub maker: Pubkey,
    pub otoken_mint: Pubkey,
    pub amount: u64,
    pub payout: u64,
}

#[event]
pub struct MMSelfRedeemEvent {
    pub maker: Pubkey,
    pub otoken_mint: Pubkey,
    pub amount: u64,
    pub payout: u64,
}

#[event]
pub struct MMBalanceCleared {
    pub maker: Pubkey,
    pub otoken_mint: Pubkey,
    pub amount: u64,
}

#[event]
pub struct PhysicalDeliveryEvent {
    pub user: Pubkey,
    pub maker: Pubkey,
    pub otoken_mint: Pubkey,
    pub amount: u64,
    pub contra_amount: u64,
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
    #[msg("Invalid custody account")]
    InvalidCustodyAccount,
    #[msg("Unauthorized")]
    Unauthorized,
    #[msg("Escape delay too short (min 3 days)")]
    EscapeDelayTooShort,
    #[msg("Escape delay not reached")]
    EscapeNotReady,
    #[msg("Insufficient MM oToken balance")]
    InsufficientMMBalance,
    #[msg("Option has not expired")]
    OptionNotExpired,
    #[msg("Expiry price not set")]
    ExpiryPriceNotSet,
    #[msg("Option is not in-the-money")]
    OptionNotITM,
    #[msg("Invalid Jupiter program")]
    InvalidJupiterProgram,
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

    let pk_off = u16::from_le_bytes(
        ix.data[6..8]
            .try_into()
            .map_err(|_| error!(SettlerError::InvalidEd25519Data))?,
    ) as usize;
    let msg_off = u16::from_le_bytes(
        ix.data[10..12]
            .try_into()
            .map_err(|_| error!(SettlerError::InvalidEd25519Data))?,
    ) as usize;
    let msg_sz = u16::from_le_bytes(
        ix.data[12..14]
            .try_into()
            .map_err(|_| error!(SettlerError::InvalidEd25519Data))?,
    ) as usize;

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
    // Vault space: discriminator + owner + vault_id + collateral_mint +
    // collateral_amount + otoken_mint + short_amount + settled +
    // beneficiary + bump
    let vault_space = 8 + 32 + 8 + 32 + 8 + 32 + 8 + 1 + 32 + 1;
    let lamports = rent.minimum_balance(vault_space);
    anchor_lang::system_program::transfer(
        CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            anchor_lang::system_program::Transfer {
                from: ctx.accounts.user.to_account_info(),
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
        ctx.accounts.user.key(), // beneficiary = user (option seller)
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
                user_token_account: ctx.accounts.user_collateral_account.to_account_info(),
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
                destination: ctx.accounts.settler_otoken_account.to_account_info(),
                owner: ctx.accounts.settler_config.to_account_info(),
                token_program: ctx.accounts.token_program.to_account_info(),
            },
            signer_seeds,
        ),
        amount,
    )
}

/// Premium flow: MM -> user (net), MM -> treasury (fee).
/// MM's premium account must be delegated to settler PDA.
fn transfer_premium(
    ctx: &Context<ExecuteOrder>,
    signer_seeds: &[&[&[u8]]],
    net: u64,
    fee: u64,
) -> Result<()> {
    if net > 0 {
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.mm_premium_account.to_account_info(),
                    to: ctx.accounts.user_premium_account.to_account_info(),
                    authority: ctx.accounts.settler_config.to_account_info(),
                },
                signer_seeds,
            ),
            net,
        )?;
    }
    if fee > 0 {
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.mm_premium_account.to_account_info(),
                    to: ctx.accounts.treasury_account.to_account_info(),
                    authority: ctx.accounts.settler_config.to_account_info(),
                },
                signer_seeds,
            ),
            fee,
        )?;
    }
    Ok(())
}
