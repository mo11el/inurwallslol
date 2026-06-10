// ============================================================
// aria-bolster.patch.ts
// Exact wiring of BolsterEngine into aria-agent.ts.
// This is the core integration — it touches callAria() directly.
// ============================================================


// ── STEP 1 — Import ──────────────────────────────────────────

import { bolster } from "./aria-bolster";
import type { ClassifiedMessage } from "./aria-bolster";


// ── STEP 2 — Update ConversationState ─────────────────────────
// Add lastClassification to track what mode was used last turn.

interface ConversationState {
  history:              { role: "user" | "assistant"; content: string }[];
  timezone:             string | null;
  consecutiveOosCount:  number;
  ariaCtx:              AriaContext;
  lastClassification?:  ClassifiedMessage;   // ← ADD THIS
}


// ── STEP 3 — Update callAria() ────────────────────────────────
// The bolster engine injects a behavioral directive into
// every system prompt. This is where the behavior OS plugs in.

async function callAria(
  state:       ConversationState,
  userMessage: string,
): Promise<AriaResult> {
  const nowISO = new Date().toISOString();

  // ── Classify the incoming message ──────────────────────────
  const classified = bolster.classify(userMessage, state.senderId, state.history);
  state.lastClassification = classified;

  // ── Build behavioral directive ─────────────────────────────
  const behavioralDirective = bolster.buildBehavioralDirective(classified);
  const memoryHint          = bolster.buildMemoryHint(state.senderId);

  // ── Choose base system prompt ──────────────────────────────
  const isReminder = isReminderIntent(userMessage);
  const baseSystem = isReminder
    ? buildReminderPrompt(nowISO, state.ariaCtx.prefs.timezone)
    : buildConversationPrompt({
        nowISO,
        timezone: state.ariaCtx.prefs.timezone,
        cadence:  state.ariaCtx.prefs.cadence,
        history:  state.history,
      })
      + "\n\n" + buildIdentityContext();

  // ── Inject behavioral directive + memory hint ──────────────
  // The directive goes LAST — it's the most specific instruction,
  // so it has the highest influence on Claude's immediate output.
  const fullSystem = baseSystem
    + (memoryHint ? "\n\n" + memoryHint : "")
    + "\n\n" + behavioralDirective;

  const messages = [
    ...state.history,
    { role: "user" as const, content: userMessage },
  ];

  const resp = await claude.messages.create({
    model:      "claude-sonnet-4-20250514",
    max_tokens: classified.verbosity >= 4 ? 800 : classified.verbosity === 3 ? 600 : 400,
    system:     fullSystem,
    messages,
  });

  const raw = resp.content
    .filter((b) => b.type === "text")
    .map((b) => (b as { type: "text"; text: string }).text)
    .join("\n").trim();

  // ── Guardrail check ────────────────────────────────────────
  const check = bolster.checkGuardrails(raw, classified.mode);
  if (!check.passes) {
    console.warn(`[Bolster] Guardrail: ${check.issue}`);
    // Note: we don't block the response, just log it.
    // Future: re-run with stricter instructions.
  }

  const parsed = parseBurstResponse(raw);

  if (!parsed || !parsed.bursts.length) {
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
      return { type: "clarify", bursts: parsed.bursts };
    }
    return { type: "reminder", bursts: parsed.bursts, parsed: reminder };
  }

  return {
    type:   parsed.type,
    bursts: parsed.bursts,
  };
}


// ── STEP 4 — Record interaction after response ─────────────────
// Add this AFTER sending the reply in handleMessage():

bolster.recordInteraction(
  senderId,
  state.lastClassification!,
  result.bursts.join(" "),
  text,
);


// ══════════════════════════════════════════════════════════════
// WHAT BOLSTER DOES TO ARIA — BEHAVIOR CHANGES BY MODE
// ══════════════════════════════════════════════════════════════
//
// OPERATOR MODE  (utility + immediate urgency)
//   "remind me in 10 min to call John" → "done. 10 min."
//   "set my alarm for 7am" → "on it. 7am set."
//   Short, zero preamble, no warmth, just execution.
//
// STRATEGIST MODE  (transactional + medium urgency)
//   "should I switch to Stripe?" → structured tradeoffs,
//   options, second-order consequences, decision anchor at end.
//
// COMPANION MODE  (emotional + any)
//   "i'm so overwhelmed with work" → acknowledges first,
//   zero rushing to solutions, warm, emotionally present.
//
// CREATOR MODE  (creative + excited)
//   "brainstorm names for my startup" → expansive, multiple
//   directions, energy, no over-qualifying.
//
// ANALYST MODE  (financial + research + technical)
//   "break down NVDA's business model" → structured, data-
//   driven, named assumptions, logical flow.
//
// CONCIERGE MODE  (travel + informational + first-time users)
//   "plan a trip to Lisbon" → anticipates next steps, maps
//   everything out, service-first, multi-step guidance.
//
//
// ══════════════════════════════════════════════════════════════
// BEHAVIORAL MATRIX — QUICK REFERENCE
// ══════════════════════════════════════════════════════════════
//
//  Intent         Urgency      Emotion       → Mode + Verbosity
//  ─────────────────────────────────────────────────────────────
//  utility        immediate    neutral/stress → operator, V1
//  utility        short_term   neutral        → concierge, V2
//  transactional  medium       neutral        → strategist, V3
//  emotional      any          stressed/sad   → companion, V2
//  creative       any          excited        → creator, V4
//  financial      any          neutral        → analyst, V4
//  research       low          curious        → analyst, V5
//  travel         any          any            → concierge, V4
//  technical      any          neutral        → analyst/concierge, V4
//  social         low          amused         → companion, V2
//  informational  any          curious        → concierge, V3
