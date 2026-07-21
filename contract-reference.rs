#![no_std]

use soroban_sdk::{
    contract, contractclient, contracterror, contractimpl, contracttype, token, Address, BytesN,
    Env, Vec,
};

const BPS: i128 = 10_000;
const YEAR_SECS: i128 = 31_536_000;
const HOURS_PER_YEAR: i128 = 8_760;
const DAYS_PER_YEAR: i128 = 365;
const RATE_SCALE: i128 = 1_000_000_000_000;
const INDEX_SCALE: i128 = 1_000_000_000_000;
const MAX_BATCH: u32 = 10;
const MAX_SCAN: u32 = 25;

#[contractclient(name = "AquariusPoolClient")]
pub trait AquariusPool {
    fn swap(
        env: Env,
        user: Address,
        in_idx: u32,
        out_idx: u32,
        in_amount: u128,
        out_min: u128,
    ) -> u128;

    fn swap_strict_receive(
        env: Env,
        user: Address,
        in_idx: u32,
        out_idx: u32,
        out_amount: u128,
        in_max: u128,
    ) -> u128;

    fn estimate_swap(env: Env, in_idx: u32, out_idx: u32, in_amount: u128) -> u128;

    fn estimate_swap_strict_receive(env: Env, in_idx: u32, out_idx: u32, out_amount: u128) -> u128;

    fn get_tokens(env: Env) -> Vec<Address>;
    fn get_reserves(env: Env) -> Vec<u128>;
    fn get_is_killed_swap(env: Env) -> bool;
    fn get_emergency_mode(env: Env) -> bool;
}

#[contracttype]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum Side {
    Long,
    Short,
}

#[contracttype]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum PositionStatus {
    Open,
    Closed,
    Liquidated,
}

