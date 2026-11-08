// What a dialogue shows the model of its history (spaces-mmo/docs/modell-npcs.en.md "Durable dialogues"). The stored
// conversation keeps every word; each request sends only the current prompt and, before it, the last answered turns that
// fit: at most `turns` of them and at most `maxChars` together. A turn is a user message with the assistant's answer to
// it; a user message the model never answered (its call failed: too long, no budget, cut off) is left out, or a dialogue
// that once outgrew the model's limit would keep sending what broke it. No model call summarises anything (no compaction).

type Part = { type: string; text?: string };
type Message = { role: string; content?: string | readonly Part[]; stopReason?: string };

/** How many earlier answered turns a dialogue shows the model, and how many characters they may take together. */
export const DIALOGUE_WINDOW = { turns: 4, maxChars: 150_000 };

const size = (m: Message) => typeof m.content === "string" ? m.content.length
  : (m.content ?? []).reduce((n, p) => n + (p.text?.length ?? 0), 0);
const answered = (m: Message | undefined) => !!m && m.role === "assistant" && m.stopReason !== "error" && m.stopReason !== "aborted" && size(m) > 0;

/** The messages of one request: the last user message (the current prompt) always, before it the newest answered turns
 *  within the bounds, oldest first. Messages that are neither user nor assistant are kept with their turn. */
export function dialogueWindow<M extends Message>(messages: readonly M[], o: { turns: number; maxChars: number } = DIALOGUE_WINDOW): M[] {
  let last = messages.length - 1;
  while (last >= 0 && messages[last]!.role !== "user") last--;
  if (last < 0) return [...messages];
  const keep: M[][] = [];
  let chars = size(messages[last]!);
  // the turns before it, newest first: a user message up to the next user message
  let end = last;
  for (let i = last - 1; i >= 0 && keep.length < o.turns; i--) {
    if (messages[i]!.role !== "user") continue;
    const turn = messages.slice(i, end);
    end = i;
    if (!answered([...turn].reverse().find((m) => m.role === "assistant"))) continue;
    const n = turn.reduce((s, m) => s + size(m), 0);
    if (chars + n > o.maxChars) break;
    chars += n;
    keep.push(turn);
  }
  return [...keep.reverse().flat(), ...messages.slice(last)];
}
