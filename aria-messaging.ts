// ============================================================
// aria-messaging.ts
// Aria's iMessage-native communication layer.
//
// Handles:
//   - Burst message splitting (one thought per bubble)
//   - Natural human timing between messages
//   - Tapbacks via @photon-ai/advanced-imessage-kit
//   - Message length enforcement
//   - Stream-of-consciousness delivery
//
// Install:
//   bun add @photon-ai/advanced-imessage-kit
//
// Import in aria-agent.ts:
//   import { AriaMessaging } from "./aria-messaging";
//   const messaging = new AriaMessaging(sdk, advancedSdk);
//
// Replace every sdk.send() call with:
//   await messaging.send(chatId, text, senderId, msgGuid);
// ============================================================

// ─── ADVANCED SDK INTERFACE ──────────────────────────────────

export interface AdvancedIMessageSDK {
  messages: {
    sendReaction(params: {
      chatGuid:    string;
      messageGuid: string;
      reaction:    "love" | "like" | "dislike" | "laugh" | "emphasize" | "question";
      partIndex?:  number;
    }): Promise<void>;
  };
}

export interface BasicIMessageSDK {
  send(chatId: string, content: string): Promise<void>;
}

// ─── TYPES ───────────────────────────────────────────────────

export interface Burst {
  text:     string;
  delayMs?: number;   // override auto-delay before this bubble
}

type TapbackReaction = "love" | "like" | null;

// ─── TAPBACK RULES ───────────────────────────────────────────
// ❤️ Love  — gratitude, affection, excitement, congratulations
// 👍 Like  — reminders, notes, saves, acknowledgements
// Everything else — no tapback

