/**
 * human_monitor.js
 * 
 * Human-in-the-loop monitoring system for AI agent conversations.
 * Allows staff to view real-time conversations, intervene, and take over from AI.
 * Implements Hybrid storage: real-time Redis + archived in Bubble.
 */

import axios from "axios";

let redis;
let config;
let logger;

const MESSAGE_TTL = 7 * 24 * 60 * 60; // 7 days in seconds
const CONVERSATION_SCAN_LIMIT = 100;

/**
 * Initialize human monitoring system
 */
export function init({ redis: redisClient, config: cfg, logger: log = console }) {
  redis = redisClient;
  config = cfg;
  logger = log;
}

/**
 * Log a message in the conversation history (Redis sorted set)
 * 
 * @param {string} phone - User's phone number (10 digits)
 * @param {object} message - Message object
 * @param {string} message.sender - "user", "ai", or "human"
 * @param {string} message.text - Message content
 * @param {object} [message.metadata] - Optional metadata (location, list selection, etc.)
 */
export async function logMessage(phone, message) {
  if (!redis || !phone || !message) return;

  try {
    const key = `conversation:${phone}:messages`;
    const timestamp = Date.now();
    
    const messageData = {
      id: `msg_${timestamp}_${Math.random().toString(36).substr(2, 9)}`,
      sender: message.sender || "ai",
      text: message.text || "",
      metadata: message.metadata || {},
      timestamp
    };

    // Store in sorted set (score = timestamp)
    await redis.zadd(key, { score: timestamp, member: JSON.stringify(messageData) });
    
    // Set TTL on conversation
    await redis.expire(key, MESSAGE_TTL);
    
    // Update last activity timestamp for active conversation tracking
    await redis.zadd("conversations:active", { 
      score: timestamp, 
      member: phone 
    });

    logger.info(`[HumanMonitor] Logged message: ${phone} / ${message.sender}`);
  } catch (err) {
    logger.error(`[HumanMonitor] Failed to log message for ${phone}:`, err);
  }
}

/**
 * Escalate a conversation to human (adds to escalation queue)
 * 
 * @param {string} phone - User's phone number
 * @param {string} reason - Why it was escalated (e.g., "low_confidence", "user_request")
 * @param {string} [webhookUrl] - Optional Bubble webhook to notify
 */
export async function escalateToHuman(phone, reason, webhookUrl) {
  if (!redis || !phone) return;

  try {
    const timestamp = Date.now();
    const escalationData = {
      phone,
      reason,
      timestamp,
      status: "pending"
    };

    // Add to escalation queue (sorted set by timestamp)
    await redis.zadd("escalations:queue", {
      score: timestamp,
      member: JSON.stringify(escalationData)
    });

    // Mark conversation as escalated
    await redis.set(`escalation:${phone}`, JSON.stringify(escalationData), {
      ex: MESSAGE_TTL
    });

    logger.info(`[HumanMonitor] Escalated ${phone}: ${reason}`);

    // Send webhook notification to Bubble if provided
    if (webhookUrl) {
      try {
        await axios.post(webhookUrl, {
          phone,
          reason,
          timestamp,
          conversationUrl: `/api/conversation/${phone}`
        }, { timeout: 5000 });
        logger.info(`[HumanMonitor] Webhook sent for escalation: ${phone}`);
      } catch (webhookErr) {
        logger.error(`[HumanMonitor] Webhook failed for ${phone}:`, webhookErr.message);
      }
    }
  } catch (err) {
    logger.error(`[HumanMonitor] Failed to escalate ${phone}:`, err);
  }
}

/**
 * Check if conversation is in human mode (AI paused)
 */
export async function isHumanMode(phone) {
  if (!redis || !phone) return false;
  
  try {
    const mode = await redis.get(`mode:${phone}`);
    return mode === "human";
  } catch (err) {
    logger.error(`[HumanMonitor] Failed to check mode for ${phone}:`, err);
    return false;
  }
}

/**
 * Enable human mode (pause AI, allow staff to respond)
 */
