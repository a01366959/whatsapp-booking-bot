import express from "express";
import axios from "axios";

const app = express();
app.use(express.json());

/**
 * ============================
 * 1. WEBHOOK VERIFICATION
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
 * 2. SESSION STORAGE (TEMP)
 * ============================
 */
const sessions = {};

/**
 * ============================
 * 3. INCOMING WHATSAPP MESSAGES
 * ============================
 */
app.post("/webhook", async (req, res) => {
  try {
    const message =
      req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];

    if (!message) return res.sendStatus(200);

    const phone = message.from;
    const type = message.type;

    if (!sessions[phone]) {
      sessions[phone] = {};
      await findUser(phone);
    }

    if (type === "text") {
      const text = message.text.body.toLowerCase();

      if (text.includes("book")) {
        await sendDateList(phone);
      } else {
        const name = sessions[phone].name;
        await sendText(
          phone,
          name
            ? `Hola ${name} 👋\nEscribe *book* para reservar`
            : "Hola 👋\nEscribe *book* para reservar"
        );
      }
    }

    if (type === "interactive") {
      await handleInteraction(phone, message.interactive);
    }

    res.sendStatus(200);
  } catch (err) {
    console.error("Webhook error:", err.message);
    res.sendStatus(200);
  }
});

/**
 * ============================
 * 4. BUBBLE CALLS
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

async function getAvailableHours(phone, date) {
  const res = await axios.get(
    `${process.env.BUBBLE_BASE_URL}/api/1.1/wf/get_available_hours`,
    { params: { date } }
  );

  sessions[phone].availableHours = res.data.response.hours;
}

async function confirmReservation(phone) {
  const session = sessions[phone];

  await axios.post(
    `${process.env.BUBBLE_BASE_URL}/api/1.1/wf/confirm_reservation`,
    {
      phone,
      date: session.date,
      time: session.time
    }
  );
}

/**
 * ============================
 * 5. HANDLE INTERACTIONS
 * ============================
 */
async function handleInteraction(phone, interactive) {
  const id =
    interactive.list_reply?.id ||
    interactive.button_reply?.id;

  if (!id) return;

  if (id.startsWith("date_")) {
    const date = id.replace("date_", "");
    sessions[phone].date = date;

    await getAvailableHours(phone, date);
    await sendTimeButtons(phone);
  }

  if (id.startsWith("time_")) {
    sessions[phone].time = id.replace("time_", "");
    await sendConfirmation(phone);
  }

  if (id === "confirm") {
    try {
      await confirmReservation(phone);
      await sendText(phone, "🎉 Reserva confirmada en Black Padel & Pickleball");
      delete sessions[phone];
    } catch {
      await sendText(
        phone,
        "❌ Ese horario ya no está disponible. Intenta otro."
      );
    }
  }
}

/**
 * ============================
 * 6. WHATSAPP UI
 * ============================
 */
async function sendDateList(phone) {
  await sendInteractive(phone, {
    type: "list",
    body: { text: "📅 Elige una fecha" },
    action: {
      button: "Seleccionar fecha",
      sections: [
        {
          title: "Fechas disponibles",
          rows: [
            { id: "date_2026-01-27", title: "Hoy" },
            { id: "date_2026-01-28", title: "Mañana" },
            { id: "date_2026-01-29", title: "Jueves" }
          ]
        }
      ]
    }
  });
}

async function sendTimeButtons(phone) {
  const hours = sessions[phone].availableHours || [];

  await sendInteractive(phone, {
    type: "button",
    body: { text: "⏰ Elige un horario" },
    action: {
      buttons: hours.slice(0, 3).map(h => ({
        type: "reply",
        reply: {
          id: `time_${h}`,
          title: h
        }
      }))
    }
  });
}

async function sendConfirmation(phone) {
  await sendInteractive(phone, {
    type: "button",
    body: { text: "✅ ¿Confirmar reserva?" },
    action: {
      buttons: [
        {
          type: "reply",
          reply: { id: "confirm", title: "Confirmar" }
        }
      ]
    }
  });
}

/**
 * ============================
 * 7. SEND MESSAGES
 * ============================
 */
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
        Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
        "Content-Type": "application/json"
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
        Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
        "Content-Type": "application/json"
      }
    }
  );
}

/**
 * ============================
 * 8. START SERVER
 * ============================
 */
app.listen(process.env.PORT || 3000, () => {
  console.log("✅ WhatsApp bot running");
});
