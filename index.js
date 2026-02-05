/******************************************************************
 * FULL AI AGENT — WHATSAPP (REDIS FIXED)
 ******************************************************************/
import express from "express";
import axios from "axios";
import OpenAI from "openai";
import { Redis } from "@upstash/redis";
import { randomUUID } from "crypto";

const app = express();
app.use(express.json());

/******************************************************************
 * CLIENTS
 ******************************************************************/
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN
});

/******************************************************************
 * CONSTANTS
 ******************************************************************/
const WHATSAPP_API = `https://graph.facebook.com/v18.0/${process.env.WHATSAPP_PHONE_ID}/messages`;
const RAW_BUBBLE_BASE = (process.env.BUBBLE_BASE_URL || "").trim();
const normalizeBubbleBase = raw => {
  if (!raw) return "";
  let base = raw.replace(/\/$/, "");
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
};
const BUBBLE = normalizeBubbleBase(RAW_BUBBLE_BASE);
const DEFAULT_SPORT = "Padel";
const MAX_BUTTONS = 3;
const MEXICO_TZ = "America/Mexico_City";
const CONFIRM_ENDPOINT = process.env.BUBBLE_CONFIRM_ENDPOINT || "confirm_reserva";

const BUBBLE_HEADERS = {
  Authorization: `Bearer ${process.env.BUBBLE_TOKEN}`
};
const BUBBLE_REDIRECTS = new Set([301, 302, 303, 307, 308]);

const buildBubbleUrl = path => `${BUBBLE}${path.startsWith("/") ? "" : "/"}${path}`;

async function bubbleRequest(method, path, { params, data } = {}) {
  const url = buildBubbleUrl(path);
  const config = {
    method,
    url,
    params,
    data,
    headers: BUBBLE_HEADERS,
    maxRedirects: 0,
    validateStatus: status => (status >= 200 && status < 400) || BUBBLE_REDIRECTS.has(status)
  };
  let res = await axios.request(config);
  if (BUBBLE_REDIRECTS.has(res.status) && res.headers?.location) {
    const redirectedUrl = new URL(res.headers.location, url).toString();
    res = await axios.request({ ...config, url: redirectedUrl });
  }
  return res;
}

/******************************************************************
 * SYSTEM PROMPT (AGENTE)
 ******************************************************************/
const SYSTEM_MESSAGE = {
  role: "system",
  content: `
Eres Michelle, recepcionista humana de Black Padel & Pickleball (México).

REGLAS DURAS:
- NO repitas saludos
- NO inventes información
- NO respondas programación, código, temas técnicos, ilegales o fuera del club
- Si preguntan algo fuera del club, responde educadamente que solo ayudas con temas del club
- Si ya hay fecha, NO la pidas otra vez
- Si ya hay horarios, NO preguntes horas
- Si necesitas datos, pregunta de forma breve y natural
- Si el usuario quiere reservar, pide solo lo mínimo (deporte, fecha, hora, duración)

HERRAMIENTAS:
- get_user: obtener nombre del cliente por teléfono
- get_hours: horarios disponibles por fecha

Usa herramientas cuando ayuden. Si no tienes información, dilo.
Responde en español, corto y claro.
`
};

/******************************************************************
 * HELPERS
 ******************************************************************/
const normalizePhone = p => {
  const digits = p.replace(/\D/g, "");
  if (digits.length <= 10) return digits;
  return digits.slice(-10);
};

const normalizeText = text =>
  text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

const WEEKDAY_INDEX = {
  domingo: 0,
  lunes: 1,
  martes: 2,
  miercoles: 3,
  jueves: 4,
  viernes: 5,
  sabado: 6
};

