# Voice Implementation Plan — Twilio + Agent Core

## Overview
Transform the booking bot from WhatsApp-only to support voice calls via **Twilio Voice** with real-time speech-to-text (STT) and text-to-speech (TTS). The agent core will remain channel-agnostic; only the voice adapter will differ.

---

## 1. Services & Infrastructure Required

### Primary Services

| Service | Purpose | Why | Alternative |
|---------|---------|-----|-------------|
| **Twilio Voice** | Incoming/outgoing calls | Industry standard, webhooks, Media Streams | AWS Chime, Vonage |
| **Twilio Media Streams** | Real-time audio/transport | Bidirectional streaming, built-in to Twilio | WebRTC, raw SIP |
| **OpenAI Whisper API** | Speech-to-Text (STT) | Accurate Spanish, real-time capable | Google Cloud Speech, Azure Cognitive |
| **OpenAI TTS** | Text-to-Speech | Low latency, natural voices | Google TTS, Azure Speech, ElevenLabs |
| **Redis** | Session / state (shared) | Already in use for WhatsApp | PostgreSQL, DynamoDB |
| **WebSocket Server** | Real-time bidirectional comm | Required for Media Streams | HTTP long-polling (slower) |

### Environment Variables Needed
```bash
# Twilio Voice
TWILIO_ACCOUNT_SID=AC...
TWILIO_AUTH_TOKEN=...
TWILIO_PHONE_NUMBER=+529876543210
TWILIO_TWIML_URL=https://your-domain.com/voice/twiml

# OpenAI (already have)
OPENAI_API_KEY=sk-...

# WebSocket / Media Streams
VOICE_WEBSOCKET_URL=wss://your-domain.com/voice/media-stream
VOICE_WEBHOOK_URL=https://your-domain.com/voice/webhook
```

---

## 2. Architecture & Data Flow

### Call Lifecycle

```
User calls +52 XXX XXX XXXX (Twilio number)
    ↓
Twilio webhook → POST /voice/webhook
    ↓
CreateCall event → agent_core.handleIncoming({ channel: 'voice', phone, meta })
    ↓
Session loaded from Redis
    ↓
Twilio Media Streams WebSocket established
    ↓
Audio frames → Whisper STT → transcripts
    ↓
Transcripts → agent_core (same as WhatsApp)
    ↓
Agent decision (reply, get_hours, confirm, escalate)
    ↓
Response text → OpenAI TTS → audio chunks
    ↓
Audio → Twilio Media Streams → User's phone
    ↓
User speaks → repeat STT → interrupt (if needed) → repeat
    ↓
Booking confirmed / Escalated / Hung up
    ↓
Session saved to Redis, call ended
```

### Key Difference from WhatsApp
- **WhatsApp**: Request/response cycles, discrete messages
- **Voice**: Continuous bidirectional streaming, interrupts mid-sentence, natural turn-taking

---

## 3. Implementation Phases

### Phase 1: Twilio Setup & Incoming Calls (Week 1)
**Goal**: Answer calls, detect speaker, load session

**Deliverables**:
1. Install `twilio` npm package
2. Create `/voice/webhook` endpoint (TwiML response)
3. Create `/voice/media-stream` WebSocket endpoint
4. Detect caller phone → load/create session from Redis
5. Start Media Streams connection
6. Log call metadata

**Code Structure**:
```
index.js (new routes)
├── POST /voice/webhook → createCall
├── POST /voice/twiml → return TwiML with Media Streams URL
└── WS /voice/media-stream → handle audio + setup

adapters/voice.js (new)
├── parseMediaStreamEvent(chunk)
├── encodeAudioForWhisper(raw)
├── decodeAudioFromTTS(buffer)
└── sendAudioToUser(stream, buffer)
```

### Phase 2: Speech-to-Text (Week 2)
**Goal**: Convert user audio → text → agent_core

**Deliverables**:
1. Whisper API integration for STT
2. Handle partial transcripts (for real-time feedback)
3. Final transcript confidence scoring
4. Buffer audio frames, send periodically to Whisper
5. Extract transcript → send to agentCore.handleIncoming

**Implementation**:
```javascript
// On each audio frame from Twilio:
audioBuffer.push(frame);

// Every 2 seconds or on silence:
if (bufferReady) {
  const transcript = await whisperSOT(audioBuffer);
  // Send to agent
  const action = await agentCore.handleIncoming({
    channel: 'voice',
    phone: caller,
    text: transcript.text,
    isFinal: transcript.isFinal
  });
}
```

### Phase 3: Text-to-Speech & Audio Output (Week 3)
**Goal**: Agent response → audio → user's phone

**Deliverables**:
1. OpenAI TTS integration
2. Convert agent text responses → audio chunks
3. Send audio via Media Streams in real-time
4. Handle interrupts (user speaks while agent is talking)
5. Graceful fallback if TTS fails

