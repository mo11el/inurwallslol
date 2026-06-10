// ============================================================
// aria-finclaw.ts
// Finclaw financial intelligence fully integrated into Aria.
// Every feature — watchlist, morning brief, EOD summary, news
// alerts, technicals, fundamentals, insiders, sectors,
// discovery, opinions, theses — delivered as iMessage bursts
// with Aria's persona and stock analysis protocol intact.
//
// Architecture:
//   aria-finclaw-poller.py  →  JSON files  →  aria-finclaw.ts
//   (yfinance Python)          (bridge)        (TS / delivery)
//
// Drop next to aria-agent.ts.
//
// Import in aria-agent.ts:
//   import { FinclawEngine } from "./aria-finclaw";
//   const finclaw = new FinclawEngine(sdk, advancedSdk);
//   finclaw.start();
//
// In handleMessage(), before callAria():
//   const handled = await finclaw.handleIntent(text, senderId, msg.chatId, msg.guid);
//   if (handled) continue;
//
// Run alongside:
//   python aria-finclaw-poller.py
// ============================================================

import fs from "fs";
import path from "path";
import Anthropic from "@anthropic-ai/sdk";

import { AriaMessaging, Burst } from "./aria-messaging";

// ─── FILE PATHS ───────────────────────────────────────────────

const BASE = process.cwd();
const WATCHLIST = path.join(BASE, "aria-finclaw-watchlist.json");
const ALERT_QUEUE = path.join(BASE, "aria-finclaw-alerts.json");
const OPINIONS = path.join(BASE, "aria-finclaw-opinions.json");
const PRICE_CACHE = path.join(BASE, "aria-finclaw-prices.json");
const COMMAND_PATH = path.join(BASE, "aria-finclaw-commands.json");
const RESPONSE_PATH = path.join(BASE, "aria-finclaw-responses.json");

// ─── TYPES ───────────────────────────────────────────────────

interface WatchlistStore {
  tickers: Record<string, { thesis?: string; opinion?: string; addedAt: string }>;
  users: Record<string, string[]>;   // senderId → [tickers]
}

interface PriceData {
  ticker: string; price: number; prev: number; chg_pct: number;
  volume: number; avg_vol: number; vol_mult: number; mkt_cap?: number; fetched: string;
}

interface FundamentalsData {
  ticker: string; name?: string; sector?: string;
  pe?: number; fwd_pe?: number; peg?: number; ps?: number; pb?: number;
  ev_ebitda?: number; revenue_growth?: number; earnings_growth?: number;
  gross_margins?: number; op_margins?: number; profit_margins?: number;
  roe?: number; debt_equity?: number; current_ratio?: number;
  "52w_high"?: number; "52w_low"?: number; analyst_target?: number; recommendation?: string;
}

interface TechnicalData {
  ticker: string; available: boolean; price?: number;
  sma50?: number; sma200?: number; above_50?: boolean; above_200?: boolean;
  rsi?: number; rsi_label?: string; macd?: number; macd_sig?: number; macd_bull?: boolean;
  bb_upper?: number; bb_lower?: number; bb_mid?: number;
}

interface NewsItem { title: string; publisher?: string; url?: string; published?: string; }
interface InsiderTx { insider: string; relation: string; date: string; shares: number; value: number; tx_type: string; }
interface SectorItem { name: string; etf: string; chg_pct: number; price: number; }
interface Opinion { ticker: string; stance: "Bullish" | "Neutral" | "Bearish"; conviction: string; signals: string[]; }

interface FinclawAlert {
  type: string;
  tier?: "notable" | "urgent";
  ticker?: string;
  price?: number;
  chg_pct?: number;
  vol_mult?: number;
  thesis?: string;
  opinion?: string;
  headline?: string;
  publisher?: string;
  url?: string;
  items?: unknown[];
  recipient?: string;
  recipients?: string[];
  sent: boolean;
  created?: string;
}

// ─── FILE HELPERS ─────────────────────────────────────────────

function readJSON<T>(p: string, def: T): T {
  try { return JSON.parse(fs.readFileSync(p, "utf8")) as T; } catch { return def; }
}
function writeJSON(p: string, d: unknown): void {
  fs.writeFileSync(p, JSON.stringify(d, null, 2), "utf8");
}

// ─── COMMAND BUS (TS → Python → TS) ──────────────────────────

