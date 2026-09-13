/**
 * Mid-turn message queue shared by every agent process.
 *
 * `isBusy` / `sendNow` are the only per-backend hooks: every backend queues
 * on an in-flight turn (pi/claude/grok/codex), never merely because a
 * process exists. Delivery and cancel stay identical.
 */
export function attachQueue(agent, { isBusy, sendNow, steerNow, requeueOnFailure = true }) {
  if (!Array.isArray(agent.queuedMessages)) agent.queuedMessages = [];
  if (!Number.isFinite(agent.queueSeq)) agent.queueSeq = 0;
  agent.isBusy = function isBusyBound() {
    return isBusy.call(this);
  };

  /**
   * Suppress the one auto-flush that the interrupt's own turn-end would
   * trigger. A message queued behind a turn was queued on the assumption that
   * the turn would finish; once the user cancels that turn, sending it anyway
   * is the agent deciding for them. It stays in the queue strip, where
   * "Send now" and the ✕ are both one click away.
   */
  agent.holdQueue = function holdQueue() {
    this.queueHeld = this.queuedMessages.length > 0;
  };

  // A new turn means the user is driving again, so a hold that the aborted
  // turn's settle never consumed (codex skips the flush on a failed turn)
  // must not survive to eat a later, legitimate one.
  const ownPrompt = typeof agent.prompt === "function" ? agent.prompt : undefined;
  if (ownPrompt)
    agent.prompt = function promptReleasingHold(message, images) {
      this.queueHeld = false;
      return ownPrompt.call(this, message, images);
    };

  agent.queueSnapshot = function queueSnapshot() {
    return this.queuedMessages.map(({ id, message, at }) => ({
      id,
      message,
      at,
    }));
  };

  agent.emitQueue = function emitQueue() {
    this.emit({
      type: "queue_updated",
      sessionKey: this.sessionKey,
      queued: this.queueSnapshot(),
    });
  };

  agent.enqueue = function enqueue(message, images) {
    const text = String(message ?? "");
    if (!text.trim())
      return Promise.resolve({ ok: false, error: "Empty message" });
    if (!isBusy.call(this))
      return sendNow.call(this, text, images).then((result) =>
        result.ok ? { ok: true, data: { queued: false } } : result,
      );
    this.queueSeq += 1;
    this.queuedMessages.push({
      id: `q-${Date.now()}-${this.queueSeq}`,
      message: text,
      images: Array.isArray(images) ? images : [],
      at: Date.now(),
    });
    this.emitQueue();
    return Promise.resolve({
      ok: true,
      data: { queued: true, position: this.queuedMessages.length },
    });
  };

  agent.cancelQueued = function cancelQueued(id) {
    const before = this.queuedMessages.length;
    this.queuedMessages = id
      ? this.queuedMessages.filter((entry) => entry.id !== id)
      : [];
    if (this.queuedMessages.length === before)
      return { ok: false, error: "That message is no longer queued" };
    // Nothing left to hold back; don't leave the flag for a later settle.
    if (this.queuedMessages.length === 0) this.queueHeld = false;
    this.emitQueue();
    return {
      ok: true,
      data: { cancelled: before - this.queuedMessages.length },
    };
  };

  agent.sendNextQueued = function sendNextQueued() {
    if (this.queueHeld) {
      // One-shot: this is the interrupted turn's settle going by.
      this.queueHeld = false;
      return;
    }
    const next = this.queuedMessages.shift();
    if (!next) return;
    this.emitQueue();
    const sent = sendNow.call(
      this,
      next.message,
      next.images.length ? next.images : undefined,
    );
    if (!requeueOnFailure || !sent || typeof sent.then !== "function") return;
    sent
      .then((result) => {
        if (result?.ok) return;
        this.queuedMessages.unshift(next);
        this.emitQueue();
      })
      .catch(() => {
        this.queuedMessages.unshift(next);
        this.emitQueue();
      });
  };

  agent.steerQueued = function steerQueued(id) {
    // Idle: there is no running turn to splice into, so this is an ordinary
    // send. That is what makes the queue strip's button work after an
    // interrupt even on an agent that cannot steer, like grok.
    const deliver = isBusy.call(this) ? steerNow : sendNow;
    if (typeof deliver !== "function")
      return Promise.resolve({
        ok: false,
        error: "This agent cannot take a message mid-turn",
      });
    this.queueHeld = false;
    const idx = id
      ? this.queuedMessages.findIndex((entry) => entry.id === id)
      : 0;
    if (idx < 0 || !this.queuedMessages[idx])
      return Promise.resolve({
        ok: false,
        error: "That message is no longer queued",
      });
    const [entry] = this.queuedMessages.splice(idx, 1);
    this.emitQueue();
    const sent = deliver.call(
      this,
      entry.message,
      entry.images.length ? entry.images : undefined,
    );
    if (!requeueOnFailure || !sent || typeof sent.then !== "function")
      return sent ?? { ok: true };
    return sent
      .then((result) => {
        if (result?.ok) return result;
        this.queuedMessages.splice(idx, 0, entry);
        this.emitQueue();
        return result;
      })
      .catch((error) => {
        this.queuedMessages.splice(idx, 0, entry);
        this.emitQueue();
        throw error;
      });
  };

  // Claude called this flushQueue; keep the alias so existing call sites work.
  agent.flushQueue = agent.sendNextQueued;
  return agent;
}
