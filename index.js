/******************************************************************
 * HUMAN-GRADE AI AGENT — WHATSAPP
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
 * SESSION MEMORY (Railway single instance OK)
 ******************************************************************/
const sessions = new Map();

/******************************************************************
 * SYSTEM PROMPT — AGENT AUTHORITY
 ******************************************************************/
const SYSTEM_MESSAGE = {
  role: "system",
  content: `
You are a HUMAN WhatsApp receptionist for Black Padel & Pickleball (Mexico).

You decide WHAT TO DO NEXT.
The server only executes your decision.

RULES:
- Never greet twice in the same conversation
- Never invent info
- Never answer unrelated questions (code, politics, etc.)
- Stay strictly within club context
- If user changes topic, adapt naturally
- If info is missing, ask ONE clear question

AVAILABLE ACTIONS (respond ONLY JSON):

{
  "action": "reply | get_hours | show_hours | confirm_booking | reset",
  "message": "text to send to user",
  "params": {
    "date": "YYYY-MM-DD | null",
    "time": "HH:MM | null"
  }
}
`
};

/******************************************************************
 * HELPERS
 ******************************************************************/
const normalizePhone = p => p.replace(/\D/g, "");

const todayISO = () => {
  const d = new Date();
  d.setHours(0,0,0,0);
  return d.toISOString().slice(0,10);
};

const resolveDate = text => {
  const t = text.toLowerCase();
  if (t.includes("hoy")) return todayISO();
  if (t.includes("mañana") || t.includes("manana")) {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    d.setHours(0,0,0,0);
    return d.toISOString().slice(0,10);
  }
  return null;
};

/******************************************************************
 * BUBBLE TOOLS
 ******************************************************************/
async function findUser(phone) {
  const r = await axios.get(`${BUBBLE}/find_user`, { params:{ phone }});
  return r.data?.response || { found:false };
}

async function getAvailableHours(date) {
  const r = await axios.get(`${BUBBLE}/get_available_hours`, {
    params:{ sport: DEFAULT_SPORT, date }
  });

  if (!r.data?.response?.hours) return [];

  return [...new Set(r.data.response.hours)]
    .sort((a,b)=>a.localeCompare(b));
}

async function confirmBooking(phone, date, time) {
  await axios.post(`${BUBBLE}/confirm_booking`, { phone, date, time });
}

/******************************************************************
 * OPENAI AGENT DECISION
 ******************************************************************/
async function agentDecide(session, userText) {
  const messages = [
    SYSTEM_MESSAGE,
    {
      role: "system",
      content: `SESSION STATE:
${JSON.stringify({
  greeted: session.greeted,
  date: session.date,
  hours: session.hours
}, null, 2)}`
    },
    ...session.messages,
    { role: "user", content: userText }
  ];

  const r = await openai.responses.create({
    model: "gpt-4.1-mini",
    input: messages,
    temperature: 0.2,
    max_output_tokens: 300
  });

  try {
    return JSON.parse(r.output_text);
  } catch {
    return {
      action: "reply",
      message: "¿Me repites eso por favor? 😊",
      params: {}
    };
  }
}

/******************************************************************
 * WHATSAPP SENDERS
 ******************************************************************/
const headers = {
  Authorization:`Bearer ${process.env.WHATSAPP_TOKEN}`,
  "Content-Type":"application/json"
};

const sendText = (to,text)=>axios.post(
  WHATSAPP_API,
  { messaging_product:"whatsapp", to, type:"text", text:{ body:text }},
  { headers }
);

const sendButtons = (to,text,buttons)=>axios.post(
  WHATSAPP_API,
  {
    messaging_product:"whatsapp",
    to,
    type:"interactive",
    interactive:{
      type:"button",
      body:{ text },
      action:{ buttons }
    }
  },
  { headers }
);

/******************************************************************
 * WEBHOOK
 ******************************************************************/
app.post("/webhook", async (req,res)=>{
  try {
    const msg = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!msg) return res.sendStatus(200);

    const phone = normalizePhone(msg.from);
    const text = msg.text?.body || "";

    // INIT SESSION
    if (!sessions.has(phone)) {
      const user = await findUser(phone);
      sessions.set(phone,{
        greeted:false,
        user,
        date:null,
        hours:null,
        messages:[]
      });
    }

    const session = sessions.get(phone);

    // FIRST GREETING (ONCE)
    if (!session.greeted) {
      session.greeted = true;
      await sendText(
        phone,
        session.user?.found
          ? `Hola ${session.user.name.split(" ")[0]} 👋 ¿Cómo te ayudo hoy?`
          : "Hola 👋 ¿Cómo te ayudo hoy?"
      );
      return res.sendStatus(200);
    }

    // QUICK DATE RESOLUTION (cheap & deterministic)
    if (!session.date) {
      const d = resolveDate(text);
      if (d) session.date = d;
    }

    // AGENT DECISION
    const decision = await agentDecide(session, text);

    // EXECUTION LAYER
    switch (decision.action) {

      case "get_hours": {
        session.date = decision.params.date || session.date;
        await sendText(phone, decision.message || "Déjame revisar disponibilidad…");
        session.hours = await getAvailableHours(session.date);

        if (!session.hours.length) {
          await sendText(phone,"Ese día ya está lleno 😕 ¿Revisamos otra fecha?");
          break;
        }

        await sendButtons(
          phone,
          "Horarios disponibles:",
          session.hours.slice(0,5).map(h=>({
            type:"reply",
            reply:{ id:h, title:h }
          }))
        );
        break;
      }

      case "confirm_booking": {
        await confirmBooking(phone, session.date, decision.params.time);
        await sendText(phone,"¡Listo! Tu reserva quedó confirmada 🙌");
        sessions.delete(phone);
        break;
      }

      case "reset": {
        sessions.delete(phone);
        await sendText(phone,"Perfecto, empezamos de nuevo 😊");
        break;
      }

      case "reply":
      default:
        await sendText(phone, decision.message);
    }

    // SAVE CONVERSATION
    session.messages.push({ role:"user", content:text });
    session.messages.push({ role:"assistant", content:decision.message || "" });

    res.sendStatus(200);
  } catch (err) {
    console.error("WEBHOOK ERROR:", err);
    res.sendStatus(500);
  }
});

/******************************************************************
 * SERVER
 ******************************************************************/
app.listen(process.env.PORT || 3000,()=>{
  console.log("HUMAN-GRADE AI AGENT RUNNING");
});