let cmdSeq = 0;

async function requestData(type: string, ticker?: string, extra?: Record<string, unknown>): Promise<Record<string, unknown> | null> {
  const id = `cmd_${Date.now()}_${cmdSeq++}`;
  const cmd = { id, type, ticker, ...extra };

  const cmds = readJSON<unknown[]>(COMMAND_PATH, []);
  cmds.push(cmd);
  writeJSON(COMMAND_PATH, cmds);

  // Poll response file for up to 30s
  for (let i = 0; i < 60; i++) {
    
    const responses = readJSON<{ id: string; data?: unknown; error?: string }[]>(RESPONSE_PATH, []);
    const match = responses.find((r) => r.id === id);
    if (match) {
      // Remove from response file
      writeJSON(RESPONSE_PATH, responses.filter((r) => r.id !== id));
      if (match.error) { console.error(`[Finclaw] Command error: ${match.error}`); return null; }
      return match as Record<string, unknown>;
    }
  }

  console.warn(`[Finclaw] Command timeout: ${type}/${ticker}`);
  return null;
}

// ─── CLAUDE — ARIA STOCK ANALYSIS PROTOCOL ───────────────────
// Four-layer analysis as specified in Enhanced Aria PDF.

const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY ?? "" });

async function ariaStockAnalysis(
  ticker: string,
  data: { quote?: PriceData; fundamentals?: FundamentalsData; technicals?: TechnicalData; news?: NewsItem[]; opinion?: Opinion; thesis?: string },
): Promise<string[]> {
  const { quote, fundamentals, technicals, news, opinion, thesis } = data;

  const contextLines = [
    quote ? `Price: $${quote.price} (${quote.chg_pct > 0 ? "+" : ""}${quote.chg_pct}% today)` : "",
    fundamentals?.pe ? `P/E: ${fundamentals.pe}` : "",
    fundamentals?.fwd_pe ? `Fwd P/E: ${fundamentals.fwd_pe}` : "",
    fundamentals?.revenue_growth ? `Revenue growth: ${(fundamentals.revenue_growth * 100).toFixed(0)}%` : "",
    fundamentals?.gross_margins ? `Gross margins: ${(fundamentals.gross_margins * 100).toFixed(0)}%` : "",
    technicals?.rsi ? `RSI: ${technicals.rsi} (${technicals.rsi_label})` : "",
    technicals?.above_200 !== undefined ? `200d SMA: ${technicals.above_200 ? "above ✅" : "below ⚠️"}` : "",
    technicals?.macd_bull ? "MACD: bullish crossover" : "",
    opinion ? `Signals: ${opinion.stance} (${opinion.conviction} conviction)` : "",
    thesis ? `User thesis: ${thesis}` : "",
    news?.length ? `Recent headlines: ${news.slice(0, 3).map((n) => n.title).join(" | ")}` : "",
    fundamentals?.recommendation ? `Analyst consensus: ${fundamentals.recommendation}` : "",
  ].filter(Boolean).join("\n");

  const prompt = `You are Aria using the four-layer stock analysis protocol.

Ticker: ${ticker}
Data:
${contextLines}

Generate a four-layer analysis as a JSON array of short iMessage bursts.
Each burst is one iMessage bubble — 1-2 sentences, under 25 words.
Total 8-14 bursts covering:
  1. Opening observation (1-3 bursts): witty, sharp, identifies the narrative/absurdity. Do NOT preface with "Layer 1" etc.
  2. Objective analysis (3-5 bursts): factual — price action, key metrics, what matters. No humor here.
  3. Market narrative (2-3 bursts): what bulls are buying, what bears are selling, what's in the price.
  4. Closing thought (1 burst): under 15 words. Memorable. Slightly cynical but not pessimistic.

Return ONLY a JSON array of strings. No markdown. No labels. Just the bursts.
Example: ["opening obs.", "transition to facts.", "metric detail.", "bull thesis.", "bear thesis.", "closing."]`;

  try {
    const resp = await claude.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 800,
      messages: [{ role: "user", content: prompt }],
    });

    const raw = resp.content
      .filter((b: any) => b.type === "text")
      .map((b: any) => b.text)
      .join("")
      .trim();

    const arr = JSON.parse(raw.replace(/```json?|```/g, "").trim()) as string[];
    return Array.isArray(arr) ? arr : [raw];
  } catch (err) {
    console.error("[Finclaw] Claude analysis error:", err);
    return [
      `${ticker} — $${quote?.price ?? "?"} (${quote?.chg_pct ?? "?"}% today).`,
      opinion ? `${opinion.stance} with ${opinion.conviction.toLowerCase()} conviction.` : "",
    ].filter(Boolean);
  }
}

