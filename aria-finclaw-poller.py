#!/usr/bin/env python3
# ============================================================
# aria-finclaw-poller.py
# Finclaw financial intelligence poller for Aria.
# Runs alongside aria-agent.ts. Writes JSON files that
# aria-finclaw.ts reads and delivers via iMessage bursts.
#
# Install:
#   pip install yfinance stockstats pandas requests
#
# Run:
#   python aria-finclaw-poller.py
# ============================================================

import json
import time
import os
import math
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Optional

import yfinance as yf
import pandas as pd

try:
    from stockstats import StockDataFrame
    HAS_STOCKSTATS = True
except ImportError:
    HAS_STOCKSTATS = False
    print("[Finclaw] stockstats not found — technical indicators disabled. pip install stockstats")

# ─── PATHS ───────────────────────────────────────────────────

BASE              = Path(__file__).parent
WATCHLIST_PATH    = BASE / "aria-finclaw-watchlist.json"
ALERT_QUEUE_PATH  = BASE / "aria-finclaw-alerts.json"
OPINIONS_PATH     = BASE / "aria-finclaw-opinions.json"
PRICE_CACHE_PATH  = BASE / "aria-finclaw-prices.json"
COMMAND_PATH      = BASE / "aria-finclaw-commands.json"   # TS → Python commands
RESPONSE_PATH     = BASE / "aria-finclaw-responses.json"  # Python → TS responses

# ─── SCHEDULE (ET approximate) ───────────────────────────────

MARKET_OPEN_H  = 9
MARKET_OPEN_M  = 30
MARKET_CLOSE_H = 16
POLL_INTERVAL  = 120   # seconds between price checks during market hours
NEWS_INTERVAL  = 1800  # 30 min — news scan

# ─── HELPERS ─────────────────────────────────────────────────

def now_utc() -> str:
    return datetime.now(timezone.utc).isoformat()

def now_et_hour() -> int:
    # Rough ET (UTC-4 EDT / UTC-5 EST). Good enough for open/close gating.
    from datetime import timezone as tz
    utc = datetime.now(timezone.utc)
    et  = utc - timedelta(hours=4)
    return et.hour

def now_et_minute() -> int:
    from datetime import timezone as tz
    utc = datetime.now(timezone.utc)
    et  = utc - timedelta(hours=4)
    return et.minute

def is_market_open() -> bool:
    now = datetime.now(timezone.utc) - timedelta(hours=4)
    if now.weekday() >= 5: return False
    t = now.hour * 60 + now.minute
    return (MARKET_OPEN_H * 60 + MARKET_OPEN_M) <= t < (MARKET_CLOSE_H * 60)

def load_json(path: Path, default):
    if not path.exists(): return default
    try:
        return json.loads(path.read_text())
    except: return default

def save_json(path: Path, data):
    path.write_text(json.dumps(data, indent=2, default=str))

def safe_float(v, digits=2) -> Optional[float]:
    try:
        f = float(v)
        return round(f, digits) if not math.isnan(f) and not math.isinf(f) else None
    except: return None

# ─── WATCHLIST ───────────────────────────────────────────────

def load_watchlist() -> dict:
    return load_json(WATCHLIST_PATH, {"tickers": {}, "users": {}})
    # tickers: { "NVDA": { "thesis": "...", "opinion": null, "addedAt": "..." } }
    # users:   { senderId: ["NVDA", "AAPL"] }

def all_tickers(wl: dict) -> list[str]:
    return list(wl.get("tickers", {}).keys())

# ─── PRICE QUOTE ─────────────────────────────────────────────

def fetch_quote(ticker: str) -> Optional[dict]:
    try:
        t    = yf.Ticker(ticker)
        info = t.fast_info
        hist = t.history(period="5d", interval="1d")

        price    = safe_float(info.last_price)
        prev     = safe_float(hist["Close"].iloc[-2]) if len(hist) >= 2 else price
        chg_pct  = round((price - prev) / prev * 100, 2) if price and prev else 0
        volume   = int(info.last_volume or 0)
        avg_vol  = int(info.three_month_average_volume or volume or 1)
        mkt_cap  = safe_float(getattr(info, "market_cap", None))

        return {
            "ticker":   ticker.upper(),
            "price":    price,
            "prev":     prev,
            "chg_pct":  chg_pct,
            "volume":   volume,
            "avg_vol":  avg_vol,
            "vol_mult": round(volume / avg_vol, 2) if avg_vol else 1.0,
            "mkt_cap":  mkt_cap,
            "fetched":  now_utc(),
        }
    except Exception as e:
        print(f"[Finclaw] Quote error {ticker}: {e}")
        return None

