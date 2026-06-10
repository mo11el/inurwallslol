// ============================================================
// ARIA — iMessage Reminder Agent for Antigravity
// Stack: spectrum-ts (Photon) + Google Gemini
// Paste this entire file into Antigravity and set env vars.
// ============================================================

import { createClient } from "@insforge/sdk";
import "dotenv/config";
import { Spectrum } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";
import { formatReminder } from "./aria-reminder-messages";
import { FinclawEngine } from "./aria-finclaw";
import { PlacesEngine } from "./aria-places";
import { buildIdentityContext, handleIdentityIntent } from "./aria-identity";
import { MacroEngine } from "./aria-macro";
import { AdvancedIMessageKit } from "@photon-ai/advanced-imessage-kit";
import { AriaMessaging, AdvancedIMessageSDK } from "./aria-messaging";
import {
  DTPEngine,
  AriaContext,
  defaultContext,
  inferCadence,
  detectOpenLoop,
} from "./aria-persona";
import {
  buildConversationPrompt,
  buildReminderPrompt,
  isReminderIntent,
  parseBurstResponse,
  sendBursts,
} from "./aria-conversation";

// ─── ENV ─────────────────────────────────────────────────────
const PROJECT_ID     = process.env.PROJECT_ID!;
const PROJECT_SECRET = process.env.PROJECT_SECRET!;
const INSFORGE_URL   = process.env.INSFORGE_URL!;
const INSFORGE_ANON_KEY = process.env.INSFORGE_ANON_KEY!;

// ─── TYPES ───────────────────────────────────────────────────
interface ParsedReminder {
  task: string;
  iso_datetime: string;       // UTC ISO-8601
  timezone: string;           // IANA tz, e.g. "America/New_York"
  local_display: string;      // human-readable in sender's tz
  confidence: "high" | "low";
}

// Response categories Aria can return
type AriaResponseType =
  | "reminder"       // successfully parsed reminder → schedule it
  | "clarify"        // reminder needs one more piece of info
  | "conversational" // handled inline (translation, quick fact, siri-like)
  | "hard_oos";      // truly out of scope → website redirect (after patience exhausted)

interface AriaResult {
  type: string;
  bursts: string[];
  parsed?: ParsedReminder;
  openLoopDetected?: string | null;
}

interface ConversationState {
  history: { role: "user" | "assistant"; content: string }[];
  timezone: string | null;
  // Rolling count of consecutive messages that are NOT reminders or clarifications.
  // Resets to 0 whenever a reminder is parsed or a clarify is issued.
  consecutiveOosCount: number;
  ariaCtx: AriaContext;
}

// ─── PERSISTENT REMINDER STORE ───────────────────────────────
interface ScheduledReminder {
  id: string;
  senderId: string;
  task: string;
  fireAt: Date;
  timezone: string;
  timerId: ReturnType<typeof setTimeout>;
}

const sessions  = new Map<string, ConversationState>();
const scheduled = new Map<string, ScheduledReminder>();
const dtpEngines = new Map<string, DTPEngine>();

// ─── INSFORGE AI CALL ─────────────────────────────────────────────
const insforge = createClient({
  baseUrl: INSFORGE_URL,
  anonKey: INSFORGE_ANON_KEY,
});

async function callAria(state: ConversationState, userMessage: string): Promise<AriaResult> {
  const nowISO = new Date().toISOString();
  const isReminder = isReminderIntent(userMessage);

  const systemBase = isReminder
    ? buildReminderPrompt(nowISO, state.ariaCtx.prefs.timezone)
    : buildConversationPrompt({
        nowISO,
        timezone: state.ariaCtx.prefs.timezone,
        cadence:  state.ariaCtx.prefs.cadence,
        history:  state.history,
      });

  const system = systemBase + "\n\n" + buildIdentityContext();

  const messages = [
    { role: "system" as const, content: system },
    ...state.history,
    { role: "user" as const, content: userMessage },
  ];

  const resp = await insforge.ai.chat.completions.create({
    model: "openai/gpt-4o",
    messages: messages,
  });

  const raw = resp.choices?.[0]?.message?.content?.trim() || "";
  const parsed = parseBurstResponse(raw);

  if (!parsed || !parsed.bursts.length) {
    // Fallback: treat raw text as a single burst
    return { type: "conversational_burst", bursts: [raw.slice(0, 300)] };
  }

  if (parsed.type === "reminder" && parsed.iso_datetime) {
    const reminder: ParsedReminder = {
      task:          parsed.task          ?? "",
      iso_datetime:  parsed.iso_datetime  ?? "",
      timezone:      parsed.timezone      ?? "America/New_York",
      local_display: parsed.local_display ?? "",
      confidence:    parsed.confidence    ?? "high",
    };

    if (reminder.confidence === "low") {
      return {
        type:   "clarify",
        bursts: parsed.bursts,
        parsed: reminder,
      };
    }

    return {
      type:   "reminder",
      bursts: parsed.bursts,
      parsed: reminder,
    };
  }

  return {
    type:             parsed.type,
    bursts:           parsed.bursts,
    openLoopDetected: parsed.openLoopDetected,
  };
}