**Implementation**:
```javascript
// When agent sends reply action:
const replyText = action.payload.message;

// Stream TTS audio
const audioStream = await tts.stream(replyText, {
  voice: 'nova',
  speed: 1.0
});

// Send chunks to user in real-time
for await (const chunk of audioStream) {
  mediaStream.send(chunk);
}
```

### Phase 4: Interrupts & Turn-Taking (Week 4)
**Goal**: Natural conversation, user can interrupt agent

**Deliverables**:
1. Detect user speaking while agent is still talking
2. Stop TTS immediately, analyze silence/speech
3. Interrupt agent gracefully (cut off reply, ask user to repeat)
4. Proper state machine: WAITING → LISTENING → TRANSCRIBING → AGENT_DECISION → SPEAKING
5. Test with real users

**State Machine**:
```
WAITING → (user speaks) → LISTENING
LISTENING → (transcript ready) → AGENT_DECIDING
AGENT_DECIDING → SPEAKING (TTS)
SPEAKING → (user interrupts) → STOP_TTS, go to LISTENING
SPEAKING → (complete) → WAITING
```

---

## 4. Integration with Agent Core

The **agent_core.js** is already channel-agnostic. Min changes needed:

### Current Agent Core API
```javascript
handleIncoming(event) {
  // event: { channel, phone, text, raw, msgId, ts }
  // returns: { actions: [...], session }
}
```

### Voice-Specific Event Fields
```javascript
{
  channel: 'voice',
  phone: '+525574599078',
  text: 'Quiero reservar pádel para mañana',
  isFinal: true,
  isMidTurn: false,  // NEW: true if partial transcript
  callSid: 'CA....',  // NEW: Twilio call ID
  timestamp: Date.now()
}
```

### Voice-Specific Actions (additive, not breaking)
```javascript
{
  type: 'send_text',
  payload: { message: '...' }  // Agent sends text
}
// Voice adapter AUTOMATICALLY converts to TTS + audio

{
  type: 'interrupt',
  payload: { reason: 'user_spoke' }  // NEW: Tell agent to pause
}

{
  type: 'confirm_booking',
  payload: { ... }  // Same as WhatsApp
}

{
  type: 'escalate_to_human',
  payload: { reason: '...' }  // Hang up, call staff
}
```

**No changes needed to agent_core.js logic** — voice adapter handles audio transport.

---

## 5. Services Implementation Details

### 5.1 Twilio Voice Integration

**Install**:
```bash
npm install twilio twilio-media-streams
```

**Phone Number**: Buy or configure in Twilio Console
```
+52 ??? (Mexican number)
Webhook URL: https://your-domain.com/voice/twiml
```

**Call Flow**:
1. User dials → Twilio hits `/voice/twiml`
2. Server returns TwiML with Media Streams URL
3. Twilio connects WebSocket to `/voice/media-stream`
4. Audio streams in real-time

**TwiML Response** (example):
```xml
<Response>
  <Say language="es-MX">Un momento, conectando...</Say>
  <Connect>
    <Stream url="wss://your-domain.com/voice/media-stream?CallSid={CallSid}&From={From}" />
  </Connect>
</Response>
```

### 5.2 Whisper STT

**How it works**:
- Buffer 2–3 sec of audio
- Send `.wav` to Whisper API
- Get transcript + confidence
- Cost: ~$0.02 per 15 min audio

**Integration**:
```javascript
const audioPath = '/tmp/audio.wav';
const response = await openai.audio.transcriptions.create({
  file: fs.createReadStream(audioPath),
  model: 'whisper-1',
  language: 'es'  // Spanish
});
const text = response.text;
```

### 5.3 OpenAI TTS

**How it works**:
- Send text (e.g., "Para Padel el 11, tengo: 10:00, 14:00...")
- Get MP3 audio stream
- Send to Twilio Media Streams
- Cost: ~$0.015 per 1K characters

**Integration**:
```javascript
const response = await openai.audio.speech.create({
  model: 'tts-1',  // Lower latency
  voice: 'nova',   // Spanish-friendly
  input: replyText
});
const audioBuffer = Buffer.from(await response.arrayBuffer());
```

### 5.4 Media Streams WebSocket

**What we receive** (audio from user):
```json
{
  "type": "media",
  "media": {
    "payload": "[base64 audio]"
  }
}
```

**What we send back** (audio to user):
```json
{
  "type": "media",
  "media": {
    "payload": "[base64 audio]"
  }
}
```

**Handling**:
```javascript
const wss = new WebSocketServer({ port: 8080 });
wss.on('connection', (ws) => {
  ws.on('message', (msg) => {
    const event = JSON.parse(msg);
    if (event.type === 'media') {
      const audioChunk = Buffer.from(event.media.payload, 'base64');
      // Process audio → STT → agent → TTS → send back
    }
  });
});
```

---

## 6. Conversation Flow Example

**User calls, bot greets**:
```
User dials +52...
Twilio connects Media Streams
Bot (TTS): "Hola, bienvenido a Black Padel. ¿Cómo puedo ayudarte?"
```