# ─── FUNDAMENTALS ────────────────────────────────────────────

def fetch_fundamentals(ticker: str) -> dict:
    try:
        t    = yf.Ticker(ticker)
        info = t.info
        return {
            "ticker":        ticker.upper(),
            "name":          info.get("longName", ticker),
            "sector":        info.get("sector", ""),
            "pe":            safe_float(info.get("trailingPE")),
            "fwd_pe":        safe_float(info.get("forwardPE")),
            "peg":           safe_float(info.get("pegRatio")),
            "ps":            safe_float(info.get("priceToSalesTrailing12Months")),
            "pb":            safe_float(info.get("priceToBook")),
            "ev_ebitda":     safe_float(info.get("enterpriseToEbitda")),
            "revenue_growth":safe_float(info.get("revenueGrowth")),
            "earnings_growth":safe_float(info.get("earningsGrowth")),
            "gross_margins": safe_float(info.get("grossMargins")),
            "op_margins":    safe_float(info.get("operatingMargins")),
            "profit_margins":safe_float(info.get("profitMargins")),
            "roe":           safe_float(info.get("returnOnEquity")),
            "debt_equity":   safe_float(info.get("debtToEquity")),
            "current_ratio": safe_float(info.get("currentRatio")),
            "52w_high":      safe_float(info.get("fiftyTwoWeekHigh")),
            "52w_low":       safe_float(info.get("fiftyTwoWeekLow")),
            "analyst_target":safe_float(info.get("targetMeanPrice")),
            "recommendation":info.get("recommendationKey", ""),
            "fetched":       now_utc(),
        }
    except Exception as e:
        print(f"[Finclaw] Fundamentals error {ticker}: {e}")
        return {"ticker": ticker, "error": str(e)}

# ─── TECHNICAL INDICATORS ────────────────────────────────────

def fetch_technicals(ticker: str) -> dict:
    try:
        hist = yf.Ticker(ticker).history(period="6mo", interval="1d")
        if hist.empty or not HAS_STOCKSTATS:
            return {"ticker": ticker, "available": False}

        hist.columns = [c.lower() for c in hist.columns]
        sdf = StockDataFrame.retype(hist.copy())

        def sv(key):
            try: return safe_float(sdf[key].iloc[-1])
            except: return None

        price     = safe_float(hist["close"].iloc[-1])
        sma50     = sv("close_50_sma")
        sma200    = sv("close_200_sma")
        rsi       = sv("rsi_14")
        macd      = sv("macd")
        macd_sig  = sv("macds")
        bb_upper  = sv("boll_ub")
        bb_lower  = sv("boll_lb")
        bb_mid    = sv("boll")

        # MACD crossover (bullish if macd crossed above signal in last 3 days)
        macd_bull = False
        try:
            m  = sdf["macd"].iloc[-5:]
            ms = sdf["macds"].iloc[-5:]
            for i in range(1, len(m)):
                if m.iloc[i-1] < ms.iloc[i-1] and m.iloc[i] >= ms.iloc[i]:
                    macd_bull = True
        except: pass

        above_50  = price > sma50  if price and sma50  else None
        above_200 = price > sma200 if price and sma200 else None

        rsi_label = (
            "overbought" if rsi and rsi > 70 else
            "oversold"   if rsi and rsi < 30 else
            "neutral"
        )

        return {
            "ticker":    ticker.upper(),
            "price":     price,
            "sma50":     sma50,
            "sma200":    sma200,
            "above_50":  above_50,
            "above_200": above_200,
            "rsi":       rsi,
            "rsi_label": rsi_label,
            "macd":      macd,
            "macd_sig":  macd_sig,
            "macd_bull": macd_bull,
            "bb_upper":  bb_upper,
            "bb_lower":  bb_lower,
            "bb_mid":    bb_mid,
            "available": True,
            "fetched":   now_utc(),
        }
    except Exception as e:
        print(f"[Finclaw] Technicals error {ticker}: {e}")
        return {"ticker": ticker, "available": False, "error": str(e)}

# ─── NEWS ────────────────────────────────────────────────────

def fetch_news(ticker: str, limit=5) -> list[dict]:
    try:
        t     = yf.Ticker(ticker)
        news  = t.news or []
        out   = []
        for item in news[:limit]:
            ct = item.get("content", {})
            out.append({
                "title":     ct.get("title", item.get("title", "")),
                "publisher": ct.get("provider", {}).get("displayName", ""),
                "url":       ct.get("canonicalUrl", {}).get("url", ""),
                "published": ct.get("pubDate", ""),
            })
        return out
    except Exception as e:
        print(f"[Finclaw] News error {ticker}: {e}")
        return []

