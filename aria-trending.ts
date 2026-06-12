/**
 * aria-trending.ts
 * AriaReply — Trending News Module
 *
 * Pulls live headlines from Google News RSS (via rss2json, no API key required),
 * selects a story that feels relevant and fresh, then generates a casual iMessage-
 * style "did you hear about this?" opener for Aria to send the user.
 *
 * Usage:
 *   import { shouldSendTrendingUpdate, buildTrendingMessage } from "./aria-trending";
 *
 *   if (await shouldSendTrendingUpdate(userId)) {
 *     const message = await buildTrendingMessage();
 *     if (message) await sendToUser(userId, message);
 *   }
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export interface TrendingStory {
  title: string;
  summary: string;       // first sentence / teaser
  source: string;        // publisher name
  url: string;
  published: string;     // ISO datetime string
  category: NewsCategory;
}

export type NewsCategory =
  | "top"
  | "technology"
  | "business"
  | "entertainment"
  | "sports"
  | "science"
  | "health";

export interface AriaNewsMessage {
  openingText: string;   // the casual hook Aria sends first
  followUpText: string;  // the actual story summary sent right after
  story: TrendingStory;
}

// ─── Config ───────────────────────────────────────────────────────────────────

/**
 * How often (in hours) Aria is allowed to send an unprompted trending update.
 * Keeps her from being spammy.
 */
const UPDATE_COOLDOWN_HOURS = 4;

/**
 * Probability (0–1) that Aria actually sends a trending message when the
 * cooldown has cleared. Keeps it feeling spontaneous, not clockwork.
 */
const SEND_PROBABILITY = 0.35;

/**
 * Categories Aria pulls from — weighted so "top" appears most often.
 * Tune this list to match your user base's vibe.
 */
const CATEGORY_WEIGHTS: { category: NewsCategory; weight: number }[] = [
  { category: "top",           weight: 40 },
  { category: "technology",    weight: 20 },
  { category: "business",      weight: 15 },
  { category: "entertainment", weight: 10 },
  { category: "sports",        weight: 8  },
  { category: "science",       weight: 5  },
  { category: "health",        weight: 2  },
];

// ─── RSS → JSON endpoints (no API key required) ───────────────────────────────

const RSS2JSON_BASE = "https://api.rss2json.com/v1/api.json";

const GOOGLE_NEWS_RSS: Record<NewsCategory, string> = {
  top:           "https://news.google.com/rss?hl=en-US&gl=US&ceid=US:en",
  technology:    "https://news.google.com/rss/topics/CAAqJggKIiBDQkFTRWdvSUwyMHZNRGRqTVhZU0FtVnVHZ0pWVXlnQVAB?hl=en-US&gl=US&ceid=US:en",
  business:      "https://news.google.com/rss/topics/CAAqJggKIiBDQkFTRWdvSUwyMHZNRGx6TVdZU0FtVnVHZ0pWVXlnQVAB?hl=en-US&gl=US&ceid=US:en",
  entertainment: "https://news.google.com/rss/topics/CAAqJggKIiBDQkFTRWdvSUwyMHZNREpxYW5RU0FtVnVHZ0pWVXlnQVAB?hl=en-US&gl=US&ceid=US:en",
  sports:        "https://news.google.com/rss/topics/CAAqJggKIiBDQkFTRWdvSUwyMHZNRFp1ZEdvU0FtVnVHZ0pWVXlnQVAB?hl=en-US&gl=US&ceid=US:en",
  science:       "https://news.google.com/rss/topics/CAAqJggKIiBDQkFTRWdvSUwyMHZNRFp0Y1RjU0FtVnVHZ0pWVXlnQVAB?hl=en-US&gl=US&ceid=US:en",
  health:        "https://news.google.com/rss/topics/CAAqIQgKIhtDQkFTRGdvSUwyMHZNR3QwTlRFU0FtVnVLQUFQAQ?hl=en-US&gl=US&ceid=US:en",
};

// ─── In-memory cooldown store ──────────────────────────────────────────────────
// Replace with Redis / KV in production.

const lastSentAt = new Map<string, number>(); // userId → timestamp ms

// ─── Core helpers ─────────────────────────────────────────────────────────────

