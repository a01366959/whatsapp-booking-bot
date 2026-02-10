# Agent Core Design — WhatsApp & Voice Booking Agent

Goal: extract a channel-agnostic Agent Core that encapsulates intent/entity extraction, session management, tool calls (Bubble), decision logic, confirmation flow, escalation, telemetry, and streaming-friendly interfaces for voice.

This document outlines the API, session model, components, and migration steps to make the current WhatsApp-centric code ready for voice and other channels.

1) High-level components
- Agent Core (`agent_core.js`): channel-agnostic coordinator. Exposes `init(deps)` and `handleIncoming(event)`.
- Channel Adapters (`adapters/whatsapp.js`, `adapters/voice.js`): thin translators that convert transport messages -> agent events and render agent actions -> transport responses.
- Tools layer: Bubble integration helpers and Redis session helpers (already implemented in `index.js`).
- Telemetry / Escalation: centralized logging + escalation queue.

2) Agent Core responsibilities
- Load and persist session (Redis) by `phone+channel`.
- Interpret messages (call LLM `interpretMessage`).
- Make decisions (`agentDecide`) and/or run in-depth agent loop (`runAgent`) when needed.
- Call tools: `get_user`, `get_hours`, `confirm_reserva` via Bubble wrappers.
- Compute confidence and decide to escalate.
- Expose a streaming-friendly interface for voice: incremental partial responses and interrupts.

3) Public API (suggested)

- init(deps)
  - deps: { openai, redis, bubbleClient, senders, config, logger }
  - returns AgentCore instance

- handleIncoming(event)
  - event: { channel: 'whatsapp'|'voice', phone, text, raw, msgId, ts, meta }
  - returns: { actions: [ { type: 'send_text'|'send_buttons'|'escalate'|'noop'|'confirm' , payload } ], session }

- handleStreamChunk(streamContext)
  - voice-specific: accept incremental STT chunks and allow early responses / interrupts

4) Session model (canonical)

{
  phone: "+52...",
  channel: "whatsapp|voice",
  intent: "book|cancel|reschedule|info",
  service: null,
  date: null,
  time: null,
  duration: null,
  bookingId: null,
  state: "collecting|confirming|completed",
  messages: [ {role, content, ts} ],
  awaitingSport: false,
  awaitingDate: false,
  awaitingTime: false,
  awaitingDuration: false,
  pendingConfirm: null,
  lastUpdated: ISO
}

5) Tooling contract
- Bubble wrappers must implement retry/backoff and surface errors as structured objects.
- Tools should be callable synchronously by the Agent Core and produce deterministic JSON.

6) Voice streaming and interrupts
- Design agent to accept partial transcripts and produce partial replies.
- Implement a small state machine per call to support: listening -> thinking -> speaking -> listening (interruptible).
- Use streaming LLM / TTS when available; otherwise send short TTS chunks frequently to feel responsive.

7) Confidence & escalation
- Implement `computeConfidence(decision, interpretation, session)`.
- Thresholds:
  - confidence < 0.45: offer human handoff immediately.
  - 0.45 <= confidence < 0.7: ask a clarifying question.
  - >= 0.7: proceed.
- Escalation: push structured message to `escalation` Redis list and optionally send SMS/WhatsApp to `STAFF_PHONE`.

8) Telemetry & observability
- Push events to Redis list `telemetry` and console.log for local debugging.
- Events: decision, tool_call, bubble_error, escalation, session_timeout, voice_interrupt.

9) Migration plan (minimal, non-breaking)
1. Add `agent_core.js` skeleton and adapter files (no changes to current `index.js`).
2. Implement agent core functions and gradually move logic from `index.js` into `agent_core.js`.
3. Update `index.js` to use `adapters/whatsapp.js` which will call `agent_core.handleIncoming`.
4. Add `adapters/voice.js` and wire Twilio Media Streams once agent core supports streaming.

10) Next steps (recommended)
- Implement `agent_core.js` core loop (interpret -> decide -> call tools -> act).
- Add streaming LLM/TTS for voice (or use chunked responses from existing LLM)
- Add metrics (Prometheus/Datadog) and monitoring for escalations.
- Create test harness to simulate WhatsApp and Voice events.

Appendix: Example flow for a booking
1. WhatsApp inbound -> `adapters/whatsapp` -> normalizes message -> `agentCore.handleIncoming`.
2. Agent core loads session from Redis and calls `interpretMessage`.
3. Agent decides action `get_hours` -> calls Bubble via tools -> builds `options`.
4. Agent returns `send_buttons` action to adapter -> adapter renders as WhatsApp buttons.
5. User selects time -> adapter receives message -> agent confirms and calls `confirm_reserva`.
6. On Bubble success, agent sends confirmation and clears session; on failure, agent escalates.

---
This doc should be considered the canonical plan for extracting the Agent Core. When you want, I can implement step 1 (create `agent_core.js` with a working `handleIncoming` that delegates to existing functions), then replace parts of `index.js` to use it.