const resolveDate = text => {
  const t = normalizeText(text);
  const { dateStr, weekdayIndex } = getMexicoDateParts();
  const base = new Date(`${dateStr}T00:00:00Z`);

  if (t.includes("hoy")) return dateStr;
  if (t.includes("manana")) {
    const d = new Date(base);
    d.setUTCDate(d.getUTCDate() + 1);
    return d.toISOString().slice(0, 10);
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

const getMexicoDateParts = () => {
  const dt = new Date();
  const dateStr = new Intl.DateTimeFormat("en-CA", {
    timeZone: MEXICO_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(dt);
  const hour = Number(
    new Intl.DateTimeFormat("en-US", {
      timeZone: MEXICO_TZ,
      hour: "2-digit",
      hour12: false
    }).format(dt)
  );
  const weekdayRaw = new Intl.DateTimeFormat("es-MX", {
    timeZone: MEXICO_TZ,
    weekday: "long"
  }).format(dt);
  const weekday = WEEKDAY_INDEX[normalizeText(weekdayRaw)] ?? 0;
  return { dateStr, hour, weekdayIndex: weekday };
};

const extractTime = text => {
  const m = text.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);
  if (m) {
    const hh = m[1].padStart(2, "0");
    const mm = m[2];
    return `${hh}:${mm}`;
  }
  const m2 = text.match(/\b(?:a\s+las\s+)?([01]?\d|2[0-3])\s*(am|pm)?\b/i);
  if (!m2) return null;
  let hour = Number(m2[1]);
  const mer = (m2[2] || "").toLowerCase();
  if (mer === "pm" && hour < 12) hour += 12;
  if (mer === "am" && hour === 12) hour = 0;
  return `${String(hour).padStart(2, "0")}:00`;
};

const isGreeting = text =>
  /\b(hola|buenas|buenos\s+d[ií]as|buenas\s+tardes|buenas\s+noches|hey|que\s+tal)\b/i.test(text);

const hasBookingIntent = text =>
  /\b(reservar|reserva|resev|agendar|agenda|apart(ar)?|cancha|horario)\b/i.test(text);

const isYes = text =>
  /\b(s[ií]|ok|vale|confirmo|confirmar|de acuerdo|adelante|por favor|porfa)\b/i.test(text);
const isNo = text => /\b(no|cancelar|mejor no|todav[ií]a no)\b/i.test(text);
const wantsOtherTimes = text =>
  /\b(otra\s+hora|otras\s+horas|que\s+otra|qué\s+otra|opciones|alternativas|diferente|más\s+tarde|mas\s+tarde|más\s+temprano|mas\s+temprano)\b/i.test(
    text
  );

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

const extractSport = text => {
  const t = normalizeText(text);
  if (t.includes("pickle")) return "Pickleball";
  if (t.includes("golf")) return "Golf";
  if (t.includes("padel") || t.includes("paddel") || t.includes("pádel")) return "Padel";
  return null;
};

const extractDuration = text => {
  const t = normalizeText(text);
  const m = t.match(/\b(\d+)\s*hora/);
  if (m) return Number(m[1]);
  if (t.includes("una hora")) return 1;
  if (t.includes("dos horas")) return 2;
  if (t.includes("tres horas")) return 3;
  return null;
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

const startTimesFromOptions = options =>
  uniqueStarts(options).map(o => o.start);

const pickClosestOptions = (options, desiredTime) => {
  const unique = uniqueStarts(options);
  if (!desiredTime) return unique.slice(0, MAX_BUTTONS);
  const target = hourToNumber(desiredTime);
  return unique
    .sort((a, b) => {
      const da = Math.abs(hourToNumber(a.start) - target);
      const db = Math.abs(hourToNumber(b.start) - target);
      return da - db;
    })
    .slice(0, MAX_BUTTONS);
};

const formatTimeRange = times => {
  if (!times?.length) return "";
  if (times.length === 1) return times[0];
  return `${times[0]} a ${times[times.length - 1]}`;
};
const hourToNumber = timeStr => {
  const m = timeStr?.match(/^(\d{2}):/);
  return m ? Number(m[1]) : null;
};

const suggestClosestHours = (hours, desiredTime) => {
  if (!hours?.length) return [];
  const desiredHour = hourToNumber(desiredTime);
  if (desiredHour === null) return hours.slice(0, MAX_BUTTONS);
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
  return [...new Set(suggestions)].slice(0, MAX_BUTTONS);
};
/******************************************************************
 * REDIS SESSION
 ******************************************************************/
const getSession = phone => redis.get(`session:${phone}`);
const saveSession = (phone, session) =>
  redis.set(`session:${phone}`, session, { ex: 1800 });
const clearSession = phone => redis.del(`session:${phone}`);

const markMessageProcessed = async id =>
  redis.set(`msg:${id}`, 1, { nx: true, ex: 86400 });

const getFlowToken = phone => redis.get(`flow:${phone}`);
const setFlowToken = (phone, token) =>
  redis.set(`flow:${phone}`, token, { ex: 86400 });
const ensureFlowToken = async phone => {
  let token = await getFlowToken(phone);
  if (!token) {
    token = randomUUID();
    await setFlowToken(phone, token);
  }
  return token;
};

/******************************************************************
 * BUBBLE
 ******************************************************************/
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
      sport: desiredSport || DEFAULT_SPORT,
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
    sport: sport || DEFAULT_SPORT,
    user_type: userType
  };
  if (name) basePayload.name = name;
  if (lastName) basePayload.last_name = lastName;
  const withUser = userId ? { ...basePayload, user: userId } : basePayload;
  try {
    await bubbleRequest("post", `/${CONFIRM_ENDPOINT}`, { data: withUser });
  } catch (err) {
    console.error("confirmBooking failed", {
      baseURL: BUBBLE,
      url: err?.config?.url,
      method: err?.config?.method,
      statusCode: err?.response?.status,
      data: err?.response?.data
    });
    if (userId) {
      await bubbleRequest("post", `/${CONFIRM_ENDPOINT}`, { data: basePayload });
      return;
    }
    throw err;
  }
}

/******************************************************************
 * OPENAI (AGENT LOOP)
 ******************************************************************/
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
  },
];

