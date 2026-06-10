// ============================================================
// aria-macro.ts
// Macro Intelligence & Second-Order Reasoning Engine for Aria.
// Implements the full AriaReply Capability Module from the MD spec.
//
// Features:
//   - First Contact opt-in flow
//   - Recurring Intelligence Mode (periodic observations)
//   - Six-lens reasoning framework (first/second-order, incentives,
//     information asymmetry, time horizon, probability)
//   - Weather as economic variable
//   - Supply chain, technology, geopolitics, cultural intelligence
//   - Crucix signal monitoring (github.com/calesthio/Crucix)
//   - Aria Intelligence Burst format (⚡🌎🧩🔭📌)
//   - Full iMessage burst delivery with natural timing
//
// Install:
//   bun add @anthropic-ai/sdk
//
// Import in aria-agent.ts:
//   import { MacroEngine } from "./aria-macro";
//   const macro = new MacroEngine(messaging, sdk);
//   macro.start();
//
// In handleMessage(), before callAria():
//   const handled = await macro.handleIntent(text, senderId, msg.chatId, msg.guid);
//   if (handled) continue;
// ============================================================

import fs   from "fs";
import path from "path";
import Anthropic from "@anthropic-ai/sdk";
import type { AriaMessaging, Burst } from "./aria-messaging";

// ─── TYPES ───────────────────────────────────────────────────

interface BasicSDK {
  send(chatId: string, content: string): Promise<void>;
}

interface MacroStore {
  users: Record<string, MacroUserState>;
  lastCrucixCheck: string | null;
  lastCrucixSha:   string | null;
}

interface MacroUserState {
  opted_in:    boolean;
  opted_at:    string | null;
  chatId:      string;
  senderId:    string;
  lastBrief:   string | null;   // ISO date of last proactive observation
  frequency:   "daily" | "weekly" | "realtime";
}

interface IntelBurst {
  observation:   string;
  implications:  string[];
  hidden_angle:  string;
  watchlist:     string[];
  confidence:    "Low" | "Medium" | "High";
}

type MacroLens = "weather" | "supply_chain" | "technology" | "geopolitics" | "culture" | "business" | "general";

// ─── PATHS ───────────────────────────────────────────────────

const STORE_PATH  = path.join(process.cwd(), "aria-macro-store.json");
const CRUCIX_REPO = "https://api.github.com/repos/calesthio/Crucix/commits?per_page=5";

// ─── HELPERS ─────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function readStore(): MacroStore {
  try {
    if (!fs.existsSync(STORE_PATH)) return { users: {}, lastCrucixCheck: null, lastCrucixSha: null };
    return JSON.parse(fs.readFileSync(STORE_PATH, "utf8")) as MacroStore;
  } catch { return { users: {}, lastCrucixCheck: null, lastCrucixSha: null }; }
}

function writeStore(s: MacroStore): void {
  fs.writeFileSync(STORE_PATH, JSON.stringify(s, null, 2), "utf8");
}

function now(): string { return new Date().toISOString(); }
function today(): string { return new Date().toISOString().slice(0, 10); }

// ─── CLAUDE CLIENT ───────────────────────────────────────────

const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY ?? "" });

// ─── LENS SYSTEM PROMPT ───────────────────────────────────────