#[contracttype]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum CloseReason {
    User,
    StopLoss,
    TakeProfit,
    Liquidation,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GlobalConfig {
    pub admin: Address,
    /// USDC is the universal collateral, settlement, and quote asset.
    pub usdc: Address,
    pub open_fee_bps: u32,
    pub close_fee_bps: u32,
    pub liquidation_reward_bps: u32,
    pub trigger_fee_bps: u32,
    pub trigger_keeper_share_bps: u32,
    pub paused: bool,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MarketConfig {
    /// Supported non-USDC asset, e.g. XLM or BTC.
    pub asset: Address,
    /// Fixed direct Aquarius pool for USDC/asset.
    pub aquarius_pool: Address,
    /// Index of USDC in Aquarius pool.get_tokens().
    pub usdc_index: u32,
    /// Index of the supported asset in Aquarius pool.get_tokens().
    pub asset_index: u32,
    /// Number of token base units in one whole asset. Usually 10^7 on Stellar.
    pub asset_scale: i128,
    pub max_leverage_bps: u32,
    pub maintenance_margin_bps: u32,
    pub closeness_equity_bps: u32,
    pub normal_slippage_bps: u32,
    pub trigger_slippage_bps: u32,
    pub liquidation_slippage_bps: u32,
    pub max_position_notional_usdc: i128,
    pub enabled: bool,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct InterestRateConfig {
    /// APR at zero utilization.
    pub base_apr_bps: u32,
    /// Utilization where the steep part of the curve begins.
    pub optimal_utilization_bps: u32,
    /// APR added linearly between zero and optimal utilization.
    pub slope_before_kink_bps: u32,
    /// APR added linearly between optimal and 100% utilization.
    pub slope_after_kink_bps: u32,
    /// New borrowing is blocked above this projected utilization.
    pub max_utilization_bps: u32,
    /// Share of accrued borrowing interest retained as protocol reserves.
    pub reserve_factor_bps: u32,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BorrowRateView {
    pub market_asset: Address,
    pub side: Side,
    pub borrowed_asset: Address,
    pub utilization_bps: i128,
    pub apr_bps: i128,
    /// RATE_SCALE represents 100%. This is APR / 365.
    pub daily_rate_scaled: i128,
    /// RATE_SCALE represents 100%. This is APR / 8,760.
    pub hourly_rate_scaled: i128,
    pub rate_scale: i128,
    pub available_liquidity: i128,
    pub total_debt: i128,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PoolState {
    pub total_assets: i128,
    pub total_shares: i128,
    /// Current principal plus accrued borrowing interest.
    pub total_borrowed: i128,
    pub accrued_interest: i128,
    pub reserves: i128,
    pub borrow_index: i128,
    pub last_accrual_timestamp: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Position {
    pub id: u64,
    pub owner: Address,
    pub asset: Address,
    pub side: Side,
    pub initial_collateral_usdc: i128,
    pub collateral_usdc: i128,
    pub open_fee_paid_usdc: i128,
    /// Borrowed principal multiple. 50_000 means collateral * 5 is borrowed.
    pub leverage_bps: u32,
    /// USDC principal for longs; supported-asset principal for shorts.
    pub borrowed_amount: i128,
    /// Normalized debt units at the lending pool borrow index.
    pub borrow_scaled: i128,
    /// Supported asset held for longs; USDC sale proceeds held for shorts.
    pub held_amount: i128,
    pub entry_price: i128,
    pub opened_at: u64,
    pub last_fee_at: u64,
    pub stop_loss_price: i128,
    pub take_profit_price: i128,
    pub status: PositionStatus,
    pub action_queued: bool,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PositionRisk {
    pub id: u64,
    /// Effective USDC price for the full position-sized Aquarius close estimate.
    pub executable_price: i128,
    /// Estimated USDC equity if the position closed against Aquarius now.
    pub executable_equity_usdc: i128,
    pub equity_ratio_bps: i128,
    pub margin_ratio_bps: i128,
    pub liquidatable: bool,
    pub actionable: bool,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PositionPreview {
    pub id: u64,
    pub owner: Address,
    pub asset: Address,
    pub side: Side,
    pub status: PositionStatus,
    pub initial_collateral_usdc: i128,
    pub collateral_usdc: i128,
    pub open_fee_paid_usdc: i128,
    pub borrowed_principal: i128,
    pub current_debt: i128,
    pub accrued_borrow_fee_asset: i128,
    pub accrued_borrow_fee_usdc: i128,
    pub held_amount: i128,
    pub entry_price: i128,
    pub executable_price: i128,
    pub gross_pnl_usdc: i128,
    pub estimated_close_fee_usdc: i128,
    pub total_estimated_fees_usdc: i128,
    pub estimated_manual_payout_usdc: i128,
    pub net_pnl_usdc: i128,
    pub equity_ratio_bps: i128,
    pub margin_ratio_bps: i128,
    pub current_borrow_apr_bps: i128,
    pub liquidatable: bool,
    pub actionable: bool,
    pub action_queued: bool,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Settlement {
    pub position_id: u64,
    pub asset: Address,
    pub reason: CloseReason,
    pub debt_repaid: i128,
    pub interest_paid_usdc: i128,
    pub protocol_close_fee_usdc: i128,
    pub liquidation_reward_usdc: i128,
    pub keeper_trigger_fee_usdc: i128,
    pub reserve_trigger_fee_usdc: i128,
    pub returned_usdc: i128,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ScanResult {
    pub inspected: u32,
    pub queued: u32,
    pub next_cursor: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BatchResult {
    pub inspected: u32,
    pub executed: u32,
    pub skipped: u32,
}

#[contracttype]
#[derive(Clone)]
enum DataKey {
    GlobalConfig,
    Market(Address),
    Pool(Address),
    RateConfig(Address),
    LpShares(Address, Address), // asset, lp
    Position(u64),
    NextPositionId,
    PositionCount,
    ScanCursor,
    ActionQueue,
    ActionHead,
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum Error {
    AlreadyInitialized = 1,
    NotInitialized = 2,
    Unauthorized = 3,
    Paused = 4,
    InvalidAmount = 5,
    InvalidLeverage = 6,
    InsufficientLiquidity = 7,
    PositionNotFound = 8,
    PositionNotOpen = 9,
    TriggerNotReached = 10,
    NotLiquidatable = 11,
    InvalidBatch = 12,
    InvalidPrice = 13,
    InvalidEstimate = 14,
    Slippage = 15,
    Arithmetic = 16,
    WithdrawalLocked = 17,
    MarketNotFound = 18,
    MarketDisabled = 19,
    InvalidPool = 20,
    PoolSwapDisabled = 21,
    PoolEmergencyMode = 22,
    PositionTooLarge = 24,
    SwapAccountingMismatch = 25,
    RateConfigNotFound = 26,
    MaxUtilizationExceeded = 27,
}

#[contract]
pub struct AmpliFiProtocol;

#[contractimpl]
impl AmpliFiProtocol {
    pub fn __constructor(env: Env, config: GlobalConfig) -> Result<(), Error> {
        if env.storage().instance().has(&DataKey::GlobalConfig) {
            return Err(Error::AlreadyInitialized);
        }
        validate_global_config(&config)?;
        validate_interest_rate_config(&default_interest_rate_config())?;
        env.storage()
            .instance()
            .set(&DataKey::GlobalConfig, &config);
        env.storage().instance().set(
            &DataKey::Pool(config.usdc.clone()),
            &empty_pool(env.ledger().timestamp()),
        );
        env.storage().persistent().set(
            &DataKey::RateConfig(config.usdc.clone()),
            &default_interest_rate_config(),
        );
        env.storage()
            .instance()
            .set(&DataKey::NextPositionId, &1_u64);
        env.storage()
            .instance()
            .set(&DataKey::PositionCount, &0_u64);
        env.storage().instance().set(&DataKey::ScanCursor, &1_u64);
        env.storage()
            .instance()
            .set(&DataKey::ActionQueue, &Vec::<u64>::new(&env));
        env.storage().instance().set(&DataKey::ActionHead, &0_u32);
        Ok(())
    }

    pub fn set_paused(env: Env, paused: bool) -> Result<(), Error> {
        let mut cfg = global_config(&env)?;
        cfg.admin.require_auth();
        cfg.paused = paused;
        env.storage().instance().set(&DataKey::GlobalConfig, &cfg);
        Ok(())
    }

    /// Adds or updates a USDC/asset market. USDC remains the universal base.
    pub fn set_market(env: Env, market: MarketConfig) -> Result<(), Error> {
        let cfg = global_config(&env)?;
        cfg.admin.require_auth();
        validate_market(&env, &cfg, &market)?;
        env.storage()
            .persistent()
            .set(&DataKey::Market(market.asset.clone()), &market);
        if !env
            .storage()
            .instance()
            .has(&DataKey::Pool(market.asset.clone()))
        {
            env.storage().instance().set(
                &DataKey::Pool(market.asset.clone()),
                &empty_pool(env.ledger().timestamp()),
            );
        }
        if !env
            .storage()
            .persistent()
            .has(&DataKey::RateConfig(market.asset.clone()))
        {
            env.storage().persistent().set(
                &DataKey::RateConfig(market.asset.clone()),
                &default_interest_rate_config(),
            );
        }
        Ok(())
    }

    pub fn set_market_enabled(env: Env, asset: Address, enabled: bool) -> Result<(), Error> {
        let cfg = global_config(&env)?;
        cfg.admin.require_auth();
        let mut market = market_config(&env, &asset)?;
        market.enabled = enabled;
        env.storage()
            .persistent()
            .set(&DataKey::Market(asset), &market);
        Ok(())
    }

    pub fn set_interest_rate_config(
        env: Env,
        asset: Address,
        rate: InterestRateConfig,
    ) -> Result<(), Error> {
        let cfg = global_config(&env)?;
        cfg.admin.require_auth();
        ensure_supported_pool_asset(&env, &cfg, &asset)?;
        validate_interest_rate_config(&rate)?;
        let pool = accrue_pool(&env, &asset)?;
        set_pool(&env, &asset, &pool);
        env.storage()
            .persistent()
            .set(&DataKey::RateConfig(asset), &rate);
        Ok(())
    }

    pub fn upgrade(env: Env, wasm_hash: BytesN<32>) -> Result<(), Error> {
        let cfg = global_config(&env)?;
        cfg.admin.require_auth();
        env.deployer().update_current_contract_wasm(wasm_hash);
        Ok(())
    }

    pub fn deposit_liquidity(
        env: Env,
        lp: Address,
        asset: Address,
        amount: i128,
    ) -> Result<i128, Error> {
        require_positive(amount)?;
        lp.require_auth();
        let cfg = global_config(&env)?;
        ensure_supported_pool_asset(&env, &cfg, &asset)?;
        let mut pool = accrue_pool(&env, &asset)?;
        let shares = if pool.total_shares == 0 || pool.total_assets == 0 {
            amount
        } else {
            mul_div(amount, pool.total_shares, pool.total_assets)?
        };
        if shares <= 0 {
            return Err(Error::InvalidAmount);
        }
        token::Client::new(&env, &asset).transfer(&lp, &env.current_contract_address(), &amount);
        pool.total_assets = checked_add(pool.total_assets, amount)?;
        pool.total_shares = checked_add(pool.total_shares, shares)?;
        set_pool(&env, &asset, &pool);
        let key = DataKey::LpShares(asset.clone(), lp.clone());
        let old: i128 = env.storage().persistent().get(&key).unwrap_or(0);
        env.storage()
            .persistent()
            .set(&key, &checked_add(old, shares)?);
        Ok(shares)
    }

    pub fn withdraw_liquidity(
        env: Env,
        lp: Address,
        asset: Address,
        shares: i128,
    ) -> Result<i128, Error> {
        require_positive(shares)?;
        lp.require_auth();
        let cfg = global_config(&env)?;
        ensure_supported_pool_asset(&env, &cfg, &asset)?;
        let mut pool = accrue_pool(&env, &asset)?;
        let key = DataKey::LpShares(asset.clone(), lp.clone());
        let owned: i128 = env.storage().persistent().get(&key).unwrap_or(0);
        if shares > owned || pool.total_shares <= 0 {
            return Err(Error::InvalidAmount);
        }
        let amount = mul_div(shares, pool.total_assets, pool.total_shares)?;
        let available = checked_sub(pool.total_assets, pool.total_borrowed)?;
        if amount > available {
            return Err(Error::WithdrawalLocked);
        }
        pool.total_assets = checked_sub(pool.total_assets, amount)?;
        pool.total_shares = checked_sub(pool.total_shares, shares)?;
        set_pool(&env, &asset, &pool);
        env.storage()
            .persistent()
            .set(&key, &checked_sub(owned, shares)?);
        token::Client::new(&env, &asset).transfer(&env.current_contract_address(), &lp, &amount);
        Ok(amount)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn open_long(
        env: Env,
        owner: Address,
        asset: Address,
        collateral_usdc: i128,
        leverage_bps: u32,
        stop_loss_price: i128,
        take_profit_price: i128,
    ) -> Result<u64, Error> {
        owner.require_auth();
        let cfg = active_global_config(&env)?;
        let market = active_market(&env, &asset)?;
        validate_open(&market, collateral_usdc, leverage_bps)?;
        ensure_pool_operational(&env, &market)?;

        let borrowed_usdc = mul_div(collateral_usdc, leverage_bps as i128, BPS)?;
        if borrowed_usdc > market.max_position_notional_usdc {
            return Err(Error::PositionTooLarge);
        }
        let mut usdc_pool = accrue_pool(&env, &cfg.usdc)?;
        ensure_borrow_capacity(&env, &cfg.usdc, &usdc_pool, borrowed_usdc)?;

        token::Client::new(&env, &cfg.usdc).transfer(
            &owner,
            &env.current_contract_address(),
            &collateral_usdc,
        );

        let open_fee = bps(borrowed_usdc, cfg.open_fee_bps)?;
        if open_fee >= collateral_usdc {
            return Err(Error::InvalidAmount);
        }

        let estimate = estimate_exact_in(
            &env,
            &market,
            market.usdc_index,
            market.asset_index,
            borrowed_usdc,
        )?;
        let min_out = apply_negative_bps(estimate, market.normal_slippage_bps)?;
        let asset_out = swap_exact_in(
            &env,
            &market,
            market.usdc_index,
            market.asset_index,
            borrowed_usdc,
            min_out,
            &cfg.usdc,
            &asset,
        )?;

        usdc_pool.total_borrowed = checked_add(usdc_pool.total_borrowed, borrowed_usdc)?;
        usdc_pool.reserves = checked_add(usdc_pool.reserves, open_fee)?;
        set_pool(&env, &cfg.usdc, &usdc_pool);

        let entry_price =
            effective_price_from_exact_in(borrowed_usdc, asset_out, market.asset_scale)?;
        let id = next_id(&env)?;
        save_position(
            &env,
            &Position {
                id,
                owner,
                asset,
                side: Side::Long,
                initial_collateral_usdc: collateral_usdc,
                collateral_usdc: checked_sub(collateral_usdc, open_fee)?,
                open_fee_paid_usdc: open_fee,
                leverage_bps,
                borrowed_amount: borrowed_usdc,
                borrow_scaled: scaled_borrow_amount(borrowed_usdc, usdc_pool.borrow_index)?,
                held_amount: asset_out,
                entry_price,
                opened_at: env.ledger().timestamp(),
                last_fee_at: env.ledger().timestamp(),
                stop_loss_price,
                take_profit_price,
                status: PositionStatus::Open,
                action_queued: false,
            },
        );
        Ok(id)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn open_short(
        env: Env,
        owner: Address,
        asset: Address,
        collateral_usdc: i128,
        leverage_bps: u32,
        stop_loss_price: i128,
        take_profit_price: i128,
    ) -> Result<u64, Error> {
        owner.require_auth();
        let cfg = active_global_config(&env)?;
        let market = active_market(&env, &asset)?;
        validate_open(&market, collateral_usdc, leverage_bps)?;
        ensure_pool_operational(&env, &market)?;

        let target_usdc = mul_div(collateral_usdc, leverage_bps as i128, BPS)?;
        if target_usdc > market.max_position_notional_usdc {
            return Err(Error::PositionTooLarge);
        }

        // The short borrows the amount of the supported asset that the configured
        // Aquarius pool estimates can be purchased with the target USDC notional.
        let borrowed_asset = estimate_exact_in(
            &env,
            &market,
            market.usdc_index,
            market.asset_index,
            target_usdc,
        )?;
        let mut asset_pool = accrue_pool(&env, &asset)?;
        ensure_borrow_capacity(&env, &asset, &asset_pool, borrowed_asset)?;

        token::Client::new(&env, &cfg.usdc).transfer(
            &owner,
            &env.current_contract_address(),
            &collateral_usdc,
        );

        let open_fee = bps(target_usdc, cfg.open_fee_bps)?;
        if open_fee >= collateral_usdc {
            return Err(Error::InvalidAmount);
        }

        let expected_usdc = estimate_exact_in(
            &env,
            &market,
            market.asset_index,
            market.usdc_index,
            borrowed_asset,
        )?;
        let min_usdc_out = apply_negative_bps(expected_usdc, market.normal_slippage_bps)?;
        let proceeds = swap_exact_in(
            &env,
            &market,
            market.asset_index,
            market.usdc_index,
            borrowed_asset,
            min_usdc_out,
            &asset,
            &cfg.usdc,
        )?;

        asset_pool.total_borrowed = checked_add(asset_pool.total_borrowed, borrowed_asset)?;
        set_pool(&env, &asset, &asset_pool);
        let mut usdc_pool = pool_for(&env, &cfg.usdc);
        usdc_pool.reserves = checked_add(usdc_pool.reserves, open_fee)?;
        set_pool(&env, &cfg.usdc, &usdc_pool);

        let entry_price =
            effective_price_from_exact_in(proceeds, borrowed_asset, market.asset_scale)?;
        let id = next_id(&env)?;
        save_position(
            &env,
            &Position {
                id,
                owner,
                asset,
                side: Side::Short,
                initial_collateral_usdc: collateral_usdc,
                collateral_usdc: checked_sub(collateral_usdc, open_fee)?,
                open_fee_paid_usdc: open_fee,
                leverage_bps,
                borrowed_amount: borrowed_asset,
                borrow_scaled: scaled_borrow_amount(borrowed_asset, asset_pool.borrow_index)?,
                held_amount: proceeds,
                entry_price,
                opened_at: env.ledger().timestamp(),
                last_fee_at: env.ledger().timestamp(),
                stop_loss_price,
                take_profit_price,
                status: PositionStatus::Open,
                action_queued: false,
            },
        );
        Ok(id)
    }

    pub fn close_position(
        env: Env,
        owner: Address,
        position_id: u64,
        close_bps: Option<u32>,
    ) -> Result<Settlement, Error> {
        owner.require_auth();

        let effective_close_bps = close_bps.unwrap_or(BPS as u32);

        validate_close_bps(effective_close_bps)?;

        let position = load_position(&env, position_id)?;

        if position.owner != owner {
            return Err(Error::Unauthorized);
        }

        if position.status != PositionStatus::Open {
            return Err(Error::PositionNotOpen);
        }

        settle_user_close(&env, position, effective_close_bps)
    }

    pub fn execute_trigger(
        env: Env,
        keeper: Address,
        position_id: u64,
    ) -> Result<Settlement, Error> {
        keeper.require_auth();
        let p = load_position(&env, position_id)?;
        let risk = risk_at(&env, &p)?;
        let reason = if risk.liquidatable {
            CloseReason::Liquidation
        } else if stop_reached(&p, risk.executable_price) {
            CloseReason::StopLoss
        } else if take_reached(&p, risk.executable_price) {
            CloseReason::TakeProfit
        } else {
            return Err(Error::TriggerNotReached);
        };
        settle(&env, p, reason, Some(keeper))
    }

    /// Contract-owned global scan. Caller supplies only the work bound.
    pub fn refresh_action_queue(env: Env, max_scan: u32) -> Result<ScanResult, Error> {
        if max_scan == 0 || max_scan > MAX_SCAN {
            return Err(Error::InvalidBatch);
        }
        let _cfg = active_global_config(&env)?;
        let count: u64 = env
            .storage()
            .instance()
            .get(&DataKey::PositionCount)
            .unwrap_or(0);
        if count == 0 {
            return Ok(ScanResult {
                inspected: 0,
                queued: 0,
                next_cursor: 1,
            });
        }
        let mut cursor: u64 = env
            .storage()
            .instance()
            .get(&DataKey::ScanCursor)
            .unwrap_or(1);
        let mut queue: Vec<u64> = env
            .storage()
            .instance()
            .get(&DataKey::ActionQueue)
            .unwrap_or(Vec::new(&env));
        let mut inspected = 0_u32;
        let mut queued = 0_u32;

        while inspected < max_scan {
            if cursor > count {
                cursor = 1;
            }
            if let Some(mut p) = env
                .storage()
                .persistent()
                .get::<_, Position>(&DataKey::Position(cursor))
            {
                if p.status == PositionStatus::Open {
                    let risk = risk_at(&env, &p)?;
                    let trigger = stop_reached(&p, risk.executable_price)
                        || take_reached(&p, risk.executable_price);
                    if (risk.actionable || trigger) && !p.action_queued {
                        p.action_queued = true;
                        save_position(&env, &p);
                        queue.push_back(p.id);
                        queued += 1;
                    }
                }
            }
            cursor += 1;
            inspected += 1;
            if inspected as u64 >= count {
                break;
            }
        }

        env.storage().instance().set(&DataKey::ScanCursor, &cursor);
        env.storage().instance().set(&DataKey::ActionQueue, &queue);
        Ok(ScanResult {
            inspected,
            queued,
            next_cursor: cursor,
        })
    }

    /// Processes one contract-selected candidate per transaction. No IDs, routes, pools,
    /// indices, min outputs, or max inputs are supplied by the keeper.
    pub fn process_ready(
        env: Env,
        keeper: Address,
        max_positions: u32,
    ) -> Result<BatchResult, Error> {
        if max_positions == 0 || max_positions > MAX_BATCH {
            return Err(Error::InvalidBatch);
        }
        keeper.require_auth();
        let _cfg = active_global_config(&env)?;
        let queue: Vec<u64> = env
            .storage()
            .instance()
            .get(&DataKey::ActionQueue)
            .unwrap_or(Vec::new(&env));
        let mut head: u32 = env
            .storage()
            .instance()
            .get(&DataKey::ActionHead)
            .unwrap_or(0);
        let mut inspected = 0_u32;
        let mut executed = 0_u32;
        let mut skipped = 0_u32;

        while head < queue.len() && executed < max_positions && inspected < max_positions * 3 {
            let id = queue.get_unchecked(head);
            head += 1;
            inspected += 1;
            let mut p = match env
                .storage()
                .persistent()
                .get::<_, Position>(&DataKey::Position(id))
            {
                Some(v) => v,
                None => {
                    skipped += 1;
                    continue;
                }
            };
            p.action_queued = false;
            save_position(&env, &p);
            if p.status != PositionStatus::Open {
                skipped += 1;
                continue;
            }
            let risk = risk_at(&env, &p)?;
            let reason = if risk.liquidatable {
                Some(CloseReason::Liquidation)
            } else if stop_reached(&p, risk.executable_price) {
                Some(CloseReason::StopLoss)
            } else if take_reached(&p, risk.executable_price) {
                Some(CloseReason::TakeProfit)
            } else {
                None
            };
            match reason {
                Some(r) => {
                    settle(&env, p, r, Some(keeper.clone()))?;
                    executed += 1;
                }
                None => skipped += 1,
            }
        }

        env.storage().instance().set(&DataKey::ActionHead, &head);
        Ok(BatchResult {
            inspected,
            executed,
            skipped,
        })
    }

    pub fn get_global_config(env: Env) -> Result<GlobalConfig, Error> {
        global_config(&env)
    }

    pub fn get_market(env: Env, asset: Address) -> Result<MarketConfig, Error> {
        market_config(&env, &asset)
    }

    pub fn get_position(env: Env, id: u64) -> Result<Position, Error> {
        load_position(&env, id)
    }

    pub fn get_risk(env: Env, id: u64) -> Result<PositionRisk, Error> {
        let p = load_position(&env, id)?;
        risk_at(&env, &p)
    }

    pub fn get_interest_rate_config(env: Env, asset: Address) -> Result<InterestRateConfig, Error> {
        let cfg = global_config(&env)?;
        ensure_supported_pool_asset(&env, &cfg, &asset)?;
        rate_config(&env, &asset)
    }

    pub fn get_borrow_rate(env: Env, asset: Address, side: Side) -> Result<BorrowRateView, Error> {
        let cfg = global_config(&env)?;
        let _market = market_config(&env, &asset)?;
        let borrowed_asset = match side {
            Side::Long => cfg.usdc.clone(),
            Side::Short => asset.clone(),
        };
        let pool = projected_pool(&env, &borrowed_asset)?;
        let rate = rate_config(&env, &borrowed_asset)?;
        let utilization_bps = utilization_bps(&pool)?;
        let apr_bps = borrow_apr_bps_for_utilization(utilization_bps, &rate)?;
        let annual_rate_scaled = mul_div(apr_bps, RATE_SCALE, BPS)?;
        Ok(BorrowRateView {
            market_asset: asset,
            side,
            borrowed_asset,
            utilization_bps,
            apr_bps,
            daily_rate_scaled: annual_rate_scaled / DAYS_PER_YEAR,
            hourly_rate_scaled: annual_rate_scaled / HOURS_PER_YEAR,
            rate_scale: RATE_SCALE,
            available_liquidity: available_liquidity(&pool)?,
            total_debt: pool.total_borrowed,
        })
    }

    pub fn preview_position(env: Env, id: u64) -> Result<PositionPreview, Error> {
        let p = load_position(&env, id)?;
        preview_position_at(&env, &p)
    }

    pub fn get_pool(env: Env, asset: Address) -> Result<PoolState, Error> {
        let cfg = global_config(&env)?;
        ensure_supported_pool_asset(&env, &cfg, &asset)?;
        projected_pool(&env, &asset)
    }
}

fn settle(
    env: &Env,
    mut p: Position,
    reason: CloseReason,
    keeper: Option<Address>,
) -> Result<Settlement, Error> {
    if p.status != PositionStatus::Open {
        return Err(Error::PositionNotOpen);
    }
    let cfg = active_global_config(env)?;
    let market = active_market(env, &p.asset)?;
    ensure_pool_operational(env, &market)?;

    if reason == CloseReason::Liquidation && !risk_at(env, &p)?.liquidatable {
        return Err(Error::NotLiquidatable);
    }

    let borrowed_asset = borrowed_asset_for_side(&cfg, &p);
    let mut debt_pool = accrue_pool(env, &borrowed_asset)?;
    let debt_total = position_debt(&debt_pool, p.borrow_scaled)?;
    let interest_asset = checked_sub(debt_total, p.borrowed_amount)?;
    let close_notional_usdc = match p.side {
        Side::Long => estimate_exact_in(
            env,
            &market,
            market.asset_index,
            market.usdc_index,
            p.held_amount,
        )?,
        Side::Short => p.held_amount,
    };
    let close_fee = bps(close_notional_usdc, cfg.close_fee_bps)?;

    let liquidation_reward = if reason == CloseReason::Liquidation {
        bps(p.collateral_usdc, cfg.liquidation_reward_bps)?
    } else {
        0
    };

    let trigger_fee = if reason == CloseReason::StopLoss || reason == CloseReason::TakeProfit {
        bps(p.collateral_usdc, cfg.trigger_fee_bps)?
    } else {
        0
    };
    let keeper_trigger_fee = bps(trigger_fee, cfg.trigger_keeper_share_bps)?;
    let reserve_trigger_fee = checked_sub(trigger_fee, keeper_trigger_fee)?;

    let slippage_bps = match reason {
        CloseReason::User => market.normal_slippage_bps,
        CloseReason::StopLoss | CloseReason::TakeProfit => market.trigger_slippage_bps,
        CloseReason::Liquidation => market.liquidation_slippage_bps,
    };

    let mut payout: i128;
    let interest_usdc: i128;

    match p.side {
        Side::Long => {
            let estimate = estimate_exact_in(
                env,
                &market,
                market.asset_index,
                market.usdc_index,
                p.held_amount,
            )?;
            let min_out = apply_negative_bps(estimate, slippage_bps)?;
            let usdc_out = swap_exact_in(
                env,
                &market,
                market.asset_index,
                market.usdc_index,
                p.held_amount,
                min_out,
                &p.asset,
                &cfg.usdc,
            )?;
            interest_usdc = interest_asset;
            payout = signed_equity(checked_add(p.collateral_usdc, usdc_out)?, debt_total)?;

            debt_pool.total_borrowed = checked_sub(debt_pool.total_borrowed, debt_total)?;
            set_pool(env, &cfg.usdc, &debt_pool);
        }
        Side::Short => {
            let estimate = estimate_exact_out(
                env,
                &market,
                market.usdc_index,
                market.asset_index,
                debt_total,
            )?;
            let max_in = apply_positive_bps(estimate, slippage_bps)?;
            let usdc_in = swap_exact_out(
                env,
                &market,
                market.usdc_index,
                market.asset_index,
                debt_total,
                max_in,
                &cfg.usdc,
                &p.asset,
            )?;
            interest_usdc = if debt_total == 0 {
                0
            } else {
                mul_div(usdc_in, interest_asset, debt_total)?
            };
            payout = signed_equity(checked_add(p.collateral_usdc, p.held_amount)?, usdc_in)?;

            debt_pool.total_borrowed = checked_sub(debt_pool.total_borrowed, debt_total)?;
            set_pool(env, &p.asset, &debt_pool);
        }
    }

    payout = checked_sub(payout, close_fee)?;
    payout = checked_sub(payout, liquidation_reward)?;
    payout = checked_sub(payout, trigger_fee)?;
    if payout < 0 {
        payout = 0;
    }

    let mut usdc_pool = pool_for(env, &cfg.usdc);
    usdc_pool.reserves = checked_add(usdc_pool.reserves, close_fee)?;
    usdc_pool.reserves = checked_add(usdc_pool.reserves, reserve_trigger_fee)?;
    set_pool(env, &cfg.usdc, &usdc_pool);

    if liquidation_reward > 0 {
        let k = keeper.clone().ok_or(Error::Unauthorized)?;
        token::Client::new(env, &cfg.usdc).transfer(
            &env.current_contract_address(),
            &k,
            &liquidation_reward,
        );
    }
    if keeper_trigger_fee > 0 {
        let k = keeper.ok_or(Error::Unauthorized)?;
        token::Client::new(env, &cfg.usdc).transfer(
            &env.current_contract_address(),
            &k,
            &keeper_trigger_fee,
        );
    }
    if payout > 0 {
        token::Client::new(env, &cfg.usdc).transfer(
            &env.current_contract_address(),
            &p.owner,
            &payout,
        );
    }

    p.status = if reason == CloseReason::Liquidation {
        PositionStatus::Liquidated
    } else {
        PositionStatus::Closed
    };
    p.action_queued = false;
    save_position(env, &p);

    Ok(Settlement {
        position_id: p.id,
        asset: p.asset,
        reason,
        debt_repaid: debt_total,
        interest_paid_usdc: interest_usdc,
        protocol_close_fee_usdc: close_fee,
        liquidation_reward_usdc: liquidation_reward,
        keeper_trigger_fee_usdc: keeper_trigger_fee,
        reserve_trigger_fee_usdc: reserve_trigger_fee,
        returned_usdc: payout,
    })
}

fn risk_at(env: &Env, p: &Position) -> Result<PositionRisk, Error> {
    if p.status != PositionStatus::Open {
        return Err(Error::PositionNotOpen);
    }

    let cfg = global_config(env)?;
    let market = market_config(env, &p.asset)?;
    ensure_pool_operational(env, &market)?;

    let borrowed_asset = borrowed_asset_for_side(&cfg, p);
    let debt_pool = projected_pool(env, &borrowed_asset)?;
    let debt_total = position_debt(&debt_pool, p.borrow_scaled)?;
    let liquidation_reward = bps(p.collateral_usdc, cfg.liquidation_reward_bps)?;

    let (executable_price, executable_equity, close_notional_usdc) = match p.side {
        Side::Long => {
            let estimated_usdc_out = estimate_exact_in(
                env,
                &market,
                market.asset_index,
                market.usdc_index,
                p.held_amount,
            )?;
            let price = effective_price_from_exact_in(
                estimated_usdc_out,
                p.held_amount,
                market.asset_scale,
            )?;
            let close_fee = bps(estimated_usdc_out, cfg.close_fee_bps)?;
            let obligations = checked_add(checked_add(debt_total, close_fee)?, liquidation_reward)?;
            let equity = signed_equity(
                checked_add(p.collateral_usdc, estimated_usdc_out)?,
                obligations,
            )?;
            (price, equity, estimated_usdc_out)
        }
        Side::Short => {
            let estimated_usdc_in = estimate_exact_out(
                env,
                &market,
                market.usdc_index,
                market.asset_index,
                debt_total,
            )?;
            let price =
                effective_price_from_exact_in(estimated_usdc_in, debt_total, market.asset_scale)?;
            let close_fee = bps(p.held_amount, cfg.close_fee_bps)?;
            let obligations = checked_add(
                checked_add(estimated_usdc_in, close_fee)?,
                liquidation_reward,
            )?;
            let equity =
                signed_equity(checked_add(p.collateral_usdc, p.held_amount)?, obligations)?;
            (price, equity, p.held_amount)
        }
    };

    let entry_notional_usdc = match p.side {
        Side::Long => p.borrowed_amount,
        Side::Short => value_asset_usdc(p.borrowed_amount, p.entry_price, &market)?,
    };

    let equity_ratio_bps = if p.collateral_usdc == 0 {
        0
    } else {
        mul_div(executable_equity, BPS, p.collateral_usdc)?
    };

    let margin_ratio_bps = if entry_notional_usdc == 0 {
        0
    } else {
        mul_div(executable_equity, BPS, entry_notional_usdc)?
    };

    let liquidatable = margin_ratio_bps <= market.maintenance_margin_bps as i128;
    let actionable = liquidatable
        || equity_ratio_bps <= market.closeness_equity_bps as i128
        || close_notional_usdc <= 0;

    Ok(PositionRisk {
        id: p.id,
        executable_price,
        executable_equity_usdc: executable_equity,
        equity_ratio_bps,
        margin_ratio_bps,
        liquidatable,
        actionable,
    })
}

fn preview_position_at(env: &Env, p: &Position) -> Result<PositionPreview, Error> {
    if p.status != PositionStatus::Open {
        return Err(Error::PositionNotOpen);
    }
    let cfg = global_config(env)?;
    let market = market_config(env, &p.asset)?;
    ensure_pool_operational(env, &market)?;

    let borrowed_asset = borrowed_asset_for_side(&cfg, p);
    let debt_pool = projected_pool(env, &borrowed_asset)?;
    let debt_total = position_debt(&debt_pool, p.borrow_scaled)?;
    let accrued_borrow_fee_asset = checked_sub(debt_total, p.borrowed_amount)?;
    let rate_cfg = rate_config(env, &borrowed_asset)?;
    let utilization = utilization_bps(&debt_pool)?;
    let current_apr = borrow_apr_bps_for_utilization(utilization, &rate_cfg)?;

    let risk = risk_at(env, p)?;
    let (gross_pnl_usdc, accrued_borrow_fee_usdc, close_notional, payout_before_close_fee) =
        match p.side {
            Side::Long => {
                let estimated_out = estimate_exact_in(
                    env,
                    &market,
                    market.asset_index,
                    market.usdc_index,
                    p.held_amount,
                )?;
                let gross_pnl = signed_equity(estimated_out, p.borrowed_amount)?;
                let borrow_fee_usdc = accrued_borrow_fee_asset;
                let before_fee =
                    signed_equity(checked_add(p.collateral_usdc, estimated_out)?, debt_total)?;
                (gross_pnl, borrow_fee_usdc, estimated_out, before_fee)
            }
            Side::Short => {
                let principal_buyback = estimate_exact_out(
                    env,
                    &market,
                    market.usdc_index,
                    market.asset_index,
                    p.borrowed_amount,
                )?;
                let total_buyback = estimate_exact_out(
                    env,
                    &market,
                    market.usdc_index,
                    market.asset_index,
                    debt_total,
                )?;
                let gross_pnl = signed_equity(p.held_amount, principal_buyback)?;
                let borrow_fee_usdc = checked_sub(total_buyback, principal_buyback)?;
                let before_fee = signed_equity(
                    checked_add(p.collateral_usdc, p.held_amount)?,
                    total_buyback,
                )?;
                (gross_pnl, borrow_fee_usdc, p.held_amount, before_fee)
            }
        };

    let estimated_close_fee = bps(close_notional, cfg.close_fee_bps)?;
    let estimated_manual_payout =
        non_negative(signed_equity(payout_before_close_fee, estimated_close_fee)?);
    let net_pnl = signed_equity(estimated_manual_payout, p.initial_collateral_usdc)?;
    let total_fees = checked_add(
        checked_add(p.open_fee_paid_usdc, accrued_borrow_fee_usdc)?,
        estimated_close_fee,
    )?;

    Ok(PositionPreview {
        id: p.id,
        owner: p.owner.clone(),
        asset: p.asset.clone(),
        side: p.side.clone(),
        status: p.status.clone(),
        initial_collateral_usdc: p.initial_collateral_usdc,
        collateral_usdc: p.collateral_usdc,
        open_fee_paid_usdc: p.open_fee_paid_usdc,
        borrowed_principal: p.borrowed_amount,
        current_debt: debt_total,
        accrued_borrow_fee_asset,
        accrued_borrow_fee_usdc,
        held_amount: p.held_amount,
        entry_price: p.entry_price,
        executable_price: risk.executable_price,
        gross_pnl_usdc,
        estimated_close_fee_usdc: estimated_close_fee,
        total_estimated_fees_usdc: total_fees,
        estimated_manual_payout_usdc: estimated_manual_payout,
        net_pnl_usdc: net_pnl,
        equity_ratio_bps: risk.equity_ratio_bps,
        margin_ratio_bps: risk.margin_ratio_bps,
        current_borrow_apr_bps: current_apr,
        liquidatable: risk.liquidatable,
        actionable: risk.actionable,
        action_queued: p.action_queued,
    })
}

fn borrowed_asset_for_side(cfg: &GlobalConfig, p: &Position) -> Address {
    match p.side {
        Side::Long => cfg.usdc.clone(),
        Side::Short => p.asset.clone(),
    }
}

fn scaled_borrow_amount(amount: i128, borrow_index: i128) -> Result<i128, Error> {
    require_positive(amount)?;
    require_positive(borrow_index)?;
    mul_div_round_up(amount, INDEX_SCALE, borrow_index)
}

fn position_debt(pool: &PoolState, borrow_scaled: i128) -> Result<i128, Error> {
    if borrow_scaled <= 0 {
        return Err(Error::InvalidAmount);
    }
    mul_div(borrow_scaled, pool.borrow_index, INDEX_SCALE)
}

fn rate_config(env: &Env, asset: &Address) -> Result<InterestRateConfig, Error> {
    env.storage()
        .persistent()
        .get(&DataKey::RateConfig(asset.clone()))
        .ok_or(Error::RateConfigNotFound)
}

fn default_interest_rate_config() -> InterestRateConfig {
    InterestRateConfig {
        base_apr_bps: 500,
        optimal_utilization_bps: 7_500,
        slope_before_kink_bps: 3_500,
        slope_after_kink_bps: 26_000,
        max_utilization_bps: 8_500,
        reserve_factor_bps: 1_000,
    }
}

fn validate_interest_rate_config(rate: &InterestRateConfig) -> Result<(), Error> {
    if rate.optimal_utilization_bps == 0
        || rate.optimal_utilization_bps >= 10_000
        || rate.max_utilization_bps <= rate.optimal_utilization_bps
        || rate.max_utilization_bps > 10_000
        || rate.reserve_factor_bps > 5_000
        || rate.base_apr_bps > 10_000
        || rate.slope_before_kink_bps > 50_000
        || rate.slope_after_kink_bps > 100_000
    {
        return Err(Error::InvalidAmount);
    }
    Ok(())
}

fn utilization_bps(pool: &PoolState) -> Result<i128, Error> {
    if pool.total_assets <= 0 || pool.total_borrowed <= 0 {
        return Ok(0);
    }
    mul_div(pool.total_borrowed, BPS, pool.total_assets)
}

fn borrow_apr_bps_for_utilization(
    utilization: i128,
    rate: &InterestRateConfig,
) -> Result<i128, Error> {
    let u = if utilization < 0 {
        0
    } else if utilization > BPS {
        BPS
    } else {
        utilization
    };
    let optimal = rate.optimal_utilization_bps as i128;
    if u <= optimal {
        let variable = mul_div(u, rate.slope_before_kink_bps as i128, optimal)?;
        checked_add(rate.base_apr_bps as i128, variable)
    } else {
        let excess = checked_sub(u, optimal)?;
        let post_range = checked_sub(BPS, optimal)?;
        let post = mul_div(excess, rate.slope_after_kink_bps as i128, post_range)?;
        checked_add(
            checked_add(
                rate.base_apr_bps as i128,
                rate.slope_before_kink_bps as i128,
            )?,
            post,
        )
    }
}

fn project_pool_to_timestamp(
    pool: &PoolState,
    rate: &InterestRateConfig,
    timestamp: u64,
) -> Result<PoolState, Error> {
    let mut projected = pool.clone();
    let elapsed = timestamp.saturating_sub(pool.last_accrual_timestamp) as i128;
    if elapsed == 0 || pool.total_borrowed <= 0 {
        projected.last_accrual_timestamp = timestamp;
        return Ok(projected);
    }

    let utilization = utilization_bps(pool)?;
    let apr_bps = borrow_apr_bps_for_utilization(utilization, rate)?;
    let interest = mul_div(
        mul_div(pool.total_borrowed, apr_bps, BPS)?,
        elapsed,
        YEAR_SECS,
    )?;
    if interest <= 0 {
        projected.last_accrual_timestamp = timestamp;
        return Ok(projected);
    }

    let reserve_interest = bps(interest, rate.reserve_factor_bps)?;
    let lp_interest = checked_sub(interest, reserve_interest)?;
    let index_growth = mul_div(pool.borrow_index, interest, pool.total_borrowed)?;

    projected.total_borrowed = checked_add(projected.total_borrowed, interest)?;
    projected.total_assets = checked_add(projected.total_assets, lp_interest)?;
    projected.accrued_interest = checked_add(projected.accrued_interest, interest)?;
    projected.reserves = checked_add(projected.reserves, reserve_interest)?;
    projected.borrow_index = checked_add(projected.borrow_index, index_growth)?;
    projected.last_accrual_timestamp = timestamp;
    Ok(projected)
}

fn projected_pool(env: &Env, asset: &Address) -> Result<PoolState, Error> {
    let pool = pool_for(env, asset);
    let rate = rate_config(env, asset)?;
    project_pool_to_timestamp(&pool, &rate, env.ledger().timestamp())
}

fn accrue_pool(env: &Env, asset: &Address) -> Result<PoolState, Error> {
    let projected = projected_pool(env, asset)?;
    set_pool(env, asset, &projected);
    Ok(projected)
}

fn available_liquidity(pool: &PoolState) -> Result<i128, Error> {
    checked_sub(pool.total_assets, pool.total_borrowed)
}

fn ensure_borrow_capacity(
    env: &Env,
    asset: &Address,
    pool: &PoolState,
    requested: i128,
) -> Result<(), Error> {
    require_positive(requested)?;
    if available_liquidity(pool)? < requested {
        return Err(Error::InsufficientLiquidity);
    }
    let rate = rate_config(env, asset)?;
    let projected_debt = checked_add(pool.total_borrowed, requested)?;
    let projected_utilization = if pool.total_assets <= 0 {
        BPS
    } else {
        mul_div(projected_debt, BPS, pool.total_assets)?
    };
    if projected_utilization > rate.max_utilization_bps as i128 {
        return Err(Error::MaxUtilizationExceeded);
    }
    Ok(())
}

fn estimate_exact_in(
    env: &Env,
    market: &MarketConfig,
    in_idx: u32,
    out_idx: u32,
    amount: i128,
) -> Result<i128, Error> {
    require_positive(amount)?;
    let result = AquariusPoolClient::new(env, &market.aquarius_pool).estimate_swap(
        &in_idx,
        &out_idx,
        &(amount as u128),
    ) as i128;
    require_positive(result)?;
    Ok(result)
}

fn estimate_exact_out(
    env: &Env,
    market: &MarketConfig,
    in_idx: u32,
    out_idx: u32,
    amount: i128,
) -> Result<i128, Error> {
    require_positive(amount)?;
    let result = AquariusPoolClient::new(env, &market.aquarius_pool).estimate_swap_strict_receive(
        &in_idx,
        &out_idx,
        &(amount as u128),
    ) as i128;
    require_positive(result)?;
    Ok(result)
}

#[allow(clippy::too_many_arguments)]
fn swap_exact_in(
    env: &Env,
    market: &MarketConfig,
    in_idx: u32,
    out_idx: u32,
    amount: i128,
    min_out: i128,
    input_asset: &Address,
    output_asset: &Address,
) -> Result<i128, Error> {
    require_positive(amount)?;
    require_positive(min_out)?;
    let contract = env.current_contract_address();
    let input_before = token::Client::new(env, input_asset).balance(&contract);
    let output_before = token::Client::new(env, output_asset).balance(&contract);
    let reported = AquariusPoolClient::new(env, &market.aquarius_pool).swap(
        &contract,
        &in_idx,
        &out_idx,
        &(amount as u128),
        &(min_out as u128),
    ) as i128;
    let input_after = token::Client::new(env, input_asset).balance(&contract);
    let output_after = token::Client::new(env, output_asset).balance(&contract);
    let spent = checked_sub(input_before, input_after)?;
    let received = checked_sub(output_after, output_before)?;
    if spent != amount || received != reported || received < min_out {
        return Err(Error::SwapAccountingMismatch);
    }
    Ok(received)
}

#[allow(clippy::too_many_arguments)]
fn swap_exact_out(
    env: &Env,
    market: &MarketConfig,
    in_idx: u32,
    out_idx: u32,
    out_amount: i128,
    max_in: i128,
    input_asset: &Address,
    output_asset: &Address,
) -> Result<i128, Error> {
    require_positive(out_amount)?;
    require_positive(max_in)?;
    let contract = env.current_contract_address();
    let input_before = token::Client::new(env, input_asset).balance(&contract);
    let output_before = token::Client::new(env, output_asset).balance(&contract);
    let reported = AquariusPoolClient::new(env, &market.aquarius_pool).swap_strict_receive(
        &contract,
        &in_idx,
        &out_idx,
        &(out_amount as u128),
        &(max_in as u128),
    ) as i128;
    let input_after = token::Client::new(env, input_asset).balance(&contract);
    let output_after = token::Client::new(env, output_asset).balance(&contract);
    let spent = checked_sub(input_before, input_after)?;
    let received = checked_sub(output_after, output_before)?;
    if spent != reported || spent > max_in || received != out_amount {
        return Err(Error::SwapAccountingMismatch);
    }
    Ok(spent)
}

fn ensure_pool_operational(env: &Env, market: &MarketConfig) -> Result<(), Error> {
    let client = AquariusPoolClient::new(env, &market.aquarius_pool);
    if client.get_is_killed_swap() {
        return Err(Error::PoolSwapDisabled);
    }
    if client.get_emergency_mode() {
        return Err(Error::PoolEmergencyMode);
    }
    Ok(())
}

fn validate_market(env: &Env, cfg: &GlobalConfig, market: &MarketConfig) -> Result<(), Error> {
    if market.asset == cfg.usdc
        || market.usdc_index == market.asset_index
        || market.asset_scale <= 0
        || market.max_leverage_bps < 10_000
        || market.max_leverage_bps > 100_000
        || market.maintenance_margin_bps == 0
        || market.maintenance_margin_bps >= 5_000
        || market.closeness_equity_bps <= market.maintenance_margin_bps
        || market.normal_slippage_bps > 2_000
        || market.trigger_slippage_bps > 3_000
        || market.liquidation_slippage_bps > 5_000
        || market.max_position_notional_usdc <= 0
    {
        return Err(Error::InvalidAmount);
    }
    let tokens = AquariusPoolClient::new(env, &market.aquarius_pool).get_tokens();
    if market.usdc_index >= tokens.len() || market.asset_index >= tokens.len() {
        return Err(Error::InvalidPool);
    }
    if tokens.get_unchecked(market.usdc_index) != cfg.usdc
        || tokens.get_unchecked(market.asset_index) != market.asset
    {
        return Err(Error::InvalidPool);
    }
    Ok(())
}

fn validate_global_config(c: &GlobalConfig) -> Result<(), Error> {
    if c.open_fee_bps > 1_000
        || c.close_fee_bps > 1_000
        || c.liquidation_reward_bps > 2_000
        || c.trigger_fee_bps > 1_000
        || c.trigger_keeper_share_bps > 10_000
    {
        return Err(Error::InvalidAmount);
    }
    Ok(())
}

fn validate_open(market: &MarketConfig, collateral: i128, leverage_bps: u32) -> Result<(), Error> {
    require_positive(collateral)?;
    if leverage_bps < 10_000 || leverage_bps > market.max_leverage_bps {
        return Err(Error::InvalidLeverage);
    }
    Ok(())
}

fn global_config(env: &Env) -> Result<GlobalConfig, Error> {
    env.storage()
        .instance()
        .get(&DataKey::GlobalConfig)
        .ok_or(Error::NotInitialized)
}

fn active_global_config(env: &Env) -> Result<GlobalConfig, Error> {
    let cfg = global_config(env)?;
    if cfg.paused {
        Err(Error::Paused)
    } else {
        Ok(cfg)
    }
}

fn market_config(env: &Env, asset: &Address) -> Result<MarketConfig, Error> {
    env.storage()
        .persistent()
        .get(&DataKey::Market(asset.clone()))
        .ok_or(Error::MarketNotFound)
}

fn active_market(env: &Env, asset: &Address) -> Result<MarketConfig, Error> {
    let market = market_config(env, asset)?;
    if market.enabled {
        Ok(market)
    } else {
        Err(Error::MarketDisabled)
    }
}

fn ensure_supported_pool_asset(
    env: &Env,
    cfg: &GlobalConfig,
    asset: &Address,
) -> Result<(), Error> {
    if asset == &cfg.usdc {
        return Ok(());
    }
    let _ = market_config(env, asset)?;
    Ok(())
}

fn pool_for(env: &Env, asset: &Address) -> PoolState {
    env.storage()
        .instance()
        .get(&DataKey::Pool(asset.clone()))
        .unwrap_or(empty_pool(env.ledger().timestamp()))
}

fn set_pool(env: &Env, asset: &Address, pool: &PoolState) {
    env.storage()
        .instance()
        .set(&DataKey::Pool(asset.clone()), pool);
}

fn empty_pool(timestamp: u64) -> PoolState {
    PoolState {
        total_assets: 0,
        total_shares: 0,
        total_borrowed: 0,
        accrued_interest: 0,
        reserves: 0,
        borrow_index: INDEX_SCALE,
        last_accrual_timestamp: timestamp,
    }
}

fn save_position(env: &Env, p: &Position) {
    env.storage().persistent().set(&DataKey::Position(p.id), p);
}

fn load_position(env: &Env, id: u64) -> Result<Position, Error> {
    env.storage()
        .persistent()
        .get(&DataKey::Position(id))
        .ok_or(Error::PositionNotFound)
}

fn next_id(env: &Env) -> Result<u64, Error> {
    let id: u64 = env
        .storage()
        .instance()
        .get(&DataKey::NextPositionId)
        .unwrap_or(1);
    env.storage().instance().set(
        &DataKey::NextPositionId,
        &id.checked_add(1).ok_or(Error::Arithmetic)?,
    );
    env.storage().instance().set(&DataKey::PositionCount, &id);
    Ok(id)
}

fn value_asset_usdc(amount: i128, price: i128, market: &MarketConfig) -> Result<i128, Error> {
    // price is USDC base units per one whole asset.
    // amount is in asset base units, scaled by asset_scale.
    let whole_asset_value = mul_div(amount, price, market.asset_scale)?;
    mul_div(whole_asset_value, BPS, BPS)
}

fn stop_reached(p: &Position, price: i128) -> bool {
    p.stop_loss_price > 0
        && match p.side {
            Side::Long => price <= p.stop_loss_price,
            Side::Short => price >= p.stop_loss_price,
        }
}

fn take_reached(p: &Position, price: i128) -> bool {
    p.take_profit_price > 0
        && match p.side {
            Side::Long => price >= p.take_profit_price,
            Side::Short => price <= p.take_profit_price,
        }
}

fn effective_price_from_exact_in(
    usdc_amount: i128,
    asset_amount: i128,
    asset_scale: i128,
) -> Result<i128, Error> {
    require_positive(usdc_amount)?;
    require_positive(asset_amount)?;
    require_positive(asset_scale)?;
    mul_div(usdc_amount, asset_scale, asset_amount)
}

/// Returns assets minus obligations and preserves a negative result so risk
/// calculations can detect insolvency. Arithmetic overflow still returns Error.
fn signed_equity(assets: i128, obligations: i128) -> Result<i128, Error> {
    checked_sub(assets, obligations)
}

fn apply_negative_bps(value: i128, bps_value: u32) -> Result<i128, Error> {
    checked_sub(value, bps(value, bps_value)?)
}

fn apply_positive_bps(value: i128, bps_value: u32) -> Result<i128, Error> {
    checked_add(value, bps(value, bps_value)?)
}

fn require_positive(v: i128) -> Result<(), Error> {
    if v <= 0 {
        Err(Error::InvalidAmount)
    } else {
        Ok(())
    }
}

fn non_negative(v: i128) -> i128 {
    if v < 0 {
        0
    } else {
        v
    }
}

fn bps(v: i128, b: u32) -> Result<i128, Error> {
    mul_div(v, b as i128, BPS)
}

fn mul_div(a: i128, b: i128, d: i128) -> Result<i128, Error> {
    if d == 0 {
        return Err(Error::Arithmetic);
    }
    a.checked_mul(b)
        .and_then(|v| v.checked_div(d))
        .ok_or(Error::Arithmetic)
}

fn mul_div_round_up(a: i128, b: i128, d: i128) -> Result<i128, Error> {
    if d <= 0 || a < 0 || b < 0 {
        return Err(Error::Arithmetic);
    }
    let product = a.checked_mul(b).ok_or(Error::Arithmetic)?;
    let quotient = product.checked_div(d).ok_or(Error::Arithmetic)?;
    let remainder = product.checked_rem(d).ok_or(Error::Arithmetic)?;
    if remainder == 0 {
        Ok(quotient)
    } else {
        checked_add(quotient, 1)
    }
}

fn checked_add(a: i128, b: i128) -> Result<i128, Error> {
    a.checked_add(b).ok_or(Error::Arithmetic)
}

fn checked_sub(a: i128, b: i128) -> Result<i128, Error> {
    a.checked_sub(b).ok_or(Error::Arithmetic)
}

#[cfg(test)]
mod test;
