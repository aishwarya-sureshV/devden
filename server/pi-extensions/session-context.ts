/** Session context budgets. Pi's model catalog stays untouched. */
type Model = { provider: string; id: string; contextWindow: number; maxContextWindow?: number };
type Choice = { provider: string; id: string; contextWindow: number | null };
type Context = {
  model?: Model;
  modelRegistry: { find(provider: string, id: string): Model | undefined };
  sessionManager: { getBranch(): { type: string; customType?: string; data?: Choice }[] };
  isIdle(): boolean;
};
type Api = {
  on(event: string, handler: (event: unknown, context: Context) => Promise<void>): void;
  registerCommand(name: string, options: { description: string; handler(args: string, context: Context): Promise<void> }): void;
  setModel(model: Model): Promise<boolean>;
  getThinkingLevel(): string;
  setThinkingLevel(level: string): void;
  appendEntry(type: string, data: Choice): void;
};
const ENTRY = "devden-session-context";
export default function sessionContext(pi: Api) {
  const apply = async (choice: Choice, ctx: Context, save: boolean) => {
    if (!ctx.isIdle()) throw new Error("Wait for the current response to finish.");
    if (ctx.model?.provider !== choice.provider || ctx.model.id !== choice.id)
      throw new Error("Select this model before changing its context.");
    const base = ctx.modelRegistry.find(choice.provider, choice.id);
    if (!base?.contextWindow) throw new Error("The backend has not supplied this model's context capacity.");
    const capacity = base.maxContextWindow ?? base.contextWindow;
    const tokens = choice.contextWindow ?? base.contextWindow;
    if (!Number.isSafeInteger(tokens) || tokens <= 0 || tokens > capacity)
      throw new Error(`Context must be between 1 and ${capacity} tokens.`);
    const thinking = pi.getThinkingLevel();
    if (!await pi.setModel({ ...base, contextWindow: tokens })) throw new Error("Could not apply the session context.");
    pi.setThinkingLevel(thinking);
    if (save) pi.appendEntry(ENTRY, choice);
  };
  const restore = async (_event: unknown, ctx: Context) => {
    const choice = ctx.sessionManager.getBranch().slice().reverse().find(entry =>
      entry.type === "custom" && entry.customType === ENTRY && entry.data?.provider === ctx.model?.provider && entry.data?.id === ctx.model?.id,
    )?.data;
    if (choice) await apply(choice, ctx, false);
    else if (ctx.model) {
      const base = ctx.modelRegistry.find(ctx.model.provider, ctx.model.id);
      if (base && ctx.model.contextWindow !== base.contextWindow)
        await apply({ provider: base.provider, id: base.id, contextWindow: null }, ctx, false);
    }
  };
  pi.on("session_start", async (event, ctx) => {
    const initial = process.env.DEVDEN_SESSION_CONTEXT;
    // Consume once: switching to another session must not inherit this choice.
    delete process.env.DEVDEN_SESSION_CONTEXT;
    if (initial) await apply(JSON.parse(initial), ctx, true);
    else await restore(event, ctx);
  });
  pi.on("model_select", restore);
  pi.registerCommand("devden-context", {
    description: "Set this session's context budget without changing the model catalog",
    handler: async (args, ctx) => { await apply(JSON.parse(args), ctx, true); },
  });
}
