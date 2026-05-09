use anchor_lang::prelude::*;

#[account]
pub struct TradeEscrow {
    pub trade_id: String,        // UUID from DB, max 36 chars
    pub buyer: Pubkey,           // Lagos/Accra merchant wallet
    pub supplier: Pubkey,        // Dubai supplier wallet
    pub arbiter: Pubkey,         // Platform admin/arbiter wallet
    pub total_amount: u64,       // Total USDC in atomic units (6 decimals)
    pub released_amount: u64,    // How much has been paid out so far
    pub arbitration_fee_bps: u16, // Fee charged on dispute resolution (basis points)
    pub milestone_count: u8,     // Total number of milestones (1-5)
    pub current_milestone: u8,   // Index of next milestone to release
    pub status: EscrowStatus,
    pub bump: u8,                // Escrow PDA bump
    pub token_bump: u8,          // Escrow token account PDA bump
    pub fund_nonce: u64,         // Idempotency nonce for fund action
    pub release_nonce: u64,      // Idempotency nonce for release action
    pub dispute_nonce: u64,      // Idempotency nonce for dispute action
    pub refund_nonce: u64,       // Idempotency nonce for refund action
}

impl TradeEscrow {
    // 8 (discriminator)
    // + 40 (4 len prefix + 36 max string bytes for trade_id)
    // + 32 + 32 + 32 (three pubkeys)
    // + 8 + 8 (two u64s)
    // + 2 (one u16)
    // + 1 + 1 (two u8s)
    // + 1 (enum)
    // + 1 + 1 (two bump u8s)
    // + 8 + 8 + 8 + 8 (four nonce u64 fields)
    pub const LEN: usize = 8 + 40 + 32 + 32 + 32 + 8 + 8 + 2 + 1 + 1 + 1 + 1 + 1 + 8 + 8 + 8 + 8;
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq)]
pub enum EscrowStatus {
    PendingFunding, // Initialized, waiting for buyer to deposit
    Funded,         // Buyer funded, supplier can begin shipment
    InProgress,     // At least one milestone released
    Disputed,       // Dispute raised, escrow frozen
    Completed,      // All milestones released, trade done
    Refunded,       // Cancelled, full refund sent to buyer
}
