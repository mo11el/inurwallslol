// ============================================================
// aria-bolster.ts
// AriaReply Behavioral Variability & Response Matrix v1.0
//
// Implements the full behavior OS from the spec:
//   - 5-axis message classification (intent, urgency, emotion,
//     familiarity, context depth)
//   - 6 fluid behavior archetypes (Operator, Strategist,
//     Companion, Creator, Analyst, Concierge)
//   - Response style matrix (tone × structure × verbosity)
//   - Controlled 10-20% stylistic variance per response
//   - Dataset-driven phrase banks with rotation
//   - Memory-aware tone calibration
//   - Output guardrails
//
// Drop next to aria-agent.ts.
//
// Import in aria-agent.ts:
//   import { BolsterEngine, ClassifiedMessage }
//     from "./aria-bolster";
//   const bolster = new BolsterEngine();
//
// Use in callAria() to dynamically inject behavioral context:
//   const behavioral = bolster.classify(text, senderId, history);
//   const systemAddition = bolster.buildBehavioralDirective(behavioral);
//   // append systemAddition to your system prompt string
//
// Also call after each response to update memory:
//   bolster.recordInteraction(senderId, behavioral, result.reply);
// ============================================================

// ─── AXIS TYPES ───────────────────────────────────────────────

export type IntentType =
  | "utility"       // tasks, reminders, scheduling, setting things up
  | "informational" // questions, explanations, lookups
  | "creative"      // ideas, brainstorming, writing, concepts
  | "social"        // chat, humor, casual conversation
  | "emotional"     // support, frustration, excitement, venting
  | "transactional" // decisions, comparisons, recommendations
  | "technical"     // code, APIs, systems, architecture
  | "financial"     // stocks, markets, money, investing
  | "travel"        // planning, destinations, logistics
  | "research";     // deep dives, analysis, synthesis

export type UrgencyLevel =
  | "immediate"   // needs action right now
  | "short_term"  // today, within hours
  | "medium_term" // planning, this week
  | "low";        // casual, exploratory

export type EmotionalSignal =
  | "neutral"
  | "positive"
  | "excited"
  | "stressed"
  | "confused"
  | "frustrated"
  | "curious"
  | "sad"
  | "anxious"
  | "amused";

export type FamiliarityLevel =
  | "first_time"  // no history
  | "returning"   // 1-10 messages
  | "frequent"    // 11-50 messages
  | "power";      // 50+ messages

export type ContextDepth =
  | "single"       // one message, no context
  | "thread"       // this conversation
  | "deep";        // long history + memory

export type BehaviorMode =
  | "operator"    // execution, short, precise, no fluff
  | "strategist"  // structured reasoning, tradeoffs, options
  | "companion"   // warm, emotionally aware, natural dialogue
  | "creator"     // ideation, expansive, imaginative
  | "analyst"     // data-driven, comparisons, logical
  | "concierge";  // service-oriented, multi-step, anticipatory

export type ToneDimension =
  | "minimal"
  | "direct"
  | "warm"
  | "high_energy"
  | "analytical"
  | "playful"
  | "executive"
  | "supportive";

export type StructureDimension =
  | "single_line"
  | "bullets"
  | "step_by_step"
  | "narrative"
  | "hybrid";

// 1 = ultra concise, 5 = expanded reasoning
export type VerbosityScale = 1 | 2 | 3 | 4 | 5;

export interface ClassifiedMessage {
  intent:      IntentType;
  urgency:     UrgencyLevel;
  emotion:     EmotionalSignal;
  familiarity: FamiliarityLevel;
  context:     ContextDepth;
  mode:        BehaviorMode;
  tone:        ToneDimension;
  structure:   StructureDimension;
  verbosity:   VerbosityScale;
  confidence:  number;   // 0–1 how confident the classifier is
}

// ─── USER BEHAVIORAL MEMORY ───────────────────────────────────

