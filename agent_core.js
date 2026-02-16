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
            enum: ["Padel", "Pickleball"],
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

const parseDayMonth = t => {
  const m = t.match(/\b(\d{1,2})\s+de\s+([a-z]+)(?:\s+de\s+(\d{4}))?\b/);
  if (!m) return null;
  const day = Number(m[1]);
  const monthName = m[2];
  const month = MONTH_INDEX[monthName];
  if (!month) return null;
  const year = m[3] ? Number(m[3]) : null;
  return { day, month, year };
};

const parseRelativeDays = t => {
  const m = t.match(/\ben\s+(\d+|[a-z]+)\s+dias?\b/);
  if (!m) return null;
  const raw = m[1];
  const n = Number.isNaN(Number(raw)) ? SPANISH_NUMBERS[raw] : Number(raw);
  return Number.isFinite(n) ? n : null;
};

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

const resolveDate = text => {
  const t = normalizeText(text || "");
  const { dateStr, weekdayIndex } = getMexicoDateParts();
  const base = new Date(`${dateStr}T00:00:00Z`);

  if (t.includes("hoy")) return dateStr;
  if (t.includes("manana")) {
    const d = new Date(base);
    d.setUTCDate(d.getUTCDate() + 1);
    return d.toISOString().slice(0, 10);
  }

  const relDays = parseRelativeDays(t);
  if (relDays) {
    const d = new Date(base);
    d.setUTCDate(d.getUTCDate() + relDays);
    return d.toISOString().slice(0, 10);
  }

  const dayMonth = parseDayMonth(t);
  if (dayMonth) {
    const { day, month, year } = dayMonth;
    const { dateStr: todayStr } = getMexicoDateParts();
    const [ty, tm, td] = todayStr.split("-").map(Number);
    let y = year || ty;
    const candidate = new Date(Date.UTC(y, month - 1, day));
    const today = new Date(Date.UTC(ty, tm - 1, td));
    if (!year && candidate < today) {
      y += 1;
    }
    return new Date(Date.UTC(y, month - 1, day)).toISOString().slice(0, 10);
  }

  for (const [day, idx] of Object.entries(WEEKDAY_INDEX)) {
    if (t.includes(day)) {
      let delta = (idx - weekdayIndex + 7) % 7;
      if (delta === 0 && /proxim|siguiente/.test(t)) delta = 7;
      const d = new Date(base);
      d.setUTCDate(d.getUTCDate() + delta);
      return d.toISOString().slice(0, 10);
    }
  }

  return null;
};

const toBubbleDate = dateStr => {
  if (!dateStr) return null;
  if (dateStr.includes("T")) return dateStr;
  return `${dateStr}T00:00:00Z`;
};

// Extract time from text, returns {time, isAmbiguous}
// isAmbiguous=true means user said a bare number like "10" that could be AM or PM
const extractTime = text => {
  const t = normalizeText(text || "");
  if (/\bde\s+(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre)\b/.test(t)) {
    return { time: null, isAmbiguous: false };
  }
  // Look for explicit HH:MM format
  const m = (text || "").match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);
  if (m) {
    const hh = m[1].padStart(2, "0");
    const mm = m[2];
    return { time: `${hh}:${mm}`, isAmbiguous: false };
  }
  // Look for (a) las NUMBER [am/pm]
  const m2 = (text || "").match(/\b(?:a\s+las\s+)?([01]?\d|2[0-3])\s*(am|pm|de\s+la\s+(?:mañana|tarde|noche))?\b/i);
  if (!m2) return { time: null, isAmbiguous: false };
  let hour = Number(m2[1]);
  const mer = (m2[2] || "").toLowerCase();
  const isAmbiguous = !mer; // No AM/PM/mañana/tarde specified = ambiguous
  
  // Parse meridiem indicator
  if (mer.includes("pm") || mer.includes("tarde")) {
    if (hour < 12) hour += 12;
  } else if (mer.includes("am") || mer.includes("mañana") || mer.includes("madrugada")) {
    if (hour === 12) hour = 0;
  } else if (!mer && hour >= 1 && hour <= 11) {
    // No meridiem = ambiguous (could be 1am or 1pm)
    // Will ask user to clarify
  }
  return { time: `${String(hour).padStart(2, "0")}:00`, isAmbiguous };
};