/** Weighted random category pick. */
function pickCategory(): NewsCategory {
  const total = CATEGORY_WEIGHTS.reduce((s, c) => s + c.weight, 0);
  let roll = Math.random() * total;
  for (const { category, weight } of CATEGORY_WEIGHTS) {
    roll -= weight;
    if (roll <= 0) return category;
  }
  return "top";
}

/** Strip HTML tags from RSS description snippets. */
function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/** Pull latest stories from a Google News RSS feed via rss2json. */
async function fetchStories(category: NewsCategory): Promise<TrendingStory[]> {
  const feedUrl = encodeURIComponent(GOOGLE_NEWS_RSS[category]);
  const endpoint = `${RSS2JSON_BASE}?rss_url=${feedUrl}&count=10`;

  const res = await fetch(endpoint, {
    headers: { "Accept": "application/json" },
  });

  if (!res.ok) throw new Error(`rss2json error: ${res.status}`);

  const data = await res.json();
  if (data.status !== "ok" || !Array.isArray(data.items)) return [];

  return data.items.map((item: Record<string, string>) => ({
    title:     item.title?.trim() ?? "",
    summary:   stripHtml(item.description ?? item.content ?? "").slice(0, 280),
    source:    item.author || data.feed?.title || "Google News",
    url:       item.link ?? "",
    published: item.pubDate ?? new Date().toISOString(),
    category,
  }));
}

/**
 * Filter out boring/low-signal stories: very short titles, paywalled
 * outlets we can't summarise, and duplicates from the last run.
 */
function filterStories(stories: TrendingStory[]): TrendingStory[] {
  return stories.filter((s) => {
    if (s.title.length < 20) return false;
    if (!s.url.startsWith("http")) return false;
    if (s.summary.length < 30) return false;
    return true;
  });
}

/** Pick one story at random from the filtered list. */
function pickStory(stories: TrendingStory[]): TrendingStory | null {
  if (!stories.length) return null;
  return stories[Math.floor(Math.random() * stories.length)];
}

// ─── Message generation ───────────────────────────────────────────────────────

/**
 * Opening hooks Aria uses to casually float a news item.
 * Rotate through them to avoid feeling scripted.
 */
const OPENING_HOOKS = [
  "ok wait did you see this",
  "yo have you heard about this yet",
  "omg you need to see this",
  "wait okay this is actually interesting",
  "not to bombard you but this is worth a look",
  "random but did you catch this story",
  "ok this just came up and honestly",
  "hey quick thing — did you see what happened with",
  "lol sorry to interrupt but this is kinda wild",
  "this just dropped and i feel like you'd be into it",
];

const CATEGORY_CONTEXT: Record<NewsCategory, string> = {
  top:           "",
  technology:    "tech/",
  business:      "business/",
  entertainment: "culture/",
  sports:        "sports/",
  science:       "science/",
  health:        "health/",
};

/**
 * Compose the two-bubble iMessage Aria sends:
 *   1. Casual hook (first bubble)
 *   2. Short story teaser + source (second bubble)
 */