const HEART_PATTERNS: RegExp[] = [
  /\b(?:thank(?:s| you)|thx|ty|tysm|thanks so much)\b/i,
  /\b(?:appreciate (?:it|that|you)|i appreciate)\b/i,
  /\byou(?:'re| are) (?:the best|amazing|great|awesome|a lifesaver|incredible)\b/i,
  /\b(?:love (?:it|this|you|that)|❤️|🙏|so good|that's great|that's amazing)\b/i,
  /\b(?:congrats|congratulations|well done|great job|nailed it)\b/i,
  /\b(?:perfect|exactly what i needed|this is great|omg yes|yes!)\b/i,
  /🙌|🎉|🥳/,
];

const LIKE_PATTERNS: RegExp[] = [
  /\b(?:remind me|set (?:a |an )?reminder|remember (?:this|that|to)|don't let me forget)\b/i,
  /\b(?:keep track|note (?:this|that)|save (?:this|that)|add (?:this|that) to)\b/i,
  /\b(?:got it|noted|understood|sounds good|okay|ok|sure|will do|perfect)\b/i,
  /\b(?:watch (?:this|that)|track (?:this|that)|follow (?:this|that))\b/i,
  /\b(?:make (?:a )?note|jot (?:that )?down|put (?:that )?on my list)\b/i,
];

export function detectTapback(userText: string): TapbackReaction {
  if (HEART_PATTERNS.some((re) => re.test(userText))) return "love";
  if (LIKE_PATTERNS.some((re)  => re.test(userText))) return "like";
  return null;
}

// ─── TIMING ENGINE ────────────────────────────────────────────
// Human-feeling delays based on message length and position.
// Short reactions arrive fast. Longer thoughts take a beat.

function naturalDelay(text: string, index: number, total: number): number {
  const words = text.trim().split(/\s+/).length;
  const chars = text.length;

  // First message in a sequence — no delay
  if (index === 0) return 0;

  // Very short reactions ("yeah.", "hm.", "lol") — snappy
  if (words <= 3) return 700 + Math.random() * 600;           // 0.7–1.3s

  // Normal short iMessage (4–10 words)
  if (words <= 10) return 1100 + Math.random() * 1200;        // 1.1–2.3s

  // Medium thought (11–18 words)
  if (words <= 18) return 1800 + Math.random() * 2000;        // 1.8–3.8s

  // Longer message (19+ words) — rare, takes a moment
  return 2800 + Math.random() * 3000;                         // 2.8–5.8s
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── MESSAGE SPLITTER ────────────────────────────────────────
// Splits a raw text block into iMessage-native bursts.
// Rules:
//   - Split on sentence boundaries
//   - Each burst = one thought (one sentence or clause)
//   - Max ~20 words per burst
//   - Preserve short single-sentence messages as-is

const SENTENCE_BREAK = /(?<=[.!?])\s+(?=[A-Z])/g;
const MAX_BURST_WORDS = 22;

export function splitIntoBursts(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];

  // If already short — don't split
  const words = trimmed.split(/\s+/).length;
  if (words <= MAX_BURST_WORDS && !SENTENCE_BREAK.test(trimmed)) {
    return [trimmed];
  }

  // Split on sentence boundaries first
  const sentences = trimmed
    .split(SENTENCE_BREAK)
    .map((s) => s.trim())
    .filter(Boolean);

  const bursts: string[] = [];

  for (const sentence of sentences) {
    const sw = sentence.split(/\s+/).length;

    // If sentence is still too long, split on comma/clause boundaries
    if (sw > MAX_BURST_WORDS) {
      const clauses = sentence
        .split(/,\s+(?=(?:and |but |so |because |though |which |that |when |where |if )|[A-Z])/g)
        .map((c) => c.trim())
        .filter(Boolean);

      for (const clause of clauses) {
        const cw = clause.split(/\s+/).length;
        if (cw > MAX_BURST_WORDS) {
          // Last resort: split on " and " / " but "
          const parts = clause
            .split(/\s+(?:and|but|so|because)\s+/i)
            .map((p) => p.trim())
            .filter(Boolean);
          bursts.push(...parts);
        } else {
          bursts.push(clause);
        }
      }
    } else {
      bursts.push(sentence);
    }
  }

  return bursts.filter((b) => b.length > 0);
}

// ─── BURST ARRAY SENDER ──────────────────────────────────────

export async function sendBursts(
  sdk:    BasicIMessageSDK,
  chatId: string,
  bursts: Burst[],
): Promise<void> {
  for (let i = 0; i < bursts.length; i++) {
    const burst = bursts[i];
    const delay = burst!.delayMs !== undefined
      ? burst!.delayMs
      : naturalDelay(burst!.text, i, bursts.length);

    if (delay > 0) await sleep(delay);
    await sdk.send(chatId, burst!.text);
  }
}

// ─── ARIA MESSAGING CLASS ─────────────────────────────────────

export class AriaMessaging {
  private sdk: BasicIMessageSDK;
  private adv: AdvancedIMessageSDK | null;

  // Per-chat tapback cooldown — don't tapback every message
  private lastTapback = new Map<string, number>();
  private TAPBACK_COOLDOWN_MS = 5 * 60 * 1000;   // 5 min between tapbacks per chat

  constructor(sdk: BasicIMessageSDK, adv?: AdvancedIMessageSDK) {
    this.sdk = sdk;
    this.adv = adv ?? null;
  }

  // ── Main entry point ─────────────────────────────────────
  // Call this instead of sdk.send() for everything going out.
  // Handles splitting, timing, and tapbacks automatically.

  async send(
    chatId:      string,
    text:        string,
    // Optional: pass incoming message context for tapback decisions
    incomingText?: string,
    incomingGuid?: string,
  ): Promise<void> {
    // Tapback on incoming message if warranted
    if (incomingText && incomingGuid) {
      await this.maybeTapback(chatId, incomingGuid, incomingText);
    }

    const bursts = splitIntoBursts(text).map((t) => ({ text: t }));
    if (!bursts.length) return;

    await sendBursts(this.sdk, chatId, bursts);
  }

  // ── Send a pre-split burst array ─────────────────────────
  // Use when you've already constructed the burst sequence
  // (e.g. from aria-finclaw.ts, aria-live.ts, etc.)

  async sendBursts(chatId: string, bursts: Burst[]): Promise<void> {
    await sendBursts(this.sdk, chatId, bursts);
  }

  // ── Send a single message with no splitting ───────────────
  // For links, confirmations, and things that must stay intact.

  async sendRaw(chatId: string, text: string): Promise<void> {
    await this.sdk.send(chatId, text);
  }

  // ── Tapback ──────────────────────────────────────────────
  // Called with the USER's incoming message text + guid.
  // Applies 5-min cooldown per chat so tapbacks never feel automated.

  async maybeTapback(
    chatId:      string,
    messageGuid: string,
    userText:    string,
  ): Promise<void> {
    if (!this.adv) return;

    const reaction = detectTapback(userText);
    if (!reaction) return;

    // Cooldown check
    const last = this.lastTapback.get(chatId) ?? 0;
    if (Date.now() - last < this.TAPBACK_COOLDOWN_MS) return;

    // Natural human delay before reacting (300–900ms)
    await sleep(300 + Math.random() * 600);

    try {
      await this.adv.messages.sendReaction({
        chatGuid:    chatId,
        messageGuid: messageGuid,
        reaction,
      });
      this.lastTapback.set(chatId, Date.now());
      console.log(`[Messaging] Tapback "${reaction}" on ${messageGuid}`);
    } catch (err) {
      // Non-fatal — tapbacks degrade gracefully without advanced kit
      console.warn(`[Messaging] Tapback skipped (advanced kit unavailable?):`, err);
    }
  }

  // ── Explicit tapback (for task completions etc.) ──────────
  // Call directly when you know a tapback is appropriate
  // regardless of the message content.

  async tapback(
    chatId:      string,
    messageGuid: string,
    reaction:    "love" | "like",
  ): Promise<void> {
    if (!this.adv) return;
    await sleep(400 + Math.random() * 500);
    try {
      await this.adv.messages.sendReaction({
        chatGuid: chatId, messageGuid, reaction,
      });
      this.lastTapback.set(chatId, Date.now());
    } catch { /* non-fatal */ }
  }
}

// ─── STANDALONE HELPERS (used by other modules) ───────────────

/**
 * Quick wrapper used by aria-finclaw.ts, aria-live.ts, etc.
 * when they don't have access to an AriaMessaging instance.
 * Pass the BasicIMessageSDK directly.
 */
export async function burstSend(
  sdk:    BasicIMessageSDK,
  chatId: string,
  bursts: (string | Burst)[],
): Promise<void> {
  const normalized: Burst[] = bursts.map((b) =>
    typeof b === "string" ? { text: b } : b
  );
  await sendBursts(sdk, chatId, normalized);
}
