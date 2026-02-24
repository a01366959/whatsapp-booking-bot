import test from "node:test";
import assert from "node:assert/strict";
import { init } from "../agent_core.js";

class RedisMock {
  constructor() {
    this.store = new Map();
    this.lists = new Map();
    this.sorted = new Map();
  }

  async get(key) {
    return this.store.has(key) ? this.store.get(key) : null;
  }

  async set(key, value, options = {}) {
    if (options?.nx && this.store.has(key)) return null;
    this.store.set(key, value);
    return "OK";
  }

  async del(key) {
    this.store.delete(key);
    this.lists.delete(key);
    this.sorted.delete(key);
    return 1;
  }

  async lpush(key, value) {
    const list = this.lists.get(key) || [];
    list.unshift(value);
    this.lists.set(key, list);
    return list.length;
  }

  async expire() {
    return 1;
  }

  async zadd(key, { score, member }) {
    const list = this.sorted.get(key) || [];
    const idx = list.findIndex(item => item.member === member);
    if (idx >= 0) list[idx] = { score, member };
    else list.push({ score, member });
    list.sort((a, b) => a.score - b.score);
    this.sorted.set(key, list);
    return 1;
  }

  async zrange(key, start, end, options = {}) {
    const list = [...(this.sorted.get(key) || [])];
    const sorted = options.rev ? list.reverse() : list;
    const len = sorted.length;

    const normalize = index => (index < 0 ? Math.max(0, len + index) : index);
    const s = normalize(start);
    const e = normalize(end);
    const slice = sorted.slice(s, e + 1);

    if (options.withScores) {
      const out = [];
      for (const item of slice) {
        out.push(item.member, item.score);
      }
      return out;
    }

    return slice.map(item => item.member);
  }

  async incrby(key, value) {
    const current = Number(this.store.get(key) || 0);
    const next = current + value;
    this.store.set(key, next);
    return next;
  }

  async incr(key) {
    return this.incrby(key, 1);
  }
}

function createOpenAIStub(handler) {
  return {
    chat: {
      completions: {
        create: handler
      }
    }
  };
}

function buildSession(overrides = {}) {
  return {
    phone: "5512345678",
    messages: [],
    user: { found: false },
    userLastName: null,
    userChecked: true,
    lastTs: 0,
    bookingDraft: { sport: null, date: null, time: null, duration: 1, name: null, lastName: null },
    confirmedBookings: [],
    hours: null,
    ...overrides
  };
}

test("ignores reaction messages without calling OpenAI", async () => {
  const redis = new RedisMock();
  let openAICalls = 0;

  const openai = createOpenAIStub(async () => {
    openAICalls += 1;
    return { choices: [{ message: { content: "ok", tool_calls: [] } }] };
  });

  const sent = [];
  const { handleIncoming } = init({
    openai,
    redis,
    senders: { text: async (to, text) => sent.push({ to, text }) },
    config: {}
  });

  await handleIncoming({
    channel: "whatsapp",
    phone: "5512345678",
    raw: {
      id: "msg_reaction_1",
      from: "5215512345678",
      timestamp: String(Math.floor(Date.now() / 1000)),
      type: "reaction",
      reaction: { emoji: "👍" }
    }
  });

  assert.equal(openAICalls, 0);
  assert.equal(sent.length, 0);
});

test("dedupes repeated msg.id and processes only once", async () => {
  const redis = new RedisMock();
  await redis.set("session:5512345678", buildSession());

  let openAICalls = 0;
  const openai = createOpenAIStub(async () => {
    openAICalls += 1;
    return { choices: [{ message: { content: "Perfecto, te ayudo.", tool_calls: [] } }] };
  });

  const sent = [];
  const { handleIncoming } = init({
    openai,
    redis,
    senders: { text: async (to, text) => sent.push({ to, text }) },
    config: {}
  });

  const event = {
    channel: "whatsapp",
    phone: "5512345678",
    raw: {
      id: "msg_same_123",
      from: "5215512345678",
      timestamp: String(Math.floor(Date.now() / 1000)),
      type: "text",
      text: { body: "Hola" }
    }
  };

  await handleIncoming(event);
  await handleIncoming(event);

  assert.equal(openAICalls, 1);
  assert.equal(sent.length, 1);
});

test("includes confirmed bookings in prompt for post-booking questions", async () => {
  const redis = new RedisMock();

  const confirmed = [{
    sport: "Padel",
    date: "2026-02-25",
    time: "18:00",
    name: "Pablo",
    lastName: "Escalante",
    confirmedAt: "2026-02-24T12:00:00.000Z",
    status: "confirmed"
  }];

  await redis.set("session:5512345678", buildSession({ confirmedBookings: confirmed }));
  await redis.set("bookings:5512345678", confirmed);

  let capturedSystemPrompt = "";
  const openai = createOpenAIStub(async payload => {
    capturedSystemPrompt = payload?.messages?.[0]?.content || "";
    return {
      choices: [
        {
          message: {
            content: "Sí, tenemos torneos y retas. Para detalles te recomiendo escribir al club.",
            tool_calls: []
          }
        }
      ]
    };
  });

  const sent = [];
  const { handleIncoming } = init({
    openai,
    redis,
    senders: { text: async (to, text) => sent.push({ to, text }) },
    config: {}
  });

  await handleIncoming({
    channel: "whatsapp",
    phone: "5512345678",
    raw: {
      id: "msg_torneos_1",
      from: "5215512345678",
      timestamp: String(Math.floor(Date.now() / 1000)),
      type: "text",
      text: { body: "Tienen torneos?" }
    }
  });

  assert.match(capturedSystemPrompt, /RESERVAS CONFIRMADAS/i);
  assert.match(capturedSystemPrompt, /Padel/i);
  assert.match(capturedSystemPrompt, /18:00/);
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /torneos|retas/i);
});