function composeMessage(story: TrendingStory): AriaNewsMessage {
  const hook = OPENING_HOOKS[Math.floor(Math.random() * OPENING_HOOKS.length)];

  // If the hook ends with a topic word (like "with"), append the headline inline
  const openingText = hook.endsWith("with")
    ? `${hook} ${story.title.split(":")[0].toLowerCase()}?`
    : hook;

  const ctxLabel = CATEGORY_CONTEXT[story.category];
  const followUpText =
    `"${story.title}"\n\n` +
    `${story.summary.length > 200
      ? story.summary.slice(0, 197) + "..."
      : story.summary}\n\n` +
    `📰 ${story.source}${ctxLabel ? ` · ${ctxLabel}` : ""}\n` +
    `${story.url}`;

  return { openingText, followUpText, story };
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Determines whether Aria should proactively send a trending update to a user.
 *
 * Returns true only if:
 *   - Cooldown has passed (or no previous send exists)
 *   - Random probability check passes
 */
export function shouldSendTrendingUpdate(userId: string): boolean {
  const last = lastSentAt.get(userId);
  if (last !== undefined) {
    const hoursSince = (Date.now() - last) / (1000 * 60 * 60);
    if (hoursSince < UPDATE_COOLDOWN_HOURS) return false;
  }
  return Math.random() < SEND_PROBABILITY;
}

/**
 * Fetches a live trending story and composes Aria's iMessage-native two-bubble
 * message. Returns null if no valid stories are available.
 */
export async function buildTrendingMessage(): Promise<AriaNewsMessage | null> {
  try {
    const category = pickCategory();
    const raw = await fetchStories(category);
    const filtered = filterStories(raw);
    const story = pickStory(filtered);
    if (!story) return null;
    return composeMessage(story);
  } catch (err) {
    console.error("[aria-trending] Failed to build trending message:", err);
    return null;
  }
}

/**
 * Full flow: check cooldown → fetch story → compose message → mark sent.
 * Returns the composed message if sent, or null if skipped/failed.
 *
 * @param userId  Unique identifier for the user (used for cooldown tracking)
 * @param force   Skip the probability check — useful for explicit user requests
 */
export async function maybeSendTrendingUpdate(
  userId: string,
  force = false
): Promise<AriaNewsMessage | null> {
  if (!force && !shouldSendTrendingUpdate(userId)) return null;

  const message = await buildTrendingMessage();
  if (!message) return null;

  // Mark sent (replace with persistent store in production)
  lastSentAt.set(userId, Date.now());

  return message;
}

/**
 * Handles an explicit user request like "what's going on in the world?"
 * or "any news?". Bypasses cooldown and probability — user asked for it.
 */
export async function handleUserNewsRequest(
  userMessage: string,
  userId: string
): Promise<AriaNewsMessage | null> {
  const newsKeywords = [
    "news", "trending", "what's going on", "what's happening",
    "current events", "any news", "heard anything", "latest",
    "what happened", "fill me in", "update me",
  ];
  const isNewsRequest = newsKeywords.some((kw) =>
    userMessage.toLowerCase().includes(kw)
  );
  if (!isNewsRequest) return null;

  return maybeSendTrendingUpdate(userId, true);
}

// ─── Scheduler helper (optional) ──────────────────────────────────────────────

/**
 * Attaches a recurring check to your existing Aria message loop.
 * Call this once at startup. Every `intervalMs`, Aria will *consider*
 * sending a trending update to each active user.
 *
 * @param getActiveUserIds  Async function returning currently-active user IDs
 * @param deliverMessage    Async function that actually sends the two bubbles
 * @param intervalMs        How often to run the check (default: 30 min)
 */
export function startTrendingScheduler(
  getActiveUserIds: () => Promise<string[]>,
  deliverMessage: (userId: string, msg: AriaNewsMessage) => Promise<void>,
  intervalMs = 30 * 60 * 1000
): NodeJS.Timeout {
  const tick = async () => {
    const users = await getActiveUserIds();
    for (const userId of users) {
      try {
        const msg = await maybeSendTrendingUpdate(userId);
        if (msg) await deliverMessage(userId, msg);
      } catch (err) {
        console.error(`[aria-trending] Scheduler error for user ${userId}:`, err);
      }
    }
  };

  // Run once immediately, then on the interval
  tick();
  return setInterval(tick, intervalMs);
}

// ─── Example integration (remove in production) ───────────────────────────────

/**
 * Example: how you'd wire this into Aria's main message handler.
 *
 * ```ts
 * import { handleUserNewsRequest, maybeSendTrendingUpdate } from "./aria-trending";
 *
 * async function onUserMessage(userId: string, text: string) {
 *   // 1. Check if user explicitly asked for news
 *   const explicitNews = await handleUserNewsRequest(text, userId);
 *   if (explicitNews) {
 *     await sendBubble(userId, explicitNews.openingText);
 *     await delay(1200); // Aria's natural "typing" pause
 *     await sendBubble(userId, explicitNews.followUpText);
 *     return;
 *   }
 *
 *   // 2. Normal Aria response logic...
 *   const ariaReply = await generateAriaResponse(text);
 *   await sendBubble(userId, ariaReply);
 *
 *   // 3. After replying, maybe float a trending story
 *   const proactive = await maybeSendTrendingUpdate(userId);
 *   if (proactive) {
 *     await delay(3000);
 *     await sendBubble(userId, proactive.openingText);
 *     await delay(1400);
 *     await sendBubble(userId, proactive.followUpText);
 *   }
 * }
 * ```
 */