const extractSport = text => {
  const t = normalizeText(text || "");
  if (t.includes("pickle")) return "Pickleball";
  if (t.includes("golf")) return "Golf";
  if (t.includes("padel") || t.includes("paddel") || t.includes("pádel")) return "Padel";
  return null;
};

const extractDuration = text => {
  const t = normalizeText(text || "");
  const m = t.match(/\b(\d+)\s*hora/);
  if (m) return Number(m[1]);
  if (t.includes("una hora")) return 1;
  if (t.includes("dos horas")) return 2;
  if (t.includes("tres horas")) return 3;
  return null;
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
  
  // Build context from current session
  const sessionContext = {
    user_name: session?.user?.name || null,
    last_name: session?.userLastName || null,
    sport: session?.sport || null,
    date: session?.date || null,
    desired_time: session?.desiredTime || null,
    available_times: session?.hours || [],
    duration_hours: session?.duration || 1
  };
  
  // Get conversation history from Redis for context awareness
  const conversationHistory = await getConversationHistory(phone, 10);
  
  const systemPrompt = `Eres Michelle, recepcionista humana de Black Padel & Pickleball. Tu trabajo es hacer reservas de manera natural, como lo haría una persona real.

INFORMACIÓN DEL CLUB:
- Nombre: Black Padel & Pickleball
- Dirección: P.º de los Sauces Manzana 007, San Gaspar Tlahuelilpan, Estado de México
- Horarios: Lunes a viernes 7:00-22:00, Sábado y domingo 8:00-15:00
- Deportes: Padel, Pickleball
- Contacto: WhatsApp +52 56 5440 7815 (donde estás)

HOY ES: ${dateStr}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
⚠️ REGLA CRÍTICA DE MEMORIA (LEE ESTO PRIMERO) ⚠️
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

ANTES de responder CUALQUIER cosa:
1. LEE TODOS los mensajes anteriores arriba
2. EXTRAE toda la información que el usuario YA dio:
   - ¿Ya dijo el deporte? (Padel/Pickleball)
   - ¿Ya dijo la fecha? (mañana/16/sábado/etc)
   - ¿Ya dijo la hora? (3pm/15:00/en la tarde)
   - ¿Ya dijo el nombre?

3. NUNCA vuelvas a preguntar información que YA tienes

EJEMPLO CORRECTO:
User: "Quiero reservar mañana"
Tú: ¿Para qué deporte?
User: "Padel en la tarde"
Tú: [RECUERDAS: deporte=Padel, fecha=mañana, preferencia=tarde]
     [LLAMAS: get_hours(sport="Padel", date=mañana)]
     "Para Padel mañana tengo: 14:00, 15:00, 16:00..."

EJEMPLO INCORRECTO (NO HAGAS ESTO):
User: "Quiero reservar mañana"
Tú: ¿Para qué deporte?
User: "Padel en la tarde"  
Tú: ¿Para qué fecha? ❌ ← USUARIO YA DIJO "MAÑANA"

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

SESIÓN ACTUAL (datos ya capturados):
${JSON.stringify(sessionContext, null, 2)}

⚠️ HORARIOS DISPONIBLES - REGLA IMPORTANTE:
Si ya MOSTRASTE una lista de horarios disponibles, y el usuario dice una hora:
1. Mira la lista que YA mostraste (session.available_times)
2. Interpreta lo que el usuario dijo usando esa lista:
   - Usuario dice "3" + disponibles tiene "15:00" → ES 15:00
   - Usuario dice "11" + disponibles tiene "11:00" → ES 11:00
   - Usuario dice "tarde" → filtra horarios >= 14:00
   - SOLO pregunta "¿mañana o tarde?" si REALMENTE hay ambigüedad después de checar la lista
3. Presenta la hora con claridad: "Perfecto, 15:00 (3 de la tarde)"
4. NUNCA re-muestres los horarios que ya mostraste

EXTRACCIÓN DE DATOS DEL USUARIO:
- "mañana" → fecha = día siguiente (${dateStr})
- "Padel" o "Pickleball" → deporte
- "en la tarde" → preferencia de horario (14:00+)
- "en la mañana" → preferencia de horario (<14:00)
- "a las 3" o "las 3" → 15:00 (3pm)
- "el 16" → fecha = 2026-02-16
- Solo un número (9, 14, etc) → hora en formato 24h (NOTA: si es ambiguo, pregunta "¿9 de la mañana o de la noche?")

CUÁNDO USAR HERRAMIENTAS:
- **get_hours**: Cuando tengas deporte + fecha → úsala INMEDIATAMENTE, no preguntes más
- **confirm_booking**: INMEDIATAMENTE cuando:
  - Usuario dice "sí", "si", "confirmo", "confir", "yes", "vale", "listo", "adelante"
  - Tengas: sport, date, time, name
  - NO necesitas preguntar más después - solo llama el tool y el sistema responde

TOOLS DISPONIBLES:
- get_hours, confirm_booking, get_user

NO tenemos tools para: promociones, torneos, clases, información de políticas, etc.
Si preguntan algo que no puedes resolver con los tools disponibles, sé honesto:
❌ NO DIGAS: "Te recomendaría que te pongas en contacto"
✅ SÍ DI: "No tengo información sobre eso, pero los chicos del staff sabrían"

FLUJO NATURAL (como humano):
1. Usuario pide reserva
2. Si falta deporte → pregunta
3. Si falta fecha → pregunta  
4. En cuanto tengas deporte + fecha → LLAMA get_hours AUTOMÁTICAMENTE
5. Muestra horarios disponibles
6. Usuario elige hora → pregunta confirmación CON CLARIFICACIÓN si es ambiguo
7. Usuario dice "sí" → LLAMA confirm_booking (NO re-preg asuntos que ya confirmó)

REGLA DE CONFIRMACIÓN:
- Si usuario ya confirmó una hora específica → NO vuelvas a preguntar la hora
- Si usuario ya dio deporte → NO vuelvas a preguntar el deporte
- Si usuario dice "si" o "confirmo" → va directo a confirm_booking

NUNCA DIGAS:
❌ "Voy a revisar"
❌ "Déjame consultar"
❌ "¿Para qué fecha?" (si ya dijeron la fecha)
❌ "¿Qué deporte?" (si ya dijeron el deporte)
❌ "¿A qué hora?" (si ya dijeron la hora)
❌ "Te recomendaría que te pongas en contacto con..."
❌ Repetir confirmaciones que ya hiciste

ANTI-PATRÓN (NUNCA HAGAS ESTO):
User: "3 de la tarde"
Bot: "¿Quieres 15:00?"
User: "Si"
Bot: "¿Estás seguro de 15:00?" ← MALA, ya confirmó
Bot: "¿A qué hora?" ← TERRIBLE, acaba de decir la hora

PATRÓN CORRECTO:
User: "3 de la tarde"
Bot: "¿Confirmó 15:00 para hoy?"
User: "Si"
Bot: [LLAMA confirm_booking] ← Ya terminó, no pide nada más

SÉ NATURAL, HONESTO, Y RECUERDA TODO.`;

  const messages = [
    { role: "system", content: systemPrompt },
    ...conversationHistory,  // Include full conversation history
    { role: "user", content: userText }
  ];

  try {
    const response = await openai.chat.completions.create({
      model: deps.config?.decideModel || "gpt-4o",
      messages,
      tools: TOOLS,
      tool_choice: "auto",  // Let AI decide when to use tools
      temperature: 0.3
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
    if (!firstTime) return { actions: [] };
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
  const normalizedText = text.trim().toLowerCase();
  const cleanText = normalizeText(text);
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
      date: null,
      hours: null,
      slots: [],
      options: [],
      hoursSent: false,
      pendingTime: null,
      pendingConfirm: null,
      pendingConfirmDraft: null,
      justFetchedHours: false,
      desiredTime: null,
      sport: null,
      duration: 1,
      awaitingSport: false,
      awaitingDate: false,
      awaitingTime: false,
      awaitingDuration: false,
      awaitingName: false,
      noAvailabilityDate: null,
      userChecked: false,
      lastTs: 0
    };
  }
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

  // SMART EXTRACTION: Parse user input to update session BEFORE AI sees it
  // This ensures AI gets fresh context with what user just said
  
  // Extract date
  const parsedDate = resolveDate(text);
  if (parsedDate) {
    session.date = parsedDate;
  }
  
  // Extract sport
  const parsedSport = extractSport(text);
  if (parsedSport) {
    session.sport = parsedSport;
  }
  
  // Extract duration  
  const parsedDuration = extractDuration(text);
  if (parsedDuration) {
    session.duration = parsedDuration;
  }
  
  // Extract name (if it's after we asked for it - check for multi-word input)
  if (session.awaitingName && text.trim().split(/\s+/).length >= 1) {
    const fullName = text.trim().split(/\s+/).filter(Boolean);
    if (fullName.length) {
      session.user = session.user || { found: false };
      session.user.name = fullName.shift();
      session.userLastName = fullName.join(" ");
    }
  }

  // Call agent with tool-based architecture - AI sees fresh session with extracted data
  const decision = await agentDecide(phone, text, session);
  logger?.info?.(`[AGENT] Response excerpt: "${decision.response?.substring(0, 100)}", Tools: ${decision.toolCalls?.length || 0}`);

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
        const sport = args.sport || session.sport;
          const date = args.date || session.date;

          if (!sport || !date) {
            toolResults.push({ toolName, result: "Missing sport or date for availability check" });
            continue;
          }

          try {
            const slots = await getAvailableHours(date, sport);
            const options = buildOptions(slots, 1);
            const timesList = startTimesFromOptions(options);

            session.slots = slots;
            session.options = options;
            session.hours = timesList;  // IMPORTANT: Store hours so AI can use them
            session.sport = sport;
            session.date = date;

            const result = timesList.length > 0 
              ? `Available times for ${sport} on ${formatDateEs(date)}: ${timesList.join(", ")}`
              : `No availability for ${sport} on ${formatDateEs(date)}`;

            toolResults.push({ toolName, result });
          } catch (err) {
            toolResults.push({ toolName, result: `Error fetching times: ${err.message}` });
          }
        }

        else if (toolName === "confirm_booking") {
          const bookingSport = args.sport || session.sport;
          const bookingDate = args.date || session.date;
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
            toolResults.push({
              toolName,
              result: `Booking confirmed! ${bookingSport} on ${formatDateEs(bookingDate)} at ${bookingTime} for ${bookingName}`
            });

            await clearSessionWithArchive(phone, {
              userName: bookingName,
              userLastName: bookingLastName,
              sport: bookingSport,
              date: bookingDate,
              time: bookingTime,
              bookingStatus: "confirmed"
            }, true);
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
        logger?.info?.(`[AGENTIC] Session state: sport=${session.sport}, date=${session.date}, hours=[${session.hours?.join(", ")}], user=${session.user?.name}`);

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
              const sport = followUpArgs.sport || session.sport;
              const date = followUpArgs.date || session.date;
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

                  await safeSendText(phone, `¡Listo! Te llegará la confirmación por WhatsApp.`, flowToken);
                  await clearSessionWithArchive(phone, {
                    userName: name,
                    userLastName: lastName,
                    sport,
                    date,
                    time,
                    bookingStatus: "confirmed"
                  }, true);
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
