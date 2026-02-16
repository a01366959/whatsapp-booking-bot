# Tool-Based Architecture Refactor - COMPLETE ✅

## What Changed

### 1. **TOOLS Array** (Lines 58-120)
- Expanded tool definitions with detailed descriptions
- Added `confirm_booking` tool
- Ready for easy addition of new tools (liga, tournaments, promotions)

### 2. **Conversation History Function** (Lines 606-628)
- New `getConversationHistory(phone, limit)` function
- Retrieves messages from Redis via human_monitor
- Converts to OpenAI message format for context awareness

### 3. **agentDecide() Function** (Lines 989-1106)
**Complete rewrite:**
- Old signature: `agentDecide(session, userText)`
- New signature: `agentDecide(phone, userText, session)`
- Returns: `{ response, toolCalls[], needsEscalation, rawMessage }`
- Uses OpenAI function calling instead of JSON mode
- Passes full conversation history for context
- System prompt focused on reasoning, not rigid rules

### 4. **Handler Logic** (Lines 1343-1654)
**Completely refactored from 300+ lines of action-based logic to clean tool processing:**

**Old approach:**
```javascript
if (decision.action === "get_hours") { ... 50 lines ... }
if (decision.action === "confirm_reserva") { ... 60 lines ... }
if (decision.action === "ask") { ... }
if (decision.action === "reply") { ... }
// etc... very repetitive
```

**New approach:**
```javascript
// 1. Handle escalation
if (decision.needsEscalation) { escalate and return }

// 2. Process tool calls
for (const toolCall of decision.toolCalls) {
  if (toolName === "get_hours") { execute and show times }
  else if (toolName === "confirm_booking") { prepare confirmation }
  // Easy to add new tools here
}

// 3. Send AI response if no tools
if (decision.response) { send text }
```

## Key Improvements

### Natural Conversation Handling
**Before:**
```
User: "para el 16 a las 3"
Agent: [follows state machine] "No tengo ese horario"
```

**After:**
```
User: "para el 16 a las 3"
Agent: [reasons] User changed date to 16th, "3" = 15:00
         → calls get_hours(date="2026-02-16")
         → checks if 15:00 available
         → "Perfecto, ¿confirmo Padel para el 16 a las 15:00?"
```

### Context Awareness
- AI sees full conversation history (last 10 messages)
- Understands when user changes mind
- Doesn't repeat questions already answered
- Handles ambiguous inputs intelligently

### Scalability
Adding new capabilities now takes **1 minute**:
```javascript
// Add to TOOLS array:
{
  type: "function",
  function: {
    name: "register_for_liga",
    description: "Register user in a league",
    parameters: { ... }
  }
}

// Add handler in tool processing loop:
else if (toolName === "register_for_liga") {
  // Call Bubble endpoint
  // Update session
  // Send confirmation
}
```

**That's it!** No state machine updates, no complex flow logic.

## Testing Checklist

### 1. Basic Booking Flow
```
User: "Quiero reservar"
Expected: AI asks for sport/date naturally
```

### 2. Ambiguous Time Input
```  
User: "para el 16 a las 3"
Expected: AI understands "3" = 15:00 (3pm)
```

### 3. Mid-Conversation Changes
```
User: "para mañana"
AI: (shows times for tomorrow)
User: "mejor el 16"
Expected: AI adapts, shows times for 16th without complaint
```

### 4. Repeat Questions
```
User: "que horarios para el 16"
AI: (shows times)
User: "que horarios para el 16" (asks again)
Expected: AI shows times again naturally
```

### 5. Incomplete Then Complete
```
User: "Quiero reservar padel"
AI: "¿Para qué fecha?"
User: "mañana a las 3"
Expected: AI processes both date and time together
```

### 6. Multi-Request (Future)
```
User: "Quiero reservar y también inscribir a la liga"
Expected: AI handles both requests (when liga tool added)
```

### 7. Escalation
```
User: "Quiero hablar con el dueño"
Expected: AI says "Dame un momento para revisar..." + escalates silently
```

## What's Ready for Addition

### New Tools Template
When you're ready to add liga, tournaments, or promotions:

```javascript
// 1. Add to TOOLS array
{
  type: "function",
  function: {
    name: "register_for_liga",
    description: "Register user in league when they want to join competitive play",
    parameters: {
      type: "object",
      properties: {
        phone: { type: "string" },
        sport: { type: "string", enum: ["Padel", "Pickleball"] },
        level: { type: "string", enum: ["beginner", "intermediate", "advanced"] }
      },
      required: ["phone", "sport", "level"]
    }
  }
}

// 2. Add handler in tool processing loop (around line 1450)
else if (toolName === "register_for_liga") {
  const result = await callBubbleLigaEndpoint(args);
  await safeSendText(phone, `¡Listo! Te inscribí en la liga ${args.level} de ${args.sport}.`, flowToken);
}
```

The AI will automatically:
- Know when to use this tool
- Ask for missing info (level, sport)
- Call it with correct parameters
- Respond naturally

## Model Configuration

Current model: `gpt-4o` (changed from `gpt-4o-mini`)
- Reasoning: Better context understanding and tool usage
- Temperature: 0.3 (slightly creative but mostly deterministic)

If cost is concern, can switch back to `gpt-4o-mini` after testing, but `gpt-4o` recommended for best natural conversation handling.

## Monitoring

Key log messages to watch:
```
[AGENT] Response: "...", Tools: N, Escalation: false
[TOOL] Executing get_hours with args: {...}
[TOOL] get_user result: Juan
[SUBTLE ESCALATION] phone=...
```

## Next Steps

1. **Deploy and test** with real WhatsApp conversations
2. **Monitor logs** for tool execution patterns
3. **Add new tools** as needed (liga, tournaments, promotions)
4. **Tune system prompt** based on real usage
5. **Consider streaming** (SSE) for Bubble dashboard (discussed earlier)

## Documentation

- Full architecture explanation: [TOOL_BASED_ARCHITECTURE.md](TOOL_BASED_ARCHITECTURE.md)
- This summary: [REFACTOR_COMPLETE.md](REFACTOR_COMPLETE.md)

---

**Status: Ready for deployment and testing** ✅
