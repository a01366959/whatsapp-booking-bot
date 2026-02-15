# Subtle Escalation System

## Overview

**Subtle Escalation** is a transparent, user-friendly way to hand off conversations to human staff when the AI agent encounters questions it can't answer. The user perceives a seamless handoff while a real human takes over in the background.

## How It Works

### User's Experience

1. **User asks something outside AI's scope**: "Quiero hablar con el dueño" or "Tengo una queja"
2. **Sees "thinking" message**: "Dame un momento para revisar..."
3. **Human takes over silently** and responds naturally
4. **User never knows** it was handed to a human (feels like the same bot got smarter)

### Backend Flow

```
┌─────────────────────────────────────────────────────────────────┐
│ User sends out-of-scope message                                 │
└────────────────────┬────────────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────────────┐
│ Agent analyzes: "This needs subtle_escalate"                    │
│ (detects keywords: dueño, reclamación, queja)                   │
└────────────────────┬────────────────────────────────────────────┘
                     │
                     ├──────────────────────────────────────────────┐
                     │                                              │
                     ▼                                              ▼
        ┌──────────────────────┐          ┌─────────────────────┐
        │ Send "thinking" msg  │          │ Escalate to Human   │
        │ "Dame un momento..." │          │ (no user message)   │
        │                      │          │                     │
        │ (appears natural)    │          │ - Add to queue      │
        └──────────────────────┘          │ - Flag in Redis     │
                                          │ - Notify Bubble     │
                                          └────────┬────────────┘
                                                   │
                     ┌─────────────────────────────┘
                     │
                     ▼
        ┌──────────────────────────────┐
        │ Human sees in Bubble         │
        │ - Phone in escalation queue  │
        │ - Full conversation history  │
        │ - Takes over with one click  │
        └──────────────────────────────┘
                     │
                     ▼
        ┌──────────────────────────────┐
        │ Human responds humanly       │
        │ User receives human response │
        │ Feels seamless & continues   │
        └──────────────────────────────┘
```

## Implementation Details

### Agent Changes (agent_core.js)

#### 1. New Action Type
```javascript
// Added to system prompt's action types:
"action": "ask|reply|get_user|get_hours|confirm_reserva|send_location|subtle_escalate"

// Response includes optional reason field:
"reason": "user_requests_owner|complaint|out_of_scope|policy_question"
```

#### 2. Detection Keywords (GPT-4 powered)

The agent detects and escalates when user mentions:

**Direct requests for human contact:**
- "Hablar con el dueño/gerente/director/manager"
- "Quiero hablar con un humano"
- "Conectame con alguien"

**Complaints/Issues:**
- "Tengo una queja/reclamación/reclamo"
- "Esto no es justo / es injusto"
- "Quiero presentar una queja"
- "No estoy conforme / satisfecho"

**Policy/Sensitive topics:**
- "¿Cuál es la política de..."
- "¿Qué pasa si...?" (cancellation, refunds, etc.)
- "¿Puedo devolver...?"
- "¿Hay reembolso?"
- Business litigation or legal questions

**Arbitrary/Out of Scope:**
- Any topic completely unrelated to booking/facility info
- Personal requests
- Technical support beyond the agent's knowledge base

#### 3. Subtle Escalation Handler

```javascript
if (decision.action === "subtle_escalate") {
  // Send the "thinking" message - appears natural
  const thinkingMsg = decision.message || "Dame un momento para revisar...";
  await safeSendText(phone, thinkingMsg, flowToken);
  
  // Escalate to human in background (no user notification)
  await humanMonitor.escalateToHuman(phone, `subtle_${reason}`, config.escalationWebhook);
  
  // Human will take over when they click in Bubble dashboard
  return { actions: [] };
}
```

### Redis Storage

When escalated subtly:

```javascript
// Escalation marked with "subtle_" prefix
escalation:{phone} = {
  phone: "5512345678",
  reason: "subtle_user_requests_owner",  // Prefix indicates subtle escalation
  timestamp: 1708012345678,
  status: "pending",
  userPregnancy: "didn't know it was escalated"
}

// Added to visible queue
escalations:queue → sorted set maintains order by timestamp
```

### Bubble Integration

The Bubble dashboard **already supports this**. When an escalation occurs:

1. ✅ Appears in `/api/escalations` queue
2. ✅ Staff member clicks "View" → sees full conversation
3. ✅ Staff clicks "Take Over" → takes control immediately
4. ✅ Staff types response → user receives as if bot continued

## Real-World Examples

### Example 1: Request for Owner

**User message:**
```
Quiero hablar con el dueño
```

**Agent decision:**
```json
{
  "action": "subtle_escalate",
  "message": "Dame un momento para revisar...",
  "reason": "user_requests_owner",
  "params": {}
}
```

