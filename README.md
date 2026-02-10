# WhatsApp + Voice Booking Agent — Full Project Context

This repository implements a production-grade, multi-channel booking agent that behaves like a real human receptionist for Black Padel & Pickleball (Mexico).

---

**1. Project Overview**

- Multi-channel agent that: answers WhatsApp messages, answers phone calls (Twilio Voice), speaks naturally on calls, holds context, asks clarifying questions, checks real availability via Bubble, creates bookings, and escalates to humans when needed.
- This is an agent (not an IVR or scripted chatbot).

---

**2. Core Principles (NON-NEGOTIABLE)**

1. Never invent availability.
2. Bubble is the single source of truth.
3. Booking only happens after explicit confirmation.
4. Agent must ask clarifying questions if data is incomplete.
5. Voice agent must feel human (interruptible, conversational).
6. Same brain for WhatsApp and Voice.
7. No hardcoded scripts or button-only logic.
8. Escalation to human must always be possible.

---

**3. Channels**

- WhatsApp: chat-based booking, rescheduling, confirmations. Implemented as a webhook bot; needs refactor to use the shared agent core.
- Voice (Twilio): inbound calls answered by the agent using Twilio Media Streams; audio streamed via WebSocket; NOT IVR.

---

**4. High-Level Architecture**

User (WhatsApp / Phone Call)
→ Twilio / WhatsApp Webhook
→ Channel Adapter (WhatsApp / Voice)
→ AGENT CORE (shared logic)
→ Bubble API (availability, booking)
→ Response rendered back to channel

Twilio and WhatsApp are transport layers only — all intelligence lives in the Agent Core.

---

**5. Agent Definition**

- Tool-using conversational agent.
- Can understand intent (book / cancel / reschedule / info), extract entities (sport/service, date, time preference, duration), ask follow-ups, call Bubble, confirm actions, speak or text naturally.
- Not a decision tree, not button-only, not IVR.

---

**6. Agent Responsibilities**

Must:
- Keep conversation state.
- Decide next best question and when enough info exists to book.
- Decide when to escalate to human.
- Handle corrections and interruptions.

Must NOT:
- Guess availability.
- Skip confirmation.
- Create bookings silently.

---

**7. Session & Memory Model**

Sessions keyed by `phone_number` and `channel` with a persisted object (Redis/DB), for example:

{
  "phone": "+52...",
  "channel": "whatsapp|voice",
  "intent": "book|cancel|reschedule|info",
  "service": null,
  "date": null,
  "time": null,
  "duration": null,
  "bookingId": null,
  "state": "collecting|confirming|completed",
  "lastUpdated": "ISO_DATE"
}

Sessions must persist across turns (Redis is used in this repo).

---

**8. Bubble Integration (CRITICAL)**

Bubble is the single source of truth. The agent may only read availability from Bubble and create/update/cancel bookings via Bubble workflows. The agent must never calculate availability locally or assume hours.

---

**9. Voice-Specific Requirements**

- Use Twilio Media Streams with WebSocket audio streaming.
- Support interruptions, natural pauses, clarifications, real-time STT and TTS.
- No IVR or DTMF menus.

---

**10. Twilio Voice Entry Point**

Example TwiML for inbound calls:

```xml
<Response>
  <Connect>
    <Stream url="wss://YOUR_DOMAIN/voice/stream" />
  </Connect>
</Response>
```

All conversation logic lives in the agent after the stream is established.

---

**11. WhatsApp Entry Point**

- WhatsApp messages are normalized and sent to the same agent core.
- Responses are plain text or interactive buttons (UX helpers only — logic must not depend on them).

---

**12. Escalation to Human**

Escalate if user asks for human, agent confidence is low, booking fails, user is frustrated, or system errors occur. Methods: transfer call (Twilio Dial), notify staff, or continue WhatsApp human takeover.

---

**13. Tech Stack**

- Node.js / Express
- Twilio Voice + Media Streams
- WhatsApp Cloud API
- Bubble API
- Redis for sessions (Upstash or similar)
- OpenAI (or equivalent) for agent intelligence and realtime STT/TTS

---

**14. What Already Exists**

- WhatsApp webhook bot (index.js)
- Bubble workflows and endpoints
- Railway deployment config (in repo)
- Some agent-like logic inside `index.js` that currently is WhatsApp-centric and needs refactor into a shared Agent Core

Current problem: logic is too WhatsApp-centric and must be refactored to a true agent core abstraction.

---

**15. Immediate Next Refactor Goals**

1. Extract Agent Core (channel-agnostic).
2. Create Channel Adapters: WhatsApp adapter and Voice adapter.
3. Add Twilio Media Streams integration and voice pipeline.
4. Unify session handling (Redis-backed).
5. Implement escalation logic and human handoff.

---

**16. Definition of Done**

- A user can call, talk naturally, book a service, get confirmation, receive WhatsApp summary, and escalate to human when needed — and the experience feels like a real person answered.

---

**17. Important Notes for Contributors & AI Assistants**

- Do NOT propose IVR or button-only flows.
- Do NOT hardcode scripts.
- Do NOT invent availability.
- ALWAYS respect Bubble as source of truth.
- ALWAYS design for multi-channel reuse.

---

How to use this file:

- Paste into Cursor / VS Code AI chat or other assistant contexts.
- Use as the single authoritative system brief for new contributors and tools.

Next suggested actions (pick one):

- Translate this into a formal `SYSTEM_PROMPT.md` for coding agents.
- Start extracting the Agent Core and add channel adapter skeletons.
- I can implement either of the above — tell me which you'd like next.
