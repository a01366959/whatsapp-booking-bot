import express from "express";
import axios from "axios";
import OpenAI from "openai";

const app = express();
app.use(express.json());

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

/**
 * ============================
 * SESSION MEMORY
 * ============================
 */
const sessions = {};

/**
 * ============================
 * WEBHOOK VERIFY
 * ============================
 */
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === process.env.WEBHOOK_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

/**
 * ============================
 * INCOMING MESSAGES
 * ============================
 */
app.post("/webhook", async (req, res) => {
  try {
    const message =
      req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!message) return res.sendStatus(200);

    const phone = message.from;

    if (!sessions[phone]) {
      sessions[phone] = { step: "menu" };
      await findUser(phone);
      await sendMainMenu(phone);
      return res.sendStatus(200);
    }

    if (message.type === "interactive") {
      await handleInteraction(phone, message.interactive);
      return res.sendStatus(200);
    }

    if (message.type === "text") {
      await handleFreeText(phone, message.text.body);
    }

    res.sendStatus(200);
  } catch (err) {
    console.error("Webhook error:", err.response?.data || err.message);
    res.sendStatus(200);
  }
});

/**
 * ============================
 * AI UNDERSTANDING
 * ============================
 */
async function understandMessage(phone, text) {
  const s = sessions[phone];

  const prompt = `
You are a booking intent parser.

Context:
- Expected step: ${s.step}
- Known date: ${s.date || "null"}
- Known time: ${s.time || "null"}

User message:
"${text}"

Return ONLY JSON:
{
  "intent": "menu | book | hours | info | date | time | confirm | unknown",
  "date": null or "YYYY-MM-DD",
  "time": null or "HH:mm"
}
`;

  const res = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0,
    messages: [{ role: "system", content: prompt }]
  });

  return JSON.parse(res.choices[0].message.content);
}

/**
 * ============================
 * FREE TEXT HANDLER
 * ============================
 */
async function handleFreeText(phone, text) {
  const ai = await understandMessage(phone, text);
  const s = sessions[phone];

  if (ai.intent === "hours") {
    return sendText(
      phone,
      "🕘 Horarios:\nL–V 7:00–22:00\nS–D 8:00–20:00"
    );
  }

  if (ai.intent === "info") {
    return sendText(
      phone,
      "🎾 Black Padel & Pickleball\n📍 CDMX\n📞 Reservas por WhatsApp"
    );
  }

  if (ai.date) {
    s.date = ai.date;
    s.step = "choose_time";
    await loadAvailableHours(phone);
    return sendTimeButtons(phone);
  }

  if (ai.time) {
    s.time = ai.time;
    s.step = "confirm";
    return sendConfirmation(phone);
  }

  return sendMainMenu(phone);
}

/**
 * ============================
 * INTERACTIONS
 * ============================
 */
async function handleInteraction(phone, interactive) {
  const id =
    interactive.button_reply?.id ||
    interactive.list_reply?.id;

  if (!id) return;

  if (id === "menu_book") {
    sessions[phone].step = "choose_date";
    return sendDateList(phone);
  }

  if (id.startsWith("date_")) {
    sessions[phone].date = id.replace("date_", "");
    await loadAvailableHours(phone);
    return sendTimeButtons(phone);
  }

  if (id.startsWith("time_")) {
    sessions[phone].time = id.replace("time_", "");
    return sendConfirmation(phone);
  }

  if (id === "confirm_booking") {
    await confirmBooking(phone);
    delete sessions[phone];
    return sendText(phone, "✅ ¡Reserva confirmada!");
  }
}

/**
 * ============================
 * BUBBLE
 * ============================
 */
async function findUser(phone) {
  const res = await axios.get(
    `${process.env.BUBBLE_BASE_URL}/api/1.1/wf/find_user`,
    { params: { phone } }
  );

  if (res.data.response?.found) {
    sessions[phone].name = res.data.response.name;
  }
}

async function loadAvailableHours(phone) {
  const s = sessions[phone];
  const res = await axios.get(
    `${process.env.BUBBLE_BASE_URL}/api/1.1/wf/get_available_hours`,
    { params: { date: s.date } }
  );

  const unique = [...new Set(res.data.response.timeslots)];
  s.availableHours = unique;
}

async function confirmBooking(phone) {
  const s = sessions[phone];
  await axios.post(
    `${process.env.BUBBLE_BASE_URL}/api/1.1/wf/confirm_booking`,
    {
      phone,
      date: s.date,
      time: s.time
    }
  );
}

/**
 * ============================
 * WHATSAPP UI
 * ============================
 */
async function sendMainMenu(phone) {
  const name = sessions[phone]?.name;
  await sendInteractive(phone, {
    type: "button",
    body: {
      text: `Hola ${name || ""} 👋\n¿Qué te gustaría hacer?`
    },
    action: {
      buttons: [
        { type: "reply", reply: { id: "menu_book", title: "📅 Reservar" } },
        { type: "reply", reply: { id: "menu_hours", title: "⏰ Horarios" } },
        { type: "reply", reply: { id: "menu_info", title: "ℹ️ Información" } }
      ]
    }
  });
}

async function sendDateList(phone) {
  await sendInteractive(phone, {
    type: "list",
    body: { text: "📅 Elige una fecha" },
    action: {
      button: "Seleccionar",
      sections: [
        {
          rows: [
            { id: "date_today", title: "Hoy" },
            { id: "date_tomorrow", title: "Mañana" }
          ]
        }
      ]
    }
  });
}

async function sendTimeButtons(phone) {
  const hours = sessions[phone].availableHours;
  await sendInteractive(phone, {
    type: "button",
    body: { text: "⏰ Elige un horario" },
    action: {
      buttons: hours.slice(0, 3).map(h => ({
        type: "reply",
        reply: { id: `time_${h}`, title: h }
      }))
    }
  });
}

async function sendConfirmation(phone) {
  await sendInteractive(phone, {
    type: "button",
    body: { text: "¿Confirmar reserva?" },
    action: {
      buttons: [
        { type: "reply", reply: { id: "confirm_booking", title: "Confirmar" } }
      ]
    }
  });
}

async function sendText(phone, text) {
  await axios.post(
    `https://graph.facebook.com/v18.0/${process.env.WHATSAPP_PHONE_ID}/messages`,
    {
      messaging_product: "whatsapp",
      to: phone,
      type: "text",
      text: { body: text }
    },
    {
      headers: {
        Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`
      }
    }
  );
}

async function sendInteractive(phone, interactive) {
  await axios.post(
    `https://graph.facebook.com/v18.0/${process.env.WHATSAPP_PHONE_ID}/messages`,
    {
      messaging_product: "whatsapp",
      to: phone,
      type: "interactive",
      interactive
    },
    {
      headers: {
        Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`
      }
    }
  );
}

app.listen(process.env.PORT || 3000, () => {
  console.log("✅ AI WhatsApp bot running");
});