function buildMacroSystemPrompt(): string {
  return `
You are Aria's macro intelligence layer.
Built by AriaReply, based between NYC and CDMX.

Your role is pattern recognition, not prediction.
You connect seemingly unrelated events into coherent observations.
You think in second and third-order consequences.
You never recommend trades, investments, or specific financial actions.

REASONING FRAMEWORK — apply all six lenses simultaneously:

LENS 1 — FIRST ORDER: What is directly happening?
LENS 2 — SECOND ORDER: What happens because of what happened? Follow downstream effects.
  Example: Orange crop failure → juice prices up → restaurant margins shrink → alternative beverages benefit.
LENS 3 — INCENTIVE ANALYSIS: Who benefits if this narrative succeeds? Who benefits if it fails?
LENS 4 — INFORMATION ASYMMETRY: What do experts know that the public hasn't priced in? Where are blind spots?
LENS 5 — TIME HORIZON: Immediate (hours), Near-term (days), Intermediate (weeks-months), Long-term (years).
LENS 6 — PROBABILITY: Low / Medium / High / Unknown. Never assume certainty.

DOMAIN CONTEXTS:

WEATHER AS ECONOMIC VARIABLE: Never analyze in isolation.
  Heat wave → electricity demand, utility strain, data center cooling, agricultural stress.
  Cold snap → natural gas demand, infrastructure stress, transport delays.
  Hurricane → insurance claims, supply chain, energy infrastructure, retail shortages.

SUPPLY CHAIN: Ports, shipping routes, freight costs, rail, air cargo, manufacturing hubs.
  Ask: shortages? excess inventory? pricing power shifts? earnings impact?

TECHNOLOGY: AI, robotics, semiconductors, cloud, data centers, energy, defense, cybersecurity.
  Ask: what becomes cheaper? what becomes obsolete? who gains leverage? who loses it?

GEOPOLITICS: Elections, trade disputes, export controls, sanctions, military, international agreements.

CULTURE: Consumer behavior, social platforms, creator economy, demographic shifts.
  Ask: what behaviors are changing? what industries benefit? what are threatened?

BUSINESS: Leadership, incentives, capital allocation, competitive advantage, product strength,
  market structure, customer loyalty, regulatory/supply chain/technological/narrative/execution risk.

SIGNAL DETECTION: Small anomalies, unusual behavior, unexpected announcements, contradictory data.
  Weak signals often precede major developments.

CONTRARIAN CHECK: What if the consensus is wrong? What assumptions are embedded in current narratives?

OUTPUT FORMAT — return ONLY valid JSON:
{
  "observation": "one concise sentence describing what happened",
  "implications": ["implication 1", "implication 2", "implication 3"],
  "hidden_angle": "the less obvious angle most people aren't considering",
  "watchlist": ["signal to monitor 1", "signal to monitor 2"],
  "confidence": "Low" | "Medium" | "High"
}

Use language: "worth watching" / "potential implication" / "one possibility" / "emerging signal" /
"interesting development" / "could indicate" / "may suggest."
Never guarantee outcomes. Never predict with certainty.
`.trim();
}

// ─── MACRO ANALYSIS VIA CLAUDE ───────────────────────────────

async function runMacroAnalysis(topic: string, lens: MacroLens): Promise<IntelBurst | null> {
  const lensHints: Record<MacroLens, string> = {
    weather:      "Analyze this as an economic variable. Map downstream effects on agriculture, energy, insurance, transport, and commodities.",
    supply_chain: "Focus on freight, ports, inventory implications, and pricing power.",
    technology:   "Focus on adoption curves, who gains/loses leverage, what becomes obsolete.",
    geopolitics:  "Focus on trade flows, sanctions exposure, and second-order market effects.",
    culture:      "Focus on consumer behavior shifts and which industries benefit or suffer.",
    business:     "Analyze leadership, incentives, competitive moat, and execution risk.",
    general:      "Apply all six lenses. Prioritize second and third-order consequences.",
  };

  const prompt = `Topic: ${topic}\n\nLens context: ${lensHints[lens]}\n\nApply the full reasoning framework and return the JSON analysis.`;

  try {
    const resp = await claude.messages.create({
      model:      "claude-sonnet-4-20250514",
      max_tokens: 600,
      system:     buildMacroSystemPrompt(),
      messages:   [{ role: "user", content: prompt }],
    });

    const raw = resp.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { type: "text"; text: string }).text)
      .join("")
      .trim()
      .replace(/```json?|```/g, "");

    return JSON.parse(raw) as IntelBurst;
  } catch (err) {
    console.error("[Macro] Analysis error:", err);
    return null;
  }
}

// ─── FORMAT INTELLIGENCE BURST ────────────────────────────────
// Aria Intelligence Burst Format from the spec:
// ⚡ Observation / 🌎 Implications / 🧩 Hidden Angle / 🔭 Watchlist / 📌 Confidence

function formatIntelBurst(intel: IntelBurst, ticker?: string): Burst[] {
  const bursts: Burst[] = [];

  bursts.push({ text: `⚡ ${ticker ? ticker + " — " : ""}${intel.observation}` });

  bursts.push({ text: "🌎 potential implications:", delayMs: 1800 });
  for (const impl of intel.implications.slice(0, 3)) {
    bursts.push({ text: impl, delayMs: 1200 });
  }

  if (intel.hidden_angle) {
    bursts.push({ text: `🧩 ${intel.hidden_angle}`, delayMs: 2000 });
  }

  if (intel.watchlist?.length) {
    bursts.push({ text: "🔭 worth watching:", delayMs: 2000 });
    for (const item of intel.watchlist.slice(0, 3)) {
      bursts.push({ text: item, delayMs: 900 });
    }
  }

  bursts.push({
    text: `📌 confidence: ${intel.confidence.toLowerCase()}.`,
    delayMs: 1500,
  });

  return bursts;
}

