# API Debugging & Authentication Strategy

## Status: Issues Found & Fixes

### Issue 1: enableHumanMode & disableHumanMode Functions

**Problem:**
- Functions use `if (!redis || !phone) return;` which silently returns without throwing errors
- This causes the API endpoints to return success even though the functions fail silently
- When errors in human_monitor.js are silently caught and logged, the API returns generic success

**Root Cause in human_monitor.js:**
```javascript
// BEFORE (lines ~140-185) - Silent failure pattern
export async function enableHumanMode(phone, staffName = "staff") {
  if (!redis || !phone) return;  // ← Returns nothing, no error thrown
  try {
    // code...
  } catch (err) {
    logger.error(...);  // ← Catches error but doesn't re-throw
  }
}
```

**Solution (Already Partially Applied):**
```javascript
// AFTER - Proper error handling
export async function enableHumanMode(phone, staffName = "staff") {
  if (!redis) throw new Error("Redis not initialized");
  if (!phone) throw new Error("Phone number required");
  try {
    // code...
  } catch (err) {
    throw err;  // ← Re-throw so calling code knows there was an error
  }
}
```

**Status:** ✅ enableHumanMode fixed  
**Status:** ⚠️ disableHumanMode needs manual fix (replace_string_in_file has issues with backticks)  
**Status:** ⚠️ sendHumanMessage needs manual fix  

### Fix Applied to disableHumanMode (Manual):

Line 164: Change from:
```javascript
if (!redis || !phone) return;
```

To:
```javascript
if (!redis) throw new Error("Redis not initialized");
if (!phone) throw new Error("Phone number required");
```

Then add before closing catch block (line ~181):
```javascript
return { success: true, phone };
```

And on error (line ~183):
```javascript
throw err;
```

### Fix Needed for sendHumanMessage (Lines ~368-388):

Change from:
```javascript
if (!phone || !text || !sendFn) return;
```

To:
```javascript
if (!phone) throw new Error("Phone number required");
if (!text) throw new Error("Message text required");
if (!sendFn) throw new Error("Send function required");
```

Add return before closing catch block:
```javascript
return { success: true, phone, text };
```

And on error:
```javascript
throw err;
```

### Issue 2: Readable Timestamps for Bubble

**Problem:** 
- Messages only have `timestamp` (milliseconds since epoch)
- Bubble date type expects ISO 8601 format with timezone info

**Solution:**
Add `createdAt` field to all messages with ISO format:

```javascript
{
  "id": "msg_1708012345678_abc123",
  "sender": "user",
  "text": "Hola, quiero reservar",
  "timestamp": 1708012345678,              // Unix milliseconds
  "createdAt": "2024-02-15T17:52:25.678Z", // ISO 8601 format for Bubble
  "metadata": { "type": "text" }
}
```

**Changes Needed in human_monitor.js:**

#### In `getConversation()` function (around line 205):
```javascript
return messages.map(msg => {
  try {
    const parsed = JSON.parse(msg);
    // Add readable date format for Bubble
    parsed.createdAt = new Date(parsed.timestamp).toISOString();
    return parsed;
  } catch {
    const now = Date.now();
    return { 
      sender: "system", 
      text: msg, 
      timestamp: now,
      createdAt: new Date(now).toISOString()
    };
  }
});
```

#### In `getActiveConversations()` function (around line 245):
```javascript
conversations.push({
  phone,
  lastActivity,
  lastActivityDate: new Date(lastActivity).toISOString(), // ← ADD THIS
  lastMessage: lastMessage?.text || "",
  lastMessageSender: lastMessage?.sender || "unknown",
  mode,
  escalated: Boolean(escalationData),
  escalationReason: escalationData?.reason || null
});
```

#### In `getEscalationQueue()` function (around line 280):
Escalations already have timestamp, just need to add:
```javascript
timestampDate: new Date(item.timestamp).toISOString()
```