// ─── FORMATTERS ───────────────────────────────────────────────

function pct(n?: number | null): string {
  if (n === null || n === undefined) return "n/a";
  const s = n >= 0 ? "+" : "";
  return `${s}${n.toFixed(1)}%`;
}
function usd(n?: number | null): string {
  if (n === null || n === undefined) return "n/a";
  return `$${n.toFixed(2)}`;
}
function fmt(n?: number | null, digits = 2): string {
  if (n === null || n === undefined) return "n/a";
  return n.toFixed(digits);
}

function formatMorningBrief(items: { ticker: string; price: number; chg_pct: number; news: string[] }[]): Burst[] {
  const bursts: Burst[] = [
    { text: "good morning. market opens in 30 min." },
    { text: "here's your watchlist:" },
  ];
  for (const item of items) {
    const flag = Math.abs(item.chg_pct) >= 3 ? " ⚠️" : "";
    bursts.push({ text: `${item.ticker}: ${usd(item.price)} (${pct(item.chg_pct)} pre-mkt)${flag}` });
    if (item.news?.length) {
      bursts.push({ text: item.news[0]! });
    }
  }
  return bursts;
}

function formatEOD(prices: Record<string, PriceData>, opinions: Record<string, Opinion>, userTickers: string[]): Burst[] {
  const relevant = userTickers.filter((t) => prices[t]);
  if (!relevant.length) return [{ text: "market closed. nothing significant to report." }];

  const sorted = relevant.sort((a, b) => (prices[b]?.chg_pct ?? 0) - (prices[a]?.chg_pct ?? 0));
  const bursts: Burst[] = [{ text: "market close." }];

  for (const t of sorted) {
    const q = prices[t]!;
    const op = opinions[t];
    const flag = Math.abs(q.chg_pct) >= 4 ? " ⚠️" : "";
    const opStr = op ? `  ${op.stance.toLowerCase()}.` : "";
    bursts.push({ text: `${t} ${pct(q.chg_pct)}  ${usd(q.price)}${flag}${opStr}` });
  }

  return bursts;
}

function formatTechnicals(tech: TechnicalData): Burst[] {
  if (!tech.available) return [{ text: `no technical data available for ${tech.ticker}.` }];
  return [
    { text: `${tech.ticker} technicals.` },
    { text: `RSI: ${fmt(tech.rsi, 0)} — ${tech.rsi_label ?? "neutral"}.` },
    { text: `MACD: ${tech.macd_bull ? "bullish crossover." : "no recent crossover."}` },
    { text: `200d SMA: ${tech.above_200 ? "above ✅" : "below ⚠️"}. 50d: ${tech.above_50 ? "above ✅" : "below ⚠️"}.` },
    ...(tech.bb_upper && tech.bb_lower && tech.price
      ? [{ text: `Bollinger: ${tech.price > (tech.bb_upper ?? Infinity) ? "above upper band." : tech.price < (tech.bb_lower ?? -Infinity) ? "below lower band." : "trading within bands."}` }]
      : []),
  ];
}

function formatFundamentals(fund: FundamentalsData, price?: number): Burst[] {
  const bursts: Burst[] = [
    { text: `${fund.ticker}${fund.name ? ` — ${fund.name}` : ""}.` },
  ];
  if (fund.pe) bursts.push({ text: `P/E: ${fmt(fund.pe, 0)}. Fwd P/E: ${fmt(fund.fwd_pe, 0)}.` });
  if (fund.revenue_growth !== undefined && fund.revenue_growth !== null)
    bursts.push({ text: `revenue growth: ${pct(fund.revenue_growth * 100)}.` });
  if (fund.gross_margins !== undefined && fund.gross_margins !== null)
    bursts.push({ text: `gross margins: ${pct(fund.gross_margins * 100)}.  op margins: ${pct((fund.op_margins ?? 0) * 100)}.` });
  if (fund.roe) bursts.push({ text: `ROE: ${pct(fund.roe * 100)}.  debt/equity: ${fmt(fund.debt_equity)}.` });
  if (fund["52w_high"] && fund["52w_low"] && price)
    bursts.push({ text: `52w range: ${usd(fund["52w_low"])} – ${usd(fund["52w_high"])}.  now: ${usd(price)}.` });
  if (fund.analyst_target)
    bursts.push({ text: `analyst target: ${usd(fund.analyst_target)}.  consensus: ${fund.recommendation ?? "n/a"}.` });
  return bursts;
}

