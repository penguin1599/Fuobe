/**
 * The people in the recorded live edit room (live-chat-demo.tsx): who types each change of the session, in the colours
 * their name, avatar, underline and live-frame dots take. Whole class names, so Tailwind keeps them; each reads in both
 * themes.
 */
export interface Person {
  id: string;
  name: string;
  /** The avatar, and the flag on the caret while they type. */
  avatar: string;
  /** Their name in the chat. */
  ink: string;
  /** The underline under their words in the sentence. */
  line: string;
  /** The wash behind their words while they type them. */
  tint: string;
  /** A live frame drawn at one of their letters. */
  dot: string;
}

export const YOU: Person = {
  id: "you",
  name: "You",
  avatar: "bg-primary text-primary-foreground",
  ink: "text-primary",
  line: "decoration-primary",
  tint: "bg-primary/12",
  dot: "bg-primary",
};
const MAYA: Person = { id: "maya", name: "Maya", avatar: "bg-rose-500 text-white", ink: "text-rose-600 dark:text-rose-400", line: "decoration-rose-500", tint: "bg-rose-500/12", dot: "bg-rose-500" };
const JONAH: Person = { id: "jonah", name: "Jonah", avatar: "bg-sky-600 text-white", ink: "text-sky-600 dark:text-sky-400", line: "decoration-sky-500", tint: "bg-sky-500/12", dot: "bg-sky-500" };
const PRIYA: Person = { id: "priya", name: "Priya", avatar: "bg-amber-400 text-amber-950", ink: "text-amber-600 dark:text-amber-400", line: "decoration-amber-400", tint: "bg-amber-400/15", dot: "bg-amber-400" };
const THEO: Person = { id: "theo", name: "Theo", avatar: "bg-emerald-600 text-white", ink: "text-emerald-600 dark:text-emerald-400", line: "decoration-emerald-500", tint: "bg-emerald-500/12", dot: "bg-emerald-500" };
const AIKO: Person = { id: "aiko", name: "Aiko", avatar: "bg-violet-500 text-white", ink: "text-violet-600 dark:text-violet-400", line: "decoration-violet-500", tint: "bg-violet-500/12", dot: "bg-violet-500" };

/** Who types each change, in order; the sixth is the visitor's. A longer session goes round again. */
export const CHAT_CREW: Person[] = [MAYA, JONAH, PRIYA, THEO, JONAH, YOU, AIKO, PRIYA, MAYA, THEO];
/** The change (0-based) the visitor types themselves. */
export const YOUR_TURN = CHAT_CREW.indexOf(YOU);
export const authorOf = (i: number) => CHAT_CREW[i % CHAT_CREW.length];
