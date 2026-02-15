# Human Monitoring System - Setup Guide

## Overview
The human monitoring system allows staff to view AI conversations in real-time and intervene when needed. This uses a **Hybrid architecture**: conversations are live in Redis (accessed via API) and archived to Bubble database when completed.

## Architecture

```
┌─────────────┐         ┌──────────────┐         ┌──────────────┐
│   WhatsApp  │────────>│  Node.js API │────────>│    Redis     │
│    Users    │         │ (agent_core) │         │ (Live Data)  │
└─────────────┘         └──────────────┘         └──────────────┘
                               │                         │
                               │                         │
                        REST API Calls          Real-time Access
                               │                         │
                               v                         v
                        ┌──────────────┐         ┌──────────────┐
                        │  Bubble.io   │────────>│    Bubble    │
                        │  Dashboard   │         │  Database    │
                        └──────────────┘         └──────────────┘
                               │
                               └──> Archive completed conversations
```

## System Components

### 1. **human_monitor.js** - Core monitoring module
Located at: `/human_monitor.js`

**Functions:**
- `logMessage(phone, message)` - Log all messages (user, AI, human)
- `escalateToHuman(phone, reason, webhookUrl)` - Flag conversation for human review
- `isHumanMode(phone)` - Check if human has taken over
- `enableHumanMode(phone, staffName)` - Pause AI, enable human control
- `disableHumanMode(phone)` - Resume AI
- `getConversation(phone, limit)` - Retrieve message history
- `getActiveConversations()` - List all active conversations
- `getEscalationQueue()` - Get conversations needing attention
- `archiveConversation(phone, metadata)` - Save completed conversations to Bubble
- `sendHumanMessage(phone, text, staffName, sendFn)` - Send message as staff

