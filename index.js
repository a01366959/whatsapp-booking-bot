/******************************************************************
 * 1. IMPORTS & SETUP
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
 * 2. CONSTANTS
 ******************************************************************/
const BUBBLE = `${process.env.BUBBLE_BASE_URL}/api/1.1/wf`;
const WHATSAPP_API = `https://graph.facebook.com/v18.0/${process.env.WHATSAPP_PHONE_ID}/messages`;

/******************************************************************
 * 3. IN-MEMORY STORAGE (REPLACE WITH REDIS LATER)
 ******************************************************************/
const sessions = new Map(); 
/*
session structure:
{
  messages: [],
  state: "idle" | "awaiting_date" | "awaiting_time" | "confirming",
  user: { name },
  date: null,
  availableHours: [],
  time: null
}
*/

/******************************************************************
 * 4. SYSTEM PROMPT (CORE BRAIN)
 ******************************************************************/
const SYSTEM_MESSAGE = {
  role: "system",
  content: `
You are an AI WhatsApp assistant for a padel club in Mexico.

Goals:
- Be conversational and natural.
- Help users reserve courts.
- Answer questions about the club.

Rules:
- Availability, bookings and users come ONLY from Bubble workflows.
- Never invent availability.
- Never confirm a booking without calling Bubble.
- Ask for missing info step by step.
- Use buttons ONLY when selecting dates or times.
- If multiple courts share the same hour, show it only once.
- Maintain context across messages.
- Respond in Mexican Spanish.
`
};

/******************************************************************
 * 5. BUBBLE WORKFLOWS
 ******************************************************************/
async function findUser(phone) {
  const res = await axios.get(`${BUBBLE}/find_user`, { params: { phone } });
  return res.data.response;
}

async function getAvailableHours(date) {
  const res = await axios.get(`${BUBBLE}/get_available_hours`, { params: { date } });
  const slots = res.data.response?.timeslots || [];
  return [...new Set(slots)]; // remove duplicates
}

async function confirmBooking(phone, date, time) {
  await axios.post(`${BUBBLE}/confirm_booking`, {
    phone,
    date,
    time
  });
}

/******************************************************************
 * 6. OPENAI CALL (RESPONSES API)
 ******************************************************************/
async function runAI(messages) {
  const response = await openai.responses.create({
    model: "gpt-4.1-mini",
    input: messages,
    temperature: 0.4,
    max_output_tokens: 300
  });

  return response.output_text;
}

/******************************************************************
 * 7. INTENT & DATE EXTRACTION (LIGHTWEIGHT NLP)
 ******************************************************************/
function detectIntent(text) {
  const t = text.toLowerCase();

  if (t.includes("reserv")) return "reserve";
  if (t.includes("horario")) return "hours";
  if (t.includes("info") || t.includes("ubic")) return "info";
  if (t.includes("sí") || t.includes("confirm")) return "confirm";

  return "chat";
}

function extractDate(text) {
  if (text.includes("hoy")) return new Date().toISOString().slice(0, 10);
  if (text.includes("mañana")) {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    return d.toISOString().slice(0, 10);
  }
  return null;
}

/******************************************************************
 * 8. WHATSAPP SENDERS
 ******************************************************************/
async function sendText(phone, text) {
  await axios.post(
    WHATSAPP_API,
    {
      messaging_product: "whatsapp",
      to: phone,
      type: "text",
      text: { body: text }
    },
    { headers: authHeaders() }
  );
}

async function sendButtons(phone, text, buttons) {
  await axios.post(
    WHATSAPP_API,
    {
      messaging_product: "whatsapp",
      to: phone,
      type: "interactive",
      interactive: {
        type: "button",
        body: { text },
        action: { buttons }
      }
    },
    { headers: authHeaders() }
  );
}

function authHeaders() {
  return {
    Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
    "Content-Type": "application/json"
  };
}

/******************************************************************
 * 9. MAIN WEBHOOK
 ******************************************************************/
app.post("/webhook", async (req, res) => {
  try {
    const msg = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!msg) return res.sendStatus(200);

    const phone = msg.from;
    const text = msg.text?.body || "";

    if (!sessions.has(phone)) {
      const user = await findUser(phone);
      sessions.set(phone, {
        messages: [SYSTEM_MESSAGE],
        state: "idle",
        user,
        date: null,
        availableHours: [],
        time: null
      });
    }

    const session = sessions.get(phone);
    session.messages.push({ role: "user", content: text });

    const intent = detectIntent(text);

    /**************************************************************
     * 9.1 RESERVATION FLOW
     **************************************************************/
    if (intent === "reserve" && session.state === "idle") {
      session.state = "awaiting_date";
      await sendText(phone, "Perfecto, ¿para qué fecha quieres reservar?");
      return res.sendStatus(200);
    }

    if (session.state === "awaiting_date") {
      const date = extractDate(text);
      if (!date) {
        await sendText(phone, "Dime la fecha (por ejemplo: hoy o mañana).");
        return res.sendStatus(200);
      }

      session.date = date;
      session.availableHours = await getAvailableHours(date);

      if (!session.availableHours.length) {
        await sendText(phone, "No hay horarios disponibles ese día.");
        session.state = "idle";
        return res.sendStatus(200);
      }

      session.state = "awaiting_time";

      await sendButtons(
        phone,
        "Estos son los horarios disponibles:",
        session.availableHours.slice(0, 3).map(h => ({
          type: "reply",
          reply: { id: h, title: h }
        }))
      );

      return res.sendStatus(200);
    }

    if (session.state === "awaiting_time") {
      session.time = text;
      session.state = "confirming";
      await sendText(phone, `¿Confirmo tu reserva el ${session.date} a las ${session.time}?`);
      return res.sendStatus(200);
    }

    if (session.state === "confirming" && intent === "confirm") {
      await confirmBooking(phone, session.date, session.time);
      await sendText(phone, "Reserva confirmada. ¡Te esperamos!");
      sessions.delete(phone);
      return res.sendStatus(200);
    }

    /**************************************************************
     * 9.2 GENERAL AI CHAT
     **************************************************************/
    const aiReply = await runAI(session.messages);
    session.messages.push({ role: "assistant", content: aiReply });
    await sendText(phone, aiReply);

    res.sendStatus(200);
  } catch (err) {
    console.error("Webhook error:", err.message);
    res.sendStatus(500);
  }
});

/******************************************************************
 * 10. SERVER START
 ******************************************************************/
app.listen(process.env.PORT || 3000, () => {
  console.log("WhatsApp AI Agent running");
});
