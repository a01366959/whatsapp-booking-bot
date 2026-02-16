# Scalable AI Agent Architecture

## Current Problem
**Lines of custom handler code:** 200+
**Tools with custom logic:** get_hours (150+ lines), confirm_booking (80+ lines)
**Result:** Not scalable - every new variation requires new regex patterns and logic

## New Architecture: AI-Orchestrated Tool Execution

### Core Principle
**Handler's job:** Execute tools cleanly
**AI's job:** Make ALL decisions about conversation flow

### New Tool Execution Pattern

```javascript
// BEFORE: Custom handler logic (150+ lines)
if (toolName === "get_hours") {
  // Custom filtering by tarde/mañana  
  // Custom time extraction
  // Custom ambiguity detection
  // Custom confirmation logic
  // Custom "no times" handling
  // ... 150+ lines of special cases
}

// AFTER: Simple execution (15 lines)
if (toolName === "get_hours") {
  const slots = await getAvailableHours(date, sport);
  const timesList = startTimesFromOptions(buildOptions(slots, 1)).join(", ");
  
  toolResults.push({
    toolName,
    result: `Available times for ${sport} on ${date}: ${timesList}`
  });
}
```

### Agentic Loop Pattern

**Old flow (broken):**
```
User message 
  → agentDecide 
  → handler executes tool 
  → handler does 150+ lines of custom logic
  → returns response
  → handler returns control
```

**New flow (scalable):**
```
User message 
  → agentDecide (sees conversation history)
  → handler executes tool
  → tool returns RAW DATA (no custom logic)
  → AI sees results in context
  → agentDecide called again
  → AI decides what to ask/confirm/show next
  → If more tools needed, repeat
  → Loop until done or escalation
```

### Example: "Padel mañana en la tarde"

**OLD (custom code handles it):**
```javascript
User: "Padel mañana en la tarde"
Handler extracts: sport=Padel, date=tomorrow, preference="tarde"
Handler filters hours >= 14:00 (custom regex logic)
Handler asks for time (custom confirmation logic)
User: "10"
Handler asks "¿10AM o PM?" (custom ambiguity logic)
// ... more custom code
```

**NEW (AI orchestrates):**
```javascript
User: "Padel mañana en la tarde"
AI sees: needs sport? no. needs date? no. needs times? yes
AI calls: get_hours(sport=Padel, date=tomorrow)

Handler executes:
  times = await getAvailableHours(tomorrow, Padel)
  returns: "Available: 07:00, 08:00, ..., 22:00"
  
toolResults back to AI with this list

AI sees:
  - conversation: "mañana en la tarde"
  - available times: all times
  - context: user preference is afternoon

AI responds naturally:
  "Para la tarde tengo: 14:00, 15:00, 16:00, 17:00, 18:00, 19:00. ¿Cuál te va?"
  
User: "10"
AI thinks: "User said 10, but no meridiem indicator"
AI asks: "¿10 de la mañana o de la noche?"

User: "de la mañana"
AI thinks: confirms 10:00
AI calls: confirm_booking(sport=Padel, date=tomorrow, time=10:00, name=...)
```

## Changes Needed in agent_core.js

### 1. Simplify Tool Handlers (Lines 1441-1657)

Replace 200+ lines with ~50 lines:

```javascript
if (toolName === "get_hours") {
  // Just fetch and return
  const slots = await getAvailableHours(date, sport);
  const times = startTimesFromOptions(buildOptions(slots, 1)).join(", ");
  toolResults.push({
    toolName,
    result: `Available times for ${sport} on ${date}: ${times || "None"}`
  });
}

else if (toolName === "confirm_booking") {
  // Just validate and execute
  if (!bookingSport || !bookingDate || !bookingTime || !bookingName) {
    toolResults.push({ toolName, result: "Missing required fields" });
    continue;
  }
  
  const match = session.options?.find(o => o.start === bookingTime);
  if (!match) {
    toolResults.push({ toolName, result: "Time not available" });
    continue;
  }
  
  await confirmBooking(...);
  toolResults.push({
    toolName,
    result: `Booking confirmed for ${bookingName}`
  });
}
```

### 2. Create Agentic Loop (After tool execution)

```javascript
// After all tools execute, feed results back to AI
if (toolResults.length > 0) {
  const toolResultsMessage = toolResults
    .map(tr => `[${tr.toolName}]: ${tr.result}`)
    .join("\n");

  logger?.info?.(`[AGENTIC] Tool results available, calling AI again`);

  // AI sees results + full conversation history
  const followUpDecision = await agentDecide(
    phone, 
    `Tool results:\n${toolResultsMessage}\n\nContinue naturally based on these results.`,
    session
  );

  if (followUpDecision.response) {
    await safeSendText(phone, followUpDecision.response, flowToken);
  }

  // If AI decided to use more tools, loop continues
  if (followUpDecision.toolCalls?.length > 0) {
    // recursive: go back to for loop
  }
}
```

### 3. Update System Prompt

Add note about tool results format:

```javascript
CUANDO RECIBAS TOOL RESULTS:
- [get_hours]: te da lista de horarios disponibles
- [confirm_booking]: te dice si la reserva fue exitosa
- [get_user]: te da info del usuario

ENTIENDE CONTEXTO:
- Usuario dice "en la tarde" + ve [get_hours]: 07:00...23:00
- TÚ filtras en tu respuesta natural (no código)
- TÚ entiendes "mañana en la tarde" sin que código lo haga
```

## Benefits of New Architecture

✅ **AI handles ALL conversational logic**
- Ambiguous times ("10" → asks naturally)
- Time preferences ("en la tarde" → filters in response)
- User corrections ("mejor a otra hora")
- Edge cases ("tipo 4pm", "después de las 19")

✅ **Scalable to new tools**
- Add new tool (liga, tournaments, promotions)
- Handler just: execute API + return result
- AI automatically knows how to use it

✅ **Consistent user experience**
- One decision engine (AI with conversation history)
- Not 5 different state machine flows

✅ **Maintainable**
- Handler: 50 lines of tool execution
- Not 200+ lines of custom logic
- Changes go in system prompt, not in handler code

## Migration Path

1. ✅ Remove extraction logic (DONE)
2. 🔲 Simplify tool handlers (get_hours, confirm_booking)
3. 🔲 Create agentic loop for tool results
4. 🔲 Update system prompt for tool result interpretation
5. 🔲 Test with real conversations
6. 🔲 Add next tools using same pattern

## Testing Scenarios

After refactor, these should work naturally:

```
✅ User: "Padel mañana en la tarde"
✅ User: "Tipo 3 de la tarde"
✅ User: "Después de las 19"
✅ User: "Mejor otras opciones"
✅ User: "En la mañanita"
✅ User: "Algo más temprano"
✅ User: "9 de la mañana o noche?" → AI handles ambiguity
✅ User changes mind mid-conversation
```

All WITHOUT adding any new code—AI scales naturally.
