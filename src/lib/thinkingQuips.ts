/** Playful stand-in for "Claude is thinking". One line is dealt every
 *  THINKING_QUIP_MS. The deck refills in a new order forever, and the
 *  line that just showed is never the first one dealt again. */
export const THINKING_QUIP_MS = 15_000;

export const THINKING_QUIPS = [
  "🧠 Cooking up some code",
  "⚙️ Wiring things together",
  "🔧 Turning thoughts into code",
  "⌨️ Typing at the speed of logic",
  "🧩 Connecting the dots",
  "🪄 Making the code behave",
  "☕ Brewing some code",
  "🚀 Getting this thing off the ground",
  "👀 Let me cook",
  "🧑‍💻 Cooking",
  "🧑‍💻 Let me cook",
  "🤔 Plotting the next move",
  "🕵️ Hunting down the bug",
  "🧙 Summoning the compiler",
  "🛠️ Building something",
  "🐛 Looking for suspicious bugs",
  "🐛 Hunting for bugs",
  "💡 Having a tiny eureka moment",
  "🧵 Pulling the threads together",
  "🔍 Reading between the lines",
  "📐 Measuring twice",
  "🧪 Running a tiny experiment",
  "🧭 Finding a way through",
  "🎯 Zeroing in",
  "🦊 Sneaking up on the answer",
  "📡 Listening to the stack",
  "🧱 Laying the next brick",
  "🔬 Checking the moving parts",
  "🗺️ Tracing the call path",
  "🧹 Tidying a loose end",
  "🧲 Pulling the right function in",
  "🔮 Peeking one step ahead",
  "🧂 Seasoning the diff",
  "🎢 Riding the stack trace",
  "🪴 Growing a small idea",
  "🧰 Reaching for the right tool",
  "📌 Pinning down the cause",
  "🌀 Turning it over again",
  "🌙 Quietly working it out",
  "🐝 Buzzing through the details",
  "🎛️ Tuning the logic",
  "📎 Holding the pieces together",
  "🚂 Staying on the tracks",
  "🪶 Touching this lightly",
  "🪜 One step up the stack",
  "🛰️ Looking at it from above",
  "🎁 Wrapping a neat little fix",
  "📖 Rereading the good part",
] as const;

function shuffle(items: readonly string[], random: () => number): string[] {
  const next = items.slice();
  for (let i = next.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    const swap = next[i]!;
    next[i] = next[j]!;
    next[j] = swap;
  }
  return next;
}

export function createThinkingQuips(
  random: () => number = Math.random,
): () => string {
  let bag: string[] = [];
  let previous = "";

  const refill = () => {
    bag = shuffle(THINKING_QUIPS, random);
    if (bag.length > 1 && bag[bag.length - 1] === previous) {
      bag.unshift(bag.pop()!);
    }
  };

  return () => {
    if (bag.length === 0) refill();
    previous = bag.pop()!;
    return previous;
  };
}