def fetch_market_news(limit=8) -> list[dict]:
    try:
        spy  = yf.Ticker("SPY")
        news = spy.news or []
        out  = []
        for item in news[:limit]:
            ct = item.get("content", {})
            out.append({
                "title":     ct.get("title", item.get("title", "")),
                "publisher": ct.get("provider", {}).get("displayName", ""),
                "url":       ct.get("canonicalUrl", {}).get("url", ""),
            })
        return out
    except: return []

# ─── INSIDER TRANSACTIONS ────────────────────────────────────

def fetch_insiders(ticker: str) -> list[dict]:
    try:
        t   = yf.Ticker(ticker)
        ins = t.insider_transactions
        if ins is None or ins.empty: return []
        rows = []
        for _, row in ins.head(5).iterrows():
            rows.append({
                "insider":   str(row.get("Insider", "")),
                "relation":  str(row.get("Relation", "")),
                "date":      str(row.get("Start Date", "")),
                "shares":    safe_float(row.get("Shares", 0), 0),
                "value":     safe_float(row.get("Value", 0), 0),
                "tx_type":   str(row.get("Transaction", "")),
            })
        return rows
    except Exception as e:
        print(f"[Finclaw] Insiders error {ticker}: {e}")
        return []

# ─── SECTOR PERFORMANCE ──────────────────────────────────────

SECTOR_ETFS = {
    "Technology": "XLK", "Healthcare": "XLV", "Financials": "XLF",
    "Energy": "XLE", "Consumer Disc.": "XLY", "Consumer Staples": "XLP",
    "Industrials": "XLI", "Materials": "XLB", "Utilities": "XLU",
    "Real Estate": "XLRE", "Communication": "XLC",
    "S&P 500": "SPY", "Nasdaq": "QQQ", "Russell 2000": "IWM",
}

def fetch_sectors() -> list[dict]:
    out = []
    for name, etf in SECTOR_ETFS.items():
        q = fetch_quote(etf)
        if q:
            out.append({"name": name, "etf": etf, "chg_pct": q["chg_pct"], "price": q["price"]})
    return sorted(out, key=lambda x: x["chg_pct"], reverse=True)

# ─── RELATED TICKERS ─────────────────────────────────────────

def fetch_related(ticker: str) -> list[str]:
    try:
        info = yf.Ticker(ticker).info
        recs = info.get("recommendedSymbols", [])
        if isinstance(recs, list):
            return [r if isinstance(r, str) else r.get("symbol", "") for r in recs[:5]]
        return []
    except: return []

# ─── OPINION ENGINE ──────────────────────────────────────────
# Simple rules-based opinion. The TS side enriches with Claude.

def generate_opinion(ticker: str, fund: dict, tech: dict, chg_pct: float) -> dict:
    signals = []
    bull = 0
    bear = 0

    pe = fund.get("pe")
    if pe:
        if pe < 15:   bull += 1; signals.append("low PE")
        elif pe > 50: bear += 1; signals.append("high PE")

    rev_growth = fund.get("revenue_growth")
    if rev_growth:
        if rev_growth > 0.20:  bull += 1; signals.append(f"strong revenue growth {rev_growth*100:.0f}%")
        elif rev_growth < 0:   bear += 1; signals.append("declining revenue")

    rsi = tech.get("rsi")
    if rsi:
        if rsi < 30:   bull += 1; signals.append("RSI oversold")
        elif rsi > 70: bear += 1; signals.append("RSI overbought")

    if tech.get("above_200"): bull += 1; signals.append("above 200d SMA")
    else:                     bear += 1; signals.append("below 200d SMA")

    if tech.get("macd_bull"): bull += 1; signals.append("MACD bullish crossover")

    if chg_pct > 5:   bull += 1
    elif chg_pct < -5: bear += 1

    if bull > bear + 1:   stance = "Bullish";  conviction = "High" if bull - bear >= 3 else "Moderate"
    elif bear > bull + 1: stance = "Bearish";  conviction = "High" if bear - bull >= 3 else "Moderate"
    else:                 stance = "Neutral";  conviction = "Low"

    return {
        "ticker":     ticker,
        "stance":     stance,
        "conviction": conviction,
        "bull_count": bull,
        "bear_count": bear,
        "signals":    signals,
        "updated":    now_utc(),
    }

