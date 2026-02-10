import axios from "axios";
import { randomUUID } from "crypto";

let deps = {};
let openai;
let redis;
let senders;
let logger;
let config;

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
      description: "Buscar usuario por teléfono para obtener nombre.",
      parameters: {
        type: "object",
        properties: { phone: { type: "string" } },
        required: ["phone"],
        additionalProperties: false
      }
    }
  },
  {
    type: "function",
    function: {
      name: "get_hours",
      description: "Obtener horarios disponibles para una fecha.",
      parameters: {
        type: "object",
        properties: {
          date: { type: "string", description: "YYYY-MM-DD" },
          sport: { type: "string" }
        },
        required: ["date"],
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
    staffPhone: deps.config?.staffPhone
  };
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

const SYSTEM_MESSAGE = {
  role: "system",
  content: `
Eres Michelle, recepcionista humana de Black Padel, Pickleball & Golf (México).

REGLAS DURAS:
- NO repitas saludos
- NO inventes información
- NO respondas programación, código, temas técnicos, ilegales o fuera del club
- Si preguntan algo fuera del club, responde educadamente que solo ayudas con temas del club
- Si ya hay fecha, NO la pidas otra vez
- Si ya hay horarios, NO preguntes horas
- Si necesitas datos, pregunta de forma breve y natural
- Si el usuario quiere reservar, pide solo lo mínimo (deporte, fecha, hora, duración)
- Si la pregunta NO es de reserva, responde directo sin pedir deporte/fecha

HERRAMIENTAS:
- get_user: obtener nombre del cliente por teléfono
- get_hours: horarios disponibles por fecha

Usa herramientas cuando ayuden. Si no tienes información, dilo.
Responde en español, corto y claro.
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

const extractTime = text => {
  const t = normalizeText(text || "");
  if (/\bde\s+(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre)\b/.test(t)) {
    return null;
  }
  const m = (text || "").match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);
  if (m) {
    const hh = m[1].padStart(2, "0");
    const mm = m[2];
    return `${hh}:${mm}`;
  }
  const m2 = (text || "").match(/\b(?:a\s+las\s+)?([01]?\d|2[0-3])\s*(am|pm)?\b/i);
  if (!m2) return null;
  let hour = Number(m2[1]);
  const mer = (m2[2] || "").toLowerCase();
  if (mer === "pm" && hour < 12) hour += 12;
  if (mer === "am" && hour === 12) hour = 0;
  return `${String(hour).padStart(2, "0")}:00`;
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

const startTimesFromOptions = options => uniqueStarts(options).map(o => o.start);

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

async function findUser(phone) {
  const r = await bubbleRequest("get", "/get_user", { params: { phone } });
  return r.data?.response || { found: false };
}

async function getAvailableHours(date, desiredSport) {
  const bubbleDate = toBubbleDate(date);
  const { hour } = getMexicoDateParts();
  const currentTimeNumber = hour;
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
    await bubbleRequest("post", `/${config.confirmEndpoint}`, { data: withUser });
  } catch (err) {
    logger?.error?.("confirmBooking failed", {
      baseURL: config.bubbleBaseUrl,
      url: err?.config?.url,
      method: err?.config?.method,
      statusCode: err?.response?.status,
      data: err?.response?.data
    });
    if (userId) {
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
      model: deps.config?.interpretModel || "gpt-4.1-mini",
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
- duration: ${session.duration || 1}`
    },
    ...session.messages.filter(m => m.role === "user" || (m.role === "assistant" && !m.tool_calls))
  ];

  const messages = [...context, { role: "user", content: userText }];
  let finalText = null;
  let guard = 0;

  while (!finalText && guard < 4) {
    guard += 1;
    const response = await openai.chat.completions.create({
      model: deps.config?.agentModel || "gpt-4.1-mini",
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

async function agentDecide(session, userText) {
  if (!openai) return { action: "reply", message: "¿Me repites, por favor?", params: {} };
  const { dateStr } = getMexicoDateParts();
  const system = `
Eres Michelle, recepcionista humana de Black Padel, Pickleball & Golf.
Devuelve SOLO JSON válido con este esquema:
{
  "action": "ask|reply|get_user|get_hours|confirm_reserva|reset_availability|noop",
  "message": "texto para el usuario",
  "params": {
    "sport": "Padel|Pickleball|Golf|null",
    "date": "YYYY-MM-DD|null",
    "time": "HH:MM|null",
    "duration_hours": 1|2|3|null,
    "name": "string|null",
    "last_name": "string|null"
  }
}
Reglas:
- Si el usuario pregunta algo general (no reserva), responde con action=reply.
- Si falta info para reservar, usa action=ask.
- Si ya hay datos suficientes, usa get_hours o confirm_reserva.
- No vuelvas a pedir datos que ya están en contexto.
- Si el usuario ya dio deporte/fecha/hora en el mensaje, úsalo en params.
- Usa fecha relativa en MX; hoy es ${dateStr}.
`;
  const context = {
    user: session.user || null,
    last_name: session.userLastName || null,
    sport: session.sport || null,
    date: session.date || null,
    desired_time: session.desiredTime || null,
    duration_hours: session.duration || 1,
    available_starts: startTimesFromOptions(session.options || []),
    has_options: Boolean(session.options?.length)
  };
  const messages = [
    { role: "system", content: system },
    { role: "system", content: `Contexto: ${JSON.stringify(context)}` },
    { role: "user", content: userText }
  ];
  try {
    const resp = await openai.chat.completions.create({
      model: deps.config?.decideModel || "gpt-4.1-mini",
      messages,
      temperature: 0.2,
      response_format: { type: "json_object" }
    });
    const content = resp.choices[0]?.message?.content || "{}";
    return JSON.parse(content);
  } catch {
    return { action: "reply", message: "¿Me repites, por favor?", params: {} };
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
    event.text ||
    "";
  const normalizedText = text.trim().toLowerCase();
  const cleanText = normalizeText(text);
  const msgTs = Number(msg.timestamp || event.ts || 0);

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
      justFetchedHours: false,
      desiredTime: null,
      sport: null,
      duration: 1,
      awaitingSport: false,
      awaitingDate: false,
      awaitingTime: false,
      awaitingDuration: false,
      noAvailabilityDate: null,
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

  if (config.useAgent) {
    const decision = await agentDecide(session, text);
    const params = decision.params || {};
    if (params.sport) session.sport = params.sport;
    if (params.date) session.date = params.date;
    if (params.time) session.desiredTime = params.time;
    if (params.duration_hours) session.duration = params.duration_hours;
    if (params.name) {
      session.user = session.user || { found: false };
      session.user.name = params.name;
    }
    if (params.last_name) session.userLastName = params.last_name;

    const interpretation = null;
    const confidence = computeConfidence(decision, interpretation, session);
    await logEvent("decision", { action: decision.action, confidence, phone });

    if (confidence < 0.45) {
      session.awaitingHuman = true;
      await escalateToHuman(phone, "low_confidence", session);
      await safeSendText(phone, "No estoy segura de eso. ¿Quieres que te pase con un agente humano?", flowToken);
      await saveSession(phone, session);
      return { actions: [] };
    }

    const missingSport = !session.sport;
    const missingDate = !session.date;
    const missingTime = !session.desiredTime;

    if (decision.action === "ask" && !missingSport && !missingDate) {
      decision.action = "get_hours";
    }

    if (decision.action === "get_user") {
      session.user = await findUser(phone);
      if (session.user?.last_name) session.userLastName = session.user.last_name;
    }

    if (decision.action === "get_hours") {
      if (!session.sport || !session.date) {
        const ask = decision.message || "¿Para qué deporte y fecha?";
        await safeSendText(phone, ask, flowToken);
        await saveSession(phone, session);
        return { actions: [] };
      }
      const slots = await getAvailableHours(session.date, session.sport);
      session.slots = slots;
      session.options = buildOptions(slots, session.duration || 1);
      session.hours = startTimesFromOptions(session.options);
      const suggestions = pickClosestOptions(session.options, session.desiredTime);
      const buttons = suggestions.map(o => ({
        type: "reply",
        reply: { id: o.start, title: o.start }
      }));
      await safeSendButtons(
        phone,
        decision.message || "Estos son los horarios disponibles. Elige uno:",
        buttons,
        flowToken
      );
      await saveSession(phone, session);
      return { actions: [] };
    }

    if (decision.action === "confirm_reserva") {
      const match = session.options?.find(o => o.start === session.desiredTime);
      if (!match) {
        await safeSendText(phone, "No tengo ese horario. ¿Quieres otra hora?", flowToken);
        await saveSession(phone, session);
        return { actions: [] };
      }
      const name = params.name || session.user?.name || "Cliente";
      const lastName = params.last_name || session.userLastName || "";
      await safeSendText(phone, decision.message || "Perfecto, estoy confirmando tu reserva…", flowToken);
      try {
        await confirmBooking(
          phone,
          session.date,
          match.times,
          match.court,
          name,
          lastName,
          session.user?.id,
          session.sport,
          session.user?.found ? "usuario" : "invitado"
        );
        await safeSendText(phone, "¡Listo! Te llegará la confirmación por WhatsApp.", flowToken);
        await clearSession(phone);
      } catch (err) {
        const slots = await getAvailableHours(session.date, session.sport);
        session.slots = slots;
        session.options = buildOptions(slots, session.duration || 1);
        session.hours = startTimesFromOptions(session.options);
        const suggestions = pickClosestOptions(session.options || [], session.desiredTime);
        if (suggestions.length) {
          const buttons = suggestions.map(o => ({
            type: "reply",
            reply: { id: o.start, title: o.start }
          }));
          await safeSendButtons(
            phone,
            "No pude confirmar. Te puedo ofrecer:",
            buttons,
            flowToken
          );
        } else {
          await safeSendText(phone, "No pude confirmar la reserva. ¿Quieres intentar otra hora?", flowToken);
        }
        await saveSession(phone, session);
      }
      return { actions: [] };
    }

    if (decision.action === "ask") {
      const ask =
        decision.message ||
        (missingSport && missingDate
          ? "¿Para qué deporte y fecha?"
          : missingSport
            ? "¿Para qué deporte quieres reservar?"
            : missingDate
              ? "¿Para qué fecha te gustaría reservar?"
              : missingTime
                ? "¿A qué hora te gustaría reservar?"
                : "¿Me ayudas con un dato más?");
      await safeSendText(phone, ask, flowToken);
      await saveSession(phone, session);
      return { actions: [] };
    }

    if (decision.action === "reply") {
      await safeSendText(phone, decision.message || "¿Te ayudo con algo más?", flowToken);
      await saveSession(phone, session);
      return { actions: [] };
    }
  }

  const interpretation =
    !session.pendingConfirm && !session.pendingTime ? await interpretMessage(session, text) : null;

  const prevDate = session.date;
  const prevSport = session.sport;
  const parsedDate = interpretation?.date || resolveDate(text);
  if (parsedDate) {
    session.date = parsedDate;
    session.awaitingDate = false;
    session.noAvailabilityDate = null;
    if (prevDate && parsedDate !== prevDate) {
      session.slots = [];
      session.options = [];
      session.hours = null;
    }
  }
  const parsedSport = interpretation?.sport || extractSport(text);
  if (parsedSport) {
    session.sport = parsedSport;
    session.awaitingSport = false;
    if (prevSport && parsedSport !== prevSport) {
      session.slots = [];
      session.options = [];
      session.hours = null;
    }
    if (!session.date) {
      session.awaitingDate = true;
      const ask = interpretation?.reply || "¿Para qué fecha te gustaría reservar?";
      await safeSendText(phone, ask, flowToken);
      await saveSession(phone, session);
      return { actions: [] };
    }
  }
  const parsedDuration = interpretation?.duration || extractDuration(text);
  if (parsedDuration) {
    session.duration = parsedDuration;
    session.awaitingDuration = false;
  }
  const earlyTimeCandidate = interpretation?.time || extractTime(text);
  if (earlyTimeCandidate) {
    session.desiredTime = earlyTimeCandidate;
    session.awaitingTime = false;
  }
  if (interpretation?.name) {
    session.user = session.user || { found: false };
    session.user.name = interpretation.name;
  }
  if (interpretation?.last_name) {
    session.userLastName = interpretation.last_name;
  }
  if (session.duration > 3) {
    session.duration = 3;
    await safeSendText(phone, "El máximo es 3 horas. ¿Te parece 3 horas?", flowToken);
    await saveSession(phone, session);
    return { actions: [] };
  }
  if (parsedDuration && session.slots?.length) {
    session.options = buildOptions(session.slots, session.duration || 1);
    session.hours = startTimesFromOptions(session.options);
  }

  if (!session.user && (hasBookingIntent(cleanText) || session.date || session.pendingTime || session.pendingConfirm)) {
    session.user = await findUser(phone);
    if (session.user?.last_name) session.userLastName = session.user.last_name;
  }

  if (!interpretation && isNameQuestion(cleanText)) {
    await safeSendText(phone, "Soy Michelle, recepcionista del club. ¿En qué te ayudo?", flowToken);
    await saveSession(phone, session);
    return { actions: [] };
  }

  if (!interpretation && isLateQuestion(cleanText)) {
    await safeSendText(
      phone,
      "Gracias por avisar. Si vas a llegar tarde, avísanos por aquí y te apoyamos según disponibilidad.",
      flowToken
    );
    await saveSession(phone, session);
    return { actions: [] };
  }

  const infoQuestion = isInfoQuestion(cleanText);
  const bookingIntent =
    interpretation?.intent === "book" ||
    (!infoQuestion &&
      (hasBookingIntent(cleanText) ||
        session.date ||
        session.sport ||
        session.pendingTime ||
        session.pendingConfirm ||
        session.awaitingSport ||
        session.awaitingDate ||
        session.awaitingTime));

  const infoIntent = interpretation?.intent === "info" || infoQuestion;
  if (infoIntent && !bookingIntent) {
    const reply = interpretation?.reply;
    if (reply) {
      await safeSendText(phone, reply, flowToken);
      await saveSession(phone, session);
      return { actions: [] };
    }
    const { finalText, messages } = await runAgent(session, text);
    await safeSendText(phone, finalText, flowToken);
    session.messages = messages
      .filter(m => m.role === "user" || (m.role === "assistant" && !m.tool_calls))
      .slice(-12);
    await saveSession(phone, session);
    return { actions: [] };
  }

  if (bookingIntent && !session.sport) {
    session.awaitingSport = true;
    const ask = interpretation?.reply || "¿Para qué deporte quieres reservar? (Padel, Pickleball o Golf)";
    await safeSendText(phone, ask, flowToken);
    await saveSession(phone, session);
    return { actions: [] };
  }

  if (bookingIntent && !session.date) {
    session.awaitingDate = true;
    const ask = interpretation?.reply || "¿Para qué fecha te gustaría reservar?";
    await safeSendText(phone, ask, flowToken);
    await saveSession(phone, session);
    return { actions: [] };
  }

  if (session.noAvailabilityDate && wantsAvailability(cleanText)) {
    await safeSendText(
      phone,
      `Para ${formatDateEs(session.noAvailabilityDate)} no tengo disponibilidad. ¿Quieres que revise mañana u otra fecha?`,
      flowToken
    );
    await saveSession(phone, session);
    return { actions: [] };
  }

  if (session.options?.length && wantsOtherTimes(cleanText)) {
    const suggestions = pickClosestOptions(session.options, session.desiredTime);
    const buttons = suggestions.map(o => ({
      type: "reply",
      reply: { id: o.start, title: o.start }
    }));
    const msgText = suggestions.length
      ? `Te puedo ofrecer: ${suggestions.map(o => o.start).join(", ")}.`
      : "No tengo más opciones disponibles.";
    await safeSendButtons(phone, msgText, buttons, flowToken);
    session.awaitingTime = true;
    await saveSession(phone, session);
    return { actions: [] };
  }

  if (session.pendingConfirm) {
    if (isYes(normalizedText)) {
      const { date, times, court, name, lastName } = session.pendingConfirm;
      await safeSendText(phone, "Perfecto, estoy confirmando tu reserva…", flowToken);
      try {
        await confirmBooking(
          phone,
          date,
          times,
          court,
          name,
          lastName,
          session.user?.id,
          session.sport,
          session.user?.found ? "usuario" : "invitado"
        );
        await safeSendText(phone, "¡Listo! Te llegará la confirmación por WhatsApp.", flowToken);
        await clearSession(phone);
      } catch (err) {
        logger?.error?.("confirmBooking failed", err?.response?.data || err?.message || err);
        const slots = await getAvailableHours(session.date, session.sport);
        session.slots = slots;
        session.options = buildOptions(slots, session.duration || 1);
        session.hours = startTimesFromOptions(session.options);
        const suggestions = pickClosestOptions(session.options || [], session.desiredTime);
        if (suggestions.length) {
          const buttons = suggestions.map(h => ({
            type: "reply",
            reply: { id: h.start, title: h.start }
          }));
          await safeSendButtons(
            phone,
            `No pude confirmar. Te puedo ofrecer: ${suggestions.map(o => o.start).join(", ")}.`,
            buttons,
            flowToken
          );
        } else {
          await safeSendText(phone, "No pude confirmar la reserva. ¿Quieres intentar otra hora?", flowToken);
        }
        session.pendingConfirm = null;
        await saveSession(phone, session);
      }
      return { actions: [] };
    }
    if (isNo(normalizedText)) {
      session.pendingConfirm = null;
      await safeSendText(phone, "Entendido. ¿Qué horario prefieres?", flowToken);
      await saveSession(phone, session);
      return { actions: [] };
    }
  }

  const timeCandidate = extractTime(text);
  if (timeCandidate) {
    session.desiredTime = timeCandidate;
    if (session.options?.length) {
      const match = session.options.find(o => o.start === timeCandidate);
      if (match) {
        if (!session.user?.found && (!session.user?.name || !session.userLastName)) {
          session.pendingTime = timeCandidate;
          await safeSendText(phone, "¿A nombre de quién hago la reserva? (Nombre y apellido)", flowToken);
          await saveSession(phone, session);
          return { actions: [] };
        }
        session.pendingConfirm = {
          date: session.date,
          times: match.times,
          court: match.court,
          name: session.user?.name || "Cliente",
          lastName: session.userLastName || ""
        };
        await safeSendText(
          phone,
          `Confirmo a nombre de ${session.pendingConfirm.name} ${session.pendingConfirm.lastName} el ${formatDateEs(
            session.date
          )} de ${formatTimeRange(match.times)}?`,
          flowToken
        );
        await saveSession(phone, session);
        return { actions: [] };
      }
      const suggestions = pickClosestOptions(session.options, timeCandidate);
      const buttons = suggestions.map(o => ({
        type: "reply",
        reply: { id: o.start, title: o.start }
      }));
      await safeSendButtons(
        phone,
        `No tengo ${timeCandidate} disponible. Te puedo ofrecer: ${suggestions.map(o => o.start).join(", ")}.`,
        buttons,
        flowToken
      );
      await saveSession(phone, session);
      return { actions: [] };
    }
  }

  if (isNewSession && isGreeting(text) && !hasBookingIntent(cleanText)) {
    if (!session.user) {
      session.user = await findUser(phone);
    }
    await safeSendText(
      phone,
      session.user?.found
        ? `Hola ${session.user.name} 👋 Soy Michelle, ¿cómo te ayudo?`
        : "Hola 👋 Soy Michelle, ¿cómo te ayudo?",
      flowToken
    );
    session.messages.push({ role: "assistant", content: "saludo" });
    await saveSession(phone, session);
    return { actions: [] };
  }

  if (session.pendingTime) {
    session.user = session.user || { found: false };
    const fullName = text.trim().split(/\s+/);
    session.user.name = fullName.shift() || text.trim();
    session.userLastName = fullName.join(" ");
    const match = session.options?.find(o => o.start === session.pendingTime);
    if (!match) {
      await safeSendText(phone, "Esa hora ya no está disponible. ¿Qué horario prefieres?", flowToken);
      session.pendingTime = null;
      await saveSession(phone, session);
      return { actions: [] };
    }
    session.pendingConfirm = {
      date: session.date,
      times: match.times,
      court: match.court,
      name: session.user?.name || "Cliente",
      lastName: session.userLastName || ""
    };
    session.pendingTime = null;
    await safeSendText(
      phone,
      `Confirmo a nombre de ${session.pendingConfirm.name} ${session.pendingConfirm.lastName} el ${formatDateEs(
        session.date
      )} de ${formatTimeRange(session.pendingConfirm.times)}?`,
      flowToken
    );
    await saveSession(phone, session);
    return { actions: [] };
  }

  if (bookingIntent) {
    if (session.sport && session.date && (!session.slots || session.slots.length === 0)) {
      const slots = await getAvailableHours(session.date, session.sport);
      session.slots = slots;
      session.options = buildOptions(slots, session.duration || 1);
      session.hours = startTimesFromOptions(session.options);
      if (!session.options.length) {
        session.noAvailabilityDate = session.date;
        session.awaitingDate = true;
        await safeSendText(
          phone,
          `Para ${formatDateEs(session.date)} no tengo horarios disponibles. ¿Quieres que revise mañana u otra fecha?`,
          flowToken
        );
        await saveSession(phone, session);
        return { actions: [] };
      }
      const suggestions = pickClosestOptions(session.options, session.desiredTime);
      const buttons = suggestions.map(o => ({
        type: "reply",
        reply: { id: o.start, title: o.start }
      }));
      const msg = session.desiredTime
        ? `No tengo ${session.desiredTime} disponible. Te puedo ofrecer: ${suggestions
            .map(o => o.start)
            .join(", ")}.`
        : "¿A qué hora te gustaría reservar?";
      await safeSendButtons(phone, msg, buttons, flowToken);
      session.awaitingTime = true;
      await saveSession(phone, session);
      return { actions: [] };
    }
  }

  const { finalText, messages } = await runAgent(session, text);
  await safeSendText(phone, finalText, flowToken);
  session.messages = messages
    .filter(m => m.role === "user" || (m.role === "assistant" && !m.tool_calls))
    .slice(-12);
  await saveSession(phone, session);
  return { actions: [] };
}

export default { init, handleIncoming };
