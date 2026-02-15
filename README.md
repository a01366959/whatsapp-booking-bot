# WhatsApp + Voice Booking Agent — Full Project Context

This repository implements a production-grade, multi-channel booking agent that behaves like a real human receptionist for Black Padel & Pickleball (Mexico).

---

**1. Project Overview**

- Multi-channel agent that: answers WhatsApp messages, answers phone calls (Twilio Voice), speaks naturally on calls, holds context, asks clarifying questions, checks real availability via Bubble, creates bookings, and escalates to humans when needed.
- **Human monitoring system**: Real staff can view conversations in real-time, take over from AI, respond to users, and handle edge cases.
- **Subtle escalation**: When AI encounters out-of-scope questions (owner requests, complaints), it sends a "thinking" message and hands off to a human seamlessly.
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
8. **Escalation to human must always be possible** (subtle or explicit).
9. **When in doubt, hand off to human** (provide best customer experience).

---

**3. Channels**

- WhatsApp: chat-based booking, rescheduling, confirmations. Implemented as a webhook bot; needs refactor to use the shared agent core.
- Voice (Twilio): inbound calls answered by the agent using Twilio Media Streams; audio streamed via WebSocket; NOT IVR.
- **Human Dashboard (Bubble)**: Real-time staff interface to monitor, intervene, and manage conversations.

---

**4. High-Level Architecture**

```
User (WhatsApp / Phone Call)
    ↓
Channel Adapter (WhatsApp / Voice)
    ↓
AGENT CORE (shared logic)
    ├─→ Normal booking flow (routine questions)
    ├─→ Subtle escalation (out-of-scope + "thinking" message)
    └─→ Explicit escalation (high-attention situations)
    ↓
[Redis Session Storage]
    ↓
[Human Monitoring System]
    ├─→ Check: Is human mode active?
    ├─→ If YES → Skip AI, wait for human response
    ├─→ If NO → Proceed with AI logic
    ↓
Bubble API (availability, booking, webhooks)
    ↓
Response rendered back to channel
    ↓
[Conversation Archive] → Bubble database
```

The agent can be interrupted at any time by a human taking control from the Bubble dashboard.

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

**16. Key Features (Implemented) ✅**

### Human Monitoring System
Real staff dashboard in Bubble to:
- View active conversations in real-time
- Take over from AI with one click  
- Send messages as human staff directly to WhatsApp
- See full conversation history with readable timestamps
- Archive completed conversations to database
- View escalation queue for urgent issues

📖 See: [HUMAN_MONITOR_SETUP.md](HUMAN_MONITOR_SETUP.md)

### Subtle Escalation (Smart Out-of-Scope Handling)
When user asks about topics outside agent's scope:
- Agent detects keywords (owner, complaint, policy questions)
- Sends natural "thinking" message: "Dame un momento para revisar..."
- Escalates to human in background (user never knows)
- Human takes over and responds naturally in seconds
- Experience feels seamless from user's perspective

Use cases: Owner requests, complaints, policy questions, arbitrary topics

📖 See: [SUBTLE_ESCALATION.md](SUBTLE_ESCALATION.md)

### REST API for Integration  
- `GET /api/conversations` - List active conversations
- `GET /api/conversation/:phone` - Get full conversation history
- `POST /api/conversation/:phone/takeover` - Staff takes over
- `POST /api/conversation/:phone/release` - Release back to AI
- `POST /api/conversation/:phone/send` - Send message as staff
- `GET /api/escalations` - Get escalation queue
- `POST /api/conversation/:phone/archive` - Archive conversation

📖 See: [HUMAN_MONITOR_SETUP.md#rest-api-endpoints](HUMAN_MONITOR_SETUP.md#rest-api-endpoints)

---

**17. Definition of Done**

- A user can call, talk naturally, book a service, get confirmation, receive WhatsApp summary, and escalate to human when needed — and the experience feels like a real person answered.
- Staff can monitor active conversations and take over from AI instantly
- Out-of-scope questions are handled gracefully via subtle escalation
- Full audit trail of all conversations (archived in Bubble)

---

**18. Important Notes for Contributors & AI Assistants**

- Do NOT propose IVR or button-only flows.
- Do NOT hardcode scripts.
- Do NOT invent availability.
- ALWAYS respect Bubble as source of truth.
- ALWAYS design for multi-channel reuse.
- **Escalate early, not late** - When in doubt, hand off to human for best customer experience.

---

How to use this file:

- Paste into Cursor / VS Code AI chat or other assistant contexts.
- Use as the single authoritative system brief for new contributors and tools.

Next suggested actions (pick one):

- Translate this into a formal `SYSTEM_PROMPT.md` for coding agents.
- Start extracting the Agent Core and add channel adapter skeletons.
- I can implement either of the above — tell me which you'd like next.
