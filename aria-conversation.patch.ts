// ============================================================
// aria-conversation.patch.ts
// Shows the exact changes to make in aria-agent.ts to wire in
// the burst conversation engine. Read top to bottom.
// ============================================================


// ── STEP 1 — Add import ──────────────────────────────────────

import {
  buildConversationPrompt,
  buildReminderPrompt,
  isReminderIntent,
  parseBurstResponse,
  sendBursts,
} from "./aria-conversation";


// ── STEP 2 — Replace the callAria() function ─────────────────
// The new version routes to reminder or conversational prompt
// automatically, and always returns a bursts array.

async function callAria(
  state: ConversationState,
  userMessage: string,
): Promise<{
  type:             string;
  bursts:           string[];
  parsed?:          ParsedReminder;
  openLoopDetected?: string | null;
}> {
  const nowISO  = new Date().toISOString();
  const isReminder = isReminderIntent(userMessage);

  // Pick the right system prompt
  const system = isReminder
    ? buildReminderPrompt(nowISO, state.ariaCtx.prefs.timezone)
    : buildConversationPrompt({
        nowISO,
        timezone: state.ariaCtx.prefs.timezone,
        cadence:  state.ariaCtx.prefs.cadence,
        history:  state.history,
      });

  const messages = [
    ...state.history,
    { role: "user" as const, content: userMessage },
  ];

  const resp = await claude.messages.create({
    model:      "claude-sonnet-4-20250514",
    max_tokens: 600,
    system,
    messages,
  });

  const raw = resp.content
    .filter((b) => b.type === "text")
    .map((b) => (b as { type: "text"; text: string }).text)
    .join("\n")
    .trim();

  const parsed = parseBurstResponse(raw);

  if (!parsed || !parsed.bursts.length) {
    // Fallback: treat raw text as a single burst
    return { type: "conversational_burst", bursts: [raw.slice(0, 300)] };
  }

  // Reminder path: build ParsedReminder from JSON fields
  if (parsed.type === "reminder" && parsed.iso_datetime) {
    const reminder: ParsedReminder = {
      task:          parsed.task          ?? "",
      iso_datetime:  parsed.iso_datetime  ?? "",
      timezone:      parsed.timezone      ?? "America/New_York",
      local_display: parsed.local_display ?? "",
      confidence:    parsed.confidence    ?? "high",
    };

    // Low confidence → treat as clarify
    if (reminder.confidence === "low") {
      return {
        type:   "clarify",
        bursts: parsed.bursts,
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


// ── STEP 3 — Replace message sending in handleMessage() ──────
// Find the section that does "await space.send(result.reply)"
// and replace it with burst delivery.

// REMOVE:
//   await space.send(result.reply);

// ADD:
await sendBursts(sdk, msg.chatId, result.bursts);

// Update history with the full burst sequence joined as one entry
// so Claude has the correct context on the next turn.
const assistantContent = result.bursts.join(" ");
state.history.push({ role: "user",      content: text });
state.history.push({ role: "assistant", content: assistantContent });


// ── STEP 4 — OOS counter update ──────────────────────────────
// Same logic as before, just using result.type instead of result.type.

if (result.type === "reminder" || result.type === "clarify") {
  state.consecutiveOosCount = 0;
} else {
  state.consecutiveOosCount += 1;
}


// ── STEP 5 — Reminder scheduling (unchanged) ─────────────────
// The reminder scheduling block stays identical. Just check:

if (result.type === "reminder" && result.parsed) {
  const p = result.parsed;
  if (!state.ariaCtx.prefs.timezone) state.ariaCtx.prefs.timezone = p.timezone;
  const fireAt = new Date(p.iso_datetime);
  if (!isNaN(fireAt.getTime())) {
    scheduleReminder(app, senderId, p.task, fireAt, p.timezone);
  }
}


// ── STEP 6 — DTP follow-up (if returned) ─────────────────────
// aria-conversation.ts doesn't return followUp directly —
// the DTP engine in aria-persona.ts still handles nudges.
// Keep maybeArmNudge() call exactly as before:

dtp.maybeArmNudge(
  msg.chatId,
  text,
  state.ariaCtx.prefs.wakeHour,
  state.ariaCtx.prefs.sleepHour,
);


// ══════════════════════════════════════════════════════════════
// FINAL handleMessage() flow
// ══════════════════════════════════════════════════════════════
//
//  incoming iMessage
//       ↓
//  market.registerChat() + market.handleIntent()   ← stocks
//       ↓ (not a stock command)
//  live.handleIntent()                             ← flights / weather / currency
//       ↓ (not a live data command)
//  session + ariaCtx init
//       ↓
//  inferCadence() / detectOpenLoop() / maybeArmNudge()
//       ↓
//  isReminderIntent()
//    → true:  buildReminderPrompt()   → 1 burst, brief, done
//    → false: buildConversationPrompt() → 4-8 bursts, verbose, engaging
//       ↓
//  callAria() → Claude
//       ↓
//  sendBursts() — staggered iMessage delivery
//       ↓
//  scheduleReminder() if type === "reminder"
//       ↓
//  trim history to last 20 entries