// ─── CRUCIX MONITOR ───────────────────────────────────────────

async function checkCrucix(): Promise<{ isNew: boolean; summary: string; sha: string } | null> {
  try {
    const res = await fetch(CRUCIX_REPO, {
      headers: {
        "User-Agent": "AriaReply/1.0",
        "Accept":     "application/vnd.github+json",
      },
    });
    if (!res.ok) return null;

    const commits = await res.json() as { sha: string; commit: { message: string; author: { date: string } } }[];
    if (!commits.length) return null;

    const latest = commits[0]!;
    const store  = readStore();

    if (latest.sha === store.lastCrucixSha) return null;

    // New commit detected
    const recentMessages = commits.slice(0, 3).map((c) => c.commit.message.split("\n")[0]).join(" | ");
    return {
      isNew:   true,
      summary: recentMessages,
      sha:     latest.sha,
    };
  } catch { return null; }
}

async function buildCrucixBursts(summary: string): Promise<Burst[]> {
  const prompt = `
Crucix (github.com/calesthio/Crucix) has new activity.
Recent commits: ${summary}

Generate a Crucix Signal Layer observation for Aria using the IntelBurst format.
Frame implications across: AI tooling, automation, research workflows, developer adoption, enterprise relevance.
Never present as a guaranteed breakthrough. Frame probabilistically.
Return only the JSON.`;

  try {
    const resp = await claude.messages.create({
      model:      "claude-sonnet-4-20250514",
      max_tokens: 500,
      system:     buildMacroSystemPrompt(),
      messages:   [{ role: "user", content: prompt }],
    });

    const raw = resp.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { type: "text"; text: string }).text)
      .join("")
      .trim()
      .replace(/```json?|```/g, "");

    const intel = JSON.parse(raw) as IntelBurst;

    return [
      { text: "⚡ Crucix signal." },
      { text: "new activity on the repo.", delayMs: 1200 },
      ...formatIntelBurst(intel).slice(1),
    ];
  } catch {
    return [
      { text: "⚡ Crucix." },
      { text: `new commits: ${summary.slice(0, 100)}`, delayMs: 1200 },
      { text: "🔭 worth monitoring for AI tooling implications.", delayMs: 1500 },
    ];
  }
}

// ─── PROACTIVE OBSERVATION GENERATOR ─────────────────────────

const PROACTIVE_TOPICS: { topic: string; lens: MacroLens }[] = [
  { topic: "current global semiconductor supply chain dynamics",          lens: "supply_chain"  },
  { topic: "AI infrastructure energy consumption and data center growth", lens: "technology"    },
  { topic: "US dollar strength and emerging market capital flows",        lens: "geopolitics"   },
  { topic: "consumer credit stress signals in the US economy",           lens: "general"       },
  { topic: "commercial real estate and regional bank exposure",          lens: "business"      },
  { topic: "reshoring and nearshoring manufacturing trends",             lens: "supply_chain"  },
  { topic: "social platform algorithm shifts and creator economy",       lens: "culture"       },
  { topic: "lithium and battery supply chain for EVs",                   lens: "supply_chain"  },
  { topic: "labor market tightening in skilled trades",                  lens: "general"       },
  { topic: "central bank policy divergence across G7 economies",         lens: "geopolitics"   },
];

let lastTopicIndex = -1;

async function generateProactiveObservation(): Promise<IntelBurst | null> {
  let idx: number;
  do { idx = Math.floor(Math.random() * PROACTIVE_TOPICS.length); }
  while (idx === lastTopicIndex && PROACTIVE_TOPICS.length > 1);
  lastTopicIndex = idx;

  const { topic, lens } = PROACTIVE_TOPICS[idx]!;
  return runMacroAnalysis(topic, lens);
}

// ─── INTENT DETECTION ─────────────────────────────────────────