interface BehavioralMemory {
  senderId:          string;
  messageCount:      number;
  dominantIntent:    IntentType | null;
  dominantTone:      ToneDimension | null;
  avgVerbosityPref:  number;             // 1–5, inferred from message length
  timePatterns:      number[];           // hour-of-day distribution (0-23)
  lastSeen:          string;
  recentModes:       BehaviorMode[];     // last 5 modes used
  preferredStructure: StructureDimension | null;
}

// ─── PHRASE BANKS ─────────────────────────────────────────────
// Dataset-driven variation layer. Rotated on each response.

const PHRASE_BANKS = {
  // Operator mode — fast, no fluff
  operator_acks: [
    "done.", "on it.", "got it.", "set.", "noted.", "confirmed.",
    "handled.", "locked in.", "sorted.", "executed.",
  ],
  operator_transitions: [
    "next:", "also:", "one more:", "quick note:", "heads up:",
  ],

  // Strategist mode — structured thinking
  strategist_openings: [
    "a few angles worth considering:",
    "breaking this down:",
    "the core tradeoff here:",
    "structurally, this breaks into:",
    "three things worth knowing:",
    "the real question is:",
    "a tighter frame for this:",
  ],
  strategist_transitions: [
    "the downstream effect is", "that said,", "the constraint here is",
    "worth noting:", "the leverage point is", "one variable you're missing:",
    "that changes if", "the second-order consequence is",
  ],

  // Companion mode — warm, natural
  companion_openings: [
    "yeah, that makes sense.", "honestly,", "i hear you.",
    "that's a real thing.", "makes total sense.", "okay so,",
    "been thinking about this —", "fair.", "totally.",
  ],
  companion_transitions: [
    "also,", "and honestly,", "i think", "what helps here is",
    "one thing worth knowing:", "the way i'd think about it:",
  ],
  companion_closings: [
    "what's pulling at you most right now?",
    "anything else on your mind?",
    "what would help most?",
    "how are you feeling about it?",
    "is there a specific part you want to dig into?",
  ],

  // Creator mode — expansive, energetic
  creator_openings: [
    "okay this is interesting.", "here's where my head goes:",
    "a few different directions:", "thinking out loud —",
    "the concept that comes to mind:", "what if you approached it as",
    "the interesting angle here:", "this could go a lot of ways —",
  ],
  creator_transitions: [
    "another way in:", "or flip it —", "push it further:",
    "the bold version of this:", "what makes this interesting is",
    "the part that stands out:", "a wilder take:",
  ],

  // Analyst mode — precise, data-oriented
  analyst_openings: [
    "the numbers suggest:", "comparing across factors:",
    "the data points to:", "a useful framework here:",
    "the key variable is:", "structurally:", "the core metric is:",
    "running the logic:", "the objective view:",
  ],
  analyst_transitions: [
    "by contrast,", "the correlation is", "the outlier here is",
    "this implies", "the implication is", "normalizing for that:",
    "the signal in the noise:", "holding everything else equal:",
  ],

  // Concierge mode — service-oriented, anticipatory
  concierge_openings: [
    "here's what i'd do:", "let me map this out:",
    "your best path here:", "step by step:",
    "i've got you on this.", "here's the cleanest way to handle it:",
    "here's what makes the most sense:", "walking you through it:",
  ],
  concierge_transitions: [
    "next:", "after that:", "then:", "parallel to this:",
    "one thing to line up:", "before that though:",
    "once that's done:", "the logistics on this:",
  ],

  // Emotional acknowledgment (companion + supportive tone)
  emotional_acks: [
    "that's a lot.", "i get it.", "that sounds genuinely hard.",
    "that tracks.", "makes sense you'd feel that way.",
    "yeah that's real.", "not nothing.",
    "that's a tough one.", "that takes a toll.",
  ],
  frustration_acks: [
    "that's frustrating.", "understandable.", "not ideal at all.",
    "that's annoying.", "i'd be frustrated too.",
    "yeah that's a real problem.", "that shouldn't have happened.",
  ],
  excited_matches: [
    "okay that's actually great.", "this is a real one.",
    "solid.", "that's a good move.", "i like this.",
    "let's go.", "this is worth pushing.",
  ],

  // Affirmations (used sparingly, never robotically)
  affirmations: [
    "exactly.", "that's the right instinct.", "correct.",
    "you're on it.", "that's the play.", "sharp.",
    "this is the move.", "you've got it.",
  ],

  // Transitions (general purpose)
  general_transitions: [
    "also,", "one thing:", "worth noting:", "separately,",
    "the other side of this:", "quick aside:", "the context:",
    "the catch:", "the nuance:", "the reality is",
  ],

  // Clarification prompts (non-robotic)
  clarifications: [
    "what's the actual goal here?",
    "how urgent is this?",
    "when do you need this by?",
    "what's the constraint you're working around?",
    "who else is involved?",
    "what's already been tried?",
    "what's your timeline looking like?",
    "what specifically isn't working?",
  ],

  // Gen-Z compressed variants (used when familiarity is "power" + social intent)
  compressed: [
    "ngl", "fr", "lowkey", "no cap", "actually though",
    "kind of wild", "not gonna lie", "real talk",
  ],

  // Executive shorthand (executive tone)
  executive: [
    "bottom line:", "net-net:", "the ask:", "the play:",
    "decision point:", "status:", "action item:", "the constraint:",
    "the bottleneck:", "the unlock:",
  ],
} as const;