function formatInsiders(ticker: string, txs: InsiderTx[]): Burst[] {
  if (!txs.length) return [{ text: `no notable insider activity for ${ticker} recently.` }];
  const bursts: Burst[] = [{ text: `insider activity — ${ticker}:` }];
  for (const tx of txs.slice(0, 4)) {
    const dir = tx.tx_type.toLowerCase().includes("buy") ? "bought" : "sold";
    const val = tx.value ? ` ($${(tx.value / 1_000_000).toFixed(1)}M)` : "";
    bursts.push({ text: `${tx.insider} ${dir} ${tx.shares?.toLocaleString() ?? "?"} shares${val}.  ${tx.date}.` });
  }
  return bursts;
}

function formatSectors(sectors: SectorItem[]): Burst[] {
  if (!sectors.length) return [{ text: "sector data unavailable right now." }];
  const bursts: Burst[] = [{ text: "sector snapshot:" }];
  const top = sectors.filter((s) => s.chg_pct > 0).slice(0, 3);
  const bottom = sectors.filter((s) => s.chg_pct < 0).slice(-3);
  for (const s of top) bursts.push({ text: `${s.name} (${s.etf}): ${pct(s.chg_pct)} ✅` });
  for (const s of bottom) bursts.push({ text: `${s.name} (${s.etf}): ${pct(s.chg_pct)} ⚠️` });
  return bursts;
}

// ─── INTENT DETECTION ─────────────────────────────────────────

const TICKER_RE = /\$?([A-Z]{1,5})\b/g;

