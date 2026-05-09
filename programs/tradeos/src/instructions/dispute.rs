use anchor_lang::prelude::*;
use crate::errors::TradeOSError;
use crate::state::escrow::{EscrowStatus, TradeEscrow};
use crate::state::milestone::MilestoneConfig;

pub fn handler(
    ctx: Context<RaiseDispute>,
    milestone_index: u8,
    reason: String,
    expected_nonce: u64,
) -> Result<()> {
    let escrow = &mut ctx.accounts.escrow;
    let milestone_config = &ctx.accounts.milestone_config;

    require!(expected_nonce == escrow.dispute_nonce, TradeOSError::InvalidNonce);
    require!(
        escrow.status == EscrowStatus::Funded
            || escrow.status == EscrowStatus::InProgress,
        TradeOSError::InvalidEscrowStatus
    );

    require!(
        (milestone_index as usize) < milestone_config.milestones.len(),
        TradeOSError::InvalidMilestoneIndex
    );

    // Can only dispute an unreleased milestone
    require!(
        !milestone_config.milestones[milestone_index as usize].released,
        TradeOSError::MilestoneAlreadyReleased
    );

    // Freeze the escrow so no further releases happen until arbiter resolves.
    escrow.status = EscrowStatus::Disputed;
    escrow.dispute_nonce = escrow
        .dispute_nonce
        .checked_add(1)
        .ok_or(TradeOSError::ArithmeticOverflow)?;

    emit!(DisputeRaised {
        trade_id: escrow.trade_id.clone(),
        raised_by: ctx.accounts.caller.key(),
        milestone_index,
        reason,
    });

    Ok(())
}

#[event]
pub struct DisputeRaised {
    pub trade_id: String,
    pub raised_by: Pubkey,
    pub milestone_index: u8,
    pub reason: String,
}

#[derive(Accounts)]
pub struct RaiseDispute<'info> {
    /// Either buyer or supplier can raise a dispute
    #[account(mut)]
    pub caller: Signer<'info>,

    #[account(
        mut,
        seeds = [b"escrow", escrow.trade_id.as_bytes()],
        bump = escrow.bump,
        constraint = (
            caller.key() == escrow.buyer || caller.key() == escrow.supplier
        ) @ TradeOSError::UnauthorizedDispute,
    )]
    pub escrow: Account<'info, TradeEscrow>,

    #[account(
        seeds = [b"milestones", escrow.key().as_ref()],
        bump = milestone_config.bump,
        has_one = escrow,
    )]
    pub milestone_config: Account<'info, MilestoneConfig>,

    pub system_program: Program<'info, System>,
}
