import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  Activity,
  ArrowDownToLine,
  ArrowUpFromLine,
  BarChart3,
  ChevronDown,
  Coins,
  ExternalLink,
  Gauge,
  HandCoins,
  Loader2,
  Menu,
  RefreshCw,
  ShieldCheck,
  Wallet,
  X,
} from "lucide-react";
import { config, type MarketDefinition } from "./lib/config";
import { bps, fromBaseUnits, short, toBaseUnits } from "./lib/format";
import {
  connectWallet,
  invokeContract,
  readContract,
  restoreWallet,
  sc,
  safeRead,
} from "./lib/stellar";

type Tab = "dashboard" | "trade" | "pool" | "positions" | "keeper" | "wallet";
type AnyMap = Record<string, any>;
type Toast = { type: "ok" | "error"; text: string } | null;
type RunTransaction = (label: string, fn: () => Promise<any>) => Promise<void>;

type PoolAsset = {
  symbol: string;
  name: string;
  asset: string;
  decimals: number;
};

type LpPositionView = {
  shares: bigint;
  assetValue: bigint;
  immediatelyWithdrawable: bigint;
  ownershipBps: bigint;
};

type PoolView = {
  def: PoolAsset;
  pool: AnyMap | null;
  rateConfig: AnyMap | null;
  utilizationBps: bigint;
  borrowAprBps: bigint;
  supplyAprBps: bigint;
  availableLiquidity: bigint;
  user: LpPositionView | null;
};

type WalletBalance = {
  def: PoolAsset;
  balance: bigint | null;
};

type KeeperPositionView = {
  position: AnyMap;
  risk: AnyMap;
  preview: AnyMap | null;
  market: MarketDefinition | null;
  estimatedRewardUsdc: bigint;
};

type KeeperStateView = {
  inspected: bigint;
  openPositions: bigint;
  actionablePositions: bigint;
  liquidatablePositions: bigint;
};

const BPS_SCALE = 10_000n;
const XLM_FEE_RESERVE = 10_000_000n; // 1 XLM at 7 decimals.
const ROUTES: Record<Tab, string> = {
  dashboard: "/dashboard",
  trade: "/trade",
  pool: "/liquidity",
  positions: "/positions",
  keeper: "/keeper",
  wallet: "/wallet",
};

function asBigInt(value: unknown, fallback = 0n): bigint {
  try {
    if (value === null || value === undefined || value === "") return fallback;
    return BigInt(value as any);
  } catch {
    return fallback;
  }
}

function parseHumanAmount(value: string, decimals: number): bigint {
  const normalized = value.trim();
  if (!normalized) return 0n;
  return asBigInt(toBaseUnits(normalized, decimals));
}

function formatHumanAmount(
  value: unknown,
  decimals = 7,
  maximumFractionDigits = 4
): string {
  const raw = fromBaseUnits(asBigInt(value), decimals);
  const numeric = Number(raw);
  if (!Number.isFinite(numeric)) return raw;
  return new Intl.NumberFormat(undefined, {
    maximumFractionDigits,
    minimumFractionDigits: 0,
  }).format(numeric);
}

function formatInputAmount(value: unknown, decimals = 7): string {
  return fromBaseUnits(asBigInt(value), decimals).replace(/,/g, "");
}

function formatPercentBps(value: unknown): string {
  const raw = asBigInt(value);
  const sign = raw < 0n ? "-" : "";
  const absolute = raw < 0n ? -raw : raw;
  return `${sign}${absolute / 100n}.${(absolute % 100n)
    .toString()
    .padStart(2, "0")}%`;
}

function calculateBorrowAprBps(
  utilizationBps: bigint,
  rate: AnyMap | null
): bigint {
  if (!rate) return 0n;
  const base = asBigInt(rate.base_apr_bps);
  const optimal = asBigInt(rate.optimal_utilization_bps);
  const before = asBigInt(rate.slope_before_kink_bps);
  const after = asBigInt(rate.slope_after_kink_bps);
  if (optimal <= 0n || optimal >= BPS_SCALE) return 0n;
  const u =
    utilizationBps < 0n
      ? 0n
      : utilizationBps > BPS_SCALE
      ? BPS_SCALE
      : utilizationBps;
  if (u <= optimal) return base + (u * before) / optimal;
  return base + before + ((u - optimal) * after) / (BPS_SCALE - optimal);
}

function calculateSupplyAprBps(
  borrowAprBps: bigint,
  utilizationBps: bigint,
  reserveFactorBps: bigint
): bigint {
  const lenderShare =
    reserveFactorBps >= BPS_SCALE ? 0n : BPS_SCALE - reserveFactorBps;
  return (
    (borrowAprBps * utilizationBps * lenderShare) / (BPS_SCALE * BPS_SCALE)
  );
}

function tabFromLocation(): Tab {
  if (typeof window === "undefined") return "dashboard";
  const path = window.location.pathname.replace(/\/$/, "") || "/dashboard";
  return (
    (Object.entries(ROUTES).find(([, route]) => route === path)?.[0] as Tab) ??
    "dashboard"
  );
}