async function runAgent(session, userText) {
  const context = [
    SYSTEM_MESSAGE,
    {
      role: "system",
      content: `Contexto actual:
- phone: ${session.phone}
- user_found: ${session.user?.found ? "si" : "no"}
- user_name: ${session.user?.name || "desconocido"}
- user_id: ${session.user?.id || "desconocido"}
- date: ${session.date || "null"}
- hours: ${session.hours?.length ? session.hours.join(", ") : "null"}
- sport: ${session.sport || DEFAULT_SPORT}`
    },
    ...session.messages.filter(m => m.role === "user" || (m.role === "assistant" && !m.tool_calls))
  ];

  const messages = [...context, { role: "user", content: userText }];
  let finalText = null;
  let guard = 0;

  while (!finalText && guard < 4) {
    guard += 1;
    const response = await openai.chat.completions.create({
      model: "gpt-4.1-mini",
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
          const sport = args.sport || DEFAULT_SPORT;
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

/******************************************************************
 * WHATSAPP
 ******************************************************************/
const sendText = (to, text) =>
  axios.post(
    WHATSAPP_API,
    {
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: text }
    },
    { headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` } }
  );

const sendButtons = (to, text, buttons) =>
  axios.post(
    WHATSAPP_API,
    {
      messaging_product: "whatsapp",
      to,
      type: "interactive",
      interactive: {
        type: "button",
        body: { text },
        action: { buttons }
      }
    },
    { headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` } }
  );

async function safeSendText(to, text, flowToken) {
  if (!to) return { ok: false, error: "missing_to" };
  if (flowToken) {
    const current = await getFlowToken(to);
    if (current !== flowToken) return { ok: false, error: "stale_flow" };
  }
  try {
    await sendText(to, text);
    return { ok: true };
  } catch (err) {
    console.error("sendText failed", err?.response?.data || err?.message || err);
    return { ok: false, error: "sendText_failed" };
  }
}

async function safeSendButtons(to, text, buttons, flowToken) {
  if (!to) return { ok: false, error: "missing_to" };
  if (flowToken) {
    const current = await getFlowToken(to);
    if (current !== flowToken) return { ok: false, error: "stale_flow" };
  }
  try {
    await sendButtons(to, text, buttons);
    return { ok: true };
  } catch (err) {
    console.error("sendButtons failed", err?.response?.data || err?.message || err);
    return { ok: false, error: "sendButtons_failed" };
  }
}

/******************************************************************
 * WEBHOOK
 ******************************************************************/
app.post("/webhook", async (req, res) => {
  const msg = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
  if (!msg) return res.sendStatus(200);

  const msgId = msg.id;
  if (msgId) {
    const firstTime = await markMessageProcessed(msgId);
    if (!firstTime) return res.sendStatus(200);
  }

  const phone = normalizePhone(msg.from);
  const text =
    msg.text?.body ||
    msg.button?.text ||
    msg.interactive?.button_reply?.title ||
    msg.interactive?.button_reply?.id ||
    "";
  const normalizedText = text.trim().toLowerCase();
  const msgTs = Number(msg.timestamp || 0);

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
      lastTs: 0
    };
  }
  session.phone = phone;
  session.justFetchedHours = false;

  if (msgTs && session.lastTs && msgTs < session.lastTs) {
    return res.sendStatus(200);
  }
  if (msgTs) session.lastTs = msgTs;

  // Reset manual para pruebas
  if (normalizedText === "reset") {
    const newToken = randomUUID();
    await setFlowToken(phone, newToken);
    await clearSession(phone);
    await safeSendText(phone, "Listo, reinicié la conversación.", newToken);
    return res.sendStatus(200);
  }

  // Fecha / deporte / duración directos (sin IA)
  const parsedDate = resolveDate(text);
  if (parsedDate) session.date = parsedDate;
  const parsedSport = extractSport(text);
  if (parsedSport) session.sport = parsedSport;
  const parsedDuration = extractDuration(text);
  if (parsedDuration) session.duration = parsedDuration;
  const earlyTimeCandidate = extractTime(text);
  if (earlyTimeCandidate) session.desiredTime = earlyTimeCandidate;
  if (session.duration > 3) {
    session.duration = 3;
    await safeSendText(phone, "El máximo es 3 horas. ¿Te parece 3 horas?", flowToken);
    await saveSession(phone, session);
    return res.sendStatus(200);
  }
  if (parsedDuration && session.slots?.length) {
    session.options = buildOptions(session.slots, session.duration || 1);
    session.hours = startTimesFromOptions(session.options);
  }

  if (!session.user && (hasBookingIntent(text) || session.date || session.pendingTime || session.pendingConfirm)) {
    session.user = await findUser(phone);
    if (session.user?.last_name) session.userLastName = session.user.last_name;
  }

  const bookingIntent = hasBookingIntent(text) || session.date || session.sport || session.pendingTime || session.pendingConfirm;
  if (bookingIntent && !session.sport) {
    await safeSendText(phone, "¿Para qué deporte quieres reservar? (Padel, Pickleball o Golf)", flowToken);
    await saveSession(phone, session);
    return res.sendStatus(200);
  }

  if (bookingIntent && !session.date) {
    await safeSendText(phone, "¿Para qué fecha te gustaría reservar?", flowToken);
    await saveSession(phone, session);
    return res.sendStatus(200);
  }

  // Si el usuario pide otras horas y ya tenemos opciones, responder con opciones
  if (session.options?.length && wantsOtherTimes(normalizedText)) {
    const suggestions = pickClosestOptions(session.options, session.desiredTime);
    const buttons = suggestions.map(o => ({
      type: "reply",
      reply: { id: o.start, title: o.start }
    }));
    const msgText = suggestions.length
      ? `Te puedo ofrecer: ${suggestions.map(o => o.start).join(", ")}.`
      : "No tengo más opciones disponibles.";
    await safeSendButtons(phone, msgText, buttons, flowToken);
    await saveSession(phone, session);
    return res.sendStatus(200);
  }

  // Si estamos esperando confirmación final
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
        console.error("confirmBooking failed", err?.response?.data || err?.message || err);
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
      return res.sendStatus(200);
    }
    if (isNo(normalizedText)) {
      session.pendingConfirm = null;
      await safeSendText(phone, "Entendido. ¿Qué horario prefieres?", flowToken);
      await saveSession(phone, session);
      return res.sendStatus(200);
    }
  }

  // Si ya tenemos horarios y el usuario manda una hora, pedir confirmación
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
          return res.sendStatus(200);
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
        return res.sendStatus(200);
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
      return res.sendStatus(200);
    }
  }

  // Si es un saludo inicial, no repetir saludo ni romper el flujo
  if (isNewSession && isGreeting(text) && !hasBookingIntent(text)) {
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
    return res.sendStatus(200);
  }

  // Si estamos esperando nombre, usar el siguiente mensaje como nombre
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
      return res.sendStatus(200);
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
    return res.sendStatus(200);
  }

  if (bookingIntent) {
    if (session.sport && session.date && (!session.slots || session.slots.length === 0)) {
      const slots = await getAvailableHours(session.date, session.sport);
      session.slots = slots;
      session.options = buildOptions(slots, session.duration || 1);
      session.hours = startTimesFromOptions(session.options);
      if (!session.options.length) {
        await safeSendText(phone, "No tengo horarios disponibles para esa fecha.", flowToken);
        await saveSession(phone, session);
        return res.sendStatus(200);
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
      await saveSession(phone, session);
      return res.sendStatus(200);
    }
  }

  const { finalText, messages } = await runAgent(session, text);

  await safeSendText(phone, finalText, flowToken);

  session.messages = messages
    .filter(m => m.role === "user" || (m.role === "assistant" && !m.tool_calls))
    .slice(-12);

  await saveSession(phone, session);
  res.sendStatus(200);
});

/******************************************************************
 * SERVER
 ******************************************************************/
app.listen(process.env.PORT || 3000, () => {
  console.log("FULL AI AGENT RUNNING (REDIS)");
});