**User responds**:
```
User (speaks): "Quiero reservar pádel para mañana"
Whisper (STT): "Quiero reservar pádel para mañana"
Agent core: decision = { action: 'get_hours', message: 'Para Padel el 11...' }
Bot (TTS): "Para Padel el 11 de febrero, tengo: 10:00, 14:00... ¿A qué hora prefieres?"
```

**User picks time**:
```
User: "A las 14 horas"
Whisper: "A las 14 horas"
Agent core: decision = { action: 'confirm_reserva', ... }
Bot (TTS): "Perfecto. Entonces confirmamos: Padel el 11 a las 14:00. ¿Te parece bien?"
```

**User confirms**:
```
User: "Sí, por favor"
Whisper: "Sí, por favor"
Agent core: invoke confirmBooking() → success
Bot (TTS): "¡Listo! Te llegará confirmación al WhatsApp. Gracias."
Call ends
```

---

## 7. Error Handling & Fallbacks

| Scenario | Action |
|----------|--------|
| Whisper fails (timeout) | Replay: "No entendí. ¿Puedes repetir?" |
| User is silent > 10s | Prompt: "¿Sigues ahí?" |
| TTS takes > 3s | Start playing while generating (stream) |
| Agent escalates | Play: "Te conecto con un agente. Espera un momento." → Call transfer or hang up |
| Network drops | Fallback: Send SMS confirmation |
| User hangs up | Log call end, mark session incomplete |

---

## 8. Testing & Validation

### Unit Tests
```javascript
// Test Whisper parsing
test('transcribeAudio', async () => {
  const audio = fs.readFileSync('test.wav');
  const text = await transcribeAudio(audio);
  expect(text).toContain('pádel');
});

// Test TTS generation
test('generateSpeech', async () => {
  const audio = await generateSpeech('Hola');
  expect(audio).toBeInstanceOf(Buffer);
  expect(audio.length).toBeGreaterThan(100);
});
```

### Integration Tests
```javascript
// Simulate Media Streams event
test('handleMediaStream', async () => {
  const audioChunk = Buffer.from('...');  // Real audio
  const response = await handleMediaStreamChunk(audioChunk, session);
  expect(response.type).toBe('media');
});
```

### E2E Testing (Manual)
1. Call the Twilio number from real phone
2. Speak a few requests: "Pádel mañana", "10 de la mañana", "Confirma"
3. Verify booking appears in Bubble
4. Check logs for Whisper/TTS/agent decisions

---

## 9. Cost Estimate (Monthly)

| Service | Per-Unit | Estimated Usage | Monthly Cost |
|---------|----------|-----------------|--------------|
| Twilio (incoming calls) | $0.0085/min | 1000 min | ~$8.50 |
| Whisper (STT) | $0.02 / 15 min | 1000 min = 67 calls | ~$2.67 |
| OpenAI TTS | $0.015 / 1K chars | ~50K chars (calls) | ~$0.75 |
| Twilio Media Streams | Included | — | $0 |
| OpenAI GPT-4o-mini | $0.15/$0.60 / 1M tokens | ~10K prompts | ~$2 |
| **Total** | — | — | **~$14–15/month** |

(Low usage; scales well if > 10K calls/month)

---

## 10. Roadmap & Milestones

| Week | Phase | Deliverables |
|------|-------|--------------|
| Week 1–2 | Setup & STT | Twilio connection, Whisper integration, session persistence |
| Week 3 | TTS | OpenAI TTS, real-time audio streaming |
| Week 4–5 | Testing & Polish | Interrupts, error handling, edge cases |
| Week 6 | Go-live | Soft launch, monitoring, stress test |

---

## 11. Risk Mitigations

| Risk | Solution |
|------|----------|
| STT latency (Whisper) | Buffer intelligently; show partial transcripts |
| Echo/duplex audio issues | Use Twilio's built-in echo cancellation |
| TTS quality (non-native speaker) | Test with real users; use `tts-1-hd` if needed |
| Call dropping | Implement session recovery; log call ID |
| Concurrent calls spike | Use queue; Twilio auto-scales |

---

## 12. Summary

**What changes**:
- Add Twilio integration (new routes, WebSocket)
- Add Whisper + TTS (audio codec/streaming)
- Add voice adapter (thin layer)

**What doesn't change**:
- Agent core logic (same for all channels)
- Session model (phone + metadata)
- Booking/confirmation flow

**Timeline**: ~4–6 weeks for production-ready voice
**Budget**: $15–20/month for low-to-medium volume
**Team**: 1 engineer (part-time) + QA for testing

---

## Next Steps
1. ✅ **Review this plan** with team
2. ⬜ Set up Twilio account + buy Mexican phone number
3. ⬜ Implement Phase 1 (Twilio webhook + Media Streams)
4. ⬜ Implement Phase 2 (Whisper STT)
5. ⬜ Implement Phase 3 (OpenAI TTS)
6. ⬜ Test with real calls
7. ⬜ Monitor & iterate

Ready to start Phase 1? 🎤