# ─── MORNING BRIEF ───────────────────────────────────────────

def build_morning_brief(wl: dict, prices: dict) -> dict:
    items = []
    for ticker in all_tickers(wl):
        q = prices.get(ticker)
        if not q: continue
        news = fetch_news(ticker, 2)
        items.append({
            "ticker":   ticker,
            "price":    q["price"],
            "chg_pct":  q["chg_pct"],
            "news":     [n["title"] for n in news],
        })
    return {"type": "morning_brief", "items": items, "generated": now_utc()}

# ─── COMMAND HANDLER ─────────────────────────────────────────
# TS writes commands here, Python processes and responds.

def process_commands():
    cmds = load_json(COMMAND_PATH, [])
    if not cmds: return

    responses = load_json(RESPONSE_PATH, [])
    remaining = []

    for cmd in cmds:
        ctype  = cmd.get("type")
        ticker = cmd.get("ticker", "").upper()
        rid    = cmd.get("id")

        try:
            if ctype == "quote":
                data = fetch_quote(ticker)
                responses.append({"id": rid, "type": "quote", "data": data})

            elif ctype == "fundamentals":
                data = fetch_fundamentals(ticker)
                responses.append({"id": rid, "type": "fundamentals", "data": data})

            elif ctype == "technicals":
                data = fetch_technicals(ticker)
                responses.append({"id": rid, "type": "technicals", "data": data})

            elif ctype == "news":
                data = fetch_news(ticker, cmd.get("limit", 5))
                responses.append({"id": rid, "type": "news", "ticker": ticker, "data": data})

            elif ctype == "market_news":
                data = fetch_market_news()
                responses.append({"id": rid, "type": "market_news", "data": data})

            elif ctype == "insiders":
                data = fetch_insiders(ticker)
                responses.append({"id": rid, "type": "insiders", "ticker": ticker, "data": data})

            elif ctype == "sectors":
                data = fetch_sectors()
                responses.append({"id": rid, "type": "sectors", "data": data})

            elif ctype == "related":
                data = fetch_related(ticker)
                responses.append({"id": rid, "type": "related", "ticker": ticker, "data": data})

            elif ctype == "full_analysis":
                fund = fetch_fundamentals(ticker)
                tech = fetch_technicals(ticker)
                q    = fetch_quote(ticker)
                news = fetch_news(ticker, 5)
                ins  = fetch_insiders(ticker)
                rel  = fetch_related(ticker)
                opinion = generate_opinion(ticker, fund, tech, q["chg_pct"] if q else 0)
                responses.append({
                    "id": rid, "type": "full_analysis", "ticker": ticker,
                    "data": { "quote": q, "fundamentals": fund, "technicals": tech,
                              "news": news, "insiders": ins, "related": rel, "opinion": opinion }
                })

            else:
                remaining.append(cmd)
                continue

        except Exception as e:
            print(f"[Finclaw] Command error {ctype}/{ticker}: {e}")
            responses.append({"id": rid, "type": "error", "error": str(e)})

    save_json(COMMAND_PATH, remaining)
    save_json(RESPONSE_PATH, responses)

# ─── PROACTIVE ALERT SCAN ────────────────────────────────────

PRICE_MOVE_NOTABLE = 3.0    # % — notable move
PRICE_MOVE_URGENT  = 6.0    # % — urgent alert
VOL_SPIKE          = 2.5    # x average volume
COOLDOWN_MIN       = 60     # minutes between alerts per ticker

last_alert_time: dict[str, float] = {}

def check_alerts(prices: dict, wl: dict):
    queue   = load_json(ALERT_QUEUE_PATH, [])
    ops     = load_json(OPINIONS_PATH, {})
    changed = False

    for ticker, q in prices.items():
        if ticker not in wl.get("tickers", {}): continue

        now_ts = time.time()
        last   = last_alert_time.get(ticker, 0)
        if now_ts - last < COOLDOWN_MIN * 60: continue

        abs_chg = abs(q.get("chg_pct", 0))
        vol_m   = q.get("vol_mult", 1)
        tier    = None

        if abs_chg >= PRICE_MOVE_URGENT or vol_m >= 3.0:
            tier = "urgent"
        elif abs_chg >= PRICE_MOVE_NOTABLE or vol_m >= VOL_SPIKE:
            tier = "notable"

        if tier:
            # Get users watching this ticker
            recipients = []
            for uid, tickers in wl.get("users", {}).items():
                if ticker in tickers:
                    recipients.append(uid)

            queue.append({
                "tier":       tier,
                "ticker":     ticker,
                "price":      q["price"],
                "chg_pct":    q["chg_pct"],
                "vol_mult":   vol_m,
                "thesis":     wl["tickers"].get(ticker, {}).get("thesis"),
                "opinion":    ops.get(ticker, {}).get("stance"),
                "recipients": recipients,
                "sent":       False,
                "created":    now_utc(),
            })
            last_alert_time[ticker] = now_ts
            changed = True

    if changed:
        save_json(ALERT_QUEUE_PATH, queue)