// ─── SCHEDULER ───────────────────────────────────────────────
// Node's setTimeout has a ~24.8-day hard limit (32-bit signed ms).
// For longer delays we use a recursive re-arm that wakes up periodically
// and checks the remaining time, only firing when we've actually arrived.

const MAX_TIMER_MS = 2_000_000_000; // ~23 days — safely under the 32-bit ceiling

function preciseTimeout(fireAt: Date, fn: () => void): ReturnType<typeof setTimeout> {
  let handle: ReturnType<typeof setTimeout>;

  const arm = () => {
    const remaining = fireAt.getTime() - Date.now();

    if (remaining <= 0) {
      // We're at or past the target — fire immediately
      fn();
      return;
    }

    // Sleep for at most MAX_TIMER_MS, then re-check
    const delay = Math.min(remaining, MAX_TIMER_MS);
    handle = setTimeout(arm, delay);
  };

  arm();
  // Return the first handle so the caller can clearTimeout if needed
  return handle!;
}

function scheduleReminder(
  app: Awaited<ReturnType<typeof Spectrum>>,
  senderId: string,
  task: string,
  fireAt: Date,
  timezone: string
) {
  const msUntil = fireAt.getTime() - Date.now();

  if (msUntil <= 0) {
    console.warn(`[Aria] Skipping past reminder for ${senderId}: "${task}"`);
    return;
  }

  // Deduplicate: cancel any identical reminder already queued
  const id = `${senderId}::${fireAt.toISOString()}::${task}`;
  if (scheduled.has(id)) {
    console.log(`[Aria] Reminder already scheduled — skipping duplicate: "${task}"`);
    return;
  }

  console.log(
    `[Aria] Scheduling "${task}" for ${senderId} at ${fireAt.toISOString()} (${timezone}) — ` +
    `fires in ${Math.round(msUntil / 1000)}s`
  );

  const timerId = preciseTimeout(fireAt, async () => {
    console.log(`[Aria] Firing reminder for ${senderId}: "${task}"`);
    try {
      const im   = imessage(app);
      const user = await im.user(senderId);
      const dm   = await im.space(user);
      await dm.send(formatReminder(task, senderId));
      scheduled.delete(id);
    } catch (err) {
      console.error(`[Aria] Failed to fire reminder for ${senderId}:`, err);
    }
  });

  scheduled.set(id, { id, senderId, task, fireAt, timezone, timerId });
}

