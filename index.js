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

  if (
    mode === "subscribe" &&
    token === process.env.WEBHOOK_VERIFY_TOKEN
  ) {
    return res.status(200).send(challenge);
  } else {
    return res.sendStatus(403);
  }
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
      sessions[phone] = { step: "start" };
    }

    if (type === "text") {
      const text = message.text.body.toLowerCase();

      if (text.includes("book")) {
        sessions[phone].step = "choose_date";
        await sendDateList(phone);
      } else {
        await sendText(phone, "Hi! Type *book* to start 📅");
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
 * 4. HANDLE BUTTON / LIST CLICKS
 * ============================
 */
async function handleInteraction(phone, interactive) {
  const id =
    interactive.list_reply?.id ||
    interactive.button_reply?.id;

  if (!id) return;

  if (id.startsWith("date_")) {
    sessions[phone].date = id.replace("date_", "");
    await sendTimeButtons(phone);
  }

  if (id.startsWith("time_")) {
    sessions[phone].time = id.replace("time_", "");
    await sendConfirmation(phone);
  }

  if (id === "confirm") {
    await sendText(phone, "🎉 Booking confirmed!");
    delete sessions[phone];
  }
}

/**
 * ============================
 * 5. WHATSAPP UI MESSAGES
 * ============================
 */
async function sendDateList(phone) {
  await sendInteractive(phone, {
    type: "list",
    body: {
      text: "📅 Choose a date"
    },
    action: {
      button: "Select date",
      sections: [
        {
          title: "Available dates",
          rows: [
            { id: "date_2026-01-27", title: "Tomorrow" },
            { id: "date_2026-01-28", title: "Wed Jan 28" }
          ]
        }
      ]
    }
  });
}

async function sendTimeButtons(phone) {
  await sendInteractive(phone, {
    type: "button",
    body: {
      text: "⏰ Choose a time"
    },
    action: {
      buttons: [
        {
          type: "reply",
          reply: { id: "time_17_00", title: "5:00 PM" }
        },
        {
          type: "reply",
          reply: { id: "time_17_30", title: "5:30 PM" }
        }
      ]
    }
  });
}

async function sendConfirmation(phone) {
  await sendInteractive(phone, {
    type: "button",
    body: {
      text: "✅ Confirm booking?"
    },
    action: {
      buttons: [
        {
          type: "reply",
          reply: { id: "confirm", title: "Confirm" }
        }
      ]
    }
  });
}

/**
 * ============================
 * 6. SEND WHATSAPP MESSAGES
 * ============================
 */
async function sendText(phone, text) {
  try {
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
  } catch (err) {
    console.error(
      "WhatsApp text error:",
      err.response?.data || err.message
    );
  }
}

async function sendInteractive(phone, interactive) {
  try {
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
  } catch (err) {
    console.error(
      "WhatsApp interactive error:",
      err.response?.data || err.message
    );
  }
}

/**
 * ============================
 * 7. START SERVER
 * ============================
 */
app.listen(process.env.PORT || 3000, () => {
  console.log("✅ WhatsApp bot running");
});
