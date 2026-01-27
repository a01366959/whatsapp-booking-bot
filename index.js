/******************************************************************
 * FULL AI AGENT — WHATSAPP
 ******************************************************************/
import express from "express";
import axios from "axios";
import OpenAI from "openai";

const app = express();
app.use(express.json());

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

/******************************************************************
 * CONSTANTS
 ******************************************************************/
const WHATSAPP_API = `https://graph.facebook.com/v18.0/${process.env.WHATSAPP_PHONE_ID}/messages`;
const BUBBLE = `${process.env.BUBBLE_BASE_URL}/api/1.1/wf`;
const DEFAULT_SPORT = "padel";

/******************************************************************
 * MEMORY
 ******************************************************************/
const sessions = new Map();

/******************************************************************
 * SYSTEM PROMPT
 ******************************************************************/
const SYSTEM_MESSAGE = {
  role: "system",
  content: `
Eres un recepcionista humano por WhatsApp para Black Padel & Pickleball en México.

Hablas natural, cercano y empático.
NO repites saludos.
NO preguntas cosas que ya sabes.
NO inventas horarios.

Si ya existe fecha, no la vuelvas a pedir.
Si ya existen horarios, no preguntes horas.

Responde SIEMPRE en JSON:

{
  "intent": "reserve | provide_date | provide_time | general",
  "reply": "mensaje",
  "date": "YYYY-MM-DD | null",
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
    model:"gpt-4.1-mini",
    input: messages,
    temperature:0.3,
    max_output_tokens:300
  });

  try {
    return JSON.parse(r.output_text);
  } catch {
    return { intent:"general", reply:r.output_text };
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

  if (!sessions.has(phone)) {
    const user = await findUser(phone);
    sessions.set(phone,{
      messages:[SYSTEM_MESSAGE],
      user,
      date:null,
      hours:null,
      hasFetchedHours:false
    });
    await sendText(phone, user.found ? `Hola ${user.name} 👋 ¿Cómo te ayudo hoy?` : "Hola 👋 ¿Cómo te ayudo hoy?");
    return res.sendStatus(200);
  }

  const session = sessions.get(phone);
  session.messages.push({ role:"user", content:text });

  const agent = await askAgent(session.messages);

  if (agent.date) session.date = agent.date;
  if (!session.date) {
    const d = resolveDate(text);
    if (d) session.date = d;
  }

  // RESERVA
  if (session.date && !session.hasFetchedHours) {
    session.hasFetchedHours = true;
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
    return res.sendStatus(200);
  }

  // CONFIRMAR
  if (session.hours?.includes(agent.time)) {
    await confirmBooking(phone, session.date, agent.time);
    await sendText(phone,"¡Listo! Tu reserva quedó confirmada 🙌");
    sessions.delete(phone);
    return res.sendStatus(200);
  }

  // CHAT NORMAL
  await sendText(phone, agent.reply);
  session.messages.push({ role:"assistant", content:agent.reply });

  res.sendStatus(200);
});

/******************************************************************
 * SERVER
 ******************************************************************/
app.listen(process.env.PORT || 3000,()=>{
  console.log("FULL AI AGENT RUNNING");
});