### 2. **Redis Storage Structure**
- `conversation:{phone}:messages` - Sorted set of messages (7-day TTL)
- `conversations:active` - Sorted set of active phone numbers by last activity
- `mode:{phone}` - "ai" or "human" (who's handling conversation)
- `mode:{phone}:staff` - Name of staff member who took over
- `escalation:{phone}` - Escalation details (reason, timestamp)
- `escalations:queue` - Sorted set of all escalated conversations

### 3. **REST API Endpoints** (in index.js)
All endpoints return JSON with `{ success: true/false, ... }`

#### GET `/api/conversations`
List all active conversations.

**Response:**
```json
{
  "success": true,
  "conversations": [
    {
      "phone": "5512345678",
      "lastActivity": 1708012345678,
      "lastMessage": "¿A qué hora tienen disponible?",
      "lastMessageSender": "user",
      "mode": "ai",
      "escalated": false,
      "escalationReason": null
    }
  ]
}
```

#### GET `/api/conversation/:phone`
Get full conversation history for a specific phone.

**Parameters:**
- `:phone` - User's phone number (10 digits)
- `?limit=50` - Optional: max messages to retrieve

**Response:**
```json
{
  "success": true,
  "phone": "5512345678",
  "mode": "ai",
  "messageCount": 12,
  "messages": [
    {
      "id": "msg_1708012345678_abc123",
      "sender": "user",
      "text": "Hola, quiero reservar",
      "metadata": { "type": "text", "timestamp": 1708012345000 },
      "timestamp": 1708012345678
    },
    {
      "id": "msg_1708012346789_def456",
      "sender": "ai",
      "text": "¡Hola! ¿Para qué deporte?",
      "metadata": { "type": "text" },
      "timestamp": 1708012346789
    }
  ]
}
```

#### POST `/api/conversation/:phone/takeover`
Human staff takes over conversation (pauses AI).

**Request Body:**
```json
{
  "staffName": "María García"
}
```

**Response:**
```json
{
  "success": true,
  "message": "Conversation taken over by María García",
  "phone": "5512345678",
  "mode": "human"
}
```

#### POST `/api/conversation/:phone/release`
Release conversation back to AI.

**Response:**
```json
{
  "success": true,
  "message": "Conversation released to AI",
  "phone": "5512345678",
  "mode": "ai"
}
```

#### POST `/api/conversation/:phone/send`
Send message as human staff to user.

**Request Body:**
```json
{
  "text": "Claro, déjame verificar eso para ti",
  "staffName": "María García"
}
```

**Response:**
```json
{
  "success": true,
  "message": "Message sent",
  "phone": "5512345678",
  "text": "Claro, déjame verificar eso para ti"
}
```

#### GET `/api/escalations`
Get queue of conversations needing human attention.

**Response:**
```json
{
  "success": true,
  "escalations": [
    {
      "phone": "5512345678",
      "reason": "low_confidence",
      "timestamp": 1708012345678,
      "status": "pending"
    }
  ]
}
```

#### POST `/api/conversation/:phone/archive`
Manually archive a conversation to Bubble (normally automatic).

**Request Body:**
```json
{
  "metadata": {
    "userName": "Juan Pérez",
    "sport": "Padel",
    "bookingStatus": "confirmed"
  }
}
```

## Environment Variables

Add these to your `.env` file:

```bash
# Human Monitoring System
BUBBLE_ARCHIVE_URL=https://www.blackpadel.com.mx/api/1.1/wf/archive_conversation
ESCALATION_WEBHOOK=https://www.blackpadel.com.mx/api/1.1/wf/escalation_alert
```

## Bubble.io Integration

### Step 1: Create ConversationArchive Data Type

In Bubble, create a new Data Type called **ConversationArchive** with these fields:

| Field Name | Field Type | Notes |
|------------|-----------|-------|
| phone | text | User's phone number |
| messages | text (long text) | JSON string of message array |
| messageCount | number | Total messages in conversation |
| startTime | number | Unix timestamp (milliseconds) |
| endTime | number | Unix timestamp (milliseconds) |
| userName | text | User's name |
| userLastName | text | User's last name |
| sport | text | Sport booked |
| date | text | Booking date (YYYY-MM-DD) |
| time | text | Booking time |
| bookingStatus | text | "confirmed", "cancelled", "pending" |
| archivedAt | number | Unix timestamp when archived |

### Step 2: Create Bubble API Workflows

#### Workflow: `archive_conversation`
- **Type:** POST
- **Expose as public API workflow**
- **Parameter: `phone`** (text)
- **Parameter: `messages`** (text, long text)
- **Parameter: `messageCount`** (number)
- **Parameter: `startTime`** (number)
- **Parameter: `endTime`** (number)
- **Parameter: `metadata`** (text, JSON)

**Action:** Create a new ConversationArchive
- phone = Request data's phone
- messages = Request data's messages
- messageCount = Request data's messageCount
- startTime = Request data's startTime
- endTime = Request data's endTime
- Parse `metadata` JSON to extract:
  - userName = Extract with operator: metadata:extract with JSON-safe path userName
  - sport = metadata:extract sport
  - date = metadata:extract date
  - time = metadata:extract time
  - bookingStatus = metadata:extract bookingStatus
  - archivedAt = metadata:extract archivedAt

#### Workflow: `escalation_alert` (Optional - for real-time notifications)
- **Type:** POST
- **Expose as public API workflow**
- **Parameter: `phone`** (text)
- **Parameter: `reason`** (text)
- **Parameter: `timestamp`** (number)
- **Parameter: `conversationUrl`** (text)

**Actions:**
1. Send email to staff
2. Create notification in your dashboard
3. Trigger any custom alert logic

### Step 3: Setup API Connector in Bubble

Go to **Plugins → API Connector** and add a new API:

**API Name:** NodeJS Agent Monitor

**Shared headers:**
```
Content-Type: application/json
```

#### API Call: Get Active Conversations
- **Name:** GetConversations
- **Use as:** Data
- **Data type:** ConversationList (create custom type)
- **Method:** GET
- **URL:** `https://your-railway-app.railway.app/api/conversations`

#### API Call: Get Conversation Detail
- **Name:** GetConversation
- **Use as:** Data
- **Data type:** ConversationDetail (create custom type)
- **Method:** GET
- **URL:** `https://your-railway-app.railway.app/api/conversation/[phone]`
- **Parameters:**
  - `phone` (text, used in URL)
  - `limit` (number, optional, used in parameters)

#### API Call: Takeover Conversation
- **Name:** TakeoverConversation
- **Use as:** Action
- **Method:** POST
- **URL:** `https://your-railway-app.railway.app/api/conversation/[phone]/takeover`
- **Body:** JSON object
```json
{
  "staffName": "<staffName>"
}
```
- **Parameters:**
  - `phone` (text, private, used in URL)
  - `staffName` (text, private, used in body)

#### API Call: Release Conversation
- **Name:** ReleaseConversation
- **Use as:** Action
- **Method:** POST
- **URL:** `https://your-railway-app.railway.app/api/conversation/[phone]/release`
- **Parameters:**
  - `phone` (text, private, used in URL)

#### API Call: Send Human Message
- **Name:** SendHumanMessage
- **Use as:** Action
- **Method:** POST
- **URL:** `https://your-railway-app.railway.app/api/conversation/[phone]/send`
- **Body:** JSON object
```json
{
  "text": "<messageText>",
  "staffName": "<staffName>"
}
```
- **Parameters:**
  - `phone` (text, private, used in URL)
  - `messageText` (text, private, used in body)
  - `staffName` (text, private, used in body)

### Step 4: Build Bubble Dashboard Pages

#### Page: **Conversations Dashboard**

**Elements:**
1. **Repeating Group:** ActiveConversations
   - **Type of content:** Conversation (from API call)
   - **Data source:** Get data from external API → GetConversations
   - **Layout:** Full list (vertical)

2. **Inside each cell:**
   - Text: Current cell's Conversation's phone
   - Text: Current cell's Conversation's lastMessage
   - Text: Current cell's Conversation's mode (badge: "AI" or "Human")
   - Icon/Badge: Current cell's Conversation's escalated (show only when Yes)
   - Button: "View" → Navigate to ConversationDetail (send parameter: phone)

#### Page: **Conversation Detail**

**Parameters:**
- `phone` (text, get from page URL)

**Elements:**
1. **Repeating Group:** Messages
   - **Type of content:** Message (from API)
   - **Data source:** Get data from external API → GetConversation (phone = Get data from page URL)
   - **Sort by:** timestamp ascending

2. **Inside each cell:**
   - Group container with conditional formatting:
     - Background color: 
       - When sender = "user" → Light blue
       - When sender = "ai" → Light gray
       - When sender = "human" → Light green
   - Text: Current cell's Message's text
   - Text: Current cell's Message's sender (small, faded)
   - Text: Current cell's Message's timestamp:formatted as (date format)

3. **Control Panel (always visible):**
   - **Button: "Take Over"**
     - Only visible when: GetConversation's mode = "ai"
     - Action: API Workflow → TakeoverConversation (phone, staffName = Current User's name)
     - Action: Refresh GetConversation data
   
   - **Button: "Release to AI"**
     - Only visible when: GetConversation's mode = "human"
     - Action: API Workflow → ReleaseConversation (phone)
     - Action: Refresh GetConversation data
   
   - **Input: Message** (multiline)
   - **Button: "Send"**
     - Only visible when: GetConversation's mode = "human"
     - Action: API Workflow → SendHumanMessage (phone, Input Message's value, Current User's name)
     - Action: Reset Input Message
     - Action: Refresh GetConversation data

4. **Auto-refresh:** Add workflow "Do every 5 seconds" → Refresh GetConversation data

### Step 5: Test the Integration

#### Test 1: View Active Conversations
1. Send WhatsApp message to your bot from test phone
2. Open Bubble dashboard → Conversations page
3. You should see the phone number and last message

#### Test 2: View Conversation Detail
1. Click "View" on a conversation
2. Should see full message history with proper sender colors
3. Verify timestamps are correct

#### Test 3: Human Takeover
1. Open conversation detail
2. Click "Take Over"
3. Mode badge should change from "AI" to "Human"
4. Send a WhatsApp message from test phone
5. Verify AI does NOT respond (human mode active)

#### Test 4: Send Human Message
1. While in human mode, type message in input
2. Click "Send"
3. Message should appear in conversation in WhatsApp
4. Should also appear in Bubble dashboard as green (human) message

#### Test 5: Release to AI
1. Click "Release to AI"
2. Mode should change back to "AI"
3. Send WhatsApp message from test phone
4. AI should respond normally now

#### Test 6: Conversation Archival
1. Complete a booking through WhatsApp
2. After successful confirmation, conversation archived automatically
3. Check Bubble database → ConversationArchive
4. Find record with matching phone number
5. Verify messages field contains JSON array
6. Verify metadata (userName, sport, date, time, bookingStatus)

## Monitoring System Behavior

### When User Sends Message:
1. Message logged to Redis: `conversation:{phone}:messages`
2. Last activity timestamp updated in `conversations:active`
3. If in human mode → AI does NOT process, waits for human response
4. If in AI mode → Agent processes normally

### When AI Responds:
1. AI generates response via `agent_core.js`
2. Message sent via WhatsApp API
3. Response logged to Redis with sender = "ai"
4. Available in Bubble dashboard via `/api/conversation/:phone`

### When AI Escalates:
1. Agent detects low confidence or error
2. Calls `humanMonitor.escalateToHuman(phone, reason)`
3. Added to escalation queue
4. Webhook sent to Bubble (if configured)
5. Shows in dashboard with escalation badge
6. Staff can view reason and take over

### When Human Takes Over:
1. Staff clicks "Take Over" in Bubble
2. API call: `POST /api/conversation/:phone/takeover`
3. Redis key `mode:{phone}` set to "human"
4. System message logged: "[Staff ha tomado el control]"
5. AI stops processing incoming messages from user
6. Only human can respond

### When Human Sends Message:
1. Staff types message and clicks "Send"
2. API call: `POST /api/conversation/:phone/send`
3. Message sent via WhatsApp API
4. Logged to Redis with sender = "human"
5. User receives message in WhatsApp

### When Human Releases:
1. Staff clicks "Release to AI"
2. API call: `POST /api/conversation/:phone/release`
3. Redis key `mode:{phone}` deleted
4. System message logged: "[Staff ha devuelto el control]"
5. AI resumes normal processing

### When Booking Completes:
1. After successful `confirmBooking()` call
2. Calls `clearSessionWithArchive(phone, metadata, true)`
3. Full conversation retrieved from Redis
4. Sent to Bubble via archive API endpoint
5. Saved in ConversationArchive table
6. Removed from active conversations list
7. Redis conversation keys deleted (or expire after 7 days)

## Cost Analysis (Hybrid Architecture)

**Live Conversations (Redis):**
- ~50 active conversations at any time
- ~20 messages per conversation average
- ~1 KB per message
- Total: 50 × 20 × 1 KB = **1 MB in Redis** (negligible)

**Archived Conversations (Bubble):**
- ~200 bookings per day
- ~30 messages per completed conversation
- ~1 KB per message
- Per record: 30 KB
- Monthly: 200 × 30 × 30 KB = **180 MB/month**
- At Bubble's $0.10/GB: **$0.018/month** (essentially free)

**Total Cost: ~$0.02/month** for conversation storage

## Troubleshooting

### Issue: Conversations not showing in Bubble
**Solution:**
1. Check Railway logs: `railway logs`
2. Verify API endpoint is accessible: `curl https://your-app.railway.app/api/conversations`
3. Check Bubble API Connector → Initialize call
4. Verify CORS not blocking (shouldn't be issue with API Connector)

### Issue: Human mode not pausing AI
**Solution:**
1. Check Redis connection is working
2. Verify `mode:{phone}` key is set: Use Redis CLI or Upstash console
3. Check agent_core.js logs for "[HumanMode] Skipping AI processing"
4. Ensure phone number format is consistent (10 digits, no country code)

### Issue: Messages not being logged
**Solution:**
1. Check `human_monitor.js` initialization in `index.js`
2. Verify Redis credentials in environment variables
3. Check for errors in Railway logs
4. Test manually: `await humanMonitor.logMessage("5512345678", { sender: "test", text: "test" })`

### Issue: Archive failing
**Solution:**
1. Verify `BUBBLE_ARCHIVE_URL` in environment variables
2. Check Bubble API Workflow is public and exposed
3. Test with Postman: POST to Bubble endpoint with sample data
4. Check Bubble server logs for workflow errors
5. Verify JSON parsing in Bubble workflow (metadata field)

### Issue: Webhook not triggering
**Solution:**
1. Check `ESCALATION_WEBHOOK` environment variable
2. Verify webhook URL is correct and publicly accessible
3. Check Bubble workflow accepts POST requests
4. Test webhook manually with curl
5. Review timeout settings (currently 5 seconds)

## Next Steps

1. **Add staff authentication:** Protect API endpoints with authentication
2. **Real-time updates:** Use WebSockets or Bubble's built-in refresh
3. **Notification system:** Alert staff when new escalations occur
4. **Analytics dashboard:** Track escalation rates, response times, AI accuracy
5. **Message templates:** Quick replies for common human responses
6. **Multi-staff support:** Handle multiple staff members taking over conversations
7. **Conversation tags:** Categorize conversations (booking, question, complaint)
8. **Search functionality:** Find conversations by phone, date, or content
9. **Export conversations:** Download conversation history as PDF or CSV
10. **Performance monitoring:** Track API response times, Redis memory usage

## Security Considerations

1. **API Authentication:** Add JWT or API key authentication to REST endpoints
2. **Rate Limiting:** Implement rate limiting to prevent abuse
3. **Data Privacy:** Ensure compliance with GDPR/data protection laws
4. **Access Control:** Only authorized staff can view conversations
5. **Audit Logging:** Track who accesses/modifies conversations
6. **Encryption:** Consider encrypting sensitive conversation data
7. **Session Management:** Implement proper session timeouts

## Support

For issues or questions:
- Check Railway logs: `railway logs`
- Check Bubble server logs (Settings → Logs)
- Review Redis data in Upstash console
- Test API endpoints with Postman or curl
- Reference this documentation
