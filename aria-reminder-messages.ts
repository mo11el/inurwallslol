// ============================================================
// aria-reminder-messages.ts
// Drop this file next to aria-agent.ts and import formatReminder()
//
// Usage in aria-agent.ts:
//   import { formatReminder } from "./aria-reminder-messages";
//   ...
//   content: formatReminder(p.task),
// ============================================================

type ReminderFormatter = (task: string) => string;

const VARIANTS: ReminderFormatter[] = [
  (task) => `Hey — just a reminder: ${task}.`,
  (task) => `Heads up! ${task}.`,
  (task) => `Don't forget: ${task}.`,
  (task) => `Just so you know — ${task}.`,
  (task) => `Quick reminder: ${task}.`,
  (task) => `You asked me to remind you — ${task}.`,
  (task) => `This is your reminder for: ${task}.`,
  (task) => `Friendly nudge — ${task}.`,
  (task) => `Circling back: ${task}.`,
  (task) => `Reminder dropping in — ${task}.`,
  (task) => `You've got something: ${task}.`,
  (task) => `Psst — ${task}.`,
];

// Tracks the last index used per recipient so the same
// variant is never repeated back-to-back for the same person.
const lastIndexUsed = new Map<string, number>();

/**
 * Returns a varied reminder message for the given task.
 *
 * @param task      - The reminder task string (e.g. "call Mom")
 * @param senderId  - Optional phone/chatId used to avoid
 *                    repeating the same variant twice in a row
 *                    for the same person. Pass msg.chatId.
 */
export function formatReminder(task: string, senderId?: string): string {
  const last = senderId !== undefined ? (lastIndexUsed.get(senderId) ?? -1) : -1;

  // Pick a random index, re-rolling if it matches the last one used
  let index: number;
  do {
    index = Math.floor(Math.random() * VARIANTS.length);
  } while (index === last && VARIANTS.length > 1);

  if (senderId !== undefined) lastIndexUsed.set(senderId, index);

  return VARIANTS[index](task);
}
