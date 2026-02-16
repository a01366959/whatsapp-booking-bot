# Tool-Based Agent Architecture

## Overview

The agent has been refactored from a rigid state machine to a reasoning-based tool architecture. This allows natural conversation handling with context awareness.

## Key Changes

### 1. **TOOLS Array**
Defines all available capabilities (Bubble endpoints):
- `get_user` - Fetch user info by phone
- `get_hours` - Check available time slots
- `confirm_booking` - Confirm and save reservation

### 2. **agentDecide() Function**
**Before:** 
- Used JSON mode with rigid action types
- No conversation history
- State machine logic (ask→get_hours→confirm)

**After:**
- Uses OpenAI function calling
- Full conversation history passed
- AI decides which tools to use based on context
- Natural reasoning instead of scripted responses

**New Signature:**
```javascript
async function agentDecide(phone, userText, session)
// Returns: { response, toolCalls[], needsEscalation, rawMessage }
```

### 3. **Conversation History**
New function `getConversationHistory(phone, limit)` retrieves last N messages from Redis via `human_monitor.js`. This gives the AI full context of the conversation, enabling:
- Handling corrections naturally ("actually, tomorrow instead")
- Understanding ambiguous inputs ("a las 3" = 15:00 in booking context)
- Not repeating questions user already answered
- Recognizing when user changes mind mid-conversation

### 4. **System Prompt Updates**
**Key Principles:**
- **Reason about context**: Read FULL conversation, not just last message
- **Handle corrections**: User changes date/time → adapt naturally
- **Understand ambiguity**: "3" likely means 15:00, not 03:00am
- **Be proactive**: User wants hours → call get_hours immediately
- **No rigid flow**: Follow user's lead, not a script

## How It Works Now

### Example Conversation

**User:** "Quiero reservar para hoy por favor"
```javascript
// AI reasons:
// - User wants booking
// - Need sport + date
// - Ask naturally

AI Response: "¿Para qué deporte, Padel o Pickleball?"
Tool Calls: []
```

**User:** "Padel"
```javascript
// AI reasons:
// - Now have sport: Padel
// - User said "hoy" = today
// - Need to check availability
// - Call get_hours tool

AI Response: "" (will show times after tool executes)
Tool Calls: [{ name: "get_hours", arguments: { sport: "Padel", date: "2026-02-15" }}]

// System executes tool → gets times: [07:00, 08:00, 09:00...]
// Sends message: "Para Padel hoy tengo: 07:00, 08:00, 09:00..."
```

**User:** "para el 16 a las 3"
```javascript
// AI reasons:
// - User CHANGED date (originally said today)
// - "a las 3" in booking context = 15:00 (3pm)
// - User has chosen specific time
// - Check if 15:00 available on 16th

AI Response: "Perfecto, ¿confirmo Padel para el 16 a las 15:00?"
Tool Calls: [{ name: "get_hours", arguments: { sport: "Padel", date: "2026-02-16" }}]

// After checking availability, if 15:00 exists:
// System presents confirmation
```

**User:** "que horarios para el 16"
```javascript
// AI reasons:
// - User asking AGAIN for times (already asked)
// - They want to see all options
// - Just show them again, don't complain

AI Response: ""
Tool Calls: [{ name: "get_hours", arguments: { sport: "Padel", date: "2026-02-16" }}]

// Shows full list of times
```

Notice: AI **adapts** when user changes mind. No rigid "you must answer X then Y then Z" flow.

## Adding New Tools

When you add new Bubble endpoints (liga, tournaments, promotions):

### Step 1: Define Tool
```javascript
const TOOLS = [
  ...existingTools,
  {
    type: "function",
    function: {
      name: "register_for_liga",
      description: "Register user in a league. Use when user wants to join competitive play.",
      parameters: {
        type: "object",
        properties: {
          phone: { type: "string", description: "User phone" },
          sport: { type: "string", enum: ["Padel", "Pickleball"] },
          level: { type: "string", enum: ["beginner", "intermediate", "advanced"] }
        },
        required: ["phone", "sport", "level"]
      }
    }
  }
];
```

### Step 2: That's It!

AI automatically:
- Knows this capability exists
- Uses it when user asks: "Quiero inscribirme a la liga"
- Asks for missing info: "¿Qué nivel eres?"
- Calls tool with correct parameters
- Responds naturally

**No state machine updates needed.**

## Processing Tool Calls

The handler must execute tool calls returned by agentDecide:

```javascript
const decision = await agentDecide(phone, text, session);

// 1. Send AI response (if any)
if (decision.response) {
  await safeSendText(phone, decision.response, flowToken);
}

// 2. Handle escalation
if (decision.needsEscalation) {
  await humanMonitor.escalateToHuman(phone, "out_of_scope", config.escalationWebhook);
  return { actions: [] };
}

// 3. Execute tool calls
for (const toolCall of decision.toolCalls) {
  const toolName = toolCall.function.name;
  const args = JSON.parse(toolCall.function.arguments);
  
  if (toolName === "get_hours") {
    const slots = await getAvailableHours(args.date, args.sport);
    // Update session and show times
  } else if (toolName === "confirm_booking") {
    await confirmBooking(args.phone, args.date, args.time, ...);
    // Send confirmation
  }
}
```

## Benefits

### 1. Natural Conversation
User can interrupt, change mind, correct themselves → AI adapts

### 2. Context Awareness  
AI remembers full conversation, doesn't ask same questions

### 3. Scalability
Adding new capabilities = adding tool definition (1 minute)
No complex state machine updates

### 4. Error Handling
User says ambiguous thing → AI reasons about likely meaning based on context

### 5. Multi-Action Support
User: "Quiero reservar mañana y también inscribirme a la liga"
→ AI calls both tools in sequence naturally

## What's Next

Current implementation needs:
1. ✅ Tool definitions updated
2. ✅ Conversation history function added
3. ✅ agentDecide refactored to use function calling
4. ⚠️ **Handler logic needs update** to process new response format
5. ⚠️ **Tool execution logic** needs to be added

The main handler (handleWhatsApp) still expects old format. Next step: Update the handler to:
- Call `agentDecide(phone, text, session)` with new signature
- Process `decision.toolCalls` array
- Execute each tool and update session
- Send appropriate responses

## Testing

Once complete, test with ambiguous inputs:
- "para el 16 a las 3" (should understand 15:00)
- Change mind mid-conversation
- Ask for horarios twice
- Provide incomplete info then complete later
- Multi-step requests ("reservar y inscribir liga")

The AI should handle all these naturally without rigid state checking.
