'use strict';

class PendingQuestions {
  constructor() {
    this.store = new Map();
    // Track last question ts per DM channel for non-threaded replies
    this.lastTs = new Map();
  }

  add(channelId, messageTs, context) {
    this.store.set(`${channelId}:${messageTs}`, context);
    this.lastTs.set(channelId, messageTs);
  }

  get(channelId, parentTs) {
    return this.store.get(`${channelId}:${parentTs}`);
  }

  getLastForChannel(channelId) {
    const ts = this.lastTs.get(channelId);
    if (!ts) return null;
    return { ts, context: this.store.get(`${channelId}:${ts}`) };
  }

  delete(channelId, parentTs) {
    this.store.delete(`${channelId}:${parentTs}`);
    if (this.lastTs.get(channelId) === parentTs) {
      this.lastTs.delete(channelId);
    }
  }
}

module.exports = PendingQuestions;