#### In `archiveConversation()` function (around line 300):
```javascript
const archiveData = {
  phone,
  messages,
  messageCount: messages.length,
  startTime,
  startTimeDate: new Date(startTime).toISOString(), // ← ADD THIS
  endTime,
  endTimeDate: new Date(endTime).toISOString(),     // ← ADD THIS
  metadata: {
    ...metadata,
    archivedAt: now,
    archivedAtDate: new Date(now).toISOString()     // ← ADD THIS
  }
};
```

---

## API Authentication Strategy

### Current State:
- **UNSECURED** - Anyone with the URL can access all conversations
- **RISK**: GDPR violation, privacy breach, unauthorized access

### Proposed Authentication Layers (Choose 1-3):

### Option 1: Simple API Key (Easiest)
**Cost:** 5 minutes to implement  
**Security:** ⭐⭐ (Low - if key leaked, full access)  
**Implementation:**

```javascript
// Middleware for all protected routes
const apiKeyAuth = (req, res, next) => {
  const apiKey = req.headers["x-api-key"];
  if (!apiKey || apiKey !== process.env.API_KEY) {
    return res.status(401).json({ success: false, error: "Unauthorized" });
  }
  next();
};

// Use on all /api endpoints
app.get("/api/conversations", apiKeyAuth, async (req, res) => {
  // ... existing code
});
```

**Environment Variable:**
```bash
API_KEY=your_secret_key_here_min_32_chars
```

**Bubble Usage:**
Add header to all API Connector calls:
```
X-Api-Key: [your_secret_key]
```

---

### Option 2: JWT with Expiration (Medium)
**Cost:** 30 minutes  
**Security:** ⭐⭐⭐⭐ (Good - token expires, can revoke)  
**Implementation:**

```javascript
// Generate JWT endpoint
app.post("/auth/token", (req, res) => {
  const { username, password } = req.body;
  
  // Verify credentials (hardcoded for now or use database)
  if (username !== process.env.AUTH_USER || password !== process.env.AUTH_PASS) {
    return res.status(401).json({ success: false, error: "Invalid credentials" });
  }
  
  const token = jwt.sign(
    { user: username, staff: true },
    process.env.JWT_SECRET,
    { expiresIn: "24h" }
  );
  
  res.json({ success: true, token });
});

// Middleware
const jwtAuth = (req, res, next) => {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return res.status(401).json({ success: false, error: "No token" });
  
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    res.status(401).json({ success: false, error: "Invalid token" });
  }
};

app.get("/api/conversations", jwtAuth, async (req, res) => {
  // Can use req.user to track who accessed what
  console.log(`Staff ${req.user.user} accessed conversations`);
  // ... existing code
});
```

**Bubble Usage:**
```javascript
// Step 1: Call /auth/token to get JWT
POST /auth/token
{
  "username": "admin@blackpadel.com",
  "password": "your_password"
}

// Response:
{ 
  "success": true, 
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
}

// Step 2: Use token in subsequent API calls
GET /api/conversations
Header: Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

**Environment Variables:**
```bash
JWT_SECRET=your_secret_key_here_min_32_chars
AUTH_USER=admin@blackpadel.com
AUTH_PASS=your_secure_password
```

---

### Option 3: OAuth 2.0 with Bubble Auth (Most Secure)
**Cost:** 2-3 hours  
**Security:** ⭐⭐⭐⭐⭐ (Excellent - uses Bubble's built-in auth)  
**Implementation:**

Integrate with Bubble's User database:
```javascript
// Get current user from Bubble session
app.get("/api/conversations", async (req, res) => {
  const userId = req.user?.id; // From Bubble auth middleware
  
  if (!userId) {
    return res.status(401).json({ success: false, error: "Unauthorized" });
  }
  
  // Log access for audit trail
  await logAccess(userId, "GET /api/conversations", new Date());
  
  const conversations = await humanMonitor.getActiveConversations();
  res.json({ success: true, conversations });
});
```

**Setup:** 
- Bubble handles authentication via login page
- API calls include encrypted Bubble session cookie
- Each API call logs who accessed what
- Can revoke access by removing user from Bubble

---

## Recommended Authentication Path

### Phase 1 (IMMEDIATE - 5 minutes):
Implement **Option 1 (API Key)** as temporary solution
- Add simple middleware
- Set random API_KEY in environment
- Share only with Bubble admin

### Phase 2 (SOON - 30 minutes):
Upgrade to **Option 2 (JWT)**
- Better than API keys
- Can track who accessed what (audit log)
- Tokens expire automatically
- Easy to revoke if needed

### Phase 3 (LATER - Optional):
Implement **Option 3 (OAuth)**
- Full integration with Bubble user system
- Strongest security
- Audit trail built-in
- Single sign-on for staff

---

## Quick Implementation: API Key Auth

### Step 1: Add to index.js (top of file)
```javascript
const API_KEY = process.env.API_KEY || "dev_key_insecure_do_not_use_in_prod";