**What happens:**
1. User sees: "Dame un momento para revisar..."
2. System adds to escalation queue silently
3. Staff gets notification in Bubble dashboard
4. Staff takes over, responds: "Hola, soy el gerente. ¿En qué puedo ayudarte?"
5. Conversation continues naturally

---

### Example 2: Complaint

**User message:**
```
Tengo una queja seria sobre la mala atención que recibí
```

**Agent decision:**
```json
{
  "action": "subtle_escalate",
  "message": "Entiendo. Déjame conectarte con alguien que pueda ayudarte mejor...",
  "reason": "complaint",
  "params": {}
}
```

**What happens:**
1. User sees thoughtful response (not dismissive)
2. System escalates immediately
3. Staff sees "complaint" flag in escalation queue
4. Staff can address concern with empathy
5. Conversation documented for feedback

---

### Example 3: Out of Scope Talk

**User message:**
```
No o sea, ¿puedo hablar con un humano?
```

**Agent decision:**
```json
{
  "action": "subtle_escalate",
  "message": "Claro, dame un momento...",
  "reason": "user_requests_human",
  "params": {}
}
```

**What happens:**
1. User sees: "Claro, dame un momento..."
2. No explicit message about "escalating" or "handoff"
3. Human takes over in seconds
4. Human can address the original booking request + the personal touch

---

### Example 4: Policy Question (NOT escalated)

**User message:**
```
¿Cuál son los horarios de funcionamiento?
```

**Agent decision:**
```json
{
  "action": "reply",
  "message": "Lunes a viernes 7:00-22:00, Sábado y domingo 8:00-15:00",
  "params": {}
}
```

**What happens:**
- Simple info question → normal reply (NO escalation)
- Agent handles it perfectly fine

---

### Example 5: Policy Question (IS escalated)

**User message:**
```
¿Cuál es su política de cancelación? Porque tengo un problema y necesito cancelar mi reserva urgente
```

**Agent decision:**
```json
{
  "action": "subtle_escalate",
  "message": "Entiendo la urgencia. Déjame ver tu caso específicamente...",
  "reason": "policy_question_with_conflict",
  "params": {}
}
```

**What happens:**
- Detects conflict/urgency mixed with policy
- Escalates for human judgment
- Escalation reason tells staff: "There's a problem here"

---

## Configuration

### Environment Variables

```bash
# Subtle escalation webhook (notifications to Bubble)
ESCALATION_WEBHOOK=https://www.blackpadel.com.mx/api/1.1/wf/escalation_alert

# Optional: staff notification Slack/Discord webhook
STAFF_ALERT_WEBHOOK=https://hooks.slack.com/services/YOUR/URL
```

### Agent Prompt Configuration

The system prompt in `agent_core.js` includes:

- ✅ Detection keywords and rules for subtle_escalate
- ✅ Examples of when to escalate (vs when to reply normally)
- ✅ Message language guidance ("Dame un momento..." sounds natural)
- ✅ Emphasis on subtlety (never say "escalating" or "connecting to human")

## Staff Workflow in Bubble

### Step 1: See Escalation Alert
- Dashboard shows red badge: "Escalation Queue"
- Shows phone + reason (e.g., "user_requests_owner")
- Shows when escalation occurred

### Step 2: Click "View"
- Full conversation loads
- Can see all messages (user + AI)
- Can see the "thinking" message the user saw
- No indication to user yet

### Step 3: Take Over
- Click "Take Over" button
- System sets `mode:{phone}` = "human" in Redis
- AI will skip processing further messages
- User doesn't get a message about this

### Step 4: Respond
- Type response in message box
- Click "Send"
- Message goes to WhatsApp
- User sees it continuing the conversation

### Step 5: Release
- When done addressing the issue
- Click "Release to AI"
- System resumes normal AI processing
- User can continue booking normally

## Monitoring & Analytics

### What Gets Logged

```javascript
// When escalated subtly:
[SUBTLE ESCALATION] phone=5512345678, reason=subtle_user_requests_owner
[HumanMonitor] Escalated 5512345678 - Reason: subtle_user_requests_owner

// Staff takes over:
[HumanMonitor] Human mode enabled: 5512345678 by María García

// Staff responds:
[HumanMonitor] Human message sent: 5512345678 by María García

// Staff releases:
[HumanMonitor] Human mode disabled: 5512345678
```

### Metrics to Track

1. **Escalation Rate**: How many conversations escalate subtly?
   - If high (>30%): Agent prompt might need tuning
   - If low (<5%): Agent might be too aggressive on simple replies

