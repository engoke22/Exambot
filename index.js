
const BOT_NAME = "EXAM BOT";
const MAX_RESULTS = 15;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/") {
      return new Response("Exam Bot is running.", {
        headers: { "content-type": "text/plain" }
      });
    }

    if (url.pathname !== "/telegram" || request.method !== "POST") {
      return new Response("Not found", { status: 404 });
    }

    if (!env.BOT_TOKEN || !env.BOT_KV || !env.ADMIN_ID) {
      return new Response("Missing Worker configuration", {
        status: 500
      });
    }

    if (env.WEBHOOK_SECRET) {
      const suppliedSecret = request.headers.get(
        "X-Telegram-Bot-Api-Secret-Token"
      );

      if (suppliedSecret !== env.WEBHOOK_SECRET) {
        return new Response("Unauthorized", { status: 401 });
      }
    }

    let update;

    try {
      update = await request.json();
    } catch {
      return new Response("Invalid JSON", { status: 400 });
    }

    try {
      if (update.message) {
        await handleMessage(update.message, env);
      } else if (update.callback_query) {
        await handleCallback(update.callback_query, env);
      }
    } catch (error) {
      console.error("Update handling failed:", error);
    }

    return new Response("OK");
  }
};

async function handleMessage(message, env) {
  const chatId = message.chat?.id;
  const user = message.from;

  if (!chatId || !user) return;

  const text = (message.text || "").trim();
  const isAdmin = String(user.id) === String(env.ADMIN_ID);

  if (text.startsWith("/start") || text.startsWith("/help")) {
    return showMenu(chatId, user, env);
  }

  if (text === "/papers" || text.startsWith("/papers ")) {
    return listPapers(chatId, env);
  }

  if (text.startsWith("/search")) {
    const query = text.slice(7).trim();

    if (!query) {
      return sendMessage(
        env,
        chatId,
        "🔎 Usage: /search COM 212\nYou can also search by year, semester, or paper type."
      );
    }

    return searchPapers(chatId, query, env);
  }

  if (text.startsWith("/delete")) {
    if (!isAdmin) {
      return sendMessage(env, chatId, "⛔ Only the bot administrator can delete papers.");
    }

    const id = text.split(/\s+/)[1];

    if (!id) {
      return sendMessage(
        env,
        chatId,
        "Usage: /delete PAPER_ID\nFind paper IDs using /papers."
      );
    }

    const key = `paper:${id}`;
    const paper = await env.BOT_KV.get(key, "json");

    if (!paper) {
      return sendMessage(env, chatId, "Paper not found. Check its ID using /papers.");
    }

    await env.BOT_KV.delete(key);

    return sendMessage(
      env,
      chatId,
      `✅ Deleted paper ${escapeHTML(id)}.`
    );
  }

  if (message.document) {
    if (!isAdmin) {
      return sendMessage(
        env,
        chatId,
        "⛔ Only the bot administrator can upload papers."
      );
    }

    return savePaper(message, env);
  }

  if (text) {
    return sendMessage(
      env,
      chatId,
      "I didn't recognize that command.\n\nUse /start to open the menu or /help for instructions."
    );
  }
}

async function showMenu(chatId, user, env) {
  const name = escapeHTML(user?.first_name || "Student");
  const isAdmin = String(user?.id) === String(env.ADMIN_ID);

  let menu =
    `╔═══〔 📚 <b>${BOT_NAME}</b> 〕═══╗\n` +
    `║\n` +
    `║ 👋 Hello, ${name}!\n` +
    `║ Welcome to your exam resource centre.\n` +
    `║\n` +
    `╠═══〔 📄 <b>PAST PAPERS</b> 〕═══╣\n` +
    `║ ➩ /papers\n` +
    `║ ➩ /search COM 212\n` +
    `║ ➩ /search 2025\n` +
    `║\n` +
    `╠═══〔 🎓 <b>RESOURCES</b> 〕═══╣\n` +
    `║ ➩ /help\n` +
    `║ ➩ /start\n`;

  if (isAdmin) {
    menu +=
      `║\n` +
      `╠═══〔 👑 <b>ADMIN MENU</b> 〕═══╣\n` +
      `║ ➩ Send a PDF with its details as caption\n` +
      `║ ➩ /delete PAPER_ID\n`;
  }

  menu +=
    `║\n` +
    `╚════════════════════╝\n` +
    `<i>Your studies, your success.</i>`;

  return telegram(env, "sendMessage", {
    chat_id: chatId,
    text: menu,
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [
        [
          { text: "📚 Browse Papers", callback_data: "menu_papers" },
          { text: "🔎 Search Help", callback_data: "menu_search" }
        ],
        [
          { text: "ℹ️ Help", callback_data: "menu_help" }
        ]
      ]
    }
  });
}