// ─── MAIN ────────────────────────────────────────────────────
async function main() {
  const app = await Spectrum({
    projectId: PROJECT_ID,
    projectSecret: PROJECT_SECRET,
    providers: [imessage.config()],
  });

  // Init Engines
  const imessageSdk = {
    async send(chatId: string, content: string) {
      try {
        const im = imessage(app);
        const user = await im.user(chatId);
        const dm = await im.space(user);
        await dm.send(content);
      } catch (err) {
        console.error(`[imessageSdk] Failed to send to ${chatId}:`, err);
      }
    }
  };
  const advancedSdk: AdvancedIMessageSDK | undefined = AdvancedIMessageKit
    ? new AdvancedIMessageKit()
    : undefined;
  const messaging = new AriaMessaging(imessageSdk, advancedSdk);

  const macro = new MacroEngine(messaging, imessageSdk as any);
  macro.start();

  const finclaw = new FinclawEngine(messaging, advancedSdk);
  
  const places = new PlacesEngine();

  process.on("SIGINT", () => {
    macro.stop();
    for (const dtp of dtpEngines.values()) dtp.destroy();
    console.log("[Aria] Shutting down gracefully");
    process.exit(0);
  });

  console.log("[Aria] Online — listening for iMessages...");

  for await (const [space, message] of app.messages) {
    // Add debugging log to see raw incoming messages
    console.log("RECEIVED MESSAGE RAW:", JSON.stringify(message));
    if (message.platform !== "iMessage") {
      console.log("IGNORING NON-iMessage platform:", message.platform);
      continue;
    }

    const senderId: string =
      (message as unknown as { sender: { id: string } }).sender.id;

    const text: string = (
      typeof message.content === "string"
        ? message.content
        : ((message.content as unknown as { text?: string })?.text ?? "")
    ).trim();

    if (!text) continue;

    await messaging.maybeTapback(senderId, message.id, text);

    // ── Engine Intercepts ─────────────────────────────────────
    try {
      // 1. Identity
      const handledByIdentity = await handleIdentityIntent(text, senderId, messaging);
      if (handledByIdentity) continue;

      // 2. Macro intelligence
      const handledByMacro = await macro.handleIntent(text, senderId, senderId, message.id);
      if (handledByMacro) continue;

      // 3. Finclaw
      finclaw.registerChat(senderId, senderId);
      let handled = await finclaw.handleIntent(text, senderId, senderId, message.id);
      if (handled) continue;

      handled = await places.handleIntent(text, senderId, messaging);
      if (handled) continue;
    } catch (err) {
      console.error("[Engine] Error handling intent:", err);
    }

    // ── Session init ──────────────────────────────────────────
    if (!sessions.has(senderId)) {
      sessions.set(senderId, {
        history: [],
        timezone: null,
        consecutiveOosCount: 0,
        ariaCtx: defaultContext(),
      });
    }
    const state = sessions.get(senderId)!;

    if (!dtpEngines.has(senderId)) {
      dtpEngines.set(senderId, new DTPEngine(imessageSdk));
    }
    const dtp = dtpEngines.get(senderId)!;

    // ── Inject OOS gate context when patience is running low ──
    const contextualMessage =
      state.consecutiveOosCount >= 5
        ? `[context: user has sent ${state.consecutiveOosCount} consecutive non-reminder messages that weren't fully resolvable. If this one is also outside Aria's scope, use hard_oos.]\n\n${text}`
        : text;

    // ── Call Aria ─────────────────────────────────────────────
    let result: AriaResult;
    try {
      result = await callAria(state, contextualMessage);
    } catch (err) {
      console.error("[Aria] Gemini error:", err);
      continue;
    }

    // ── Update OOS counter ────────────────────────────────────
    if (result.type === "reminder" || result.type === "clarify") {
      state.consecutiveOosCount = 0;
    } else {
      state.consecutiveOosCount += 1;
    }

    // ── Persona logic ─────────────────────────────────────────
    state.ariaCtx.prefs.cadence = inferCadence(text, state.ariaCtx.prefs.cadence);
    
    if (result.parsed?.timezone) {
      state.ariaCtx.prefs.timezone = result.parsed.timezone;
    }
    
    const loop = detectOpenLoop(text);
    if (loop) {
      state.ariaCtx.openLoops.push({ ...loop, id: `${senderId}-${Date.now()}` });
      console.log(`[Aria] Open loop detected: "${loop.description}"`);
    }
    
    dtp.maybeArmNudge(
      senderId,
      text,
      state.ariaCtx.prefs.wakeHour,
      state.ariaCtx.prefs.sleepHour
    );

    // ── Send reply ────────────────────────────────────────────
    console.log(`[Aria] Sending bursts to ${senderId}:`, result.bursts);
    await messaging.sendBursts(senderId, result.bursts.map(text => ({ text })));

    // ── Update history (store clean text, not context-injected) ──
    const assistantContent = result.bursts.join(" ");
    state.history.push({ role: "user", content: text });
    state.history.push({ role: "assistant", content: assistantContent });

    // ── Schedule if it's a confirmed reminder ─────────────────
    if (result.type === "reminder" && result.parsed) {
      const p = result.parsed;

      if (!state.timezone) state.timezone = p.timezone;

      const fireAt = new Date(p.iso_datetime);
      if (isNaN(fireAt.getTime())) {
        console.warn(`[Aria] AI returned invalid iso_datetime: "${p.iso_datetime}" — skipping schedule`);
      } else {
        scheduleReminder(app, senderId, p.task, fireAt, p.timezone);
      }
    }

    // ── Keep history lean (last 20 entries = 10 exchanges) ────
    if (state.history.length > 20) {
      state.history = state.history.slice(-20);
    }
  }
}

main().catch((err) => {
  console.error("[Aria] Fatal:", err);
  process.exit(1);
});
