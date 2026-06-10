// ============================================================
// aria-finclaw.patch.ts
// Exact additions to aria-agent.ts. Read top to bottom.
// aria-finclaw.ts replaces aria-market.ts for stock features.
// ============================================================


// ── STEP 1 — Swap import ─────────────────────────────────────

// REMOVE (if present):
// import { MarketEngine } from "./aria-market";

// ADD:
import { FinclawEngine } from "./aria-finclaw";


// ── STEP 2 — Swap instance ───────────────────────────────────

// REMOVE (if present):
// const market = new MarketEngine(sdk);
// market.start();

// ADD (pass advancedSdk if you have @photon-ai/advanced-imessage-kit):
const finclaw = new FinclawEngine(sdk, advancedSdk ?? undefined);
finclaw.start();


// ── STEP 3 — Replace handleIntent call ───────────────────────
// In handleMessage(), BEFORE callAria():

// REMOVE (if present):
// const handledByMarket = await market.handleIntent(text, senderId, msg.chatId);
// if (handledByMarket) return;

// ADD:
finclaw.registerChat(senderId, msg.chatId);
const handledByFinclaw = await finclaw.handleIntent(text, senderId, msg.chatId, msg.guid ?? "");
if (handledByFinclaw) return;


// ── STEP 4 — Shutdown ────────────────────────────────────────
// In SIGINT handler:

finclaw.stop();


// ── STEP 5 — Run the Python poller ───────────────────────────
// In a separate terminal alongside the TS agent:

// pip install yfinance stockstats pandas
// python aria-finclaw-poller.py


// ── FINAL call order in handleMessage() ──────────────────────
//
//  finclaw.registerChat()          ← register chatId for push alerts
//  finclaw.handleIntent()          ← ALL financial intents  ← replaces market
//  live.handleIntent()             ← flights / weather / currency
//  places.handleIntent()           ← local restaurant / place search
//  callAria()                      ← reminders + conversation