async function handleCallback(callback, env) {
  const chatId = callback.message?.chat?.id;
  const user = callback.from;
  const data = callback.data;

  await telegram(env, "answerCallbackQuery", {
    callback_query_id: callback.id
  });

  if (!chatId || !user) return;

  if (data === "menu_home") {
    return showMenu(chatId, user, env);
  }

  if (data === "menu_papers") {
    return listPapers(chatId, env);
  }

  if (data === "menu_search") {
    return sendMessage(
      env,
      chatId,
      "🔎 <b>How to search</b>\n\n" +
      "Search by unit: /search COM 212\n" +
      "Search by year: /search 2025\n" +
      "Search by semester: /search Semester 1\n" +
      "Search by type: /search CAT",
      {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [[
            { text: "🏠 Main Menu", callback_data: "menu_home" }
          ]]
        }
      }
    );
  }

  if (data === "menu_help") {
    return sendMessage(
      env,
      chatId,
      "📘 <b>Exam Bot Help</b>\n\n" +
      "/start — Open the main menu\n" +
      "/papers — Browse available papers\n" +
      "/search COM 212 — Search papers\n\n" +
      "Papers are provided as Telegram document links.",
      {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [[
            { text: "🏠 Main Menu", callback_data: "menu_home" }
          ]]
        }
      }
    );
  }
}

async function savePaper(message, env) {
  const document = message.document;
  const caption = (message.caption || "").trim();

  if (document.mime_type !== "application/pdf") {
    return sendMessage(
      env,
      message.chat.id,
      "Please upload a PDF file."
    );
  }

  if (!caption) {
    return sendMessage(
      env,
      message.chat.id,
      "Add a caption in this format:\n\nCOM 212 | 2025 | Semester 1 | CAT"
    );
  }

  const parts = caption.split("|").map(part => part.trim());

  if (parts.length < 3 || parts.some(part => !part)) {
    return sendMessage(
      env,
      message.chat.id,
      "Invalid caption format.\n\nUse:\nCOM 212 | 2025 | Semester 1 | CAT"
    );
  }

  const [unit, year, semester, type = "Past Paper"] = parts;

  if (!/^\d{4}$/.test(year)) {
    return sendMessage(env, message.chat.id, "The year must have four digits, for example 2025.");
  }

  const id = crypto.randomUUID().slice(0, 8);

  const paper = {
    id,
    unit,
    year,
    semester,
    type,
    filename: document.file_name || "paper.pdf",
    fileId: document.file_id,
    uploadedBy: String(message.from.id),
    createdAt: new Date().toISOString()
  };

  await env.BOT_KV.put(`paper:${id}`, JSON.stringify(paper));

  return sendMessage(
    env,
    message.chat.id,
    "✅ <b>Paper saved successfully!</b>\n\n" +
    `🆔 ID: <code>${id}</code>\n` +
    `📘 Unit: ${escapeHTML(unit)}\n` +
    `📅 Year: ${escapeHTML(year)}\n` +
    `📚 Semester: ${escapeHTML(semester)}\n` +
    `📝 Type: ${escapeHTML(type)}\n\n` +
    "Students can now find it using /papers or /search.",
    { parse_mode: "HTML" }
  );
}

async function allPapers(env) {
  const papers = [];
  let cursor;

  do {
    const page = await env.BOT_KV.list({
      prefix: "paper:",
      cursor,
      limit: 100
    });

    for (const key of page.keys) {
      const paper = await env.BOT_KV.get(key.name, "json");
      if (paper) papers.push(paper);
    }

    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  return papers.sort((a, b) =>
    String(b.createdAt).localeCompare(String(a.createdAt))
  );
}

async function listPapers(chatId, env) {
  const papers = await allPapers(env);

  if (!papers.length) {
    return sendMessage(env, chatId, "📭 No papers have been uploaded yet.");
  }

  const selected = papers.slice(0, MAX_RESULTS);

  for (const paper of selected) {
    await sendPaper(chatId, paper, env);
  }

  if (papers.length > MAX_RESULTS) {
    await sendMessage(
      env,
      chatId,
      `Showing the latest ${MAX_RESULTS} papers. Search for a specific unit or year to narrow the results.`
    );
  }
}

async function searchPapers(chatId, query, env) {
  const papers = await allPapers(env);
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);

  const matches = papers.filter(paper => {
    const haystack = [
      paper.id,
      paper.unit,
      paper.year,
      paper.semester,
      paper.type,
      paper.filename
    ].join(" ").toLowerCase();

    return terms.every(term => haystack.includes(term));
  });

  if (!matches.length) {
    return sendMessage(
      env,
      chatId,
      `No papers found for "${escapeHTML(query)}". Try a unit code or year.`
    );
  }

  for (const paper of matches.slice(0, MAX_RESULTS)) {
    await sendPaper(chatId, paper, env);
  }

  if (matches.length > MAX_RESULTS) {
    await sendMessage(
      env,
      chatId,
      `Found ${matches.length} papers. Showing the first ${MAX_RESULTS}.`
    );
  }
}

async function sendPaper(chatId, paper, env) {
  return telegram(env, "sendDocument", {
    chat_id: chatId,
    document: paper.fileId,
    caption:
      `📘 ${paper.unit}\n` +
      `📅 Year: ${paper.year}\n` +
      `📚 Semester: ${paper.semester}\n` +
      `📝 Type: ${paper.type}\n` +
      `🆔 ID: ${paper.id}`
  });
}

async function sendMessage(env, chatId, text, extra = {}) {
  return telegram(env, "sendMessage", {
    chat_id: chatId,
    text,
    ...extra
  });
}

async function telegram(env, method, payload) {
  const response = await fetch(
    `https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    }
  );

  const result = await response.json();

  if (!result.ok) {
    console.error(`Telegram ${method} error:`, result);
  }

  return result;
}

function escapeHTML(value) {
  return String(value ?? "").replace(/[&<>"']/g, character => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[character]);
                                          }