export async function enableHumanMode(phone, staffName = "staff") {
  if (!redis) throw new Error("Redis not initialized");
  if (!phone) throw new Error("Phone number required");

  try {
    await redis.set(`mode:${phone}`, "human", { ex: MESSAGE_TTL });
    await redis.set(`mode:${phone}:staff`, staffName, { ex: MESSAGE_TTL });

    // Log takeover event
    await logMessage(phone, {
      sender: "system",
      text: `[${staffName} ha tomado el control de la conversación]`,
      metadata: { event: "takeover", staff: staffName }
    });

    logger.info(`[HumanMonitor] Human mode enabled: ${phone} by ${staffName}`);
    return { success: true, phone, staffName };
  } catch (err) {
    logger.error(`[HumanMonitor] Failed to enable human mode for ${phone}:`, err);
    throw err;
  }
}

/**
 * Disable human mode (resume AI)
 */
export async function disableHumanMode(phone) {
  if (!redis) throw new Error("Redis not initialized");
  if (!phone) throw new Error("Phone number required");

  try {
    const staffName = await redis.get(`mode:${phone}:staff`) || "staff";

    await redis.del(`mode:${phone}`);
    await redis.del(`mode:${phone}:staff`);

    // Log release event
    await logMessage(phone, {
      sender: "system",
      text: `[${staffName} ha devuelto el control al asistente]`,
      metadata: { event: "release", staff: staffName }
    });

    logger.info(`[HumanMonitor] Human mode disabled: ${phone}`);
    return { success: true, phone };
  } catch (err) {
    logger.error(`[HumanMonitor] Failed to disable human mode for ${phone}:`, err);
    throw err;
  }
}

/**
 * Get conversation messages for a specific phone
 * 
 * @param {string} phone - User's phone number
 * @param {number} [limit=50] - Maximum number of messages to retrieve
 * @returns {Promise<Array>} Array of message objects
 */