const INTENTS = {
  add_watchlist: /(?:add|watch|track|follow)\s+\$?([A-Z]{1,5})(?:\s*[,.]?\s*(?:thesis|my thesis|because|i think|i believe|:)\s*(.+))?/i,
  remove_watch: /(?:remove|unwatch|stop tracking|drop)\s+\$?([A-Z]{1,5})/i,
  my_watchlist: /(?:my watchlist|what(?:'m| am) i watching|show (?:my )?watchlist|list (?:my )?stocks)/i,
  deep_analysis: /(?:deep dive|full analysis|analyze|deep analysis|tell me (?:everything )?about)\s+\$?([A-Z]{1,5})/i,
  technicals: /(?:technical|technicals|chart|RSI|MACD|moving average)\s+(?:for\s+|on\s+)?\$?([A-Z]{1,5})/i,
  fundamentals: /(?:fundamental|valuation|is\s+\$?([A-Z]{1,5})\s+(?:cheap|expensive|overvalued|undervalued)|PE|margins|balance sheet)\s+(?:for\s+|on\s+)?\$?([A-Z]{1,5})?/i,
  insiders: /(?:insider|insiders|insider (?:buy|sell|activity|trading))\s+(?:for\s+|in\s+)?\$?([A-Z]{1,5})?/i,
  sectors: /(?:sector|sectors|sector (?:performance|rotation)|how(?:'s| is) (?:the )?market|market today)/i,
  news_ticker: /(?:news|headlines|what(?:'s| is) (?:happening|going on) with)\s+\$?([A-Z]{1,5})/i,
  market_news: /(?:market news|what(?:'s| is) (?:happening|going on) (?:in )?(?:the )?market|broad market)/i,
  quick_quote: /(?:price|quote|how(?:'s| is)|what(?:'s| is))\s+(?:the\s+)?(?:price\s+of\s+)?\$?([A-Z]{1,5})\b/i,
  opinion: /(?:what(?:'s| is) your (?:take|opinion|view|stance) on|thoughts? on|bullish|bearish)\s+\$?([A-Z]{1,5})/i,
  related: /(?:related|similar|peers|competitors|alternatives)\s+(?:to\s+)?\$?([A-Z]{1,5})/i,
  morning_brief: /(?:morning brief|my brief|watchlist update|pre[\s-]?market)/i,
};

function extractTicker(text: string, group = 1): string | null {
  for (const [name, re] of Object.entries(INTENTS)) {
    const m = text.match(re);
    if (m?.[group]) return m[group].toUpperCase();
  }
  const tickers = [...text.matchAll(TICKER_RE)].map((m) => m[1]);
  return tickers[0] ?? null;
}

// ─── WATCHLIST HELPERS ────────────────────────────────────────

function loadWatchlist(): WatchlistStore {
  return readJSON<WatchlistStore>(WATCHLIST, { tickers: {}, users: {} });
}
function saveWatchlist(w: WatchlistStore): void { writeJSON(WATCHLIST, w); }

function addToWatchlist(senderId: string, ticker: string, thesis?: string): void {
  const w = loadWatchlist();
  if (!w.tickers[ticker]) w.tickers[ticker] = { addedAt: new Date().toISOString() };
  if (thesis) w.tickers[ticker].thesis = thesis;
  if (!w.users[senderId]) w.users[senderId] = [];
  if (!w.users[senderId].includes(ticker)) w.users[senderId].push(ticker);
  saveWatchlist(w);
}

function removeFromWatchlist(senderId: string, ticker: string): void {
  const w = loadWatchlist();
  if (w.users[senderId]) {
    w.users[senderId] = w.users[senderId].filter((t) => t !== ticker);
  }
  saveWatchlist(w);
}

function getUserTickers(senderId: string): string[] {
  return loadWatchlist().users[senderId] ?? [];
}

// ─── ALERT QUEUE DRAIN ────────────────────────────────────────

async function drainAlerts(sdk: any, chatIdMap: Map<string, string>): Promise<void> {
  const queue = readJSON<FinclawAlert[]>(ALERT_QUEUE, []);
  const prices = readJSON<Record<string, PriceData>>(PRICE_CACHE, {});
  const opinions = readJSON<Record<string, Opinion>>(OPINIONS, {});
  let changed = false;

  for (const alert of queue) {
    if (alert.sent) continue;

    const recipients: string[] = alert.recipient
      ? [alert.recipient]
      : (alert.recipients ?? []);

    for (const uid of recipients) {
      const chatId = chatIdMap.get(uid);
      if (!chatId) continue;

      try {
        if (alert.type === "morning_brief" && Array.isArray(alert.items)) {
          const bursts = formatMorningBrief(alert.items as { ticker: string; price: number; chg_pct: number; news: string[] }[]);
          await messaging.sendBursts( chatId, bursts);

        } else if (alert.type === "eod_summary") {
          const userTickers = getUserTickers(uid);
          const bursts = formatEOD(prices, opinions, userTickers);
          await messaging.sendBursts( chatId, bursts);

        } else if (alert.type === "news_alert" && alert.ticker && alert.headline) {
          const wl = loadWatchlist();
          const thesis = wl.tickers[alert.ticker]?.thesis;
          const op = opinions[alert.ticker];

          const bursts: Burst[] = [
            { text: `${alert.ticker}.` },
            { text: alert.headline },
          ];
          if (thesis) bursts.push({ text: `touches on your thesis: ${thesis.slice(0, 80)}${thesis.length > 80 ? "..." : ""}` });
          if (op) bursts.push({ text: `i'm ${op.stance.toLowerCase()} on this one.` });
          if (alert.url) bursts.push({ text: alert.url });

          await messaging.sendBursts( chatId, bursts);

        } else if ((alert.type === "price_alert" || alert.tier) && alert.ticker) {
          const tier = alert.tier ?? "notable";
          const wl = loadWatchlist();
          const thesis = wl.tickers[alert.ticker]?.thesis;
          const op = opinions[alert.ticker];
          const prefix = tier === "urgent" ? "hey." : "heads up.";

          const bursts: Burst[] = [
            { text: prefix },
            { text: `${alert.ticker} ${(alert.chg_pct ?? 0) >= 0 ? "up" : "down"} ${Math.abs(alert.chg_pct ?? 0).toFixed(1)}% today.` },
            { text: `trading at ${usd(alert.price)}.` },
          ];
          if ((alert.vol_mult ?? 0) >= 2) bursts.push({ text: `volume ${alert.vol_mult?.toFixed(1)}x average.` });
          if (thesis) bursts.push({ text: `worth noting for your thesis.` });
          if (op) bursts.push({ text: `still ${op.stance.toLowerCase()} with ${op.conviction.toLowerCase()} conviction.` });

          await messaging.sendBursts( chatId, bursts);
        }

        alert.sent = true;
        changed = true;
        

      } catch (err) {
        console.error(`[Finclaw] Alert delivery error:`, err);
      }
    }
  }

  // Prune old sent alerts (>24h)
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  const pruned = queue.filter((a) => !a.sent || new Date(a.created ?? 0).getTime() > cutoff);
  if (changed || pruned.length !== queue.length) writeJSON(ALERT_QUEUE, pruned);
}

// ─── FINCLAW ENGINE ───────────────────────────────────────────

export class FinclawEngine {
  private messaging: AriaMessaging;
  private chatMap: Map<string, string> = new Map(); // senderId → chatId
  private handle: ReturnType<typeof setInterval> | null = null;

  constructor(messaging: AriaMessaging, adv?: any) {
    this.messaging = messaging;
  }

  start(): void {
    this.handle = setInterval(() => drainAlerts(this.messaging, this.chatMap), 15_000);
    console.log("[Finclaw] Engine started — draining alerts every 15s");
  }

  stop(): void { if (this.handle) clearInterval(this.handle); }

  registerChat(senderId: string, chatId: string): void {
    if (!this.chatMap.has(senderId)) this.chatMap.set(senderId, chatId);
  }

  // ── Main intent handler ───────────────────────────────────

  async handleIntent(
    text: string,
    senderId: string,
    chatId: string,
    msgGuid: string,
  ): Promise<boolean> {
    this.registerChat(senderId, chatId);

    const t = text.trim();

    // ── Add to watchlist ────────────────────────────────────
    const addM = t.match(INTENTS.add_watchlist);
    if (addM) {
      const ticker = addM[1]!.toUpperCase();
      const thesis = addM[2]?.trim();
      addToWatchlist(senderId, ticker, thesis);
      const bursts: Burst[] = [
        { text: `added ${ticker}.` },
        thesis ? { text: `thesis noted: "${thesis.slice(0, 60)}${thesis.length > 60 ? "..." : ""}"` }
          : { text: `no thesis yet — share it anytime and i'll factor it in.` },
      ];
      // Pull quick quote
      const resp = await requestData("quote", ticker);
      const q = resp?.data as PriceData | undefined;
      if (q) {
        bursts.push({ text: `currently ${usd(q.price)} (${pct(q.chg_pct)} today).` });
        // Background opinion
        const fresp = await requestData("full_analysis", ticker);
        const op = (fresp?.data as { opinion?: Opinion })?.opinion;
        if (op) bursts.push({ text: `i'm ${op.stance.toLowerCase()} — ${op.conviction.toLowerCase()} conviction.` });
      }
      await this.messaging.sendBursts(chatId, bursts);
      return true;
    }

    // ── Remove from watchlist ───────────────────────────────
    const rmM = t.match(INTENTS.remove_watch);
    if (rmM) {
      const ticker = rmM[1]!.toUpperCase();
      removeFromWatchlist(senderId, ticker);
      await this.messaging.tapback(chatId, msgGuid, "like");
      await this.messaging.sendBursts(chatId, [
        { text: `removed ${ticker} from your watchlist.` },
      ]);
      return true;
    }

    // ── Show watchlist ──────────────────────────────────────
    if (INTENTS.my_watchlist.test(t)) {
      const tickers = getUserTickers(senderId);
      const prices = readJSON<Record<string, PriceData>>(PRICE_CACHE, {});
      const opinions = readJSON<Record<string, Opinion>>(OPINIONS, {});
      const wl = loadWatchlist();

      if (!tickers.length) {
        await this.messaging.sendBursts(chatId, [
          { text: "your watchlist is empty." },
          { text: "say 'watch $AAPL' to add a stock." },
        ]);
        return true;
      }

      const bursts: Burst[] = [{ text: "your watchlist:" }];
      for (const ticker of tickers) {
        const q = prices[ticker];
        const op = opinions[ticker];
        const th = wl.tickers[ticker]?.thesis;
        const line = q
          ? `${ticker}  ${usd(q.price)}  ${pct(q.chg_pct)}${op ? `  ${op.stance.toLowerCase()}` : ""}`
          : `${ticker}  —  (no data yet)`;
        bursts.push({ text: line });
        if (th) bursts.push({ text: `thesis: ${th.slice(0, 70)}${th.length > 70 ? "..." : ""}`, delayMs: 400 });
      }
      await this.messaging.sendBursts(chatId, bursts);
      return true;
    }

    // ── Morning brief ───────────────────────────────────────
    if (INTENTS.morning_brief.test(t)) {
      const tickers = getUserTickers(senderId);
      const prices = readJSON<Record<string, PriceData>>(PRICE_CACHE, {});
      const items = tickers
        .filter((t) => prices[t])
        .map((t) => ({ ticker: t, price: prices[t]!.price, chg_pct: prices[t]!.chg_pct, news: [] as string[] }));
      if (!items.length) {
        await this.messaging.sendBursts(chatId, [{ text: "nothing in your watchlist yet. add some tickers first." }]);
        return true;
      }
      const bursts = formatMorningBrief(items);
      await this.messaging.sendBursts(chatId, bursts);
      return true;
    }

    // ── Deep analysis ───────────────────────────────────────
    const deepM = t.match(INTENTS.deep_analysis);
    if (deepM) {
      const ticker = deepM[1]!.toUpperCase();
      await this.messaging.sendBursts(chatId, [
        { text: `pulling full analysis on ${ticker}.` },
        { text: `give me a sec.` },
      ]);

      const resp = await requestData("full_analysis", ticker);
      if (!resp?.data) {
        await this.messaging.sendBursts( chatId, [{ text: `couldn't get data for ${ticker} right now.` }]);
        return true;
      }

      const d = resp.data as { quote?: PriceData; fundamentals?: FundamentalsData; technicals?: TechnicalData; news?: NewsItem[]; insiders?: InsiderTx[]; opinion?: Opinion };
      const wl = loadWatchlist();
      const thesis = wl.tickers[ticker]?.thesis;

      const analysis = await ariaStockAnalysis(ticker, { ...d, thesis });
      await this.messaging.sendBursts( chatId, analysis.map((t) => ({ text: t })));

      // Follow-up with tech + fundamentals after a pause
      
      if (d.technicals?.available) {
        await this.messaging.sendBursts( chatId, formatTechnicals(d.technicals));
      }
      
      if (d.fundamentals) {
        await this.messaging.sendBursts( chatId, formatFundamentals(d.fundamentals, d.quote?.price));
      }
      return true;
    }

    // ── Technicals ──────────────────────────────────────────
    const techM = t.match(INTENTS.technicals);
    if (techM) {
      const ticker = (techM[1] ?? extractTicker(t))?.toUpperCase();
      if (!ticker) return false;
      const resp = await requestData("technicals", ticker);
      const tech = resp?.data as TechnicalData | undefined;
      if (!tech) { await this.messaging.sendBursts(chatId, [{ text: `couldn't pull technicals for ${ticker}.` }]); return true; }
      await this.messaging.sendBursts(chatId, formatTechnicals(tech));
      return true;
    }

    // ── Fundamentals ────────────────────────────────────────
    const fundM = t.match(INTENTS.fundamentals);
    if (fundM) {
      const ticker = (fundM[1] ?? fundM[2] ?? extractTicker(t))?.toUpperCase();
      if (!ticker) return false;
      const resp = await requestData("fundamentals", ticker);
      const fund = resp?.data as FundamentalsData | undefined;
      const q = readJSON<Record<string, PriceData>>(PRICE_CACHE, {})[ticker];
      if (!fund) { await this.messaging.sendBursts( chatId, [{ text: `no fundamental data for ${ticker}.` }]); return true; }
      await this.messaging.sendBursts( chatId, formatFundamentals(fund, q?.price));
      return true;
    }

    // ── Insider activity ────────────────────────────────────
    const insM = t.match(INTENTS.insiders);
    if (insM) {
      const ticker = (insM[1] ?? extractTicker(t))?.toUpperCase();
      if (!ticker) {
        // All watchlist insiders
        const tickers = getUserTickers(senderId);
        if (!tickers.length) { await this.messaging.sendBursts( chatId, [{ text: "add some stocks to your watchlist first." }]); return true; }
        for (const tk of tickers.slice(0, 3)) {
          const resp = await requestData("insiders", tk);
          const txs = resp?.data as InsiderTx[] ?? [];
          await this.messaging.sendBursts( chatId, formatInsiders(tk, txs));
          
        }
        return true;
      }
      const resp = await requestData("insiders", ticker);
      const txs = resp?.data as InsiderTx[] ?? [];
      await this.messaging.sendBursts( chatId, formatInsiders(ticker, txs));
      return true;
    }

    // ── Sector performance ──────────────────────────────────
    if (INTENTS.sectors.test(t)) {
      await this.messaging.sendBursts( chatId, [{ text: "pulling sector data..." }]);
      const resp = await requestData("sectors");
      const sectors = resp?.data as SectorItem[] ?? [];
      await this.messaging.sendBursts( chatId, formatSectors(sectors));
      return true;
    }

    // ── Stock news ──────────────────────────────────────────
    const newsM = t.match(INTENTS.news_ticker);
    if (newsM) {
      const ticker = newsM[1]!.toUpperCase();
      const resp = await requestData("news", ticker, { limit: 5 });
      const news = resp?.data as NewsItem[] ?? [];
      if (!news.length) { await this.messaging.sendBursts( chatId, [{ text: `no recent news for ${ticker}.` }]); return true; }
      const bursts: Burst[] = [{ text: `${ticker} headlines:` }];
      for (const n of news.slice(0, 4)) {
        bursts.push({ text: n.title });
        if (n.url) bursts.push({ text: n.url, delayMs: 300 });
      }
      await this.messaging.sendBursts( chatId, bursts);
      return true;
    }

    // ── Market news ─────────────────────────────────────────
    if (INTENTS.market_news.test(t)) {
      const resp = await requestData("market_news");
      const news = resp?.data as NewsItem[] ?? [];
      const bursts: Burst[] = [{ text: "market news:" }];
      for (const n of news.slice(0, 5)) bursts.push({ text: n.title });
      await this.messaging.sendBursts(chatId, bursts);
      return true;
    }

    // ── Quick quote ─────────────────────────────────────────
    const quoteM = t.match(INTENTS.quick_quote);
    if (quoteM) {
      const ticker = quoteM[1]!.toUpperCase();
      if (["THE", "A", "AN", "MY", "YOUR", "IT"].includes(ticker)) return false;
      const q = readJSON<Record<string, PriceData>>(PRICE_CACHE, {})[ticker];
      if (q) {
        const sign = q.chg_pct >= 0 ? "+" : "";
        await this.messaging.sendBursts(chatId, [
          { text: `${ticker}  ${usd(q.price)}  (${pct(q.chg_pct)} today)` },
        ]);
      } else {
        const resp = await requestData("quote", ticker);
        const fresh = resp?.data as PriceData | undefined;
        if (fresh) {
          await this.messaging.sendBursts(chatId, [
            { text: `${ticker}  ${usd(fresh.price)}  (${pct(fresh.chg_pct)} today)` },
          ]);
        } else {
          await this.messaging.sendBursts(chatId, [{ text: `no data for ${ticker}.` }]);
        }
      }
      return true;
    }

    // ── Opinion ─────────────────────────────────────────────
    const opM = t.match(INTENTS.opinion);
    if (opM) {
      const ticker = opM[1]!.toUpperCase();
      const ops = readJSON<Record<string, Opinion>>(OPINIONS, {});
      const op = ops[ticker];
      if (op) {
        await this.messaging.sendBursts(chatId, [
          { text: `${ticker}:` },
          { text: `${op.stance}.  ${op.conviction.toLowerCase()} conviction.` },
          { text: op.signals.slice(0, 3).join(".  ") + "." },
        ]);
      } else {
        await this.messaging.sendBursts(chatId, [
          { text: `i don't have a cached opinion on ${ticker} yet.` },
          { text: `say 'deep dive ${ticker}' and i'll form one.` },
        ]);
      }
      return true;
    }

    // ── Related tickers ─────────────────────────────────────
    const relM = t.match(INTENTS.related);
    if (relM) {
      const ticker = relM[1]!.toUpperCase();
      const resp = await requestData("related", ticker);
      const tickers = resp?.data as string[] ?? [];
      if (!tickers.length) {
        await this.messaging.sendBursts(chatId, [{ text: `no related tickers found for ${ticker}.` }]);
      } else {
        await this.messaging.sendBursts(chatId, [
          { text: `related to ${ticker}:` },
          { text: tickers.join("  ·  ") },
        ]);
      }
      return true;
    }

    return false;
  }
}