const OPT_IN_PATTERNS: RegExp[] = [
  /\b(?:yes|sure|sounds good|enable|turn on|activate|opt in|sign me up|i(?:'d)? like that|go for it|absolutely|definitely)\b/i,
];
const OPT_OUT_PATTERNS: RegExp[] = [
  /\b(?:no(?: thanks?)?|nope|not now|disable|turn off|stop|opt out|cancel|don't|do not)\b/i,
];

const MACRO_REQUEST_PATTERNS: RegExp[] = [
  /\b(?:macro|second.?order|what(?:'s| is) (?:the )?second.?order|downstream effects?|intelligence (?:update|brief)|give me an observation|what(?:'s| is) happening (?:in|with)|analyze (?:this|the|a))\b/i,
  /\b(?:supply chain|geopolit|semiconductor|AI infrastructure|reshoring|nearshoring|central bank|labor market)\b/i,
  /\b(?:weather (?:impact|effect|analysis)|hurricane (?:impact|effect)|economic impact of)\b/i,
];

const LENS_KEYWORDS: Record<string, MacroLens> = {
  weather:       "weather",       hurricane: "weather",       storm:      "weather",
  "supply chain":"supply_chain",  shipping:  "supply_chain",  freight:    "supply_chain",  port: "supply_chain",
  ai:            "technology",    tech:      "technology",    semiconductor:"technology",
  geopolit:      "geopolitics",   sanction:  "geopolitics",   election:   "geopolitics",   trade: "geopolitics",
  culture:       "culture",       consumer:  "culture",       social:     "culture",
  company:       "business",      business:  "business",      earnings:   "business",
};

function detectLens(text: string): MacroLens {
  const lower = text.toLowerCase();
  for (const [kw, lens] of Object.entries(LENS_KEYWORDS)) {
    if (lower.includes(kw)) return lens;
  }
  return "general";
}

// ─── FIRST CONTACT STATE ──────────────────────────────────────

const pendingOptIn = new Set<string>();   // senderIds awaiting opt-in response

// ─── MACRO ENGINE ─────────────────────────────────────────────

export class MacroEngine {
  private messaging: AriaMessaging;
  private sdk:       BasicSDK;
  private handle:    ReturnType<typeof setInterval> | null = null;

  constructor(messaging: AriaMessaging, sdk: BasicSDK) {
    this.messaging = messaging;
    this.sdk       = sdk;
  }

  start(): void {
    // Proactive observations: every 6 hours
    this.handle = setInterval(() => this.runProactiveCycle(), 6 * 60 * 60 * 1000);
    // Crucix check: every 2 hours
    setInterval(() => this.checkCrucixForAll(), 2 * 60 * 60 * 1000);
    console.log("[Macro] Engine started");
  }

  stop(): void { if (this.handle) clearInterval(this.handle); }

  // ── Main intent handler ───────────────────────────────────

  async handleIntent(
    text:     string,
    senderId: string,
    chatId:   string,
    _msgGuid: string,
  ): Promise<boolean> {
    const store = readStore();

    // ── Pending opt-in response ─────────────────────────────
    if (pendingOptIn.has(senderId)) {
      if (OPT_IN_PATTERNS.some((re) => re.test(text))) {
        pendingOptIn.delete(senderId);
        store.users[senderId] = {
          opted_in:  true,
          opted_at:  now(),
          chatId,
          senderId,
          lastBrief: null,
          frequency: "daily",
        };
        writeStore(store);
        await this.messaging.sendBursts(chatId, [
          { text: "intelligence mode on." },
          { text: "i'll send observations when something worth noticing comes up." },
          { text: "you can ask me to analyze anything — markets, weather, tech, geopolitics." },
          { text: "or just say 'give me an observation' whenever you want one." },
        ]);
        return true;
      }
      if (OPT_OUT_PATTERNS.some((re) => re.test(text))) {
        pendingOptIn.delete(senderId);
        await this.messaging.sendBursts(chatId, [
          { text: "no problem." },
          { text: "you can always ask me to analyze something manually anytime." },
        ]);
        return true;
      }
      // Not a response to opt-in — let it fall through
      pendingOptIn.delete(senderId);
    }

    // ── First contact — offer intelligence mode ─────────────
    // Trigger when user hasn't been offered yet and asks something macro-adjacent
    const user = store.users[senderId];
    if (!user && MACRO_REQUEST_PATTERNS.some((re) => re.test(text))) {
      await this.offerOptIn(senderId, chatId);
      pendingOptIn.add(senderId);
      // Also process the actual request below, don't return true yet
    }

    // ── Direct macro analysis request ──────────────────────
    if (MACRO_REQUEST_PATTERNS.some((re) => re.test(text))) {
      const lens  = detectLens(text);
      const topic = this.extractTopic(text);

      await this.messaging.sendBursts(chatId, [
        { text: "running the analysis." },
        { text: "give me a moment." },
      ]);

      const intel = await runMacroAnalysis(topic, lens);
      if (!intel) {
        await this.messaging.sendBursts(chatId, [{ text: "couldn't generate that observation right now. try again." }]);
        return true;
      }

      await this.messaging.sendBursts(chatId, formatIntelBurst(intel));
      return true;
    }

    // ── Manual "give me an observation" ────────────────────
    if (/\b(?:give me (?:an?|a) (?:observation|update|brief|intel)|what(?:'s| is) interesting|anything (?:interesting|worth watching)|what should i (?:know|watch))\b/i.test(text)) {
      await this.messaging.sendBursts(chatId, [{ text: "pulling something worth looking at." }]);

      const intel = await generateProactiveObservation();
      if (intel) {
        await this.messaging.sendBursts(chatId, formatIntelBurst(intel));
      } else {
        await this.messaging.sendBursts(chatId, [{ text: "nothing new to surface right now. ask me about a specific topic." }]);
      }
      return true;
    }

    // ── Disable recurring updates ───────────────────────────
    if (/\b(?:stop (?:sending|the) (?:updates?|observations?|briefs?)|disable (?:macro|intelligence|updates?)|turn off (?:updates?|observations?))\b/i.test(text)) {
      if (store.users[senderId]) {
        store.users[senderId].opted_in = false;
        writeStore(store);
      }
      await this.messaging.sendBursts(chatId, [
        { text: "done." },
        { text: "no more proactive observations." },
        { text: "you can still ask me to analyze anything manually." },
      ]);
      return true;
    }

    return false;
  }

  // ── Offer opt-in (First Contact Rule) ────────────────────

  private async offerOptIn(senderId: string, chatId: string): Promise<void> {
    await this.messaging.sendBursts(chatId, [
      { text: "before i dig in —" },
      { text: "would you like occasional intelligence updates?" },
      { text: "emerging tech, market signals, macro shifts, geopolitics, supply chain — that kind of thing." },
      { text: "not alerts. observations." },
      { text: "yes or no?" },
    ]);
  }

  // ── Extract topic from user message ──────────────────────

  private extractTopic(text: string): string {
    // Strip command words to get the topic
    return text
      .replace(/\b(?:analyze|what(?:'s| is) (?:the )?(?:second.?order|impact|effect|implication) of|give me (?:an?|a) (?:analysis|observation) (?:on|of|about)|macro analysis on|what happens (?:if|when)|tell me about)\b/i, "")
      .trim() || text;
  }

  // ── Proactive cycle ──────────────────────────────────────

  private async runProactiveCycle(): Promise<void> {
    const store = readStore();
    const optedIn = Object.values(store.users).filter((u) => u.opted_in);
    if (!optedIn.length) return;

    const intel = await generateProactiveObservation();
    if (!intel) return;

    const bursts = formatIntelBurst(intel);

    for (const user of optedIn) {
      // Respect daily frequency — skip if already sent today
      if (user.frequency === "daily" && user.lastBrief === today()) continue;

      try {
        await this.messaging.sendBursts(user.chatId, bursts);
        store.users[user.senderId]!.lastBrief = today();
        await sleep(2000);
      } catch (err) {
        console.error(`[Macro] Proactive delivery error for ${user.senderId}:`, err);
      }
    }

    writeStore(store);
  }

  // ── Crucix check ─────────────────────────────────────────

  private async checkCrucixForAll(): Promise<void> {
    const store   = readStore();
    const optedIn = Object.values(store.users).filter((u) => u.opted_in);
    if (!optedIn.length) return;

    const result = await checkCrucix();
    if (!result?.isNew) return;

    // Update SHA
    store.lastCrucixSha   = result.sha;
    store.lastCrucixCheck = now();
    writeStore(store);

    const bursts = await buildCrucixBursts(result.summary);

    for (const user of optedIn) {
      try {
        await this.messaging.sendBursts(user.chatId, bursts);
        await sleep(1500);
      } catch (err) {
        console.error(`[Macro] Crucix delivery error for ${user.senderId}:`, err);
      }
    }
  }
}