export async function getConversation(phone, limit = 50) {
  if (!redis || !phone) return [];

  try {
    const key = `conversation:${phone}:messages`;

    // Get last N messages (sorted by timestamp descending)
    const messages = await redis.zrange(key, -limit, -1, { rev: false });

    return messages.map(msg => {
      try {
        const parsed = JSON.parse(msg);
        // Add readable date format for Bubble (ISO 8601)
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
  } catch (err) {
    logger.error(`[HumanMonitor] Failed to get conversation for ${phone}:`, err);
    return [];
  }
}

/**
 * Get all active conversations (with last message and mode)
 * 
 * @returns {Promise<Array>} Array of conversation summaries
 */
export async function getActiveConversations() {
  if (!redis) return [];

  try {
    // Get all active phones (sorted by last activity)
    const activePhones = await redis.zrange("conversations:active", 0, -1, {
      rev: true,
      withScores: true
    });

    const conversations = [];

    // Process in pairs: [phone, timestamp, phone, timestamp, ...]
    for (let i = 0; i < activePhones.length; i += 2) {
      const phone = activePhones[i];
      const lastActivity = activePhones[i + 1];

      // Get last message
      const messages = await getConversation(phone, 1);
      const lastMessage = messages[messages.length - 1];

      // Check mode
      const mode = await isHumanMode(phone) ? "human" : "ai";

      // Check if escalated
      const escalation = await redis.get(`escalation:${phone}`);
      let escalationData = null;
      if (escalation) {
        try {
          escalationData = typeof escalation === 'string' ? JSON.parse(escalation) : escalation;
        } catch (e) {
          logger.error(`[HumanMonitor] Failed to parse escalation for ${phone}:`, e);
          escalationData = null;
        }
      }

      conversations.push({
        phone,
        lastActivity: Number(lastActivity),
        lastActivityDate: new Date(Number(lastActivity)).toISOString(),
        lastMessage: lastMessage?.text || "",
        lastMessageSender: lastMessage?.sender || "unknown",
        mode,
        escalated: Boolean(escalationData),
        escalationReason: escalationData?.reason || null
      });
    }

    return conversations;
  } catch (err) {
    logger.error(`[HumanMonitor] Failed to get active conversations:`, err);
    return [];
  }
}

/**
 * Get escalation queue (conversations waiting for human review)
 *
 * @returns {Promise<Array>} Array of escalated conversations
 */
export async function getEscalationQueue() {
  if (!redis) return [];

  try {
    const queue = await redis.zrange("escalations:queue", 0, -1, {
      rev: true,
      withScores: false
    });

    return queue
      .map(item => {
        try {
          const parsed = typeof item === 'string' ? JSON.parse(item) : item;
          // Add readable date format for Bubble
          parsed.createdAt = new Date(parsed.timestamp).toISOString();
          return parsed;
        } catch (e) {
          logger.error(`[HumanMonitor] Failed to parse escalation item:`, e);
          return null;
        }
      })
      .filter(Boolean);
  } catch (err) {
    logger.error(`[HumanMonitor] Failed to get escalation queue:`, err);
    return [];
  }
}

/**
 * Archive a conversation to Bubble (for completed conversations)
 *
 * @param {string} phone - User's phone number
 * @param {object} metadata - Conversation metadata (userName, bookingDetails, etc.)
 */
export async function archiveConversation(phone, metadata = {}) {
  if (!redis || !phone || !config?.bubbleArchiveUrl) return;

  try {
    // Get full conversation from Redis
    const messages = await getConversation(phone, 500); // Last 500 messages

    // Prepare archive payload
    const archiveData = {
      phone,
      messages,
      messageCount: messages.length,
      startTime: messages[0]?.timestamp || Date.now(),
      startTimeDate: new Date(messages[0]?.timestamp || Date.now()).toISOString(),
      endTime: messages[messages.length - 1]?.timestamp || Date.now(),
      endTimeDate: new Date(messages[messages.length - 1]?.timestamp || Date.now()).toISOString(),
      metadata: {
        ...metadata,
        archivedAt: Date.now(),
        archivedAtDate: new Date(Date.now()).toISOString()
      }
    };

    // Send to Bubble archival endpoint
    const response = await axios.post(config.bubbleArchiveUrl, archiveData, {
      headers: {
        "Content-Type": "application/json",
        ...(config.bubbleToken && { Authorization: `Bearer ${config.bubbleToken}` })
      },
      timeout: 10000
    });

    logger.info(`[HumanMonitor] Archived conversation: ${phone} (${messages.length} messages)`);

    // Remove from active conversations and escalation queue
    await redis.zrem("conversations:active", phone);

    const escalation = await redis.get(`escalation:${phone}`);
    if (escalation) {
      const escalationStr = typeof escalation === 'string' ? escalation : JSON.stringify(escalation);
      await redis.zrem("escalations:queue", escalationStr);
      await redis.del(`escalation:${phone}`);
    }

    return response.data;
  } catch (err) {
    logger.error(`[HumanMonitor] Failed to archive conversation ${phone}:`, err);
    throw err;
  }
}

/**
 * Clear escalation for a phone (when human has addressed it)
 */
export async function clearEscalation(phone) {
  if (!redis || !phone) return;

  try {
    const escalation = await redis.get(`escalation:${phone}`);
    if (escalation) {
      // Ensure we're using string format for removal from sorted set
      const escalationStr = typeof escalation === 'string' ? escalation : JSON.stringify(escalation);
      await redis.zrem("escalations:queue", escalationStr);
      await redis.del(`escalation:${phone}`);
      logger.info(`[HumanMonitor] Cleared escalation: ${phone}`);
    }
  } catch (err) {
    logger.error(`[HumanMonitor] Failed to clear escalation for ${phone}:`, err);
  }
}

/**
 * Send message from human staff to user
 */
export async function sendHumanMessage(phone, text, staffName, sendFn) {
  if (!phone) throw new Error("Phone number required");
  if (!text) throw new Error("Message text required");
  if (!sendFn) throw new Error("Send function required");

  try {
    // Log the human message
    await logMessage(phone, {
      sender: "human",
      text,
      metadata: { staff: staffName }
    });

    // Send via WhatsApp (or other channel)
    await sendFn(phone, text);

    logger.info(`[HumanMonitor] Human message sent: ${phone} by ${staffName}`);
    return { success: true, phone, text };
  } catch (err) {
    logger.error(`[HumanMonitor] Failed to send human message to ${phone}:`, err);
    throw err;
  }
}