const apiKeyAuth = (req, res, next) => {
  const providedKey = req.headers["x-api-key"];
  if (!providedKey || providedKey !== API_KEY) {
    console.warn(`[AUTH] Invalid API key attempt from ${req.ip}`);
    return res.status(401).json({ success: false, error: "Unauthorized" });
  }
  next();
};
```

### Step 2: Add middleware to all protected routes
```javascript
app.get("/api/conversations", apiKeyAuth, async (req, res) => {
  // ... existing code
});

app.get("/api/conversation/:phone", apiKeyAuth, async (req, res) => {
  // ... existing code
});

app.post("/api/conversation/:phone/takeover", apiKeyAuth, async (req, res) => {
  // ... existing code
});

app.post("/api/conversation/:phone/release", apiKeyAuth, async (req, res) => {
  // ... existing code
});

app.post("/api/conversation/:phone/send", apiKeyAuth, async (req, res) => {
  // ... existing code
});

app.get("/api/escalations", apiKeyAuth, async (req, res) => {
  // ... existing code
});

app.post("/api/conversation/:phone/archive", apiKeyAuth, async (req, res) => {
  // ... existing code
});
```

### Step 3: Add environment variable
```bash
# In .env or Railway environment:
API_KEY=blackpadel_secure_key_min_32_characters_12345678
```

### Step 4: Update Bubble API Connector Calls
In Bubble API Connector, add shared header:
```
X-Api-Key: blackpadel_secure_key_min_32_characters_12345678
```

---

## Testing Auth

### Without Authentication (Currently):
```bash
curl http://localhost:3000/api/conversations
# Returns: [all conversations]
```

### With API Key Auth:
```bash
# Without key - REJECTED
curl http://localhost:3000/api/conversations
# Returns: 401 Unauthorized

# With key - ACCEPTED
curl -H "X-Api-Key: your_key" http://localhost:3000/api/conversations
# Returns: [all conversations]

# In Postman: 
# Add header: X-Api-Key | your_key
# GET http://localhost:3000/api/conversations
# Should return 200 with data
```

---

## Current Test Status

**What Works:**
✅ GET /api/conversations  
✅ GET /api/conversation/:phone  

**What Fails:**
❌ POST /api/conversation/:phone/takeover  
❌ POST /api/conversation/:phone/release  
❌ POST /api/conversation/:phone/send  

**Why:**
- enableHumanMode/disableHumanMode/sendHumanMessage silently return on validation failure
- Functions don't throw errors so Express catches generic error
- Endpoints appear to succeed even though operations fail

**Next Steps:**
1. Fix error handling in human_monitor.js (add manual edits if editor has issues)
2. Add readable dates (createdAt, etc.) globally
3. Add API key authentication middleware
4. Re-test all endpoints

---

## Summary

| Component | Status | Priority | Effort |
|-----------|--------|----------|--------|
| Bug Fixes (error handling) | In Progress | 🔴 High | 10 min |
| Readable Dates | Not Started | 🟡 Medium | 15 min |
| API Key Auth | Designed | 🔴 High | 5 min |
| JWT Auth | Optional | 🟢 Low | 30 min |

**Blocking:** API key security should be implemented today

