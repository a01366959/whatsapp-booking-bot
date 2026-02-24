import axios from "axios";
import { randomUUID } from "crypto";
import * as humanMonitor from "./human_monitor.js";

let deps = {};
let openai;
let redis;
let senders;
let logger;
let config;
let monitorInitialized = false;

const BUBBLE_REDIRECTS = new Set([301, 302, 303, 307, 308]);
const WEEKDAY_INDEX = {
  domingo: 0,
  lunes: 1,
  martes: 2,
  miercoles: 3,
  jueves: 4,
  viernes: 5,
  sabado: 6
};
const MONTH_INDEX = {
  enero: 1,
  febrero: 2,
  marzo: 3,
  abril: 4,
  mayo: 5,
  junio: 6,
  julio: 7,
  agosto: 8,
  septiembre: 9,
  setiembre: 9,
  octubre: 10,
  noviembre: 11,
  diciembre: 12
};
const SPANISH_NUMBERS = {
  un: 1,
  uno: 1,
  una: 1,
  dos: 2,
  tres: 3,
  cuatro: 4,
  cinco: 5,
  seis: 6,
  siete: 7,
  ocho: 8,
  nueve: 9,
  diez: 10
};

// ===== SPORTS CONFIGURATION =====
// Edit this to add/remove sports. Each sport has:
// - name: Display name in messages
// - keywords: Array of words user might say
// - api_name: Name to send to get_hours endpoint
// - default: true to suggest if user doesn't pick
// ================================
const SPORTS = [
  {
    name: "Padel",
    keywords: ["padel", "paddle"],
    api_name: "Padel",
    default: true
  },
  {
    name: "Pickleball",
    keywords: ["pickleball", "pickle"],
    api_name: "Pickleball",
    default: false
  },
  {
    name: "Golf",
    keywords: ["golf", "simulador"],
    api_name: "Golf",
    default: false
  }
];

// Helper: Get available sports (non-deleted ones)
const getAvailableSports = () => SPORTS.filter(s => !s.deleted);

// Helper: Get default sport (first one marked default:true)
const getDefaultSport = () => {
  const def = SPORTS.find(s => s.default && !s.deleted);
  return def ? def.name : SPORTS[0]?.name;
};