2. **Resolution Time**: How long staff takes to respond?
   - Goal: <2 minutes for customer satisfaction

3. **Escalation Reasons**: What triggers most escalations?
   - "user_requests_owner" → people want human touch
   - "complaint" → quality/service issues
   - "out_of_scope" → agent needs more knowledge

4. **Follow-up Rate**: Do escalated conversations convert to bookings?
   - If low: Staff might need training
   - If high: Agent escalation logic is working well

## Troubleshooting

### Issue: User sees "thinking" message but no human takes over

**Solution:**
1. Check Bubble escalation queue: Is phone showing there?
2. Check escalation Redis key: `redis-cli get escalation:{phone}`
3. Check staff dashboard: Do they see the new escalation?
4. Check logs: Look for `[SUBTLE ESCALATION]` line
5. If no escalation logged: Agent didn't decide `subtle_escalate` (check confidence threshold)

---

### Issue: Human responds, but doesn't appear in Bubble conversation history

**Solution:**
1. Verify human mode is enabled: Check Redis `mode:{phone}`
2. Check `sendHumanMessage()` was called successfully
3. Verify WhatsApp API returned success
4. Check `logMessage()` was called with `sender: "human"`
5. Refresh Bubble page (API caches conversation)

---

### Issue: User keeps getting AI responses after escalation

**Solution:**
1. Check Redis key: `mode:{phone}` should equal "human"
2. Verify `isHumanMode()` check in main flow is working
3. Check logs: Should see `[HumanMode] Skipping AI processing for {phone}`
4. Verify staff member actually clicked "Take Over" (not just viewed)

---

### Issue: Escalation reason shows "undefined" in Bubble

**Solution:**
1. Check `decision.reason` is being set in agent prompt
2. Verify GPT response includes `"reason"` field
3. Check human_monitor.escalateToHuman receives reason parameter
4. Verify escalation data structure in Redis

---

## Best Practices

### For Agent Developers

1. **Keep "thinking" messages varied and natural**:
   - ✅ "Dame un momento para revisar..."
   - ✅ "Déjame verificar eso para ti..."
   - ✅ "Entiendo, déjame conectarte con alguien..."
   - ❌ "ESCALATING TO HUMAN" (too obvious)

2. **Match message tone to reason**:
   - Complaint: Empathetic ("Entiendo tu frustración...")
   - Owner request: Respectful ("Dame un momento...")
   - Out of scope: Honest ("Eso está fuera de mi alcance...")

3. **Escalate early, not late**:
   - Better 5 wrong escalations than 1 bad AI response
   - User satisfaction > operational efficiency

4. **Document edge cases**:
   - As new escalation patterns emerge, update system prompt
   - Keep "Examples" section of prompt current

### For Support Staff

1. **Check escalation reason first**:
   - Tells you what triggered the escalation
   - Helps you adapt your response

2. **Review conversation history**:
   - Understand what AI tried to do
   - Don't repeat what AI already said

3. **Be human, not robotic**:
   - Use natural language, not scripts
   - Acknowledge the "thinking" message transparently if needed

4. **Document complex cases**:
   - Note what you resolved and why
   - Helps improve agent training

### For Management

1. **Monitor escalation trends**:
   - Weekly: Check escalation count
   - Monthly: Review escalation reasons
   - Quarterly: Adjust agent prompt based on patterns

2. **Staff training**:
   - Train staff on subtle escalation feature
   - Emphasize: Be natural, not a script
   - Share examples of good responses

3. **Agent improvement**:
   - Share complaint escalations with AI team
   - Highlight missed opportunities (should have escalated earlier)
   - Balance: autonomy vs. safety

## Future Enhancements

1. **Smart Routing**: Route escalations to specialists based on topic
2. **Auto-responses**: Queue "thinking" message with slight delay (feels more human 👀)
3. **Escalation Analytics**: Dashboard showing escalation patterns
4. **Feedback Loop**: Collect staff feedback on AI responses
5. **ML Tuning**: Use escalation patterns to tune LLM prompt
6. **Multi-language**: Support Spanish, English, Portuguese, etc.
7. **Sentiment Analysis**: Escalate if user seems frustrated (before they ask)

## Summary

The **Subtle Escalation System** provides:

✅ **Seamless handoff** - User never knows it was escalated  
✅ **Natural feeling** - "Thinking" message sounds real  
✅ **Staff empowered** - Can take over immediately  
✅ **Customer happy** - Gets human attention when needed  
✅ **Data tracked** - Full audit trail of escalations  
✅ **Easy to implement** - Just return `action: subtle_escalate`  

This creates a **best of both worlds** experience:
- **AI efficiency** for routine booking questions
- **Human touch** for edge cases and customer satisfaction
