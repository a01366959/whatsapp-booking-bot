/******************************************************************
 * FULL AI AGENT — WHATSAPP (REDIS FIXED)
 ******************************************************************/
import express from "express";
import axios from "axios";
import OpenAI from "openai";
import { Redis } from "@upstash/redis";

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
const BUBBLE = `${process.env.BUBBLE_BASE_URL}/api/1.1/wf`;
const DEFAULT_SPORT = "padel";

/******************************************************************
 * SYSTEM PROMPT (BLINDADO)
 ******************************************************************/
const SYSTEM_MESSAGE = {
  role: "system",
  content: `
Eres un recepcionista humano de Black Padel & Pickleball (México).

REGLAS DURAS:
- NO repitas saludos
- NO inventes información
- NO respondas programación, código, temas técnicos, ilegales o fuera del club
- Si preguntan algo fuera del club, responde educadamente que solo ayudas con temas del club
- Si ya hay fecha, NO la pidas otra vez
- Si ya hay horarios, NO preguntes horas

RESPONDE SOLO JSON:
{
  "intent": "reserve | general",
  "reply": "mensaje natural",
  "time": "HH:MM | null"
}
`
};

/******************************************************************
 * HELPERS
 ******************************************************************/
const normalizePhone = p => p.replace(/\D/g, "");

const resolveDate = text => {
  const t = text.toLowerCase();
  const today = new Date();
  today.setHours(0,0,0,0);

  if (t.includes("hoy")) return today.toISOString().slice(0,10);
  if (t.includes("mañana") || t.includes("manana")) {
    const d = new Date(today);
    d.setDate(d.getDate() + 1);
    return d.toISOString().slice(0,10);
  }
  return null;
};

/******************************************************************
 * REDIS SESSION
 ******************************************************************/
const getSession = phone => redis.get(`session:${phone}`);
const saveSession = (phone, session) =>
  redis.set(`session:${phone}`, session, { ex: 1800 });
const clearSession = phone => redis.del(`session:${phone}`);

/******************************************************************
 * BUBBLE
 ******************************************************************/
async function findUser(phone) {
  const r = await axios.get(`${BUBBLE}/find_user`, { params:{ phone }});
  return r.data?.response || { found:false };
}

async function getAvailableHours(date) {
  const r = await axios.get(`${BUBBLE}/get_available_hours`, {
    params:{ sport: DEFAULT_SPORT, date }
  });

  return [...new Set(r.data.response.hours)].sort();
}

async function confirmBooking(phone, date, time) {
  await axios.post(`${BUBBLE}/confirm_booking`, { phone, date, time });
}

/******************************************************************
 * OPENAI
 ******************************************************************/
async function askAgent(messages) {
  const r = await openai.responses.create({
    model: "gpt-4.1-mini",
    input: messages,
    temperature: 0.25,
    max_output_tokens: 250
  });

  try {
    return JSON.parse(r.output_text);
  } catch {
    return { intent:"general", reply:"¿Te ayudo con una reserva o información del club?" };
  }
}

/******************************************************************
 * WHATSAPP
 ******************************************************************/
const sendText = (to,text)=>axios.post(WHATSAPP_API,{
  messaging_product:"whatsapp",
  to,
  type:"text",
  text:{ body:text }
},{ headers:{ Authorization:`Bearer ${process.env.WHATSAPP_TOKEN}` }});

const sendButtons = (to,text,buttons)=>axios.post(WHATSAPP_API,{
  messaging_product:"whatsapp",
  to,
  type:"interactive",
  interactive:{
    type:"button",
    body:{ text },
    action:{ buttons }
  }
},{ headers:{ Authorization:`Bearer ${process.env.WHATSAPP_TOKEN}` }});

/******************************************************************
 * WEBHOOK
 ******************************************************************/
app.post("/webhook", async (req,res)=>{
  const msg = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
  if (!msg) return res.sendStatus(200);

  const phone = normalizePhone(msg.from);
  const text = msg.text?.body || "";

  let session = await getSession(phone);

  if (!session) {
    const user = await findUser(phone);
    session = {
      messages:[SYSTEM_MESSAGE],
      user,
      date:null,
      hours:null,
      fetched:false
    };

    await sendText(
      phone,
      user.found ? `Hola ${user.name} 👋 ¿Cómo te ayudo hoy?` : "Hola 👋 ¿Cómo te ayudo hoy?"
    );
  }

  session.messages.push({ role:"user", content:text });

  // Fecha directa (sin IA)
  if (!session.date) {
    const d = resolveDate(text);
    if (d) session.date = d;
  }

  const agent = await askAgent(session.messages);

  // === SI YA TENEMOS FECHA → MOSTRAR HORARIOS UNA VEZ ===
  if (session.date && !session.fetched) {
    session.fetched = true;
    await sendText(phone,"Déjame revisar los horarios disponibles…");
    session.hours = await getAvailableHours(session.date);

    await sendButtons(
      phone,
      "Estos horarios están disponibles:",
      session.hours.slice(0,5).map(h=>({
        type:"reply",
        reply:{ id:h, title:h }
      }))
    );

    await saveSession(phone, session);
    return res.sendStatus(200);
  }

  // === CONFIRMAR ===
  if (session.hours?.includes(agent.time)) {
    await confirmBooking(phone, session.date, agent.time);
    await sendText(phone,"¡Listo! Tu reserva quedó confirmada 🙌");
    await clearSession(phone);
    return res.sendStatus(200);
  }

  // === CHAT GENERAL CONTROLADO ===
  await sendText(phone, agent.reply);
  session.messages.push({ role:"assistant", content:agent.reply });

  await saveSession(phone, session);
  res.sendStatus(200);
});

/******************************************************************
 * SERVER
 ******************************************************************/
app.listen(process.env.PORT || 3000,()=>{
  console.log("FULL AI AGENT RUNNING (REDIS)");
});