// Helper: Parse user input and match to a sport
const parseSport = (userText) => {
  const t = (userText || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  for (const sport of getAvailableSports()) {
    for (const keyword of sport.keywords) {
      if (t.includes(keyword)) return sport.name;
    }
  }
  return null;
};

const TOOLS = [
  {
    type: "function",
    function: {
      name: "get_user",
      description: "Get user information by phone number. Returns name, preferences, and booking history. Use when you need to personalize the conversation.",
      parameters: {
        type: "object",
        properties: { 
          phone: { type: "string", description: "10-digit phone number" } 
        },
        required: ["phone"],
        additionalProperties: false
      }
    }
  },
  {
    type: "function",
    function: {
      name: "get_hours",
      description: "Check available time slots for a specific sport and date. Use when user asks about availability or wants to see options. Returns list of available times.",
      parameters: {
        type: "object",
        properties: {
          sport: { 
            type: "string", 
            enum: SPORTS.map(s => s.name),
            description: "Sport type" 
          },
          date: { 
            type: "string", 
            description: "Date in YYYY-MM-DD format" 
          }
        },
        required: ["sport", "date"],
        additionalProperties: false
      }
    }
  },
  {
    type: "function",
    function: {
      name: "confirm_booking",
      description: "Confirm and save a reservation. Use ONLY when you have: sport, date, time, and user name. User must have explicitly agreed to the booking.",
      parameters: {
        type: "object",
        properties: {
          phone: { type: "string", description: "User phone number" },
          sport: { type: "string", enum: ["Padel", "Pickleball"], description: "Sport type" },
          date: { type: "string", description: "Date in YYYY-MM-DD format" },
          time: { type: "string", description: "Start time in HH:00 format (24h)" },
          name: { type: "string", description: "User first name" },
          last_name: { type: "string", description: "User last name" },
          duration_hours: { type: "number", enum: [1, 2, 3], description: "Booking duration in hours", default: 1 }
        },
        required: ["phone", "sport", "date", "time", "name"],
        additionalProperties: false
      }
    }
  }
];

export function init(dependencies = {}) {
  deps = dependencies;
  openai = deps.openai;
  redis = deps.redis;
  senders = deps.senders || {};
  logger = deps.logger || console;
  config = {
    bubbleBaseUrl: normalizeBubbleBase(deps.config?.bubbleBaseUrl || ""),
    bubbleToken: deps.config?.bubbleToken || "",
    confirmEndpoint: deps.config?.confirmEndpoint || "confirm_reserva",
    defaultSport: deps.config?.defaultSport || "Padel",
    maxButtons: Number(deps.config?.maxButtons || 3),
    mexicoTz: deps.config?.mexicoTz || "America/Mexico_City",
    useAgent: deps.config?.useAgent !== undefined ? Boolean(deps.config.useAgent) : true,
    staffPhone: deps.config?.staffPhone,
    bubbleArchiveUrl: deps.config?.bubbleArchiveUrl,
    escalationWebhook: deps.config?.escalationWebhook
  };
  
  // Initialize human monitoring system
  if (!monitorInitialized && redis) {
    humanMonitor.init({ redis, config, logger });
    monitorInitialized = true;
  }
  
  return { handleIncoming };
}

export async function handleIncoming(event) {
  if (!event?.channel) throw new Error("event.channel is required");
  if (event.channel !== "whatsapp") {
    await logEvent("unsupported_channel", { channel: event.channel });
    return { actions: [] };
  }
  return handleWhatsApp(event);
}

function normalizeBubbleBase(raw) {
  if (!raw) return "";
  let base = raw.trim().replace(/\/$/, "");
  if (!/^https?:\/\//i.test(base)) base = `https://${base}`;
  base = base.replace(/^http:\/\//i, "https://");
  base = base.replace(/\/api\/1\.1\/wf$/i, "");
  try {
    const u = new URL(base);
    if (u.hostname === "blackpadel.com.mx") {
      u.hostname = "www.blackpadel.com.mx";
    }
    base = u.toString().replace(/\/$/, "");
  } catch {
    // ignore
  }
  return `${base}/api/1.1/wf`;
}

function buildBubbleUrl(path) {
  const base = config.bubbleBaseUrl || "";
  return `${base}${path.startsWith("/") ? "" : "/"}${path}`;
}

async function bubbleRequest(method, path, { params, data } = {}) {
  const url = buildBubbleUrl(path);
  const headers = config.bubbleToken ? { Authorization: `Bearer ${config.bubbleToken}` } : {};
  const requestConfig = {
    method,
    url,
    params,
    data,
    headers,
    maxRedirects: 0,
    validateStatus: status => (status >= 200 && status < 400) || BUBBLE_REDIRECTS.has(status)
  };
  const maxAttempts = 3;
  let attempt = 0;
  let lastErr = null;
  while (attempt < maxAttempts) {
    attempt += 1;
    try {
      let res = await axios.request(requestConfig);
      if (BUBBLE_REDIRECTS.has(res.status) && res.headers?.location) {
        const redirectedUrl = new URL(res.headers.location, url).toString();
        res = await axios.request({ ...requestConfig, url: redirectedUrl });
      }
      return res;
    } catch (err) {
      lastErr = err;
      const status = err?.response?.status;
      if (status && status >= 400 && status < 500) break;
      const backoff = 100 * Math.pow(2, attempt - 1);
      await new Promise(resolve => setTimeout(resolve, backoff));
    }
  }
  throw lastErr;
}

const CLUB_INFO = {
  name: "Black Padel & Pickleball",
  address: "P.º de los Sauces Manzana 007, San Gaspar Tlahuelilpan, Estado de México, CP 52147",
  maps_url: "https://maps.app.goo.gl/7rVpWz5benMH9fHu5",
  parking: "Estacionamiento gratuito disponible dentro y fuera del club",
  phone: "+52 56 5440 7815",
  whatsapp: "+52 56 5440 7815",
  email: "hola@blackpadel.com.mx",
  website: "https://blackpadel.com.mx",
  instagram: "@blackpadelandpickleball",
  opening_hours: "Lunes a viernes de 7:00 a 22:00, Sábado y domingo de 8:00 a 15:00",
  courts: "2 canchas de Padel techadas, 2 canchas de Pickleball techadas, 1 simulador de Golf",
  amenities: "Baños, vestidores, tienda, bar, mesas, estacionamiento, WiFi",
  services: "Reservas, clases, torneos, ligas, renta de equipo",
  location: {
    latitude: 19.5256,
    longitude: -99.2325,
    address_short: "San Gaspar Tlahuelilpan, Estado de México"
  }
};

const SYSTEM_MESSAGE = {
  role: "system",
  content: `
Eres Michelle, recepcionista amable y cálida de Black Padel & Pickleball (México).

DEPORTES DISPONIBLES:
${getAvailableSports().map(s => `- ${s.name}`).join("\n")}
DEPORTE POR DEFECTO (si el usuario no especifica): ${getDefaultSport()}

INFORMACIÓN DEL CLUB:
- Nombre: ${CLUB_INFO.name}
- Dirección: ${CLUB_INFO.address}
- Horarios: ${CLUB_INFO.opening_hours}
- Canchas: ${CLUB_INFO.courts}
- Instalaciones: ${CLUB_INFO.amenities}
- Servicios: ${CLUB_INFO.services}
- Estacionamiento: ${CLUB_INFO.parking}
- Contacto: WhatsApp ${CLUB_INFO.whatsapp}, Instagram ${CLUB_INFO.instagram}
- Google Maps: ${CLUB_INFO.maps_url}

CÓMO CONVERSAR (MUY IMPORTANTE):\n- Sé amable, cálida y natural como una recepcionista real
- Cuando respondas una pregunta sobre ubicación/horarios/instalaciones, añade una sugerencia natural como:
  * Después de ubicación: "¿Te gustaría reservar una cancha?"
  * Después de horarios: "¿Quieres revisar disponibilidad?"
  * Después de instalaciones: "¿Te atrae jugar con nosotros?"
- Usa el nombre del cliente cuando lo sepas (ejemplo: "Juan, ¡qué bueno!")
- Habla con entusiasmo del club, como si fuera tu lugar favorito
- NO seas robótico ni lista de hechos - crea conversación real

REGLAS DURAS:
- NO repitas saludos
- NO inventes información - solo datos del club
- NO respondas programación, código, temas técnicos, ilegales o fuera del club
- Si preguntan algo fuera del club, responde educadamente que solo ayudas con temas del club
- Si ya hay fecha, NO la pidas otra vez
- Si ya hay horarios cargados, NO los vuelvas a pedir

HERRAMIENTAS:
- get_user: obtener nombre del cliente por teléfono
- get_hours: horarios disponibles por fecha

Responde en español, corto, claro y cálido.
`
};

const normalizePhone = p => {
  const digits = (p || "").replace(/\D/g, "");
  if (digits.length <= 10) return digits;
  return digits.slice(-10);
};

const normalizeText = text =>
  (text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

const getMexicoDateParts = () => {
  const dt = new Date();
  const dateStr = new Intl.DateTimeFormat("en-CA", {
    timeZone: config.mexicoTz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(dt);
  const hour = Number(
    new Intl.DateTimeFormat("en-US", {
      timeZone: config.mexicoTz,
      hour: "2-digit",
      hour12: false
    }).format(dt)
  );
  const weekdayRaw = new Intl.DateTimeFormat("es-MX", {
    timeZone: config.mexicoTz,
    weekday: "long"
  }).format(dt);
  const weekday = WEEKDAY_INDEX[normalizeText(weekdayRaw)] ?? 0;
  return { dateStr, hour, weekdayIndex: weekday };
};

const toBubbleDate = dateStr => {
  if (!dateStr) return null;
  if (dateStr.includes("T")) return dateStr;
  return `${dateStr}T00:00:00Z`;
};



const hourToNumber = timeStr => {
  const m = timeStr?.match(/^(\d{2}):/);
  return m ? Number(m[1]) : null;
};

const addHours = (timeStr, inc) => {
  const h = hourToNumber(timeStr);
  if (h === null) return null;
  const next = h + inc;
  if (next >= 24) return null;
  return `${String(next).padStart(2, "0")}:00`;
};

const buildOptions = (slots, duration) => {
  const byCourt = new Map();
  for (const slot of slots || []) {
    const court = slot["Court"];
    const time = slot["Time"];
    if (!court || !time) continue;
    if (!byCourt.has(court)) byCourt.set(court, new Set());
    byCourt.get(court).add(time);
  }
  const options = [];
  for (const [court, set] of byCourt.entries()) {
    const times = Array.from(set).sort();
    for (const time of times) {
      const timesSeq = [];
      let ok = true;
      for (let i = 0; i < duration; i += 1) {
        const t = addHours(time, i);
        if (!t || !set.has(t)) {
          ok = false;
          break;
        }
        timesSeq.push(t);
      }
      if (ok) options.push({ start: time, times: timesSeq, court });
    }
  }
  return options;
};

const uniqueStarts = options => {
  const map = new Map();
  for (const opt of options || []) {
    if (!map.has(opt.start)) map.set(opt.start, opt);
  }
  return Array.from(map.values());
};

const startTimesFromOptions = options => {
  const times = uniqueStarts(options).map(o => o.start);
  return times.sort((a, b) => {
    const hourA = parseInt(a.split(':')[0]);
    const hourB = parseInt(b.split(':')[0]);
    return hourA - hourB;
  });
};

const pickClosestOptions = (options, desiredTime) => {
  const unique = uniqueStarts(options);
  if (!desiredTime) return unique.slice(0, config.maxButtons);
  const target = hourToNumber(desiredTime);
  return unique
    .sort((a, b) => {
      const da = Math.abs(hourToNumber(a.start) - target);
      const db = Math.abs(hourToNumber(b.start) - target);
      return da - db;
    })
    .slice(0, config.maxButtons);
};

const formatDateEs = dateStr => {
  if (!dateStr) return "";
  const d = new Date(dateStr.includes("T") ? dateStr : `${dateStr}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return dateStr;
  return new Intl.DateTimeFormat("es-MX", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC"
  }).format(d);
};

const formatTimeRange = times => {
  if (!times?.length) return "";
  if (times.length === 1) return times[0];
  return `${times[0]} a ${times[times.length - 1]}`;
};

const suggestClosestHours = (hours, desiredTime) => {
  if (!hours?.length) return [];
  const desiredHour = hourToNumber(desiredTime);
  if (desiredHour === null) return hours.slice(0, config.maxButtons);
  const sorted = [...hours].sort();
  const before = [];
  const after = [];
  for (const h of sorted) {
    const hr = hourToNumber(h);
    if (hr === null) continue;
    if (hr < desiredHour) before.push(h);
    else if (hr > desiredHour) after.push(h);
  }
  const suggestions = [];
  if (after.length) suggestions.push(after[0]);
  if (after.length > 1) suggestions.push(after[1]);
  if (before.length) suggestions.push(before[before.length - 1]);
  return [...new Set(suggestions)].slice(0, config.maxButtons);
};

const isGreeting = text =>
  /\b(hola|buenas|buenos\s+d[ií]as|buenas\s+tardes|buenas\s+noches|hey|que\s+tal)\b/i.test(text || "");

const hasBookingIntent = text =>
  /\b(reservar|reserva|resev|resevar|reserbar|agendar|agenda|apart(ar)?|cancha|horario|jugar|juego|jugará)\b/i.test(text || "");

const isYes = text => /\b(s[ií]|ok|vale|confirmo|confirmar|de acuerdo|adelante|por favor|porfa)\b/i.test(text || "");
const isNo = text => /\b(no|cancelar|mejor no|todav[ií]a no)\b/i.test(text || "");

const wantsOtherTimes = text =>
  /\b(otra\s+hora|otras\s+horas|que\s+otra|qué\s+otra|opciones|alternativas|diferente|más\s+tarde|mas\s+tarde|más\s+temprano|mas\s+temprano)\b/i.test(
    text || ""
  );

const wantsAvailability = text =>
  /\b(horarios|disponibilidad|disponible|espacios|que\s+horarios)\b/i.test(text || "");

const isInfoQuestion = text =>
  /\b(que\s+pasa|qué\s+pasa|llego\s+tarde|llegar\s+tarde|se\s+me\s+hace\s+tarde|politica|política|regla|cancel|reagend|reembolso|devolucion|precio|costo|tarifa|ubicacion|ubicación|direccion|dirección|estacionamiento|clases|torneos|renta|rentar)\b/i.test(
    text || ""
  );

const isNameQuestion = text => /\b(como\s+te\s+llamas|cual\s+es\s+tu\s+nombre|quien\s+eres)\b/i.test(text || "");

const isLateQuestion = text =>
  /\b(llego\s+tarde|llegar\s+tarde|se\s+me\s+hace\s+tarde|voy\s+a\s+llegar\s+tarde)\b/i.test(text || "");

async function logEvent(type, payload = {}) {
  const ev = { type, payload, ts: new Date().toISOString() };
  try {
    if (redis?.lpush) await redis.lpush("telemetry", JSON.stringify(ev));
  } catch {
    // ignore telemetry failures
  }
  logger?.info?.("EVENT", ev);
}

async function escalateToHuman(phone, reason, session = {}) {
  await logEvent("escalation", {
    phone,
    reason,
    sessionSummary: { date: session.date, sport: session.sport, desiredTime: session.desiredTime }
  });
  
  // Use human monitoring system to escalate
  await humanMonitor.escalateToHuman(phone, reason, config.escalationWebhook);
  
  // Still notify staff phone if configured (legacy support)
  const staff = config.staffPhone || process.env.STAFF_PHONE;
  if (staff) {
    try {
      await safeSendText(staff, `Escalation: ${phone} — ${reason}`);
    } catch (err) {
      logger?.error?.("escalateToHuman notify staff failed", err?.message || err);
    }
  }
}

function computeConfidence(decision, interpretation, session) {
  if (!decision) return 0;
  if (decision.action === "confirm_reserva") return 0.95;
  if (decision.action === "get_hours") return 0.9;
  if (decision.action === "send_location") return 0.9;
  if (decision.action === "get_user") return 0.85;
  if (interpretation?.intent === "book") {
    const hasDate = Boolean(session.date || interpretation.date);
    const hasSport = Boolean(session.sport || interpretation.sport);
    if (hasDate && hasSport) return 0.85;
    if (hasDate || hasSport) return 0.6;
    return 0.5;
  }
  if (decision.action === "ask") return 0.65;
  if (decision.action === "reply") return 0.5;
  return 0.4;
}

const getSession = phone => redis?.get ? redis.get(`session:${phone}`) : null;
const saveSession = (phone, session) =>
  redis?.set ? redis.set(`session:${phone}`, session, { ex: 1800 }) : Promise.resolve();
const clearSession = phone => (redis?.del ? redis.del(`session:${phone}`) : Promise.resolve());

/**
 * Get conversation history for context-aware responses
 * Retrieves last N messages from human_monitor conversation log
 * @param {string} phone - User's phone number
 * @param {number} limit - Maximum messages to retrieve (default: 10)
 * @returns {Array} Array of message objects in OpenAI format
 */
async function getConversationHistory(phone, limit = 10) {
  try {
    const conversation = await humanMonitor.getConversation(phone, limit);
    if (!conversation || !conversation.messages) {
      logger?.info?.(`[ConversationHistory] No history found for ${phone}`);
      return [];
    }
    
    // Convert to OpenAI message format
    const messages = [];
    for (const msg of conversation.messages.reverse()) {  // Reverse to get chronological order
      const role = msg.sender === 'user' ? 'user' : 'assistant';
      if (msg.text) {
        messages.push({
          role,
          content: msg.text
        });
      }
    }
    
    logger?.info?.(`[ConversationHistory] Retrieved ${messages.length} messages for ${phone}`);
    if (messages.length > 0) {
      logger?.info?.(`[ConversationHistory] Last message: "${messages[messages.length - 1]?.content?.substring(0, 50)}..."`);
    }
    
    return messages;
  } catch (err) {
    logger?.error?.(`[ConversationHistory] Failed to retrieve for ${phone}:`, err.message);
    return [];
  }
}

/**
 * Clear session and optionally archive conversation to Bubble
 * @param {string} phone - User's phone number
 * @param {object} metadata - Metadata about completed conversation (userName, bookingDetails, etc.)
 * @param {boolean} shouldArchive - Whether to archive this conversation
 */
async function clearSessionWithArchive(phone, metadata = {}, shouldArchive = false) {
  if (shouldArchive && config.bubbleArchiveUrl) {
    try {
      await humanMonitor.archiveConversation(phone, metadata);
      logger?.info?.(`[Archive] Conversation archived for ${phone}`);
    } catch (err) {
      logger?.error?.(`[Archive] Failed to archive conversation for ${phone}:`, err.message);
    }
  }
  await clearSession(phone);
}

const markMessageProcessed = async id => {
  if (!redis?.set) return true;
  const res = await redis.set(`msg:${id}`, 1, { nx: true, ex: 86400 });
  return Boolean(res);
};

const getFlowToken = phone => (redis?.get ? redis.get(`flow:${phone}`) : null);
const setFlowToken = (phone, token) =>
  redis?.set ? redis.set(`flow:${phone}`, token, { ex: 86400 }) : Promise.resolve();

const ensureFlowToken = async phone => {
  let token = await getFlowToken(phone);
  if (!token) {
    token = randomUUID();
    await setFlowToken(phone, token);
  }
  return token;
};

async function safeSendText(to, text, flowToken) {
  if (!to) return { ok: false, error: "missing_to" };
  if (flowToken) {
    const current = await getFlowToken(to);
    if (current && current !== flowToken) return { ok: false, error: "stale_flow" };
  }
  try {
    if (!senders?.text) throw new Error("text sender not configured");
    await senders.text(to, text);
    await logEvent("send_text", { to, text });
    
    // Log AI message in conversation history
    await humanMonitor.logMessage(to, {
      sender: "ai",
      text,
      metadata: { type: "text" }
    });
    
    return { ok: true };
  } catch (err) {
    logger?.error?.("sendText failed", err?.response?.data || err?.message || err);
    await logEvent("send_text_error", { to, message: err?.message || "unknown" });
    return { ok: false, error: "sendText_failed" };
  }
}

async function safeSendButtons(to, text, buttons, flowToken) {
  if (!to) return { ok: false, error: "missing_to" };
  if (flowToken) {
    const current = await getFlowToken(to);
    if (current && current !== flowToken) return { ok: false, error: "stale_flow" };
  }
  try {
    if (!senders?.buttons) throw new Error("buttons sender not configured");
    await senders.buttons(to, text, buttons);
    await logEvent("send_buttons", { to, text, buttons });
    return { ok: true };
  } catch (err) {
    logger?.error?.("sendButtons failed", err?.response?.data || err?.message || err);
    await logEvent("send_buttons_error", { to, message: err?.message || "unknown" });
    return { ok: false, error: "sendButtons_failed" };
  }
}

async function safeSendLocation(to, latitude, longitude, name, address, flowToken) {
  if (!to) return { ok: false, error: "missing_to" };
  if (flowToken) {
    const current = await getFlowToken(to);
    if (current && current !== flowToken) return { ok: false, error: "stale_flow" };
  }
  try {
    if (!senders?.location) {
      logger?.warn?.("location sender not configured, sending as text");
      await safeSendText(to, `📍 ${name}\n${address}`, flowToken);
      return { ok: true };
    }
    await senders.location(to, { latitude, longitude, name, address });
    await logEvent("send_location", { to, name, address });
    
    // Log AI message in conversation history
    await humanMonitor.logMessage(to, {
      sender: "ai",
      text: `📍 ${name}\n${address}`,
      metadata: { type: "location", latitude, longitude }
    });
    
    return { ok: true };
  } catch (err) {
    logger?.error?.("sendLocation failed", err?.response?.data || err?.message || err);
    logger?.warn?.("falling back to text message for location");
    await safeSendText(to, `📍 ${name}\n${address}`, flowToken);
    return { ok: true };
  }
}

async function safeSendList(to, bodyText, buttonText, sections, flowToken) {
  if (!to) return { ok: false, error: "missing_to" };
  if (flowToken) {
    const current = await getFlowToken(to);
    if (current && current !== flowToken) return { ok: false, error: "stale_flow" };
  }
  try {
    if (!senders?.list) {
      logger?.warn?.(`[LIST] sender not configured, falling back to text. Sections: ${sections.length}`);
      const allOptions = sections.flatMap(s => s.rows.map(r => r.title)).join(", ");
      await safeSendText(to, `${bodyText}\n\n${allOptions}`, flowToken);
      return { ok: true };
    }
    logger?.info?.(`[LIST] Sending list with ${sections[0]?.rows?.length || 0} options to ${to}`);
    await senders.list(to, bodyText, buttonText, sections);
    await logEvent("send_list", { to, bodyText, sectionsCount: sections.length });
    
    // Log AI message in conversation history
    const options = sections.flatMap(s => s.rows.map(r => r.title)).join(", ");
    await humanMonitor.logMessage(to, {
      sender: "ai",
      text: `${bodyText}\n\nOpciones: ${options}`,
      metadata: { type: "list", sectionsCount: sections.length }
    });
    
    return { ok: true };
  } catch (err) {
    logger?.error?.(`[LIST] sendList failed: ${err?.message}`, err?.response?.data || err);
    logger?.warn?.(`[LIST] falling back to text message`);
    const allOptions = sections.flatMap(s => s.rows.map(r => r.title)).join(", ");
    await safeSendText(to, `${bodyText}\n\n${allOptions}`, flowToken);
    return { ok: true };
  }
}

async function findUser(phone) {
  const r = await bubbleRequest("get", "/get_user", { params: { phone } });
  return r.data?.response || { found: false };
}

async function getAvailableHours(date, desiredSport) {
  const bubbleDate = toBubbleDate(date);
  const { hour, dateStr } = getMexicoDateParts();
  const dateOnly = (date || "").includes("T") ? String(date).slice(0, 10) : String(date || "");
  const currentTimeNumber = dateOnly && dateOnly === dateStr ? hour : 0;
  const r = await bubbleRequest("get", "/get_hours", {
    params: {
      sport: desiredSport || config.defaultSport,
      date: bubbleDate,
      current_time_number: currentTimeNumber
    }
  });
  return r.data?.response?.hours || [];
}

async function confirmBooking(phone, date, times, court, name, lastName, userId, sport, userType) {
  const bubbleDate = toBubbleDate(date);
  const basePayload = {
    phone,
    date: bubbleDate,
    time: times,
    court,
    sport: sport || config.defaultSport,
    user_type: userType
  };
  if (name) basePayload.name = name;
  if (lastName) basePayload.last_name = lastName;
  const withUser = userId ? { ...basePayload, user: userId } : basePayload;
  try {
    const res = await bubbleRequest("post", `/${config.confirmEndpoint}`, { data: withUser });
    const apiError = res?.data?.response?.error;
    if (apiError) {
      const err = new Error(apiError);
      err.code = "slot_taken";
      throw err;
    }
  } catch (err) {
    logger?.error?.("confirmBooking failed", {
      baseURL: config.bubbleBaseUrl,
      url: err?.config?.url,
      method: err?.config?.method,
      statusCode: err?.response?.status,
      data: err?.response?.data
    });
    if (userId && err?.code !== "slot_taken") {
      await bubbleRequest("post", `/${config.confirmEndpoint}`, { data: basePayload });
      return;
    }
    throw err;
  }
}

async function interpretMessage(session, userText) {
  if (!openai) return { intent: "other" };
  const { dateStr } = getMexicoDateParts();
  const sys = `
Eres Michelle, recepcionista humana de Black Padel, Pickleball & Golf (México).
Tu tarea es interpretar el mensaje del usuario y extraer intención y datos.
Reglas:
- Devuelve SOLO JSON válido.
- "intent": "book" si el usuario quiere reservar o preguntar horarios; "info" si es una duda general; "other" si es otra cosa.
- Si el usuario menciona fecha relativa ("hoy", "mañana", "este viernes", "en dos días"), convierte a YYYY-MM-DD usando México (America/Mexico_City).
- Si el usuario menciona hora, usa HH:MM.
- Si el usuario menciona duración, usa 1-3.
Hoy en México es ${dateStr}.
`;

  const context = {
    known_sport: session.sport || null,
    known_date: session.date || null,
    known_time: session.desiredTime || null,
    known_duration: session.duration || null
  };

  const messages = [
    { role: "system", content: sys },
    { role: "system", content: `Contexto: ${JSON.stringify(context)}` },
    { role: "user", content: userText }
  ];

  try {
    const resp = await openai.chat.completions.create({
      model: deps.config?.interpretModel || "gpt-4o-mini",
      messages,
      temperature: 0.2,
      response_format: { type: "json_object" }
    });
    const content = resp.choices[0]?.message?.content || "{}";
    const data = JSON.parse(content);
    return {
      intent: data.intent || "other",
      reply: data.reply || "",
      sport: data.sport || null,
      date: data.date || null,
      time: data.time || null,
      duration: data.duration_hours || data.duration || null,
      name: data.name || null,
      last_name: data.last_name || null
    };
  } catch {
    return { intent: "other" };
  }
}

async function runAgent(session, userText) {
  if (!openai) return { finalText: "¿Te ayudo con algo del club?", messages: [] };
  const context = [
    SYSTEM_MESSAGE,
    {
      role: "system",
      content: `Contexto actual:
- phone: ${session.phone}
- user_found: ${session.user?.found ? "si" : "no"}
- user_name: ${session.user?.name || "desconocido"}
- user_id: ${session.user?.id || "desconocido"}
- user_last_name: ${session.userLastName || "desconocido"}
- date: ${session.date || "null"}
- hours: ${session.hours?.length ? session.hours.join(", ") : "null"}
- sport: ${session.sport || config.defaultSport}
- duration: ${session.duration || 1}

IMPORTANTE: Si el usuario te pregunta "como me llamo" y user_name no es "desconocido", responde con ese nombre.`
    },
    ...session.messages.filter(m => m.role === "user" || (m.role === "assistant" && !m.tool_calls))
  ];

  const messages = [...context, { role: "user", content: userText }];
  let finalText = null;
  let guard = 0;

  while (!finalText && guard < 4) {
    guard += 1;
    const response = await openai.chat.completions.create({
      model: deps.config?.agentModel || "gpt-4o-mini",
      messages,
      tools: TOOLS,
      tool_choice: "auto",
      temperature: 0.2
    });

    const msg = response.choices[0]?.message;
    if (!msg) break;

    if (msg.tool_calls?.length) {
      messages.push({
        role: "assistant",
        content: msg.content ?? "",
        tool_calls: msg.tool_calls
      });

      for (const call of msg.tool_calls) {
        const name = call.function.name;
        let args = {};
        try {
          args = JSON.parse(call.function.arguments || "{}");
        } catch {
          args = {};
        }

        let result = { ok: false };
        if (name === "get_user") {
          result = await findUser(args.phone);
          session.user = result;
          if (result?.last_name) session.userLastName = result.last_name;
        } else if (name === "get_hours") {
          const date = args.date || session.date;
          const sport = args.sport || config.defaultSport;
          if (!date) {
            result = { ok: false, error: "missing_date" };
          } else {
            session.date = date;
            session.sport = sport;
            const slots = await getAvailableHours(date, sport);
            session.slots = slots;
            session.options = buildOptions(slots, session.duration || 1);
            const times = startTimesFromOptions(session.options);
            session.hours = times;
            session.hoursSent = false;
            session.justFetchedHours = true;
            result = { ok: true, date, times };
          }
        } else {
          result = { ok: false, error: "unknown_tool" };
        }

        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: JSON.stringify(result)
        });
      }
    } else {
      finalText = msg.content?.trim() || "¿Te ayudo con algo del club?";
      messages.push({ role: "assistant", content: finalText });
    }
  }

  return { finalText: finalText || "¿Te ayudo con algo del club?", messages };
}

async function agentDecide(phone, userText, session) {
  if (!openai) return { response: "¿Me repites, por favor?", toolCalls: [], needsEscalation: false };
  
  const { dateStr } = getMexicoDateParts();
  
  // Build context from current session using NEW structure
  const confirmedBookings = session?.confirmedBookings || [];
  const hasRecentBooking = confirmedBookings.length > 0;
  const sessionContext = {
    bookingDraft: session?.bookingDraft || {},
    user_name: session?.user?.name || null,
    last_name: session?.userLastName || null,
    available_times: session?.hours || [],
    confirmed_bookings: confirmedBookings,
    conversation_history: session?.messages || []
  };
  
  const systemPrompt = `Eres Michelle, recepcionista humana de Black Padel & Pickleball. Tu trabajo es hacer reservas de manera natural, como lo haría una persona real.

INFORMACIÓN DEL CLUB:
- Nombre: Black Padel & Pickleball
- Dirección: P.º de los Sauces Manzana 007, San Gaspar Tlahuelilpan, Estado de México
- Horarios: Lunes a viernes 7:00-22:00, Sábado y domingo 8:00-15:00
- Deportes: Padel, Pickleball, Golf
- Servicios: Reservas, clases, torneos ("retas"), ligas, renta de equipo
- Contacto: WhatsApp +52 56 5440 7815 (donde estás)

HOY ES: ${dateStr}

${hasRecentBooking ? `
🎯 RESERVAS CONFIRMADAS DEL USUARIO:
${confirmedBookings.map(b => `   - ${b.sport} el ${formatDateEs(b.date)} a las ${b.time} para ${b.name}`).join('\n')}

⚠️ Si el usuario pregunta sobre torneos, retas, clases u otros servicios:
   1. Menciona que SÍ tienen esos servicios
   2. Recomienda que consulte directamente al club para más detalles
   3. NO intentes hacer otra reserva a menos que explícitamente lo pida
` : ''}`

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
⚠️ REGLA CRÍTICA DE MEMORIA (LEE ESTO PRIMERO) ⚠️
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

ANTES de responder CUALQUIER cosa:
1. LEE TODOS los mensajes anteriores arriba
2. EXTRAE toda la información que el usuario YA dio:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🧠 YOU ARE A BOOKING AI AGENT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Your job: Help users book Padel or Pickleball court time.

THREE PILLARS (Never break these):
1. **MEMORY**: Remember every piece of data extracted. Never ask twice for same info.
2. **HUMANLIKE**: Understand natural speech. If user says "3 de la tarde", you know they mean 15:00. No re-asking.
3. **SMART**: Make intelligent decisions. If only one time matches user's preference, don't ask "confirm 15:00?", just show it.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📊 CONVERSATION CONTEXT YOU SEE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

BOOKING DRAFT (what you're building):
${JSON.stringify(sessionContext?.bookingDraft, null, 2)}

CONVERSATION HISTORY:
${sessionContext?.messages?.map(m => `${m.role}: ${m.content}`).join("\n")}

AVAILABLE TOOLS:
- get_hours(sport, date): Get available court times
- confirm_booking(sport, date, time, name, last_name): Reserve the court
- get_user(phone): Load user contact info

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🔄 YOUR ORCHESTRATION FLOW (STATE MACHINE)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Every response follows THIS logic:

STEP 1: READ bookingDraft status
- Empty?         [sport=null, date=null, time=null, name=null]
- Partial?       [sport="Padel", date=null, time=null, name=null]
- Almost ready?  [sport="Padel", date="2026-02-17", time=null, name=null]
- Complete?      [sport="Padel", date="2026-02-17", time="15:00", name="Juan"]

STEP 2: EXTRACT from user message and UPDATE bookingDraft
- Parse sport, date, time, name from what user said
- Store extracted values in bookingDraft
- LOG what you extracted: "Extracted: sport=Padel from user message"

STEP 3: DECIDE WHAT TO DO based on bookingDraft state
- Status: [sport=?, date=null] → Missing sport & date → Ask "¿Padel o Pickleball? ¿Qué fecha?"
- Status: [sport="Padel", date=null] → Missing date → Ask "¿Qué fecha?"
- Status: [sport="Padel", date="2026-02-17"] → Have sport+date → **CALL get_hours(sport, date)**
- Status: [sport="Padel", date="2026-02-17", time=null] → Missing time → Show available times, ask user to pick
- Status: [sport="Padel", date="2026-02-17", time="15:00", name=null] → Missing name → Ask "¿A qué nombre?"
- Status: [sport="Padel", date="2026-02-17", time="15:00", name="Juan"] → COMPLETE → **CALL confirm_booking**

STEP 4: RESPOND naturally based on what you decided
- If calling get_hours: "Dale, tengo disponibilidad:"
- If asking for time: Show times from available_times, ask user to pick
- If asking for name: "¿A qué nombre?"
- If calling confirm_booking: "Perfecto, te confirmo: Padel 17/02 a las 15:00. Te llegará por WhatsApp"

DO NOT:
❌ Re-ask for information already in bookingDraft
❌ Show times twice
❌ Ask "confirm?" and then ask again - if they say yes, call confirm_booking
❌ Support multiple dates at once - focus on ONE booking at a time

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🎯 MEMORY RULE (CRITICAL)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

RULE 1: CHECK bookingDraft BEFORE responding:
- If bookingDraft.sport is already set → DON'T ask "¿Padel o Pickleball?"
- If bookingDraft.date is already set → DON'T ask "¿Qué fecha?"
- If bookingDraft.time is already set → DON'T ask "¿Qué hora?"
- If bookingDraft.name is already set → DON'T ask "¿Cuál es tu nombre?"

RULE 2: POPULATE bookingDraft as user gives data:
When user says something, IMMEDIATELY extract and update bookingDraft:

- User says "padel" or "pickleball" → SET bookingDraft.sport = that sport
- User says "mañana", "hoy", "18 de febrero", date/day → SET bookingDraft.date = parsed date
- User says "7", "15:00", "3pm", time + available times exist → SET bookingDraft.time = interpreted time
- User says their name → SET bookingDraft.name + bookingDraft.lastName

RULE 3: STATE TRANSITIONS (When to call tools):
1. **Call get_hours**: When bookingDraft.sport + bookingDraft.date are set (need times)
2. **Call confirm_booking**: When ALL four are set: sport + date + time + name (READY TO BOOK)

RULE 4: TIME INTERPRETATION (Smart matching with available times):
When user says a time and you have available_times:
- User: "7" + available_times=[07:00, 08:00, 09:00...] → bookingDraft.time = 07:00 (obvious match)
- User: "7" + available_times=[07:00, 19:00] → ASK "¿7 de la mañana (07:00) o de la noche (19:00)?"
- User: "tarde" + available_times with afternoon slots → show filtered times, user picks one
- User picks specific time from list → bookingDraft.time = that time

RULE 5: CONVERSATION PROGRESSION (Never loop):
After you show available times and ask user to pick:
→ User says "15:00" or picks any time → bookingDraft.time is LOCKED
→ User confirms ("sí", "dale", "15:00 está bien") → time choice is FINAL
→ NEVER ask about time again. Move to NEXT step.

RULE 5B: AFTER TIME IS LOCKED (Progressive questioning):
If bookingDraft.time is set but bookingDraft.name is null:
→ NEXT response should ask for name: "¿A qué nombre?"
→ DON'T re-confirm time, DON'T show times again
→ ONLY ask for what's missing

If user responds with "sí por favor" or similar confirms when time+sport+date exist but name is null:
→ User is confirming their willingness, not confirming specific time

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🎾 AFTER BOOKING CONFIRMED (CRITICAL - READ THIS)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

When user has confirmed_bookings in their session:
- They ALREADY HAVE a reservation
- They're NOT trying to make another one unless they explicitly say so
- If they ask "Tienen retas?", "Tienen torneos?", "Dan clases?" → They're asking about SERVICES, NOT making new booking

CORRECT RESPONSES (after booking confirmed):
❌ WRONG: "Para mañana tengo 17:00 y 19:00 disponible" (don't offer times!)
✅ RIGHT: "Sí, tenemos retas y torneos! Para más info te recomiendo llamar al club o checar nuestro Instagram @blackpadelandpickleball"

❌ WRONG: "¿Te gustaría reservar?" (they already reserved!)
✅ RIGHT: "Ya tienes tu cancha reservada para mañana 18:00. Si necesitas algo más, con confianza!"

Examples:
User: "Tienen retas?"
You: "¡Claro! Tenemos retas y torneos regularmente. Para horarios y cómo inscribirte, mejor llama al club o manda DM al Instagram @blackpadelandpickleball"

User: "Dan clases?"
You: "Sí, tenemos clases y coaching. Te paso el contacto del club para que te den precios y horarios: +52 56 5440 7815"

User: "Necesito otra cancha"
You: [NOW you can start a new booking] "Perfecto, ¿para qué fecha y hora?"
→ Extract name from response if present
→ If no name in response, ask: "¿A qué nombre?"
→ Then call confirm_booking (or use name from get_user if available)

RULE 5C: CONFIRMATION FLOW:
When bookingDraft is COMPLETE (sport + date + time + name):
→ Send confirmation message (examples below)
→ IMMEDIATELY call confirm_booking
→ DO NOT ask more questions

When user says "sí", "si", "dale", "confirmo", "ok", "vale" AFTER seeing available times:
→ This is CONFIRMATION
→ Extract what's missing (likely THE TIME they chose)
→ Call confirm_booking
→ NEVER ask again

EXAMPLE (CORRECT):
User (turn 1): "Quiero Padel mañana a las 7"
Your bookingDraft before response: sport=null, date=null, time=null, name=null
Your extraction: sport="Padel", date=tomorrow, time="07:00" (from natural language)
Your bookingDraft after extraction: sport="Padel", date=2026-02-17, time="07:00", name=null → CALL get_hours
Your response: "Listo, tengo disponibilidad a las 07:00 mañana. ¿A qué nombre?"

User (turn 2): "Juan García"
Your extraction: name="Juan", lastName="García"
Your bookingDraft: sport="Padel", date="2026-02-17", time="07:00", name="Juan", lastName="García" → bookingDraft COMPLETE
Your action: CALL confirm_booking immediately
Your response: "Perfecto Juan, te confirmo Padel mañana 07:00. Te llegará por WhatsApp"

EXAMPLE (WRONG - DON'T DO THIS):
User: "Padel mañana a las 7"
Your response: "¿A qué hora?" ← WRONG, user already said 7
Your response: Shows times again ← WRONG, user already gave us sport+date+time
Your response: "¿Cuál prefieres?" ← WRONG, should extract what they said and move forward

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
� WHEN TO CALL TOOLS (EXPLICIT)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

**get_hours(sport, date)**:
CALL WHEN: bookingDraft.sport AND bookingDraft.date are both set
WHAT IT DOES: Returns available times for that sport/date
YOU DO NEXT: Show times to user from the result, ask them to pick one

**confirm_booking(sport, date, time, name, last_name)**:
CALL WHEN: bookingDraft.sport AND bookingDraft.date AND bookingDraft.time AND bookingDraft.name are ALL set
WHAT IT DOES: Reserves the court
YOU DO NEXT: Send confirmation message, don't ask anything more

**get_user(phone)**:
CALL WHEN: bookingDraft.name is null and get_user might have it from DB
WHAT IT DOES: Looks up user info from phone number
YOU DO NEXT: Check if name exists, fill bookingDraft.name if found

IMPORTANT:
- Do NOT call tools speculatively. Call them ONLY when the stated conditions are met.
- Do NOT show times before having called get_hours.
- Do NOT try to confirm without all four fields set.
- After calling get_hours, the response will include available_times. Use those in your next message.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
�💬 NATURAL CONVERSATION PATTERNS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

EXTRACT SPORT:
- "Quiero padel" → sport = "Padel"
- "Pickleball para mañana" → sport = "Pickleball"
- "Algo para jugar" + no sport mentioned → Ask "¿Padel o Pickleball?"

EXTRACT DATE:
- "Mañana" → tomorrow's date
- "El 16" or "16 de febrero" → 2026-02-16
- "Hoy" → today's date
- "Este fin de semana" or ambiguous → Ask specific date

EXTRACT TIME:
- "A las 3" or "3pm" → 15:00
- "En la tarde" → keep preference, show 14:00+
- "Temprano" or "En la mañana" → keep preference, show early times
- Just "3" → context-dependent (see SMART interpretation section above)

EXTRACT NAME:
- Usually get_user() will have it from phone
- If no phone match → User will tell you
- Store in bookingDraft.name and bookingDraft.lastName

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
✅ CORRECT FLOW EXAMPLES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

SCENARIO 1: User gives everything at once
User: "Padel mañana 3 de la tarde para Juan"
bookingDraft: sport=Padel, date=tomorrow, time_pref=tarde, name=Juan
You: [CALL get_hours] → Shows times → "Para mañana tengo 14, 15, 16, 17, 18, 19, 20, 21. ¿Cuál te late?"
User: "15"
You: "Perfecto, Padel mañana a las 15:00 ¿Confirmás?" [NO re-asking]
User: "Si"
You: [CALL confirm_booking] → "Listo Juan, ahorita te llegará la confirmación por WhatsApp"

SCENARIO 2: User needs prompting
User: "Quiero reservar"
You: "¿Para qué deporte? ¿Padel o Pickleball?"
User: "Padel para mañana"
bookingDraft: sport=Padel, date=tomorrow
You: [CALL get_hours] → "Mañana tengo: 11, 12, 13, 14, 15, 17, 18, 19, 20, 21, 22. ¿A qué hora?"
User: "En la tarde"
bookingDraft: time_pref=tarde
You: "De la tarde tengo: 14, 15, 17, 18, 19, 20, 21. ¿Cuál?"
User: "17"
You: "Listo, Padel mañana a las 17:00. ¿A qué nombre?"
User: "Carlos García"
You: [CALL confirm_booking] → "Perfecto Carlos, te llegará la confirmación por WhatsApp"

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
❌ WRONG PATTERNS (NEVER DO THESE)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

User: "Padel mañana 3 de la tarde"
❌ You: "¿Para qué deporte?" ← WRONG, user said Padel
❌ You: "¿Para qué fecha?" ← WRONG, user said mañana
❌ You: "¿A qué hora?" ← WRONG, user said 3 de la tarde

User: Shows available times [14:00, 15:00, 16:00, 17:00...]
User: "3 por favor"
❌ You: "¿3 de la mañana o de la tarde?" ← WRONG, only 15:00 exists nearby
✅ You: "Dale, 15:00 para ti" ← CORRECT, you're smart enough to know

User: Confirms ("sí", "si", "confirmo", "dale", "ok", "vale")
❌ You: "¿Estás seguro de las 15:00?" ← WRONG, already confirmed
❌ You: "¿A qué nombre?" ← WRONG if you already have it from get_user

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🛠 TOOL EXECUTION RULES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

**get_hours**:
- WHEN: You have sport + date
- WHY: To show available times to user
- SHOW: All times to user, let them choose (you do smart filtering in interpretation, not hiding)

**confirm_booking**:
- WHEN: User explicitly confirms (says "yes", "sí", "confirmo", "dale", "vale", "adelante", "ok", "listo")
- REQUIRED: sport, date, time, name
- AFTER: Say something warm like:
  - "Listo {name}, ahorita te llegará la confirmación por WhatsApp"
  - "Perfecto, en pocos minutos recibes confirmación por aquí"

**get_user**:
- WHEN: At start, if you need user's name and phone isn't matching DB
- WHY: Get stored contact info

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📝 FOR NON-BOOKING QUESTIONS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

If user asks about:
- Prices, promos, memberships → "No tengo esa info, pero la gente del club te puede ayudar"
- Rules, policies → "Eso depende del staff del club"
- Tournaments, lessons → "No puedo hacer eso por acá, fijate con el club"
- Court details, equipment → "Consulta con el staff"

Key: Be honest about your limits. Don't make up policies. Redirect professionally.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
❌ ANTI-PATTERN: WHAT WENT WRONG IN REAL CONVERSATION
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

User (turn 1): "Quiero reservar para jugar padel mañana"
✅ Bot correctly extracted: sport=Padel, date=tomorrow
✅ Bot called get_hours → showed times
✅ Bot asked "¿Cuál te gustaría?"

User (turn 2): "Para pasado mañana tienes en la tarde-noche?"
❌ PROBLEM: Bot showed times for BOTH mañana AND pasado mañana
❌ PROBLEM: Bot asked "¿Cuál prefieres para CADA DÍA?" (supporting multiple dates at once - NO!)
→ User never said they wanted mañana anymore. User pivoted to ONLY pasado mañana.

User (turn 3): "Nada más para pasado mañana a las 7"
- User said: "nada más" (nothing else) + "pasado mañana a las 7"
- This means: DISCARD mañana booking, focus on pasado mañana at 07:00
❌ WRONG: Bot misinterpreted "7" as "19:00" (said "19:00 como pediste")
→ User clearly said "7" (morning), not evening. Bot misread it.
❌ WRONG: Bot didn't understand "nada más" = user is pivoting away from mañana
→ User is now focused ONLY on pasado mañana

User (turn 4): "Si, para pasado mañana"
- This is user confirming they want pasado mañana booking
- Bot should extract: sport=Padel, date=2026-02-18 (pasado mañana), time=07:00 (from turn 3)
❌ WRONG: Bot asked "¿Te gustaría confirmar esa hora?" but never had the RIGHT hour
→ Bot thought time=19:00 (misread) so confirmation was wrong
❌ WRONG: Bot showed times YET AGAIN (for 4th time)
→ User is ready to confirm, not looking at times anymore

CORRECT FLOW WOULD BE:
Turn 1: User "Padel mañana" → bot [call get_hours] → show times
Turn 2: User "Para pasado mañana en la tarde-noche" 
        → bot understands: they're adding ANOTHER request OR pivoting
        → since user said "nada más" in next message, they're PIVOTING
Turn 3: User "Nada más para pasado mañana a las 7"
        → bot extracts: sport=Padel, date=18-Feb, time=07:00
        → bookingDraft = {sport:"Padel", date:"2026-02-18", time:"07:00", name:null}
        → bot responds: "Perfecto. ¿A qué nombre?"
Turn 4: User "Si, para pasado mañana"
        → bot should ask FOR THE NAME (since that's what's missing)
        → or if they already have name from DB, call confirm_booking immediately

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🎭 NATURAL VARIATION (NO ROBOT - SUPER IMPORTANT)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

EVERY conversation should feel different. Vary your phrasing while keeping consistency:

GREETING (first message):
- "¡Hola! ¿En qué te ayudo?"
- "¡Hola! ¿Qué necesitas?"
- "¡Hey! ¿Te puedo ayudar en algo?"
- "¡Hola! ¿Qué buscas hoy?"

ASKING FOR SPORT:
- "¿Padel o Pickleball?"
- "¿Qué deporte: Padel o Pickleball?"
- "¿Para qué deporte?"
- "¿Cuál deporte te late?"

ASKING FOR DATE (when missing):
- "¿Para qué día?"
- "¿Qué fecha?"
- "¿Cuándo quieres jugar?"
- "¿Para qué día buscas?"

ASKING FOR TIME (when ambiguous):
- "¿Qué hora te viene bien?"
- "¿A qué hora?"
- "¿Qué horario prefieres?"
- "Dime una hora"

SHOWING AVAILABLE TIMES:
- "Tengo libre: [times]. ¿Cuál te late?"
- "Estas horas están libres: [times]. ¿Cuál?"
- "Disponibilidad: [times]. ¿Cuál prefieres?"
- "Tengo: [times]. ¿Te sirve alguna?"

ASKING FOR NAME (when ready to book):
- "¿A qué nombre?"
- "¿A nombre de quién?"
- "¿Cómo te llamas?"
- "¿Tu nombre?"

FINAL CONFIRMATION (user gave all info, about to book):
- "Perfecto, Padel mañana 15:00 para [name]. ¿Confirmamos?"
- "Dale, te anoto: Padel mañana 15:00 a nombre de [name]. ¿Va?"
- "Listo: Padel mañana a las 15 para [name]. ¿Lo hago?"
- "Ok [name], Padel mañana 15:00. ¿Te parece?"

AFTER USER CONFIRMS (booking success):
- "¡Listo [name]! Ahora te llega la confirmación acá mismo"
- "¡Perfecto! En un momento recibes la confirmación"
- "¡Confirmado [name]! Te mando los detalles por acá"
- "¡Dale! Ya quedó agendado. Te llegará todo en un ratito"
- "¡Listo! Te va a llegar la confirmación por WhatsApp"

INFO RESPONSES (when user asks about services AFTER booking):
- "Sí, tenemos retas/torneos/clases. Para más info llama al club o checa el Instagram"
- "¡Claro! Hay retas/torneos/clases. Para detalles mejor contacta al club directo"
- "Sí manejamos eso. Para fechas y costos llama al +52 56 5440 7815"
- "Tenemos eso! Para info completa escribe al Instagram @blackpadelandpickleball"

NATURAL VARIATION RULES:
1. Pick DIFFERENT phrasings each time - don't repeat the same words
2. Match USER's energy: if they're casual ("we", "che"), be casual back
3. Use Mexican/Latin slang naturally: "te late?", "dale", "qué onda", "está bien?"
4. Be brief and direct - real receptionists don't write essays
5. Show enthusiasm with "!" but don't overdo it - humans use it sparingly

⚠️ CRITICAL: NO REDUNDANT CONFIRMATIONS
When you have all the info (sport, date, time, name):
❌ WRONG: "¿Te gustaría que lo reserve a nombre de Pablo Escalante?" (too wordy!)
✅ RIGHT: "Perfecto Pablo, Padel mañana 18:00. ¿Confirmamos?" (concise!)

❌ WRONG: "Tengo Padel para ti mañana a las 18:00. ¿Te gustaría confirmar?"
✅ RIGHT: "Dale, Padel mañana 18:00. ¿Lo hago?"

When user gives name, DON'T repeat it back asking "¿Quieres que lo reserve a tu nombre?"
Just confirm: "Listo Pablo, Padel mañana 18:00. ¿Va?" → [call confirm_booking when they say yes]

NATURAL VARIATION RULES:
1. CONSISTENCY: Always include key info (sport, date, time, name)
2. PERSONALITY: Vary your phrases naturally - real humans don't repeat the same words
3. CONTEXT: Shorter messages early, more detailed as conversation progresses
4. TONE: Professional but warm - "dale", "listo", "perfecto" are good. Don't say "affirmative" or "processed"
5. RANDOMNESS: On each turn, pick different phrasing from options above, don't repeat same phrase

EXAMPLE OF VARIATION (same request, different days):
Day 1:
User: "Padel mañana"
You: "¿A qué hora?"
User: "En la tarde"
You: "Tengo 14, 15, 17, 18, 19, 20, 21. ¿Cuál?"
User: "15"
You: "Perfecto, Padel mañana 15:00. ¿A qué nombre?" [confirm_booking] → "Listo Juan, ahorita confirmación por WhatsApp"

Day 2:
User: "Quiero Padel mañana"
You: "¿Qué hora?"
User: "De la tarde"
You: "De tardecita: 14, 15, 17, 18, 19, 20, 21 ¿Cuál?" 
User: "15"
You: "Dale, Padel tomorrow 15:00 ¿Confirmás?" [confirm_booking] → "Confirmado, en pocos minutos recibes confirmación acá"

BOTH conversations work. They're consistent but feel natural, not robotic.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🔮 YOUR ROLE SUMMARY
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

You are NOT a chatbot - you're an orchestrator:
- Read user's natural language
- Build a booking draft in your mind
- Decide what data is missing
- Call the right tool at the right time
- Make smart decisions (don't re-ask, interpret naturally)
- Confirm and execute

Everything lives in bookingDraft. Check it first before responding.
Everything comes from conversation understanding, not pattern matching.━

ESCENARIO 1:
User: "Padel mañana tipo las 3"
Bot: [EXTRAE: padel, mañana, pref=tarde] → [LLAMA get_hours] → Muestra: "Tengo: 14, 15, 17, 18, 19, 20, 21. ¿Cuál?"
User: "15"
Bot: "Perfecto, Padel mañana a las 15:00 ¿Confirmás?" 
User: "Si"
Bot: [LLAMA confirm_booking] → "Listo Juan, ahorita te llegará la confirmación por WhatsApp acá mismo"

ESCENARIO 2:
User: "Para hoy tipo 3"
Bot: "¿Padel o Pickleball?"
User: "Padel"
Bot: [EXTRAE: padel, hoy] → [LLAMA get_hours] → "Tengo: 11, 12, 13, 14, 15, 17, 18, 19, 20, 21, 22. Dime cuál"
User: "3"
Bot: "Dale, 15:00 hoy con Padel ¿Te parece?" [NO PreguntaS si es mañana o tarde, es obvio]
User: "Si"
Bot: [LLAMA confirm_booking] → "Confirmado. Te llegará por WhatsApp"
Bot: [LLAMA confirm_booking] ← Ya terminó, no pide nada más

SÉ NATURAL, HONESTO, Y RECUERDA TODO.`;

  // Build messages array with full conversation history from session
  const messages = [
    { role: "system", content: systemPrompt },
    // Include all session messages (accumulated conversation)
    ...(session?.messages || []).filter(m => m.role === "user" || (m.role === "assistant" && !m.tool_calls)),
    { role: "user", content: userText }
  ];

  try {
    const response = await openai.chat.completions.create({
      model: deps.config?.decideModel || "gpt-4o",
      messages,
      tools: TOOLS,
      tool_choice: "auto",  // Let AI decide when to use tools
      temperature: 0.7  // Increased for natural variation
    });

    const message = response.choices[0]?.message;
    const responseText = message.content || "";
    const toolCalls = message.tool_calls || [];
    
    // Check for escalation keywords in response
    const needsEscalation = /dame un momento para revisar|déjame verificar eso|voy a revisar|necesito consultar/i.test(responseText);

    logger?.info?.(`[AGENT] Response: ${responseText}, Tools: ${toolCalls.length}, Escalation: ${needsEscalation}`);

    return {
      response: responseText,
      toolCalls: toolCalls,
      needsEscalation: needsEscalation,
      rawMessage: message
    };
  } catch (err) {
    logger?.error?.(`[AGENT ERROR] ${err?.message || err}`);
    return {
      response: "¿Me repites, por favor?",
      toolCalls: [],
      needsEscalation: false
    };
  }
}

async function handleWhatsApp(event) {
  const msg = event.raw;
  if (!msg) return { actions: [] };

  const msgId = msg.id;
  if (msgId) {
    const firstTime = await markMessageProcessed(msgId);
    if (!firstTime) {
      logger?.info?.(`[DEDUP] Skipping duplicate message ${msgId.slice(-8)}`);
      return { actions: [] };
    }
  }

  const phone = normalizePhone(msg.from || event.phone || "");
  if (!phone) return { actions: [] };

  const text =
    msg.text?.body ||
    msg.button?.text ||
    msg.interactive?.button_reply?.title ||
    msg.interactive?.button_reply?.id ||
    msg.interactive?.list_reply?.title ||
    msg.interactive?.list_reply?.id ||
    event.text ||
    "";
  const trimmedText = text.trim();
  if (!trimmedText) {
    logger?.info?.(`[FILTER] Ignoring empty message from ${phone.slice(-4)}`);
    return { actions: [] };
  }
  const msgType = msg.type || "text";
  const isReaction = msgType === "reaction" || Boolean(msg.reaction);
  const isSticker = msgType === "sticker" || Boolean(msg.sticker);
  if (isReaction || isSticker) {
    logger?.info?.(`[FILTER] Ignoring ${msgType} from ${phone.slice(-4)}`);
    return { actions: [] };
  }
  const normalizedText = trimmedText.toLowerCase();
  const cleanText = normalizeText(trimmedText);
  const msgTs = Number(msg.timestamp || event.ts || 0);

  // Log user message in conversation history
  if (text) {
    await humanMonitor.logMessage(phone, {
      sender: "user",
      text,
      metadata: { 
        type: msg.interactive?.list_reply ? "list_reply" : 
              msg.interactive?.button_reply ? "button_reply" : "text",
        timestamp: msgTs
      }
    });
  }

  // Check if conversation is in human mode (staff takeover)
  const inHumanMode = await humanMonitor.isHumanMode(phone);
  if (inHumanMode) {
    logger?.info?.(`[HumanMode] Skipping AI processing for ${phone} - human is handling`);
    return { actions: [] };
  }

  const flowToken = await ensureFlowToken(phone);

  let session = await getSession(phone);
  const isNewSession = !session;

  if (!session) {
    session = {
      phone,
      messages: [],
      user: null,
      userLastName: null,
      userChecked: false,
      lastTs: 0,
      bookingDraft: { sport: null, date: null, time: null, duration: 1, name: null, lastName: null },
      confirmedBookings: [],
      hours: null
    };
  }
  // Ensure confirmedBookings exists for sessions created before this update
  session.confirmedBookings = session.confirmedBookings || [];
  session.phone = phone;
  session.justFetchedHours = false;

  if (msgTs && session.lastTs && msgTs < session.lastTs) {
    return { actions: [] };
  }
  if (msgTs) session.lastTs = msgTs;

  if (normalizedText === "reset") {
    const newToken = randomUUID();
    await setFlowToken(phone, newToken);
    await clearSession(phone);
    await safeSendText(phone, "Listo, reinicié la conversación.", newToken);
    return { actions: [] };
  }

  // Get user info if not already checked
  if (!session.userChecked) {
    session.user = await findUser(phone);
    if (session.user?.last_name) session.userLastName = session.user.last_name;
    session.userChecked = true;
  }

  // Add user message to conversation history for AI context
  session.messages = session.messages || [];
  session.messages.push({ role: "user", content: text });

  // AI orchestrates everything from this point
  const decision = await agentDecide(phone, text, session);
  logger?.info?.(`[AGENT] Response excerpt: "${decision.response?.substring(0, 100)}", Tools: ${decision.toolCalls?.length || 0}`);

  // Save assistant response to conversation history for next turns
  if (decision.response) {
    session.messages.push({ role: "assistant", content: decision.response });
  }

  // Handle escalation immediately
  if (decision.needsEscalation) {
    await safeSendText(phone, decision.response || "Dame un momento para revisar...", flowToken);
    try {
      await humanMonitor.escalateToHuman(phone, "subtle_escalation", config.escalationWebhook);
      logger?.info?.(`[SUBTLE ESCALATION] Escalated: ${phone}`);
    } catch (escalErr) {
      logger?.error?.(`[SUBTLE ESCALATION ERROR] ${escalErr.message}`);
    }
    await saveSession(phone, session);
    return { actions: [] };
  }

  // Process tool calls - simplified execution with agentic loop
  if (decision.toolCalls && decision.toolCalls.length > 0) {
    const toolResults = [];
    
    for (const toolCall of decision.toolCalls) {
      const toolName = toolCall.function.name;
      let args;
      try {
        args = JSON.parse(toolCall.function.arguments);
      } catch (parseErr) {
        logger?.error?.(`[TOOL] Parse error for ${toolName}: ${parseErr.message}`);
        continue;
      }

      logger?.info?.(`[TOOL] Executing: ${toolName}`);

      if (toolName === "get_user") {
        const userInfo = await findUser(args.phone || phone);
        session.user = userInfo;
        if (userInfo?.last_name) session.userLastName = userInfo.last_name;
        logger?.info?.(`[TOOL] get_user: ${userInfo?.name || 'not found'}`);
        toolResults.push({
          toolName,
          result: userInfo ? `User found: ${userInfo.name}` : "User not found"
        });
      }

      else if (toolName === "get_hours") {
        const sport = args.sport || session.bookingDraft.sport;
        const date = args.date || session.bookingDraft.date;

          if (!sport || !date) {
            toolResults.push({ toolName, result: "Missing sport or date for availability check" });
            continue;
          }

          try {
            const slots = await getAvailableHours(date, sport);
            const options = buildOptions(slots, 1);
            let timesList = startTimesFromOptions(options);

            session.slots = slots;
            session.options = options;
            session.hours = timesList;
            session.bookingDraft.sport = sport;
            session.bookingDraft.date = date;

            const result = timesList.length > 0 
              ? `Available times for ${sport} on ${formatDateEs(date)}: ${timesList.join(", ")}`
              : `No availability for ${sport} on ${formatDateEs(date)}`;

            toolResults.push({ toolName, result });
          } catch (err) {
            toolResults.push({ toolName, result: `Error fetching times: ${err.message}` });
          }
        }

        else if (toolName === "confirm_booking") {
          const bookingSport = args.sport || session.bookingDraft.sport;
          const bookingDate = args.date || session.bookingDraft.date;
          const bookingTime = args.time;
          const bookingName = args.name;
          const bookingLastName = args.last_name || "";

          if (!bookingSport || !bookingDate || !bookingTime || !bookingName) {
            toolResults.push({
              toolName,
              result: "Cannot confirm: missing sport, date, time, or name"
            });
            continue;
          }

          try {
            if (!session.options?.length) {
              const slots = await getAvailableHours(bookingDate, bookingSport);
              session.options = buildOptions(slots, 1);
            }

            const match = session.options.find(o => o.start === bookingTime);
            if (!match) {
              const suggestions = startTimesFromOptions(session.options).slice(0, 3);
              toolResults.push({
                toolName,
                result: `Time ${bookingTime} unavailable. Try: ${suggestions.join(", ")}`
              });
              continue;
            }

            await confirmBooking(
              phone,
              bookingDate,
              match.times,
              match.court,
              bookingName,
              bookingLastName,
              session.user?.id,
              bookingSport,
              session.user?.found ? "usuario" : "invitado"
            );

            logger?.info?.(`[BOOKING] Confirmed: ${bookingName} - ${bookingSport} on ${bookingDate}`);
            
            // Add to confirmed bookings instead of clearing session
            session.confirmedBookings = session.confirmedBookings || [];
            session.confirmedBookings.push({
              sport: bookingSport,
              date: bookingDate,
              time: bookingTime,
              name: bookingName,
              lastName: bookingLastName,
              confirmedAt: new Date().toISOString(),
              status: "confirmed"
            });
            
            // Clear only the booking draft, keep user context
            session.bookingDraft = { sport: null, date: null, time: null, duration: 1, name: null, lastName: null };
            session.hours = null;
            session.slots = null;
            session.options = null;
            
            await saveSession(phone, session);
            
            // Archive for analytics but DON'T clear session
            await humanMonitor.archiveConversation(phone, {
              userName: bookingName,
              userLastName: bookingLastName,
              sport: bookingSport,
              date: bookingDate,
              time: bookingTime,
              bookingStatus: "confirmed"
            }).catch(err => logger?.warn?.(`Archive failed: ${err.message}`));
            
            toolResults.push({
              toolName,
              result: `Booking confirmed! ${bookingSport} on ${formatDateEs(bookingDate)} at ${bookingTime} for ${bookingName}. User can now ask about other services.`
            });
          } catch (err) {
            logger?.error?.(`[BOOKING ERROR] ${err.message}`);
            toolResults.push({
              toolName,
              result: `Booking failed: ${err.message}`
            });
          }
        }
      }

      // AGENTIC LOOP: Feed tool results back to AI
      if (toolResults.length > 0) {
        const resultsText = toolResults
          .map(tr => `[${tr.toolName}]: ${tr.result}`)
          .join("\n");

        logger?.info?.(`[AGENTIC] Feeding results back to AI:\n${resultsText}`);
        logger?.info?.(`[AGENTIC] Session state: sport=${session.bookingDraft.sport}, date=${session.bookingDraft.date}, hours=[${session.hours?.join(", ")}], user=${session.user?.name}`);

        const followUpDecision = await agentDecide(
          phone,
          `Tool results:\n${resultsText}\n\nContinue the conversation naturally based on these results.`,
          session
        );

        if (followUpDecision.response) {
          await safeSendText(phone, followUpDecision.response, flowToken);
        }

        if (followUpDecision.toolCalls?.length > 0) {
          logger?.info?.(`[AGENTIC] AI wants to use ${followUpDecision.toolCalls.length} more tool(s)`);
          for (const toolCall of followUpDecision.toolCalls) {
            const toolName = toolCall.function.name;
            let followUpArgs;
            try {
              followUpArgs = JSON.parse(toolCall.function.arguments);
            } catch (err) {
              logger?.error?.(`[TOOL] Parse error: ${err.message}`);
              continue;
            }

            if (toolName === "confirm_booking" && followUpArgs.time && followUpArgs.name) {
              const sport = followUpArgs.sport || session.bookingDraft.sport;
              const date = followUpArgs.date || session.bookingDraft.date;
              const time = followUpArgs.time;
              const name = followUpArgs.name;
              const lastName = followUpArgs.last_name || "";

              if (!session.options?.length) {
                const slots = await getAvailableHours(date, sport);
                session.options = buildOptions(slots, 1);
              }

              const match = session.options.find(o => o.start === time);
              if (match) {
                try {
                  await confirmBooking(
                    phone, date, match.times, match.court,
                    name, lastName,
                    session.user?.id, sport,
                    session.user?.found ? "usuario" : "invitado"
                  );

                  // Add to confirmed bookings
                  session.confirmedBookings = session.confirmedBookings || [];
                  session.confirmedBookings.push({
                    sport,
                    date,
                    time,
                    name,
                    lastName,
                    confirmedAt: new Date().toISOString(),
                    status: "confirmed"
                  });
                  
                  // Clear only booking draft
                  session.bookingDraft = { sport: null, date: null, time: null, duration: 1, name: null, lastName: null };
                  session.hours = null;
                  await saveSession(phone, session);
                  
                  await safeSendText(phone, `¡Listo! Te llegará la confirmación por WhatsApp.`, flowToken);
                } catch (bookErr) {
                  logger?.error?.(`[BOOKING ERROR] ${bookErr.message}`);
                  await safeSendText(phone, `No pude confirmar. ¿Quieres intentar otra hora?`, flowToken);
                }
              }
            }
          }
        }

        await saveSession(phone, session);
        return { actions: [] };
      }
    }

  // Send AI response if there is one and no tools were called
  if (decision.response && (!decision.toolCalls || decision.toolCalls.length === 0)) {
    // Check if response is about location
    const isLocationResponse = /ubicaci[óo]n|direcci[óo]n|d[óo]nde|mapa/i.test(decision.response);
    if (isLocationResponse) {
      await safeSendText(phone, decision.response, flowToken);
      await safeSendLocation(
        phone,
        CLUB_INFO.location.latitude,
        CLUB_INFO.location.longitude,
        CLUB_INFO.name,
        CLUB_INFO.location.address,
        flowToken
      );
    } else {
      await safeSendText(phone, decision.response, flowToken);
    }
    await saveSession(phone, session);
    return { actions: [] };
  }

  // If we get here with no response and no tools, fallback
  await saveSession(phone, session);
  return { actions: [] };
}

export default { init, handleIncoming };