function App() {
  const [address, setAddress] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>(() => tabFromLocation());
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [toast, setToast] = useState<Toast>(null);
  const [protocol, setProtocol] = useState<AnyMap | null>(null);
  const [markets, setMarkets] = useState<
    Array<{
      def: MarketDefinition;
      cfg: AnyMap | null;
      pool: AnyMap | null;
      longRate: AnyMap | null;
      shortRate: AnyMap | null;
    }>
  >([]);
  const [positions, setPositions] = useState<AnyMap[]>([]);
  const [keeperState, setKeeperState] = useState<KeeperStateView | null>(null);
  const [keeperPositions, setKeeperPositions] = useState<KeeperPositionView[]>(
    []
  );
  const [pools, setPools] = useState<PoolView[]>([]);
  const [walletBalances, setWalletBalances] = useState<WalletBalance[]>([]);

  const poolAssets = useMemo<PoolAsset[]>(() => {
    const out: PoolAsset[] = [];
    if (config.usdcId) {
      out.push({
        symbol: "USDC",
        name: "USD Coin",
        asset: config.usdcId,
        decimals: 7,
      });
    }
    for (const market of config.markets) {
      if (!out.some((item) => item.asset === market.asset)) {
        out.push({
          symbol: market.symbol,
          name: market.name,
          asset: market.asset,
          decimals: market.decimals,
        });
      }
    }
    return out;
  }, []);

  const notify = (type: "ok" | "error", text: string) => {
    setToast({ type, text });
    window.setTimeout(() => setToast(null), 6000);
  };

  const navigate = (next: Tab) => {
    setTab(next);
    setSidebarOpen(false);
    window.history.pushState({ tab: next }, "", ROUTES[next]);
  };

  const loadLpPosition = async (
    owner: string,
    def: PoolAsset,
    pool: AnyMap | null
  ): Promise<LpPositionView> => {
    const typed = (await safeRead(() =>
      readContract(
        config.protocolId,
        "get_lp_position",
        [sc.address(owner), sc.address(def.asset)],
        owner
      )
    )) as AnyMap | null;

    if (typed) {
      const shares = asBigInt(typed.shares);
      const totalShares = asBigInt(pool?.total_shares);
      return {
        shares,
        assetValue: asBigInt(typed.asset_value),
        immediatelyWithdrawable: asBigInt(typed.immediately_withdrawable),
        ownershipBps:
          shares > 0n && totalShares > 0n
            ? (shares * BPS_SCALE) / totalShares
            : 0n,
      };
    }

    const rawShares = await safeRead(() =>
      readContract(
        config.protocolId,
        "get_lp_shares",
        [sc.address(owner), sc.address(def.asset)],
        owner
      )
    );

    const shares = asBigInt(rawShares);
    const totalShares = asBigInt(pool?.total_shares);
    const totalAssets = asBigInt(pool?.total_assets);
    const totalBorrowed = asBigInt(pool?.total_borrowed);
    const available =
      totalAssets > totalBorrowed ? totalAssets - totalBorrowed : 0n;

    return {
      shares,
      assetValue:
        shares > 0n && totalShares > 0n
          ? (shares * totalAssets) / totalShares
          : 0n,
      immediatelyWithdrawable:
        shares > 0n && totalShares > 0n
          ? (shares * available) / totalShares
          : 0n,
      ownershipBps:
        shares > 0n && totalShares > 0n
          ? (shares * BPS_SCALE) / totalShares
          : 0n,
    };
  };

  const loadPositions = async (owner: string | null) => {
    if (!owner) {
      setPositions([]);
      return;
    }
    const found: AnyMap[] = [];
    let misses = 0;
    for (let id = 1; id <= config.scanLimit && misses < 5; id++) {
      const position = await safeRead(() =>
        readContract(config.protocolId, "get_position", [sc.u64(id)], owner)
      );
      if (!position) {
        misses++;
        continue;
      }
      misses = 0;
      const p = position as AnyMap;
      if (String(p.owner ?? "") === owner) {
        const preview =
          p.status === "Open" || p.status?.[0] === "Open"
            ? await safeRead(() =>
                readContract(
                  config.protocolId,
                  "preview_position",
                  [sc.u64(id)],
                  owner
                )
              )
            : null;
        found.push({ ...p, preview });
      }
    }
    setPositions(found);
  };

  const loadKeeperDashboard = async (globalConfig: AnyMap | null) => {
    const rawState = (await safeRead(() =>
      readContract(config.protocolId, "get_position_states")
    )) as AnyMap | null;

    setKeeperState(
      rawState
        ? {
            inspected: asBigInt(rawState.inspected),
            openPositions: asBigInt(rawState.open_positions),
            actionablePositions: asBigInt(rawState.actionable_positions),
            liquidatablePositions: asBigInt(rawState.liquidatable_positions),
          }
        : null
    );

    const liquidationRewardBps = asBigInt(globalConfig?.liquidation_reward_bps);
    const found: KeeperPositionView[] = [];
    let consecutiveMisses = 0;

    for (let id = 1; id <= config.scanLimit && consecutiveMisses < 5; id++) {
      const position = (await safeRead(() =>
        readContract(config.protocolId, "get_position", [sc.u64(id)])
      )) as AnyMap | null;

      if (!position) {
        consecutiveMisses += 1;
        continue;
      }

      consecutiveMisses = 0;
      const open = String(position.status).includes("Open");
      if (!open) continue;

      const risk = (await safeRead(() =>
        readContract(config.protocolId, "get_risk", [sc.u64(id)])
      )) as AnyMap | null;

      if (!risk || (!risk.actionable && !risk.liquidatable)) continue;

      const preview = (await safeRead(() =>
        readContract(config.protocolId, "preview_position", [sc.u64(id)])
      )) as AnyMap | null;

      const collateral = asBigInt(position.collateral_usdc);
      const estimatedRewardUsdc =
        liquidationRewardBps > 0n
          ? (collateral * liquidationRewardBps) / BPS_SCALE
          : 0n;

      found.push({
        position,
        risk,
        preview,
        market:
          config.markets.find(
            (market) => market.asset === String(position.asset ?? "")
          ) ?? null,
        estimatedRewardUsdc,
      });
    }

    found.sort((a, b) => {
      const aLiquidatable = Boolean(a.risk.liquidatable);
      const bLiquidatable = Boolean(b.risk.liquidatable);
      if (aLiquidatable !== bLiquidatable) return aLiquidatable ? -1 : 1;
      const aMargin = asBigInt(a.risk.margin_ratio_bps);
      const bMargin = asBigInt(b.risk.margin_ratio_bps);
      return aMargin < bMargin ? -1 : aMargin > bMargin ? 1 : 0;
    });

    setKeeperPositions(found);
  };

  const refresh = async () => {
    setLoading(true);
    try {
      const p = await safeRead(() =>
        readContract(config.protocolId, "get_global_config")
      );
      setProtocol(p as AnyMap | null);
      await loadKeeperDashboard(p as AnyMap | null);

      const loaded = await Promise.all(
        config.markets.map(async (def) => ({
          def,
          cfg: (await safeRead(() =>
            readContract(config.protocolId, "get_market", [
              sc.address(def.asset),
            ])
          )) as AnyMap | null,
          pool: (await safeRead(() =>
            readContract(config.protocolId, "get_pool", [sc.address(def.asset)])
          )) as AnyMap | null,
          longRate: (await safeRead(() =>
            readContract(config.protocolId, "get_borrow_rate", [
              sc.address(def.asset),
              sc.side("Long"),
            ])
          )) as AnyMap | null,
          shortRate: (await safeRead(() =>
            readContract(config.protocolId, "get_borrow_rate", [
              sc.address(def.asset),
              sc.side("Short"),
            ])
          )) as AnyMap | null,
        }))
      );
      setMarkets(loaded);

      const loadedPools: PoolView[] = await Promise.all(
        poolAssets.map(async (def) => {
          const pool = (await safeRead(() =>
            readContract(config.protocolId, "get_pool", [sc.address(def.asset)])
          )) as AnyMap | null;
          const rateConfig = (await safeRead(() =>
            readContract(config.protocolId, "get_interest_rate_config", [
              sc.address(def.asset),
            ])
          )) as AnyMap | null;
          const totalAssets = asBigInt(pool?.total_assets);
          const totalBorrowed = asBigInt(pool?.total_borrowed);
          const utilizationBps =
            totalAssets > 0n ? (totalBorrowed * BPS_SCALE) / totalAssets : 0n;
          const borrowAprBps = calculateBorrowAprBps(
            utilizationBps,
            rateConfig
          );
          const supplyAprBps = calculateSupplyAprBps(
            borrowAprBps,
            utilizationBps,
            asBigInt(rateConfig?.reserve_factor_bps)
          );
          return {
            def,
            pool,
            rateConfig,
            utilizationBps,
            borrowAprBps,
            supplyAprBps,
            availableLiquidity:
              totalAssets > totalBorrowed ? totalAssets - totalBorrowed : 0n,
            user: address ? await loadLpPosition(address, def, pool) : null,
          };
        })
      );
      setPools(loadedPools);

      if (address) {
        const balances: WalletBalance[] = await Promise.all(
          poolAssets.map(async (def) => {
            const value = await safeRead(() =>
              readContract(def.asset, "balance", [sc.address(address)], address)
            );
            return {
              def,
              balance: value === null ? null : asBigInt(value),
            };
          })
        );
        setWalletBalances(balances);
      } else {
        setWalletBalances([]);
      }

      await loadPositions(address);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    restoreWallet().then(setAddress);
  }, []);

  useEffect(() => {
    const onPopState = () => setTab(tabFromLocation());
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  useEffect(() => {
    void refresh();
  }, [address]);

  const transact: RunTransaction = async (label, fn) => {
    setLoading(true);
    try {
      const out = await fn();
      notify(
        "ok",
        `${label} confirmed${out?.hash ? ` · ${short(out.hash, 8, 8)}` : ""}`
      );
      await refresh();
    } catch (error) {
      notify("error", error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  };

  const nav: Array<[Tab, string, any]> = [
    ["dashboard", "Overview", BarChart3],
    ["trade", "Trade", Activity],
    ["pool", "Liquidity", Coins],
    ["positions", "Positions", Gauge],
    ["keeper", "Keeper", HandCoins],
    ["wallet", "Wallet", Wallet],
  ];
  const titles: Record<Tab, string> = {
    dashboard: "Protocol Overview",
    trade: "Open Leveraged Trade (Position)",
    pool: "Supply or Withdraw Liquidity",
    positions: "Manage Open Positions",
    keeper: "Liquidation Keeper Dashboard",
    wallet: "Wallet Balances and Transfers",
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      {toast && (
        <div
          className={`fixed right-5 top-5 z-[70] max-w-md rounded-xl border px-4 py-3 shadow-xl ${
            toast.type === "ok"
              ? "border-emerald-400/30 bg-emerald-950"
              : "border-rose-400/30 bg-rose-950"
          }`}
        >
          {toast.text}
        </div>
      )}

      {sidebarOpen && (
        <button
          aria-label="Close navigation"
          className="fixed inset-0 z-40 bg-black/60 lg:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      <aside
        className={`fixed inset-y-0 left-0 z-50 flex w-72 flex-col border-r border-white/10 bg-slate-950/95 p-4 backdrop-blur-xl transition-transform lg:translate-x-0 ${
          sidebarOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div className="flex items-center justify-between px-2 py-2">
          <div>
            <div className="flex items-center gap-2 text-xl font-black">
              <svg
                className="h-9 w-9"
                viewBox="0 0 340 340"
                fill="none"
                xmlns="http://www.w3.org/2000/svg"
              >
                <path
                  d="M244.618 146.529C248.587 147.852 248.859 149.316 250.77 152.979C251.376 154.125 251.981 155.272 252.605 156.453C253.255 157.708 253.905 158.962 254.556 160.217C255.231 161.504 255.908 162.79 256.587 164.076C257.617 166.03 258.646 167.984 259.672 169.94C262.605 175.529 265.631 181.065 268.681 186.592C273.818 195.945 278.721 205.413 283.605 214.9C287.402 222.252 291.351 229.482 295.467 236.659C297.551 240.356 299.443 244.129 301.309 247.939C304.146 253.674 307.092 259.334 310.153 264.951C310.526 265.639 310.9 266.327 311.284 267.035C312.806 269.839 314.329 272.642 315.87 275.435C317.017 277.518 318.149 279.608 319.278 281.701C319.63 282.33 319.982 282.959 320.345 283.608C322.683 287.984 322.683 287.984 322.327 290.956C322.093 291.475 321.859 291.994 321.618 292.529C300.457 293.516 284.791 292.055 268.408 277.576C262.753 272.183 259.179 266.852 255.806 259.842C254.78 257.797 253.753 255.752 252.724 253.709C252.21 252.679 251.696 251.648 251.166 250.587C249.221 246.745 247.182 242.96 245.109 239.185C244.108 237.36 243.12 235.527 242.145 233.688C239.725 229.156 237.226 224.89 234.196 220.736C225.532 208.238 224.371 196.547 224.181 181.717C224.154 180.788 224.127 179.859 224.099 178.901C223.772 163.946 223.772 163.946 228.01 158.397C230.777 156.117 233.518 154.318 236.618 152.529C238.139 151.347 239.643 150.143 241.118 148.904C242.962 147.428 242.962 147.428 244.618 146.529Z"
                  fill="#22D3EE"
                />
                <path
                  d="M219.619 171.529C219.619 200.899 219.619 230.269 219.619 260.529C210.709 260.529 201.799 260.529 192.619 260.529C192.21 251.497 191.881 242.471 191.686 233.431C191.592 229.232 191.466 225.04 191.261 220.844C189.971 193.803 189.971 193.803 194.331 186.767C198.39 182.511 203.017 179.886 208.379 177.576C210.671 176.505 212.553 175.253 214.579 173.745C217.619 171.529 217.619 171.529 219.619 171.529Z"
                  fill="#22D3EE"
                />
                <path
                  d="M175.617 201.529C176.607 201.859 177.597 202.189 178.617 202.529C178.617 221.669 178.617 240.809 178.617 260.529C170.037 260.529 161.457 260.529 152.617 260.529C152.617 245.349 152.617 230.169 152.617 214.529C163.555 208.592 163.555 208.592 167.008 206.721C167.898 206.236 168.789 205.751 169.707 205.252C170.623 204.754 171.54 204.257 172.484 203.744C174.533 202.702 174.533 202.702 175.617 201.529Z"
                  fill="#22D3EE"
                />
                <path
                  d="M139.617 224.529C139.617 236.409 139.617 248.289 139.617 260.529C131.037 260.529 122.457 260.529 113.617 260.529C113.617 251.619 113.617 242.709 113.617 233.529C117.35 232.044 121.083 230.559 124.93 229.029C126.103 228.559 127.277 228.09 128.486 227.605C129.412 227.24 130.338 226.875 131.293 226.498C132.241 226.121 133.189 225.744 134.165 225.355C136.617 224.529 136.617 224.529 139.617 224.529Z"
                  fill="#22D3EE"
                />
                <path
                  d="M91.7721 242.213C90.9872 243.785 90.206 245.36 89.4293 246.937C78.0174 269.997 78.0177 269.998 69.6159 277.53L67.9284 279.229C55.0703 291.5 38.5852 292.938 21.7877 292.636C20.3973 292.603 19.0062 292.568 17.6159 292.53C15.781 286.684 18.3767 283.168 21.0651 277.995C21.5414 277.111 21.541 277.111 22.027 276.209C22.9833 274.418 23.8918 272.608 24.7995 270.792C25.6026 269.283 26.2827 268.01 26.8756 266.928L35.528 261.201L92.5944 240.572C92.3231 241.114 92.0516 241.655 91.7721 242.213ZM184.177 47C189.795 47.0594 193.31 47.5666 197.616 51.5303C199.176 53.8616 200.441 55.9946 201.682 58.4795C202.217 59.502 202.216 59.5026 202.761 60.5459C203.915 62.7623 205.048 64.9895 206.178 67.2178C206.969 68.7517 207.761 70.2857 208.554 71.8184C210.151 74.9074 211.741 78.0005 213.326 81.0957C215.407 85.1454 217.55 89.1591 219.717 93.1631C220.328 94.3002 220.937 95.4378 221.566 96.6094C222.7 98.7196 223.842 100.826 224.995 102.926C225.741 104.333 225.741 104.333 226.503 105.769C227.155 106.975 227.155 106.976 227.821 108.207C228.498 110.187 228.621 111.506 228.321 113.055L217.227 126.612C216.837 127.013 216.447 127.414 216.057 127.815C215.14 128.742 215.139 128.742 214.204 129.687C213.128 130.936 212.327 132.139 211.615 133.471L187.129 163.396L214.541 137.492L214.616 137.53L217.108 135.222C218.235 134.179 219.363 133.136 220.491 132.093C221.384 131.266 221.384 131.265 222.296 130.422C225.66 127.314 229.055 124.247 232.491 121.218C237.03 117.152 241.362 112.892 245.678 108.593C246.346 107.929 247.015 107.266 247.703 106.582C248.325 105.958 248.948 105.333 249.589 104.69C250.148 104.13 250.707 103.569 251.284 102.991C252.719 101.55 252.72 101.549 253.616 99.5303L251.553 98.7803C248.047 97.2884 244.899 95.4618 241.616 93.5303V91.5303C250.237 88.5422 258.869 85.8561 267.678 83.4873C274.138 81.7242 280.466 79.6392 286.779 77.4092C290.285 76.1937 292.861 75.5303 296.616 75.5303C295.342 82.0616 293.96 88.5571 292.452 95.0381C292.156 96.3152 292.156 96.3154 291.855 97.6182C291.235 100.297 290.613 102.977 289.991 105.655C289.566 107.489 289.142 109.322 288.717 111.155C287.685 115.614 286.651 120.072 285.616 124.53C281.616 124.53 281.615 124.53 279.038 122.343L276.366 119.53L273.663 116.718L271.616 114.53C265.324 117.398 260.575 122.507 255.803 127.405C251.987 131.274 247.887 134.66 243.651 138.058C240.941 140.266 238.298 142.528 235.666 144.827C228.297 151.25 220.639 157.168 212.759 162.948C210.557 164.573 208.37 166.22 206.186 167.87C194.034 177.008 181.466 185.408 168.616 193.53C167.926 193.967 167.235 194.403 166.524 194.853C144.065 208.942 119.885 221.757 95.2399 231.571C94.1976 232.06 93.7064 232.293 93.3786 232.846L40.1491 252.088C38.9823 252.234 37.8066 252.381 36.6159 252.53C37.9448 248.235 39.6004 244.363 41.6706 240.374C41.9679 239.799 42.2646 239.223 42.5709 238.631C43.5394 236.761 44.5152 234.896 45.4909 233.03C46.1725 231.719 46.8534 230.408 47.5348 229.097C51.9611 220.6 56.5003 212.171 61.1247 203.78C65.074 196.591 68.8593 189.322 72.6159 182.03C76.8307 173.849 81.1103 165.715 85.5534 157.655C90.5612 148.568 95.3421 139.374 100.084 130.146C104.614 121.336 109.264 112.604 114.05 103.93C117.928 96.8693 121.641 89.7285 125.322 82.5645C134.518 64.6729 134.518 64.6728 138.803 56.9053C139.141 56.279 139.479 55.6521 139.827 55.0068C142.626 50.0209 145.214 47.1672 151.105 47.126C151.986 47.1133 152.868 47.101 153.776 47.0879C154.721 47.0908 155.666 47.0937 156.639 47.0967C157.618 47.0914 158.597 47.0865 159.605 47.0811C161.674 47.0746 163.745 47.0755 165.814 47.084C168.972 47.0925 172.13 47.064 175.288 47.0322C177.301 47.0306 179.314 47.0312 181.327 47.0342C182.267 47.0229 183.208 47.0116 184.177 47Z"
                  fill="#22D3EE"
                />
                <path
                  d="M92.5798 241C92.3014 241.555 92.0231 242.111 91.7363 242.683C90.9514 244.256 90.1708 245.83 89.394 247.407C77.9819 270.468 77.9819 270.468 69.5798 278C68.7445 278.841 68.7445 278.841 67.8923 279.699C55.0341 291.97 38.5494 293.408 21.7517 293.105C20.361 293.072 18.9703 293.038 17.5798 293C15.3494 285.308 20.0374 278.5 23.4362 271.75C28.4058 262.879 34.1898 259.113 43.8224 256.19C48.2554 254.942 52.7138 253.849 57.2065 252.834C61.8852 251.677 66.162 249.893 70.5798 248C73.8801 246.717 77.1979 245.483 80.5173 244.25C81.3533 243.934 82.1892 243.618 83.0505 243.293C83.8529 242.995 84.6554 242.697 85.4821 242.391C86.1988 242.123 86.9154 241.855 87.6538 241.579C89.5798 241 89.5798 241 92.5798 241Z"
                  fill="#22D3EE"
                />
                <path
                  d="M297 75C295.726 81.5314 294.344 88.0268 292.836 94.5078C292.639 95.3593 292.442 96.2108 292.239 97.0881C291.619 99.7674 290.997 102.446 290.375 105.125C289.95 106.958 289.526 108.792 289.102 110.625C288.069 115.084 287.035 119.542 286 124C282 124 282 124 279.422 121.812C278.54 120.884 277.658 119.956 276.75 119C275.858 118.072 274.966 117.144 274.047 116.188C273.034 115.105 273.034 115.105 272 114C265.708 116.868 260.959 121.976 256.188 126.875C252.371 130.743 248.272 134.13 244.035 137.527C241.325 139.736 238.683 141.998 236.051 144.297C228.682 150.721 221.023 156.638 213.144 162.418C210.941 164.044 208.754 165.69 206.57 167.34C194.418 176.478 181.851 184.877 169 193C168.31 193.437 167.62 193.873 166.909 194.323C140.593 210.831 112.419 224.435 83.6418 236.043C77.6141 238.475 71.7749 241.019 66 244C64.2627 244.799 62.5145 245.575 60.75 246.312C59.9405 246.659 59.1309 247.006 58.2969 247.363C55.7145 248.079 54.5206 247.733 52 247C52.5501 246.726 53.1002 246.451 53.667 246.168C69.625 238.152 84.8301 229.217 100.009 219.84C103.609 217.626 107.238 215.464 110.875 213.312C125.65 204.458 140.104 195.178 154 185C155.775 183.732 157.554 182.47 159.333 181.209C171.291 172.723 182.818 163.812 194.15 154.513C195.787 153.174 197.432 151.846 199.078 150.52C204.715 145.97 210.125 141.232 215.457 136.328C217.571 134.393 219.707 132.498 221.875 130.625C230.437 123.159 238.701 115.39 246.75 107.375C247.359 106.771 247.967 106.167 248.594 105.545C251.672 102.557 251.672 102.557 254 99C253.319 98.7525 252.639 98.505 251.938 98.25C248.431 96.758 245.284 94.9316 242 93C242 92.34 242 91.68 242 91C250.621 88.0118 259.252 85.3264 268.062 82.9575C274.522 81.1944 280.85 79.1092 287.163 76.8792C290.669 75.6635 293.245 75 297 75Z"
                  fill="#22D3EE"
                />
                <rect
                  x="239.273"
                  y="206.574"
                  width="57.3314"
                  height="10.8934"
                  transform="rotate(61.4172 239.273 206.574)"
                  fill="#22D3EE"
                />
              </svg>
              AmpliDex
            </div>
            <p className="mt-1 text-xs text-slate-500">
              Leveraged markets on Stellar
            </p>
          </div>
          <button
            className="rounded-lg p-2 text-slate-400 hover:bg-white/5 lg:hidden"
            onClick={() => setSidebarOpen(false)}
          >
            <X size={18} />
          </button>
        </div>

        <nav className="mt-8 space-y-1">
          {nav.map(([key, label, Icon]) => (
            <button
              key={key}
              onClick={() => navigate(key)}
              className={`flex w-full items-center gap-3 rounded-xl px-4 py-3 text-left text-sm font-semibold transition ${
                tab === key
                  ? "bg-cyan-400 text-slate-950 shadow-lg shadow-cyan-400/10"
                  : "text-slate-300 hover:bg-white/5 hover:text-white"
              }`}
            >
              <Icon size={18} />
              {label}
            </button>
          ))}
        </nav>

        <div className="mt-auto rounded-2xl border border-white/10 bg-white/5 p-4">
          <p className="text-xs uppercase tracking-wider text-slate-500">
            Protocol status
          </p>
          <div className="mt-2 flex items-center gap-2 text-sm font-semibold">
            <span
              className={`h-2 w-2 rounded-full ${
                protocol?.paused ? "bg-rose-400" : "bg-emerald-400"
              }`}
            />
            {protocol?.paused ? "Paused" : "Operational"}
          </div>
        </div>
      </aside>

      <div className="lg:pl-72">
        <header className="sticky top-0 z-30 border-b border-white/10 bg-slate-950/80 backdrop-blur-xl">
          <div className="flex items-center justify-between px-4 py-4 sm:px-6 lg:px-8">
            <div className="flex items-center gap-3">
              <button
                className="rounded-xl border border-white/10 p-2 text-slate-300 lg:hidden"
                onClick={() => setSidebarOpen(true)}
              >
                <Menu size={20} />
              </button>
              <div>
                <p className="text-xs uppercase tracking-wider text-slate-500">
                  AmpliDex
                </p>
                <h1 className="text-lg font-bold">{titles[tab]}</h1>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button
                className="btn-secondary"
                onClick={() => void refresh()}
                disabled={loading}
                aria-label="Refresh data"
              >
                <RefreshCw
                  size={16}
                  className={loading ? "animate-spin" : ""}
                />
              </button>
              <button
                className="btn-primary"
                onClick={async () => setAddress(await connectWallet())}
              >
                <Wallet size={16} />
                {address ? short(address) : "Connect wallet"}
              </button>
            </div>
          </div>
        </header>

        <main className="px-4 py-6 sm:px-6 lg:px-8">
          {!config.protocolId && (
            <div className="mb-5 rounded-xl border border-amber-400/30 bg-amber-950/40 p-4 text-sm text-amber-200">
              Set VITE_PROTOCOL_CONTRACT_ID in .env.
            </div>
          )}

          {tab === "dashboard" && (
            <Dashboard protocol={protocol} markets={markets} pools={pools} />
          )}
          {tab === "trade" && (
            <Trade
              address={address}
              markets={config.markets}
              balances={walletBalances}
              run={transact}
            />
          )}
          {tab === "pool" && (
            <Pool
              address={address}
              pools={pools}
              balances={walletBalances}
              run={transact}
            />
          )}
          {tab === "positions" && (
            <Positions address={address} positions={positions} run={transact} />
          )}
          {tab === "keeper" && (
            <KeeperDashboard
              address={address}
              protocol={protocol}
              state={keeperState}
              positions={keeperPositions}
              run={transact}
            />
          )}
          {tab === "wallet" && (
            <WalletPanel
              address={address}
              balances={walletBalances}
              run={transact}
            />
          )}
        </main>
      </div>

      {loading && (
        <div className="pointer-events-none fixed inset-0 z-20 grid place-items-center bg-slate-950/25">
          <Loader2 className="animate-spin text-cyan-300" size={38} />
        </div>
      )}
    </div>
  );
}

function Dashboard({
  protocol,
  markets,
  pools,
}: {
  protocol: AnyMap | null;
  markets: any[];
  pools: PoolView[];
}) {
  return (
    <div className="space-y-6">
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <Stat
          label="Protocol"
          value={protocol?.paused ? "Paused" : "Active"}
          icon={ShieldCheck}
        />
        <Stat
          label="Configured markets"
          value={String(markets.length)}
          icon={Coins}
        />
        <Stat
          label="Lending pools"
          value={String(pools.length)}
          icon={ArrowDownToLine}
        />
        <Stat label="Open positions" value="Live" icon={ArrowUpFromLine} />
      </div>

      <section className="card overflow-hidden">
        <div className="border-b border-white/10 p-5">
          <h2 className="font-bold">Lending pools</h2>
          <p className="text-sm text-slate-500">Liquidity per asset.</p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-white/5 text-left text-xs uppercase text-slate-500">
              <tr>
                {[
                  "Pool",
                  "Total assets",
                  "Borrowed",
                  "Available",
                  "Utilization",
                  "Supply APR est.",
                ].map((x) => (
                  <th key={x} className="px-5 py-3">
                    {x}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {pools.map((pool) => (
                <tr key={pool.def.asset} className="border-t border-white/5">
                  <td className="px-5 py-4">
                    <b>{pool.def.symbol}</b>
                    <div className="text-xs text-slate-500">
                      {short(pool.def.asset)}
                    </div>
                  </td>
                  <td className="px-5 py-4">
                    {formatHumanAmount(
                      pool.pool?.total_assets,
                      pool.def.decimals
                    )}{" "}
                    {pool.def.symbol}
                  </td>
                  <td className="px-5 py-4">
                    {formatHumanAmount(
                      pool.pool?.total_borrowed,
                      pool.def.decimals
                    )}{" "}
                    {pool.def.symbol}
                  </td>
                  <td className="px-5 py-4">
                    {formatHumanAmount(
                      pool.availableLiquidity,
                      pool.def.decimals
                    )}{" "}
                    {pool.def.symbol}
                  </td>
                  <td className="px-5 py-4">
                    {formatPercentBps(pool.utilizationBps)}
                  </td>
                  <td className="px-5 py-4 text-emerald-300">
                    {formatPercentBps(pool.supplyAprBps)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card overflow-hidden">
        <div className="border-b border-white/10 p-5">
          <h2 className="font-bold">Supported markets</h2>
          <p className="text-sm text-slate-500">
            Live contract configuration, liquidity and borrowing rates.
          </p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-white/5 text-left text-xs uppercase text-slate-500">
              <tr>
                {[
                  "Market",
                  "Status",
                  "Liquidity",
                  "Borrowed",
                  "Utilization",
                  "Long APR",
                  "Short APR",
                  "Max borrow",
                ].map((x) => (
                  <th key={x} className="px-5 py-3">
                    {x}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {markets.map((m) => (
                <tr key={m.def.asset} className="border-t border-white/5">
                  <td className="px-5 py-4">
                    <b>{m.def.symbol}</b>
                    <div className="text-xs text-slate-500">
                      {short(m.def.asset)}
                    </div>
                  </td>
                  <td className="px-5 py-4">
                    {m.cfg?.enabled ? (
                      <span className="text-emerald-400">Enabled</span>
                    ) : (
                      <span className="text-rose-400">Disabled</span>
                    )}
                  </td>
                  <td className="px-5 py-4">
                    {formatHumanAmount(m.pool?.total_assets, m.def.decimals)}
                  </td>
                  <td className="px-5 py-4">
                    {formatHumanAmount(m.pool?.total_borrowed, m.def.decimals)}
                  </td>
                  <td className="px-5 py-4">
                    {bps(m.shortRate?.utilization_bps)}
                  </td>
                  <td className="px-5 py-4">{bps(m.longRate?.apr_bps)}</td>
                  <td className="px-5 py-4">{bps(m.shortRate?.apr_bps)}</td>
                  <td className="px-5 py-4">
                    {formatHumanAmount(m.cfg?.max_position_notional_usdc, 7)}{" "}
                    USDC
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function Trade({
  address,
  markets,
  balances,
  run,
}: {
  address: string | null;
  markets: MarketDefinition[];
  balances: WalletBalance[];
  run: RunTransaction;
}) {
  const [asset, setAsset] = useState(markets[0]?.asset || "");
  const [side, setSide] = useState<"Long" | "Short">("Long");
  const [collateral, setCollateral] = useState("10");
  const [borrowMultiplier, setBorrowMultiplier] = useState(2);
  const market = markets.find((m) => m.asset === asset);
  const usdcBalance =
    balances.find((item) => item.def.asset === config.usdcId)?.balance ?? null;
  const collateralBase = useMemo(() => {
    try {
      return parseHumanAmount(collateral, 7);
    } catch {
      return 0n;
    }
  }, [collateral]);
  const collateralTooHigh =
    usdcBalance !== null && collateralBase > usdcBalance;
  const leverageBps = Math.round(borrowMultiplier * 10_000);
  const estimatedBorrowed = Number(collateral || 0) * borrowMultiplier;
  const totalExposure = Number(collateral || 0) + estimatedBorrowed;

  const submit = () => {
    if (!address) throw new Error("Connect your wallet first.");
    if (!market) throw new Error("Select a supported market.");
    if (collateralBase <= 0n) throw new Error("Enter a collateral amount.");
    if (collateralTooHigh) {
      throw new Error("Collateral exceeds your available USDC balance.");
    }
    return run(`Open ${side.toLowerCase()}`, () =>
      invokeContract(
        address,
        config.protocolId,
        side === "Long" ? "open_long" : "open_short",
        [
          sc.address(address),
          sc.address(asset),
          sc.i128(collateralBase),
          sc.u32(leverageBps),
        ]
      )
    );
  };

  return (
    <div className="grid gap-6 xl:grid-cols-[1.1fr_.9fr]">
      <section className="card p-6">
        {/* <h2 className="mb-5 text-xl font-bold">Open leveraged position</h2> */}
        <div className="mb-5 grid grid-cols-2 rounded-xl bg-slate-950 p-1">
          <button
            className={`btn ${
              side === "Long" ? "bg-emerald-400 text-slate-950" : ""
            }`}
            onClick={() => setSide("Long")}
          >
            Long
          </button>
          <button
            className={`btn ${
              side === "Short" ? "bg-rose-400 text-slate-950" : ""
            }`}
            onClick={() => setSide("Short")}
          >
            Short
          </button>
        </div>

        <Field label="Market">
          <AssetSelect
            value={asset}
            onChange={setAsset}
            assets={markets.map((m) => ({
              asset: m.asset,
              symbol: m.symbol,
              name: m.name,
              decimals: m.decimals,
            }))}
          />
        </Field>

        <div className="mb-2 flex items-center justify-between text-xs text-slate-500">
          <span>Available USDC</span>
          <span>
            {usdcBalance === null
              ? address
                ? "Unavailable"
                : "Connect wallet"
              : `${formatHumanAmount(usdcBalance, 7)} USDC`}
          </span>
        </div>
        <Field label="Collateral (USDC)">
          <div className="relative">
            <input
              className="input pr-20"
              inputMode="decimal"
              value={collateral}
              onChange={(e) => setCollateral(e.target.value)}
            />
            <button
              type="button"
              className="absolute right-3 top-1/2 -translate-y-1/2 rounded-md px-2 py-1 text-xs font-bold text-cyan-300 hover:bg-cyan-400/10 disabled:opacity-40"
              disabled={usdcBalance === null || usdcBalance <= 0n}
              onClick={() =>
                setCollateral(formatInputAmount(usdcBalance ?? 0n, 7))
              }
            >
              MAX
            </button>
          </div>
          {collateralTooHigh && (
            <ValidationMessage>
              Collateral exceeds your available USDC balance.
            </ValidationMessage>
          )}
        </Field>

        <Field label={`Borrow multiplier · ${borrowMultiplier.toFixed(1)}×`}>
          <div className="rounded-2xl border border-white/10 bg-slate-950/70 p-4">
            <input
              aria-label="Borrow multiplier"
              type="range"
              min="0"
              max="5"
              step="0.1"
              value={borrowMultiplier}
              onChange={(e) => setBorrowMultiplier(Number(e.target.value))}
              className="w-full accent-cyan-400"
            />
            <div className="mt-3 grid grid-cols-5 text-center text-xs text-slate-500">
              {[1, 2, 3, 4, 5].map((value) => (
                <button
                  key={value}
                  type="button"
                  className={`rounded-lg py-1 transition ${
                    Math.abs(borrowMultiplier - value) < 0.05
                      ? "bg-cyan-400 text-slate-950"
                      : "hover:bg-white/5 hover:text-white"
                  }`}
                  onClick={() => setBorrowMultiplier(value)}
                >
                  {value}×
                </button>
              ))}
            </div>
          </div>
          {/* <p className="mt-2 text-xs text-slate-500">
            Sent to the contract as {leverageBps.toLocaleString()} basis points.
            A 2× borrow multiplier means 2× collateral is borrowed and total
            exposure is 3× collateral.
          </p> */}
        </Field>

        <button
          className="btn-primary mt-3 w-full"
          disabled={
            !address || !market || collateralBase <= 0n || collateralTooHigh
          }
          onClick={() => void submit()}
        >
          {!address
            ? "Connect wallet"
            : collateralTooHigh
            ? "Insufficient USDC balance"
            : `Open ${side}`}
        </button>
      </section>

      <section className="card p-6">
        <h3 className="font-bold">Order summary</h3>
        <div className="mt-5 space-y-3 text-sm">
          <Line a="Side" b={side} />
          <Line a="Collateral" b={`${collateral || 0} USDC`} />
          <Line a="Borrow multiplier" b={`${borrowMultiplier.toFixed(1)}×`} />
          {/* <Line
            a="Total exposure multiplier"
            b={`${(1 + borrowMultiplier).toFixed(1)}×`}
          /> */}
          <Line
            a="Estimated borrowed notional"
            b={`${estimatedBorrowed.toFixed(2)} USDC`}
          />
          {/* <Line
            a="Estimated total exposure"
            b={`${totalExposure.toFixed(2)} USDC`}
          /> */}
          <Line a="Settlement" b="Aquarius direct pool" />
        </div>
        <div className="mt-6 rounded-xl border border-amber-400/20 bg-amber-950/30 p-4 text-xs text-amber-200">
          Leveraged trading can lose all collateral. Contract simulation runs
          before wallet signature.
        </div>
      </section>
    </div>
  );
}

function Pool({
  address,
  pools,
  balances,
  run,
}: {
  address: string | null;
  pools: PoolView[];
  balances: WalletBalance[];
  run: RunTransaction;
}) {
  const [asset, setAsset] = useState("");
  const [amount, setAmount] = useState("");
  const [shares, setShares] = useState("");

  useEffect(() => {
    if (!asset && pools[0]) setAsset(pools[0].def.asset);
  }, [asset, pools]);

  const selected = pools.find((item) => item.def.asset === asset) ?? pools[0];
  const selectedBalance =
    balances.find((item) => item.def.asset === selected?.def.asset)?.balance ??
    null;

  if (!selected) return <Empty text="No lending pools configured." />;

  const user = selected.user;
  const totalAssets = asBigInt(selected.pool?.total_assets);
  const totalShares = asBigInt(selected.pool?.total_shares);
  const walletReserve =
    selected.def.symbol.toUpperCase() === "XLM" ? XLM_FEE_RESERVE : 0n;
  const maxDeposit =
    selectedBalance !== null && selectedBalance > walletReserve
      ? selectedBalance - walletReserve
      : 0n;

  const depositAmount = (() => {
    try {
      return parseHumanAmount(amount, selected.def.decimals);
    } catch {
      return 0n;
    }
  })();
  const depositExceedsBalance =
    selectedBalance !== null && depositAmount > maxDeposit;
  const estimatedShares =
    depositAmount > 0n
      ? totalAssets > 0n && totalShares > 0n
        ? (depositAmount * totalShares) / totalAssets
        : depositAmount
      : 0n;

  const maxWithdrawableShares = (() => {
    if (!user || user.shares <= 0n) return 0n;
    if (totalAssets <= 0n || totalShares <= 0n) return user.shares;
    const liquidityLimitedShares =
      (user.immediatelyWithdrawable * totalShares) / totalAssets;
    return liquidityLimitedShares < user.shares
      ? liquidityLimitedShares
      : user.shares;
  })();

  const enteredShares = (() => {
    try {
      return parseHumanAmount(shares, selected.def.decimals);
    } catch {
      return 0n;
    }
  })();
  const sharesExceedOwned = enteredShares > (user?.shares ?? 0n);
  const sharesExceedWithdrawable = enteredShares > maxWithdrawableShares;
  const estimatedWithdrawAsset =
    enteredShares > 0n && totalShares > 0n
      ? (enteredShares * totalAssets) / totalShares
      : 0n;
  const yearlyYield =
    user && user.assetValue > 0n
      ? (user.assetValue * selected.supplyAprBps) / BPS_SCALE
      : 0n;

  const deposit = () => {
    if (!address) throw new Error("Connect your wallet first.");
    if (selectedBalance === null) {
      throw new Error("Your wallet balance could not be loaded.");
    }
    if (depositAmount <= 0n) throw new Error("Enter a deposit amount.");
    if (depositExceedsBalance) {
      throw new Error(
        `You cannot deposit this amount. Your maximum available deposit is ${formatHumanAmount(
          maxDeposit,
          selected.def.decimals
        )} ${selected.def.symbol}.`
      );
    }
    return run("Liquidity deposited", () =>
      invokeContract(address, config.protocolId, "deposit_liquidity", [
        sc.address(address),
        sc.address(selected.def.asset),
        sc.i128(depositAmount),
      ])
    ).then(() => setAmount(""));
  };

  const withdraw = () => {
    if (!address) throw new Error("Connect your wallet first.");
    if (enteredShares <= 0n) throw new Error("Enter LP shares to withdraw.");
    if (sharesExceedOwned) {
      throw new Error("The entered amount exceeds your owned LP shares.");
    }
    if (sharesExceedWithdrawable) {
      throw new Error(
        `Current pool liquidity only allows ${formatHumanAmount(
          maxWithdrawableShares,
          selected.def.decimals
        )} LP shares to be withdrawn now.`
      );
    }
    return run("Liquidity withdrawn", () =>
      invokeContract(address, config.protocolId, "withdraw_liquidity", [
        sc.address(address),
        sc.address(selected.def.asset),
        sc.i128(enteredShares),
      ])
    ).then(() => setShares(""));
  };

  return (
    <div className="space-y-6">
      <section className="card p-5">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h2 className="font-bold">Lending pool</h2>
            <p className="text-sm text-slate-500">
              Supply or withdraw USDC and supported assets such as XLM.
            </p>
          </div>
          <div className="w-full sm:w-80">
            <AssetSelect
              value={selected.def.asset}
              onChange={(value) => {
                setAsset(value);
                setAmount("");
                setShares("");
              }}
              assets={pools.map((item) => item.def)}
            />
          </div>
        </div>
      </section>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <Stat
          label="Total pool assets"
          value={`${formatHumanAmount(totalAssets, selected.def.decimals)} ${
            selected.def.symbol
          }`}
          icon={Coins}
        />
        <Stat
          label="Available liquidity"
          value={`${formatHumanAmount(
            selected.availableLiquidity,
            selected.def.decimals
          )} ${selected.def.symbol}`}
          icon={ArrowUpFromLine}
        />
        <Stat
          label="Utilization"
          value={formatPercentBps(selected.utilizationBps)}
          icon={Gauge}
        />
        <Stat
          label="Supply APR estimate"
          value={formatPercentBps(selected.supplyAprBps)}
          icon={Activity}
        />
      </div>

      <section className="card p-6">
        <h2 className="font-bold">Your {selected.def.symbol} liquidity</h2>
        {!address ? (
          <p className="mt-3 text-sm text-slate-500">
            Connect your wallet to load your LP position.
          </p>
        ) : (
          <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            <Mini
              label="LP shares"
              value={formatHumanAmount(
                user?.shares ?? 0n,
                selected.def.decimals,
                6
              )}
            />
            <Mini
              label="Current value"
              value={`${formatHumanAmount(
                user?.assetValue ?? 0n,
                selected.def.decimals
              )} ${selected.def.symbol}`}
            />
            <Mini
              label="Withdrawable now"
              value={`${formatHumanAmount(
                user?.immediatelyWithdrawable ?? 0n,
                selected.def.decimals
              )} ${selected.def.symbol}`}
            />
            <Mini
              label="Withdrawable shares"
              value={formatHumanAmount(
                maxWithdrawableShares,
                selected.def.decimals,
                6
              )}
            />
            <Mini
              label="Estimated annual yield"
              value={`${formatHumanAmount(
                yearlyYield,
                selected.def.decimals
              )} ${selected.def.symbol}`}
            />
          </div>
        )}
        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          <Mini
            label="Pool ownership"
            value={formatPercentBps(user?.ownershipBps ?? 0n)}
          />
          <Mini
            label="Borrow APR"
            value={formatPercentBps(selected.borrowAprBps)}
          />
          <Mini
            label="Reserve factor"
            value={formatPercentBps(selected.rateConfig?.reserve_factor_bps)}
          />
        </div>
      </section>

      <div className="grid gap-6 xl:grid-cols-2">
        <section className="card p-6">
          <h2 className="font-bold">Deposit liquidity</h2>
          <p className="mb-5 text-sm text-slate-500">
            Supply {selected.def.symbol} and receive LP shares.
          </p>

          <div className="mb-2 flex items-center justify-between text-sm">
            <span className="text-slate-500">Wallet balance</span>
            <span className="font-semibold">
              {!address
                ? "Connect wallet"
                : selectedBalance === null
                ? "Unavailable"
                : `${formatHumanAmount(
                    selectedBalance,
                    selected.def.decimals
                  )} ${selected.def.symbol}`}
            </span>
          </div>

          <Field label={`Amount (${selected.def.symbol})`}>
            <div className="relative">
              <input
                className="input pr-20"
                inputMode="decimal"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="0.00"
              />
              <button
                type="button"
                className="absolute right-3 top-1/2 -translate-y-1/2 rounded-md px-2 py-1 text-xs font-bold text-cyan-300 hover:bg-cyan-400/10 disabled:opacity-40"
                disabled={
                  !address || selectedBalance === null || maxDeposit <= 0n
                }
                onClick={() =>
                  setAmount(
                    formatInputAmount(maxDeposit, selected.def.decimals)
                  )
                }
              >
                MAX
              </button>
            </div>
            {depositExceedsBalance && (
              <ValidationMessage>
                You can deposit at most{" "}
                {formatHumanAmount(maxDeposit, selected.def.decimals)}{" "}
                {selected.def.symbol}.
              </ValidationMessage>
            )}
            {selected.def.symbol.toUpperCase() === "XLM" &&
              selectedBalance !== null && (
                <p className="mt-2 text-xs text-slate-500">
                  MAX keeps 1 XLM available for network fees and account
                  reserves.
                </p>
              )}
          </Field>

          <div className="mb-4 space-y-3 rounded-xl bg-white/5 p-4 text-sm">
            <Line
              a="Estimated shares"
              b={formatHumanAmount(estimatedShares, selected.def.decimals, 6)}
            />
            <Line
              a="Supply APR estimate"
              b={formatPercentBps(selected.supplyAprBps)}
            />
          </div>

          <button
            className="btn-primary w-full"
            disabled={
              !address ||
              selectedBalance === null ||
              depositAmount <= 0n ||
              depositExceedsBalance
            }
            onClick={() => void deposit()}
          >
            {!address
              ? "Connect wallet"
              : depositExceedsBalance
              ? "Insufficient balance"
              : `Deposit ${selected.def.symbol}`}
          </button>
        </section>

        <section className="card p-6">
          <h2 className="font-bold">Withdraw liquidity</h2>
          <p className="mb-5 text-sm text-slate-500">
            Burn LP shares and receive {selected.def.symbol}.
          </p>

          <div className="mb-2 flex items-center justify-between text-sm">
            <span className="text-slate-500">Withdrawable shares now</span>
            <span className="font-semibold">
              {formatHumanAmount(
                maxWithdrawableShares,
                selected.def.decimals,
                6
              )}
            </span>
          </div>

          <Field label="LP shares">
            <div className="relative">
              <input
                className="input pr-20"
                inputMode="decimal"
                value={shares}
                onChange={(e) => setShares(e.target.value)}
                placeholder="0.00"
              />
              <button
                type="button"
                className="absolute right-3 top-1/2 -translate-y-1/2 rounded-md px-2 py-1 text-xs font-bold text-cyan-300 hover:bg-cyan-400/10 disabled:opacity-40"
                disabled={!address || maxWithdrawableShares <= 0n}
                onClick={() =>
                  setShares(
                    formatInputAmount(
                      maxWithdrawableShares,
                      selected.def.decimals
                    )
                  )
                }
              >
                MAX
              </button>
            </div>
            {sharesExceedOwned && (
              <ValidationMessage>
                The entered amount exceeds your owned LP shares.
              </ValidationMessage>
            )}
            {!sharesExceedOwned && sharesExceedWithdrawable && (
              <ValidationMessage>
                Pool liquidity currently allows only{" "}
                {formatHumanAmount(
                  maxWithdrawableShares,
                  selected.def.decimals,
                  6
                )}{" "}
                shares to be withdrawn.
              </ValidationMessage>
            )}
          </Field>

          <div className="mb-4 space-y-3 rounded-xl bg-white/5 p-4 text-sm">
            <Line
              a="Owned shares"
              b={formatHumanAmount(
                user?.shares ?? 0n,
                selected.def.decimals,
                6
              )}
            />
            <Line
              a="Estimated asset received"
              b={`${formatHumanAmount(
                estimatedWithdrawAsset,
                selected.def.decimals
              )} ${selected.def.symbol}`}
            />
            <Line
              a="Withdrawable asset now"
              b={`${formatHumanAmount(
                user?.immediatelyWithdrawable ?? 0n,
                selected.def.decimals
              )} ${selected.def.symbol}`}
            />
          </div>

          <button
            className="btn-secondary w-full"
            disabled={
              !address ||
              enteredShares <= 0n ||
              sharesExceedOwned ||
              sharesExceedWithdrawable
            }
            onClick={() => void withdraw()}
          >
            {!address
              ? "Connect wallet"
              : sharesExceedOwned
              ? "Insufficient LP shares"
              : sharesExceedWithdrawable
              ? "Exceeds withdrawable maximum"
              : `Withdraw ${selected.def.symbol}`}
          </button>
        </section>
      </div>
    </div>
  );
}

function KeeperDashboard({
  address,
  protocol,
  state,
  positions,
  run,
}: {
  address: string | null;
  protocol: AnyMap | null;
  state: KeeperStateView | null;
  positions: KeeperPositionView[];
  run: RunTransaction;
}) {
  const ready = positions.filter((item) => Boolean(item.risk.liquidatable));
  const close = positions.filter(
    (item) => Boolean(item.risk.actionable) && !item.risk.liquidatable
  );
  const totalPotentialReward = ready.reduce(
    (sum, item) => sum + item.estimatedRewardUsdc,
    0n
  );

  const executeNextLiquidation = async () => {
    if (!address) throw new Error("Connect your wallet to run liquidation.");
    if (!ready.length)
      throw new Error("No position is currently liquidatable.");

    await run("Keeper liquidation executed", () =>
      invokeContract(address, config.protocolId, "execute_liquidation", [
        sc.address(address),
      ])
    );
  };

  return (
    <div className="space-y-6">
      <section className="card overflow-hidden">
        <div className="border-b border-white/10 p-6">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <div className="flex items-center gap-2">
                <div className="grid h-10 w-10 place-items-center rounded-xl bg-amber-400/15 text-amber-300">
                  <HandCoins size={20} />
                </div>
                <div>
                  <h2 className="text-xl font-bold">
                    Keeper liquidation dashboard
                  </h2>
                  <p className="text-sm text-slate-500">
                    Review stressed positions and execute the next eligible
                    liquidation selected by the contract.
                  </p>
                </div>
              </div>
            </div>
            <button
              className="btn-primary"
              disabled={!address || !ready.length || Boolean(protocol?.paused)}
              onClick={() => void executeNextLiquidation()}
            >
              <Activity size={16} />
              {!address
                ? "Connect wallet"
                : protocol?.paused
                ? "Protocol paused"
                : ready.length
                ? "Execute next liquidation"
                : "Nothing to liquidate"}
            </button>
          </div>
        </div>
        <div className="grid gap-4 p-6 sm:grid-cols-2 xl:grid-cols-5">
          <Mini label="Inspected" value={String(state?.inspected ?? 0n)} />
          <Mini
            label="Open positions"
            value={String(state?.openPositions ?? 0n)}
          />
          <Mini label="Close to liquidation" value={String(close.length)} />
          <Mini label="Ready now" value={String(ready.length)} />
          <Mini
            label="Potential rewards"
            value={`Up to ${formatHumanAmount(totalPotentialReward, 7)} USDC`}
          />
        </div>
      </section>

      <div className="rounded-xl border border-amber-400/20 bg-amber-950/25 p-4 text-sm text-amber-100">
        The reward shown is an estimate of the configured maximum. The actual
        keeper reward is capped by the position&apos;s positive surplus after
        debt repayment and protocol close fees.
      </div>

      <KeeperPositionSection
        title="Ready for liquidation"
        description="These positions currently satisfy the contract liquidation condition."
        emptyText="No positions are currently ready for liquidation."
        items={ready}
        address={address}
        execute={executeNextLiquidation}
        actionLabel="Execute next eligible"
      />

      <KeeperPositionSection
        title="Close to liquidation"
        description="These positions are actionable or stressed, but not yet liquidatable."
        emptyText="No positions are currently close to liquidation."
        items={close}
        address={address}
      />
    </div>
  );
}

function KeeperPositionSection({
  title,
  description,
  emptyText,
  items,
  address,
  execute,
  actionLabel,
}: {
  title: string;
  description: string;
  emptyText: string;
  items: KeeperPositionView[];
  address: string | null;
  execute?: () => Promise<void>;
  actionLabel?: string;
}) {
  return (
    <section className="card overflow-hidden">
      <div className="border-b border-white/10 p-5">
        <h2 className="font-bold">{title}</h2>
        <p className="text-sm text-slate-500">{description}</p>
      </div>

      {!items.length ? (
        <div className="p-8 text-center text-sm text-slate-500">
          {emptyText}
        </div>
      ) : (
        <div className="divide-y divide-white/5">
          {items.map((item) => {
            const p = item.position;
            const r = item.risk;
            const preview = item.preview ?? {};
            const id = String(p.id);
            const symbol = item.market?.symbol ?? "Asset";
            const liquidatable = Boolean(r.liquidatable);

            return (
              <article key={id} className="p-5">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <span
                        className={`rounded-lg px-2 py-1 text-xs font-bold ${
                          liquidatable
                            ? "bg-rose-400/15 text-rose-300"
                            : "bg-amber-400/15 text-amber-300"
                        }`}
                      >
                        {liquidatable ? "LIQUIDATABLE" : "AT RISK"}
                      </span>
                      <span
                        className={`rounded-lg px-2 py-1 text-xs font-bold ${
                          String(p.side).includes("Long")
                            ? "bg-emerald-400/15 text-emerald-300"
                            : "bg-fuchsia-400/15 text-fuchsia-300"
                        }`}
                      >
                        {String(p.side)} {symbol}
                      </span>
                      <b>Position #{id}</b>
                    </div>
                    <p className="mt-2 text-xs text-slate-500">
                      Owner {short(String(p.owner ?? ""), 10, 10)}
                    </p>
                  </div>

                  {execute && (
                    <button
                      className="btn-primary"
                      disabled={!address}
                      onClick={() => void execute()}
                    >
                      <HandCoins size={16} />
                      {address ? actionLabel : "Connect wallet"}
                    </button>
                  )}
                </div>

                <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-7">
                  <Mini
                    label="Margin ratio"
                    value={formatPercentBps(r.margin_ratio_bps)}
                  />
                  <Mini
                    label="Equity ratio"
                    value={formatPercentBps(r.equity_ratio_bps)}
                  />
                  <Mini
                    label="Collateral"
                    value={`${formatHumanAmount(p.collateral_usdc, 7)} USDC`}
                  />
                  <Mini
                    label="Current debt"
                    value={formatHumanAmount(
                      preview.current_debt ?? p.borrowed_amount,
                      item.market?.decimals ?? 7
                    )}
                  />
                  <Mini
                    label="Executable equity"
                    value={`${formatHumanAmount(
                      r.executable_equity_usdc,
                      7
                    )} USDC`}
                  />
                  <Mini
                    label="Est. keeper reward"
                    value={`Up to ${formatHumanAmount(
                      item.estimatedRewardUsdc,
                      7
                    )} USDC`}
                  />
                  <Mini
                    label="Executable price"
                    value={formatHumanAmount(r.executable_price, 7)}
                  />
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}

type PositionFilter = "open" | "closed" | "liquidated" | "all";

function normalizePositionStatus(status: unknown): PositionFilter | "unknown" {
  const value = String(status ?? "").toLowerCase();

  if (value.includes("liquidated")) return "liquidated";
  if (value.includes("closed")) return "closed";
  if (value.includes("open")) return "open";

  return "unknown";
}

function Positions({
  address,
  positions,
  run,
}: {
  address: string | null;
  positions: AnyMap[];
  run: RunTransaction;
}) {
  const [closeById, setCloseById] = useState<Record<string, string>>({});
  const [filter, setFilter] = useState<PositionFilter>("open");

  const positionCounts = useMemo(
    () =>
      positions.reduce(
        (counts, position) => {
          const status = normalizePositionStatus(position.status);

          counts.all += 1;

          if (status === "open") counts.open += 1;
          if (status === "closed") counts.closed += 1;
          if (status === "liquidated") counts.liquidated += 1;

          return counts;
        },
        {
          all: 0,
          open: 0,
          closed: 0,
          liquidated: 0,
        }
      ),
    [positions]
  );

  const filteredPositions = useMemo(() => {
    if (filter === "all") return positions;

    return positions.filter(
      (position) => normalizePositionStatus(position.status) === filter
    );
  }, [filter, positions]);

  if (!address) {
    return <Empty text="Connect a wallet to load positions." />;
  }

  if (!positions.length) {
    return <Empty text="No positions found." />;
  }

  const filters: Array<{
    key: PositionFilter;
    label: string;
    count: number;
  }> = [
    {
      key: "open",
      label: "Open",
      count: positionCounts.open,
    },
    {
      key: "closed",
      label: "Closed",
      count: positionCounts.closed,
    },
    {
      key: "liquidated",
      label: "Liquidated",
      count: positionCounts.liquidated,
    },
    {
      key: "all",
      label: "All",
      count: positionCounts.all,
    },
  ];

  return (
    <div className="space-y-5">
      <section className="card p-3">
        <div className="flex flex-wrap gap-2">
          {filters.map((item) => {
            const active = filter === item.key;

            return (
              <button
                key={item.key}
                type="button"
                onClick={() => setFilter(item.key)}
                className={`inline-flex items-center gap-2 rounded-xl px-4 py-2 text-sm font-semibold transition ${
                  active
                    ? "bg-cyan-400 text-slate-950"
                    : "bg-white/5 text-slate-300 hover:bg-white/10 hover:text-white"
                }`}
              >
                <span>{item.label}</span>

                <span
                  className={`rounded-full px-2 py-0.5 text-xs ${
                    active
                      ? "bg-slate-950/15 text-slate-950"
                      : "bg-white/10 text-slate-400"
                  }`}
                >
                  {item.count}
                </span>
              </button>
            );
          })}
        </div>
      </section>

      {!filteredPositions.length ? (
        <Empty
          text={`No ${filter === "all" ? "" : `${filter} `}positions found.`}
        />
      ) : (
        <div className="space-y-4">
          {filteredPositions.map((p) => {
            const id = String(p.id);
            const preview = p.preview || {};
            const normalizedStatus = normalizePositionStatus(p.status);
            const open = normalizedStatus === "open";

            const statusClasses =
              normalizedStatus === "open"
                ? "border-emerald-400/20 bg-emerald-400/10 text-emerald-300"
                : normalizedStatus === "liquidated"
                ? "border-rose-400/20 bg-rose-400/10 text-rose-300"
                : normalizedStatus === "closed"
                ? "border-slate-400/20 bg-slate-400/10 text-slate-300"
                : "border-amber-400/20 bg-amber-400/10 text-amber-300";

            return (
              <section key={id} className="card p-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <span
                        className={`rounded-lg px-2 py-1 text-xs font-bold ${
                          String(p.side).includes("Long")
                            ? "bg-emerald-400/15 text-emerald-300"
                            : "bg-rose-400/15 text-rose-300"
                        }`}
                      >
                        {String(p.side)}
                      </span>

                      <b>Position #{id}</b>
                    </div>

                    <p className="mt-1 text-xs text-slate-500">
                      {short(String(p.asset))}
                    </p>
                  </div>

                  <span
                    className={`rounded-lg border px-3 py-1 text-xs font-semibold capitalize ${statusClasses}`}
                  >
                    {normalizedStatus === "unknown"
                      ? String(p.status)
                      : normalizedStatus}
                  </span>
                </div>

                <div className="mt-5 grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
                  <Mini
                    label="Collateral"
                    value={`${formatHumanAmount(p.collateral_usdc)} USDC`}
                  />

                  <Mini
                    label="Debt"
                    value={formatHumanAmount(
                      preview.current_debt ?? p.borrowed_amount
                    )}
                  />

                  <Mini label="Held" value={formatHumanAmount(p.held_amount)} />

                  <Mini
                    label="Entry price"
                    value={formatHumanAmount(p.entry_price)}
                  />

                  <Mini
                    label="Margin ratio"
                    value={open ? bps(preview.margin_ratio_bps) : "—"}
                  />

                  <Mini
                    label="Net PnL"
                    value={
                      preview.net_pnl_usdc !== undefined
                        ? `${formatHumanAmount(preview.net_pnl_usdc)} USDC`
                        : "—"
                    }
                  />
                </div>

                {open && (
                  <div className="mt-5 flex flex-wrap items-end gap-3 border-t border-white/5 pt-5">
                    <Field label="Close position (%)">
                      <div className="flex gap-2">
                        <input
                          className="input max-w-44"
                          inputMode="decimal"
                          value={closeById[id] ?? "100"}
                          min="0.01"
                          max="100"
                          onChange={(e) =>
                            setCloseById((value) => ({
                              ...value,
                              [id]: e.target.value,
                            }))
                          }
                          placeholder="Close %"
                        />

                        <button
                          type="button"
                          className="btn-secondary"
                          onClick={() =>
                            setCloseById((value) => ({
                              ...value,
                              [id]: "100",
                            }))
                          }
                        >
                          Max
                        </button>
                      </div>
                    </Field>

                    <button
                      className="btn-primary mb-4"
                      disabled={(() => {
                        const percentage = Number(closeById[id] ?? "100");

                        return (
                          !Number.isFinite(percentage) ||
                          percentage <= 0 ||
                          percentage > 100
                        );
                      })()}
                      onClick={() => {
                        const percentage = Number(closeById[id] ?? "100");

                        if (
                          !Number.isFinite(percentage) ||
                          percentage <= 0 ||
                          percentage > 100
                        ) {
                          return;
                        }

                        void run("Position closed", () =>
                          invokeContract(
                            address,
                            config.protocolId,
                            "close_position",
                            [
                              sc.address(address),
                              sc.u64(p.id),
                              sc.optionU32(
                                percentage === 100
                                  ? null
                                  : Math.round(percentage * 100)
                              ),
                            ]
                          )
                        );
                      }}
                    >
                      Close{" "}
                      {Number(closeById[id] ?? "100") === 100
                        ? "entire position"
                        : `${closeById[id] ?? "100"}%`}
                    </button>
                  </div>
                )}

                {normalizedStatus === "liquidated" && (
                  <div className="mt-5 rounded-xl border border-rose-400/20 bg-rose-400/5 p-4 text-sm text-rose-200">
                    This position was liquidated after its margin health fell
                    below the contract’s liquidation requirement.
                  </div>
                )}

                {normalizedStatus === "closed" && (
                  <div className="mt-5 rounded-xl border border-white/10 bg-white/5 p-4 text-sm text-slate-400">
                    This position has been closed and can no longer be modified.
                  </div>
                )}
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
function WalletPanel({
  address,
  balances,
  run,
}: {
  address: string | null;
  balances: WalletBalance[];
  run: RunTransaction;
}) {
  const [asset, setAsset] = useState("");
  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState("");

  useEffect(() => {
    if (!asset && balances[0]) setAsset(balances[0].def.asset);
  }, [asset, balances]);

  const selected =
    balances.find((item) => item.def.asset === asset) ?? balances[0];
  const entered = selected
    ? (() => {
        try {
          return parseHumanAmount(amount, selected.def.decimals);
        } catch {
          return 0n;
        }
      })()
    : 0n;
  const tooHigh =
    selected?.balance !== null && selected?.balance !== undefined
      ? entered > selected.balance
      : false;

  return (
    <div className="space-y-6">
      <section className="card p-6">
        <h2 className="font-bold">Wallet balances</h2>
        <p className="mt-1 text-sm text-slate-500">
          USDC and supported base assets, including XLM.
        </p>
        <div className="mt-5 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {balances.map((item) => (
            <div
              key={item.def.asset}
              className="rounded-2xl bg-gradient-to-br from-cyan-300 to-blue-500 p-6 text-slate-950"
            >
              <p className="text-xs font-semibold uppercase">
                {item.def.symbol} balance
              </p>
              <p className="mt-2 text-3xl font-black">
                {formatHumanAmount(item.balance ?? 0n, item.def.decimals)}{" "}
                {item.def.symbol}
              </p>
              <p className="mt-5 text-xs">
                {address ? short(address, 10, 10) : "Not connected"}
              </p>
            </div>
          ))}
        </div>
        {config.network === "TESTNET" && address && (
          <a
            className="btn-secondary mt-4 w-full"
            href={`https://friendbot.stellar.org/?addr=${address}`}
            target="_blank"
            rel="noreferrer"
          >
            Fund testnet account <ExternalLink size={15} />
          </a>
        )}
      </section>

      <section className="card p-6">
        <h2 className="font-bold">Transfer asset</h2>
        <Field label="Asset">
          <AssetSelect
            value={selected?.def.asset ?? ""}
            onChange={setAsset}
            assets={balances.map((item) => item.def)}
          />
        </Field>
        <Field label="Recipient">
          <input
            className="input"
            value={recipient}
            onChange={(e) => setRecipient(e.target.value)}
            placeholder="G... or C..."
          />
        </Field>
        <Field label={`Amount (${selected?.def.symbol ?? "asset"})`}>
          <div className="relative">
            <input
              className="input pr-20"
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
            <button
              type="button"
              className="absolute right-3 top-1/2 -translate-y-1/2 rounded-md px-2 py-1 text-xs font-bold text-cyan-300 hover:bg-cyan-400/10 disabled:opacity-40"
              disabled={!selected || selected.balance === null}
              onClick={() =>
                selected &&
                setAmount(
                  formatInputAmount(
                    selected.balance ?? 0n,
                    selected.def.decimals
                  )
                )
              }
            >
              MAX
            </button>
          </div>
          {tooHigh && (
            <ValidationMessage>
              Amount exceeds your wallet balance.
            </ValidationMessage>
          )}
        </Field>
        <button
          className="btn-primary w-full"
          disabled={
            !address || !recipient || !selected || entered <= 0n || tooHigh
          }
          onClick={() =>
            void run(`${selected?.def.symbol ?? "Asset"} transferred`, () =>
              invokeContract(address!, selected!.def.asset, "transfer", [
                sc.address(address!),
                sc.address(recipient),
                sc.i128(entered),
              ])
            )
          }
        >
          {tooHigh
            ? "Insufficient balance"
            : `Transfer ${selected?.def.symbol ?? "asset"}`}
        </button>
      </section>
    </div>
  );
}

function AssetSelect({
  value,
  onChange,
  assets,
}: {
  value: string;
  onChange: (value: string) => void;
  assets: PoolAsset[];
}) {
  const selected = assets.find((asset) => asset.asset === value) ?? assets[0];
  return (
    <div className="relative">
      {/* <div className="pointer-events-none absolute inset-y-0 left-3 flex items-center gap-3">
        <span className="grid h-8 w-8 place-items-center rounded-full bg-cyan-400/15 text-xs font-black text-cyan-300">
          {selected?.symbol?.slice(0, 2) ?? "--"}
        </span>
      </div> */}
      <select
        className="input h-14 appearance-none pl-14 pr-12 font-semibold"
        value={selected?.asset ?? ""}
        onChange={(e) => onChange(e.target.value)}
      >
        {assets.map((asset) => (
          <option key={asset.asset} value={asset.asset}>
            {asset.symbol} · {asset.name}
          </option>
        ))}
      </select>
      <ChevronDown
        size={18}
        className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-slate-500"
      />
    </div>
  );
}

function ValidationMessage({ children }: { children: ReactNode }) {
  return <p className="mt-2 text-xs font-medium text-rose-400">{children}</p>;
}

function Stat({
  label,
  value,
  icon: Icon,
}: {
  label: string;
  value: string;
  icon: any;
}) {
  return (
    <div className="card p-5">
      <div className="flex items-center justify-between">
        <span className="text-xs uppercase tracking-wider text-slate-500">
          {label}
        </span>
        <Icon size={18} className="text-cyan-300" />
      </div>
      <p className="mt-3 text-2xl font-black">{value}</p>
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="mb-4 block">
      <span className="label">{label}</span>
      {children}
    </label>
  );
}

function Line({ a, b }: { a: string; b: string }) {
  return (
    <div className="flex justify-between gap-4 border-b border-white/5 pb-3 last:border-0 last:pb-0">
      <span className="text-slate-500">{a}</span>
      <b className="text-right">{b}</b>
    </div>
  );
}

function Mini({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-white/5 p-3">
      <p className="text-xs text-slate-500">{label}</p>
      <p className="mt-1 break-words font-semibold">{value}</p>
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return (
    <div className="card grid min-h-52 place-items-center p-8 text-center text-slate-400">
      {text}
    </div>
  );
}

export default App;