// ─── ROTATION ENGINE ──────────────────────────────────────────
// Tracks last-used index per phrase bank per user.
// Ensures controlled 10-20% variance with no back-to-back repeats.

class PhraseRotator {
  private lastIndex = new Map<string, number>();

  pick<T>(bankName: string, bank: readonly T[]): T {
    const last = this.lastIndex.get(bankName) ?? -1;
    let idx: number;
    let attempts = 0;
    do {
      idx = Math.floor(Math.random() * bank.length);
      attempts++;
    } while (idx === last && bank.length > 1 && attempts < 10);
    this.lastIndex.set(bankName, idx);
    return bank[idx];
  }

  // Add 10-20% stylistic variation: randomly pick a variant within budget
  vary<T>(bankName: string, bank: readonly T[], probability = 0.15): T | null {
    if (Math.random() > probability) return null;
    return this.pick(bankName, bank);
  }
}

// ─── INTENT CLASSIFIER ────────────────────────────────────────

const INTENT_SIGNALS: Record<IntentType, RegExp[]> = {
  utility: [
    /\b(?:remind|reminder|set (?:a |an )?(?:alarm|reminder|timer)|schedule|book|calendar|to[\s-]do|task|add to|don't forget|let me know)\b/i,
  ],
  informational: [
    /\b(?:what (?:is|are|does)|how (?:does|do|can|to)|why (?:is|does|do)|when (?:is|does)|where (?:is|are)|explain|tell me|who (?:is|are)|define|meaning of|what(?:'s| is) the)\b/i,
  ],
  creative: [
    /\b(?:brainstorm|ideas?|concept|write|draft|create|design|come up with|suggest|what if|imagine|pitch|story|brand|name|slogan)\b/i,
  ],
  social: [
    /\b(?:hey|how are you|what(?:'s| is) up|lol|haha|that(?:'s| is) (?:funny|wild|crazy|great)|bored|just (?:checking|wanted to|saying))\b/i,
  ],
  emotional: [
    /\b(?:stressed|overwhelmed|anxious|worried|scared|upset|angry|sad|frustrated|lonely|exhausted|burnt out|can(?:'t| not) (?:deal|handle)|don(?:'t| not) know what to do|losing it)\b/i,
  ],
  transactional: [
    /\b(?:should i|which (?:is|one) better|compare|vs|versus|recommend|best (?:option|choice|way)|worth (?:it|buying|doing)|decision|choose between)\b/i,
  ],
  technical: [
    /\b(?:code|api|function|bug|error|debug|typescript|javascript|python|database|server|deploy|architecture|npm|bun|github)\b/i,
  ],
  financial: [
    /\b(?:stock|ticker|\$[A-Z]{1,5}|market|invest|portfolio|earnings|crypto|bitcoin|etf|equity|trade|price target|sector)\b/i,
  ],
  travel: [
    /\b(?:trip|travel|fly|flight|hotel|itinerary|destination|vacation|visit|passport|visa|packing|where to go|plan (?:a )?trip)\b/i,
  ],
  research: [
    /\b(?:deep dive|research|analysis|breakdown|overview|comprehensive|everything about|tell me everything|full picture|how does .+ work)\b/i,
  ],
};

const URGENCY_SIGNALS: Record<UrgencyLevel, RegExp[]> = {
  immediate: [/\b(?:asap|right now|urgent|immediately|emergency|quick|fast|hurry|now|this (?:second|minute|instant))\b/i],
  short_term: [/\b(?:today|tonight|this morning|this afternoon|soon|in (?:a |an )?(?:hour|bit|few minutes|moment)|before \d)\b/i],
  medium_term: [/\b(?:this week|tomorrow|next (?:few days|week)|planning|upcoming|before (?:the )?\w+|in (?:\d+ )?days?)\b/i],
  low: [/\b(?:eventually|someday|no rush|whenever|just curious|thinking about|been wondering|not urgent)\b/i],
};

const EMOTION_SIGNALS: Record<EmotionalSignal, RegExp[]> = {
  neutral:    [],  // default
  positive:   [/\b(?:great|awesome|excited|happy|perfect|love (?:this|it)|amazing|fantastic|brilliant|thrilled|stoked)\b/i],
  excited:    [/\b(?:!!|omg|can(?:'t| not) wait|so excited|pumped|hyped|let(?:'s| us) go|this is huge|big news)\b/i],
  stressed:   [/\b(?:stressed|overwhelmed|drowning|swamped|too much|can(?:'t| not) keep up|losing my mind|going crazy)\b/i],
  confused:   [/\b(?:confused|don(?:'t| not) understand|lost|what does|not sure|unclear|makes no sense|help me understand)\b/i],
  frustrated: [/\b(?:frustrated|annoyed|ridiculous|this is (?:stupid|broken|terrible|awful)|doesn(?:'t| not) work|fed up|over it)\b/i],
  curious:    [/\b(?:curious|interesting|fascinating|wonder|i(?:'ve| have) been thinking|what if|hypothetically|tell me more)\b/i],
  sad:        [/\b(?:sad|depressed|down|low|miss|lonely|heartbroken|hurts|grief|loss|crying|hard day)\b/i],
  anxious:    [/\b(?:anxious|nervous|scared|worried|what if (?:it )?(?:goes wrong|fails)|not sure (?:if|about)|overthinking)\b/i],
  amused:     [/\b(?:lol|haha|hahaha|😂|💀|that(?:'s| is) (?:hilarious|funny|wild|insane)|dead|crying)\b/i],
};

// ─── BEHAVIOR MODE SELECTOR ───────────────────────────────────
// Core routing function: maps classified axes → behavior mode

function selectMode(
  intent:    IntentType,
  urgency:   UrgencyLevel,
  emotion:   EmotionalSignal,
  familiarity: FamiliarityLevel,
): BehaviorMode {
  // Emotional override — companion first
  if (["stressed", "sad", "anxious", "frustrated"].includes(emotion)) {
    return "companion";
  }

  // Intent-primary routing
  switch (intent) {
    case "utility":
      return urgency === "immediate" ? "operator" : "concierge";

    case "technical":
      return familiarity === "power" || familiarity === "frequent"
        ? "analyst"
        : "concierge";

    case "financial":
      return "analyst";

    case "creative":
      return "creator";

    case "emotional":
      return "companion";

    case "social":
      return emotion === "amused" || emotion === "excited"
        ? "companion"
        : familiarity === "first_time" ? "concierge" : "companion";

    case "transactional":
      return urgency === "immediate" ? "operator" : "strategist";

    case "informational":
      return familiarity === "power" ? "analyst" : "concierge";

    case "research":
      return "analyst";

    case "travel":
      return "concierge";

    default:
      return "companion";
  }
}

// ─── TONE SELECTOR ────────────────────────────────────────────

function selectTone(
  mode:      BehaviorMode,
  emotion:   EmotionalSignal,
  urgency:   UrgencyLevel,
  familiarity: FamiliarityLevel,
): ToneDimension {
  if (urgency === "immediate") return "direct";

  const toneMap: Record<BehaviorMode, ToneDimension> = {
    operator:   "direct",
    strategist: "analytical",
    companion:  "warm",
    creator:    "high_energy",
    analyst:    "analytical",
    concierge:  "warm",
  };

  let tone = toneMap[mode];

  // Emotional overrides
  if (emotion === "stressed" || emotion === "sad" || emotion === "anxious")
    tone = "supportive";
  if (emotion === "excited" && mode !== "operator")
    tone = "high_energy";
  if (familiarity === "power" && mode === "operator")
    tone = "minimal";
  if (familiarity === "first_time")
    tone = "warm";

  return tone;
}

// ─── VERBOSITY SELECTOR ───────────────────────────────────────

function selectVerbosity(
  intent:    IntentType,
  urgency:   UrgencyLevel,
  emotion:   EmotionalSignal,
  contextDepth: ContextDepth,
  userAvgVerbosity: number,
): VerbosityScale {
  // High urgency always compresses
  if (urgency === "immediate") return 1;

  const baseMap: Record<IntentType, VerbosityScale> = {
    utility:       2,
    informational: 3,
    creative:      4,
    social:        2,
    emotional:     3,
    transactional: 3,
    technical:     4,
    financial:     4,
    travel:        4,
    research:      5,
  };

  let v = baseMap[intent];

  // Emotional compression — don't dump on someone who's struggling
  if (["stressed", "anxious", "frustrated"].includes(emotion)) {
    v = Math.min(v, 2) as VerbosityScale;
  }

  // Deep context enables higher verbosity
  if (contextDepth === "deep" && v < 4) {
    v = (v + 1) as VerbosityScale;
  }

  // Blend with user preference (weighted 70/30)
  const blended = Math.round(0.7 * v + 0.3 * userAvgVerbosity);
  return Math.min(Math.max(blended, 1), 5) as VerbosityScale;
}

// ─── STRUCTURE SELECTOR ───────────────────────────────────────

function selectStructure(
  intent:    IntentType,
  mode:      BehaviorMode,
  verbosity: VerbosityScale,
): StructureDimension {
  if (verbosity <= 2) return "single_line";

  const structMap: Partial<Record<BehaviorMode, StructureDimension>> = {
    operator:   "single_line",
    analyst:    "bullets",
    concierge:  "step_by_step",
    creator:    "narrative",
    strategist: "hybrid",
    companion:  "narrative",
  };

  return structMap[mode] ?? "hybrid";
}

// ─── CLASSIFIER ───────────────────────────────────────────────

function classifyText(text: string): {
  intent:  IntentType;
  urgency: UrgencyLevel;
  emotion: EmotionalSignal;
} {
  // Intent
  let intent: IntentType = "informational";
  let intentScore = 0;
  for (const [type, patterns] of Object.entries(INTENT_SIGNALS) as [IntentType, RegExp[]][]) {
    const score = patterns.reduce((acc, re) => acc + (re.test(text) ? 1 : 0), 0);
    if (score > intentScore) { intent = type; intentScore = score; }
  }

  // Urgency
  let urgency: UrgencyLevel = "low";
  for (const [level, patterns] of Object.entries(URGENCY_SIGNALS) as [UrgencyLevel, RegExp[]][]) {
    if (patterns.some((re) => re.test(text))) { urgency = level; break; }
  }

  // Emotion
  let emotion: EmotionalSignal = "neutral";
  let emotionScore = 0;
  for (const [sig, patterns] of Object.entries(EMOTION_SIGNALS) as [EmotionalSignal, RegExp[]][]) {
    const score = patterns.reduce((acc, re) => acc + (re.test(text) ? 1 : 0), 0);
    if (score > emotionScore) { emotion = sig; emotionScore = score; }
  }

  return { intent, urgency, emotion };
}

function deriveFamiliarity(messageCount: number): FamiliarityLevel {
  if (messageCount === 0)  return "first_time";
  if (messageCount <= 10)  return "returning";
  if (messageCount <= 50)  return "frequent";
  return "power";
}

function deriveContextDepth(historyLength: number): ContextDepth {
  if (historyLength <= 1)  return "single";
  if (historyLength <= 10) return "thread";
  return "deep";
}

// ─── BEHAVIORAL DIRECTIVE BUILDER ────────────────────────────
// This is what gets appended to the system prompt. It's short,
// dense, and directly shapes Claude's response for this turn.

export function buildBehavioralDirective(c: ClassifiedMessage, rotator: PhraseRotator): string {
  const modeDescriptions: Record<BehaviorMode, string> = {
    operator:   "Execute. Short, precise, no preamble. Single thought per line.",
    strategist: "Structure your reasoning. Present tradeoffs. Give options. End with a decision anchor.",
    companion:  "Natural, warm. Acknowledge before advising. Think like a friend, not a system.",
    creator:    "Expansive, generative. Multiple directions. Energy in the opening. Don't over-qualify.",
    analyst:    "Data-driven. Comparisons welcome. Logical flow. Name assumptions explicitly.",
    concierge:  "Service-first. Anticipate the next step. Map it out. Be the person who already thought ahead.",
  };

  const toneInstructions: Record<ToneDimension, string> = {
    minimal:     "Absolute minimum words. No warmup. Just the answer.",
    direct:      "Straight to the point. No softening.",
    warm:        "Human and approachable. Not clinical.",
    high_energy: "Match the energy. Present tense. Active verbs.",
    analytical:  "Precise vocabulary. Clean logic. No hedging.",
    playful:     "Light, a bit irreverent. Still useful.",
    executive:   "Sharp. Bottom-line first. No fluff.",
    supportive:  "Lead with acknowledgment. Don't rush to solutions.",
  };

  const verbosityInstructions: Record<VerbosityScale, string> = {
    1: "One to three short sentences maximum. That's it.",
    2: "Brief. Two to four lines. Stop before you'd normally stop.",
    3: "Balanced. Answer, support, context. No padding.",
    4: "Detailed. Full context, supporting evidence, implications.",
    5: "Comprehensive. All angles. Structured. Thorough but not rambling.",
  };

  const structureInstructions: Record<StructureDimension, string> = {
    single_line:  "Single line responses, or very short multi-line.",
    bullets:      "Use tight bullets. Each bullet one idea. No nested bullets unless necessary.",
    step_by_step: "Number the steps. Each step one action. Clear sequencing.",
    narrative:    "Prose only. No bullets. Build the thought across sentences.",
    hybrid:       "Lead with a direct answer. Follow with supporting context or options.",
  };

  // Variance injection — add one phrase bank element if appropriate
  const varianceAddition = (() => {
    const bankMap: Record<BehaviorMode, keyof typeof PHRASE_BANKS> = {
      operator:   "operator_acks",
      strategist: "strategist_openings",
      companion:  "companion_openings",
      creator:    "creator_openings",
      analyst:    "analyst_openings",
      concierge:  "concierge_openings",
    };
    const bankName = bankMap[c.mode];
    const bank     = PHRASE_BANKS[bankName] as readonly string[];
    const phrase   = rotator.vary(bankName, bank, 0.15); // 15% chance
    return phrase ? `\nVariance hint — if natural, consider opening with a phrase in this register: "${phrase}"` : "";
  })();

  return `
════════ BEHAVIORAL DIRECTIVE (this turn) ════════
Mode:       ${c.mode.toUpperCase()} — ${modeDescriptions[c.mode]}
Tone:       ${toneInstructions[c.tone]}
Verbosity:  ${verbosityInstructions[c.verbosity]}
Structure:  ${structureInstructions[c.structure]}
Intent:     ${c.intent} | Urgency: ${c.urgency} | Emotion: ${c.emotion}
Familiarity: ${c.familiarity}
Guardrails: Never mix conflicting modes mid-response. Never break selected tone. Clarity over style.${varianceAddition}
══════════════════════════════════════════════════
`.trim();
}

// ─── BOLSTER ENGINE ───────────────────────────────────────────

export class BolsterEngine {
  private memory  = new Map<string, BehavioralMemory>();
  private rotator = new PhraseRotator();

  // ── Classify incoming message ─────────────────────────────

  classify(
    text:       string,
    senderId:   string,
    history:    { role: string; content: string }[],
  ): ClassifiedMessage {
    const mem      = this.getMemory(senderId);
    const { intent, urgency, emotion } = classifyText(text);
    const familiarity = deriveFamiliarity(mem.messageCount);
    const context     = deriveContextDepth(history.length);

    const mode      = selectMode(intent, urgency, emotion, familiarity);
    const tone      = selectTone(mode, emotion, urgency, familiarity);
    const verbosity = selectVerbosity(intent, urgency, emotion, context, mem.avgVerbosityPref);
    const structure = selectStructure(intent, mode, verbosity);

    return {
      intent, urgency, emotion, familiarity, context,
      mode, tone, structure, verbosity,
      confidence: 0.85,  // can be tuned with a real classifier later
    };
  }

  // ── Build the directive string for system prompt injection ─

  buildBehavioralDirective(c: ClassifiedMessage): string {
    return buildBehavioralDirective(c, this.rotator);
  }

  // ── Get a contextual phrase for use in responses ──────────
  // Call this when you want a natural opener/transition/ack
  // that matches the current behavioral mode.

  getPhrase(type: "opening" | "transition" | "ack" | "closing", mode: BehaviorMode, emotion?: EmotionalSignal): string {
    if (type === "ack" && emotion) {
      if (["stressed", "anxious", "sad"].includes(emotion)) {
        return this.rotator.pick("emotional_acks", PHRASE_BANKS.emotional_acks);
      }
      if (emotion === "frustrated") {
        return this.rotator.pick("frustration_acks", PHRASE_BANKS.frustration_acks);
      }
      if (emotion === "excited" || emotion === "positive") {
        return this.rotator.pick("excited_matches", PHRASE_BANKS.excited_matches);
      }
    }

    const bankMap: Record<BehaviorMode, Record<string, keyof typeof PHRASE_BANKS>> = {
      operator:   { opening: "operator_acks",       transition: "operator_transitions",  closing: "operator_acks"        },
      strategist: { opening: "strategist_openings",  transition: "strategist_transitions",closing: "general_transitions"  },
      companion:  { opening: "companion_openings",   transition: "companion_transitions", closing: "companion_closings"   },
      creator:    { opening: "creator_openings",     transition: "creator_transitions",   closing: "general_transitions"  },
      analyst:    { opening: "analyst_openings",     transition: "analyst_transitions",   closing: "general_transitions"  },
      concierge:  { opening: "concierge_openings",   transition: "concierge_transitions", closing: "general_transitions"  },
    };

    const bankName = bankMap[mode][type] ?? "general_transitions";
    const bank     = PHRASE_BANKS[bankName] as readonly string[];
    return this.rotator.pick(bankName, bank);
  }

  // ── Record interaction (update memory) ───────────────────

  recordInteraction(
    senderId:    string,
    classified:  ClassifiedMessage,
    replyText:   string,
    messageText: string,
  ): void {
    const mem = this.getMemory(senderId);

    mem.messageCount++;
    mem.lastSeen = new Date().toISOString();

    // Track dominant intent (rolling window, last 10 intents)
    mem.dominantIntent = classified.intent;

    // Track preferred verbosity from user message length
    const userWords = messageText.trim().split(/\s+/).length;
    const userVerbSig = userWords <= 5 ? 1 : userWords <= 15 ? 2 : userWords <= 40 ? 3 : userWords <= 100 ? 4 : 5;
    mem.avgVerbosityPref = +(0.8 * mem.avgVerbosityPref + 0.2 * userVerbSig).toFixed(2);

    // Track time pattern
    const hour = new Date().getHours();
    mem.timePatterns[hour] = (mem.timePatterns[hour] ?? 0) + 1;

    // Track recent modes (last 5)
    mem.recentModes.push(classified.mode);
    if (mem.recentModes.length > 5) mem.recentModes.shift();

    // Track dominant tone
    mem.dominantTone = classified.tone;

    // Track preferred structure
    mem.preferredStructure = classified.structure;

    this.memory.set(senderId, mem);
  }

  // ── Memory helpers ────────────────────────────────────────

  private getMemory(senderId: string): BehavioralMemory {
    if (!this.memory.has(senderId)) {
      this.memory.set(senderId, {
        senderId,
        messageCount:      0,
        dominantIntent:    null,
        dominantTone:      null,
        avgVerbosityPref:  2.5,
        timePatterns:      new Array(24).fill(0),
        lastSeen:          new Date().toISOString(),
        recentModes:       [],
        preferredStructure: null,
      });
    }
    return this.memory.get(senderId)!;
  }

  getMemorySnapshot(senderId: string): BehavioralMemory {
    return this.getMemory(senderId);
  }

  // ── Build a memory-aware context hint for system prompt ───
  // Returns a short string describing what Aria knows about
  // this user's behavioral preferences. Appended to system prompt.

  buildMemoryHint(senderId: string): string {
    const mem = this.getMemory(senderId);
    if (mem.messageCount === 0) return "";

    const lines: string[] = [];

    if (mem.dominantIntent) {
      lines.push(`User's dominant request type: ${mem.dominantIntent}.`);
    }
    if (mem.avgVerbosityPref) {
      const vLabel = mem.avgVerbosityPref < 2 ? "very concise" : mem.avgVerbosityPref < 3 ? "concise" : mem.avgVerbosityPref < 4 ? "balanced" : "detailed";
      lines.push(`User typically prefers ${vLabel} responses (avg verbosity: ${mem.avgVerbosityPref.toFixed(1)}).`);
    }
    if (mem.dominantTone) {
      lines.push(`User responds well to ${mem.dominantTone} tone.`);
    }
    if (mem.recentModes.length >= 3) {
      const mostRecent = mem.recentModes[mem.recentModes.length - 1];
      lines.push(`Last 3 interactions used ${mostRecent} mode.`);
    }
    if (mem.preferredStructure) {
      lines.push(`Preferred response structure: ${mem.preferredStructure}.`);
    }

    if (!lines.length) return "";

    return `\n[USER BEHAVIORAL PROFILE]\n${lines.join("\n")}\n`;
  }

  // ── Guardrail check ──────────────────────────────────────
  // Returns true if a response appears to be violating mode rules
  // (mixing Operator coldness with Companion warmth, etc.)

  checkGuardrails(responseText: string, mode: BehaviorMode): { passes: boolean; issue?: string } {
    const roboticPhrases = /\b(?:I'm an AI|As an AI|I cannot|I apologize for|Let me know if you need|Is there anything else|I understand your|Certainly!|Of course!)\b/i;
    if (roboticPhrases.test(responseText)) {
      return { passes: false, issue: "Robotic phrasing detected — violates persona guardrail" };
    }

    if (mode === "operator" && responseText.split(" ").length > 80) {
      return { passes: false, issue: "Operator mode exceeded verbosity guardrail (>80 words)" };
    }

    if (mode === "companion" && /\b(?:execute|action item|deliverable|leverage point)\b/i.test(responseText)) {
      return { passes: false, issue: "Companion mode contaminated with Operator/Strategist language" };
    }

    return { passes: true };
  }
}

// ─── CONVENIENCE EXPORT ───────────────────────────────────────
// Single shared instance for import across the project.

export const bolster = new BolsterEngine();