# ─── MAIN LOOP ───────────────────────────────────────────────

def main():
    print("[Finclaw] Starting poller...")
    prices: dict = {}
    last_news_scan = 0
    last_morning_brief = ""
    last_eod_brief = ""
    last_weekly = ""

    while True:
        now = datetime.now(timezone.utc)
        et_hour = now_et_hour()
        et_min  = now_et_minute()

        # ── Process on-demand commands from TS ────────────────
        process_commands()

        # ── Price poll ────────────────────────────────────────
        if is_market_open() or True:  # poll always for after-hours tracking
            wl = load_watchlist()
            tickers = all_tickers(wl)

            for ticker in tickers:
                q = fetch_quote(ticker)
                if q: prices[ticker] = q
                time.sleep(0.3)   # gentle rate limiting

            save_json(PRICE_CACHE_PATH, prices)
            check_alerts(prices, wl)

        # ── Morning brief (9:20 AM ET on weekdays) ─────────────
        today = now.strftime("%Y-%m-%d")
        if et_hour == 9 and et_min < 25 and today != last_morning_brief and now.weekday() < 5:
            wl = load_watchlist()
            brief = build_morning_brief(wl, prices)
            queue = load_json(ALERT_QUEUE_PATH, [])
            for uid, tickers in wl.get("users", {}).items():
                queue.append({**brief, "recipient": uid, "sent": False})
            save_json(ALERT_QUEUE_PATH, queue)
            last_morning_brief = today
            print("[Finclaw] Morning brief queued")

        # ── EOD summary (4:05 PM ET on weekdays) ───────────────
        if et_hour == 16 and et_min < 10 and today != last_eod_brief and now.weekday() < 5:
            wl  = load_watchlist()
            ops = load_json(OPINIONS_PATH, {})

            # Refresh opinions for all tickers
            for ticker in all_tickers(wl):
                fund = fetch_fundamentals(ticker)
                tech = fetch_technicals(ticker)
                q    = prices.get(ticker, {})
                op   = generate_opinion(ticker, fund, tech, q.get("chg_pct", 0))
                ops[ticker] = op
            save_json(OPINIONS_PATH, ops)

            eod = {
                "type":      "eod_summary",
                "prices":    prices,
                "opinions":  ops,
                "generated": now_utc(),
            }
            queue = load_json(ALERT_QUEUE_PATH, [])
            for uid, tickers in wl.get("users", {}).items():
                queue.append({**eod, "recipient": uid, "sent": False})
            save_json(ALERT_QUEUE_PATH, queue)
            last_eod_brief = today
            print("[Finclaw] EOD summary queued")

        # ── News scan every 30 min ─────────────────────────────
        if time.time() - last_news_scan > NEWS_INTERVAL:
            wl = load_watchlist()
            for ticker in all_tickers(wl):
                news = fetch_news(ticker, 3)
                if news:
                    # Queue interesting news (basic keyword filter)
                    for n in news:
                        title = n.get("title", "").lower()
                        if any(kw in title for kw in [
                            "earnings", "beat", "miss", "acquisition", "merger",
                            "fda", "sec", "layoff", "ceo", "guidance", "revenue",
                            "analyst", "upgrade", "downgrade", "buyback", "dividend"
                        ]):
                            recipients = []
                            for uid, tickers in wl.get("users", {}).items():
                                if ticker in tickers: recipients.append(uid)
                            if recipients:
                                queue = load_json(ALERT_QUEUE_PATH, [])
                                queue.append({
                                    "type":       "news_alert",
                                    "ticker":     ticker,
                                    "headline":   n["title"],
                                    "publisher":  n.get("publisher", ""),
                                    "url":        n.get("url", ""),
                                    "recipients": recipients,
                                    "sent":       False,
                                    "created":    now_utc(),
                                })
                                save_json(ALERT_QUEUE_PATH, queue)
            last_news_scan = time.time()

        sleep_secs = POLL_INTERVAL if is_market_open() else 300
        time.sleep(sleep_secs)

if __name__ == "__main__":
    main()
