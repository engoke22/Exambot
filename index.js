
const BOT_NAME = "KCSE PAST PAPERS";
const MAX_RESULTS = 15;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/") {
      return new Response("KCSE Past Papers service is running.");
    }

    if (request.method !== "POST" || url.pathname !== "/telegram") {
      return new Response("Not found", { status: 404 });
    }

    if (!env.BOT_TOKEN || !env.BOT_KV || !env.ADMIN_ID) {
      return new Response("Missing configuration", { status: 500 });
    }

    if (env.WEBHOOK_SECRET) {
      const secret = request.headers.get(
        "X-Telegram-Bot-Api-Secret-Token"
      );

      if (secret !== env.WEBHOOK_SECRET) {
        return new Response("Unauthorized", { status: 401 });
      }
    }

    let update;

    try {
      update = await request.json();
    } catch {
      return new Response("Invalid request", { status: 400 });
    }

    try {
      if (update.message) {
        await handleMessage(update.message, env);
      }
    } catch (error) {
      console.error("Bot error:", error);
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

  if (/^\/start(?:@\w+)?(?:\s|$)/i.test(text)) {
    return showMenu(chatId, user, env);
  }

  if (/^\/help(?:@\w+)?(?:\s|$)/i.test(text)) {
    return showHelp(chatId, env, isAdmin);
  }

  if (/^\/papers(?:@\w+)?(?:\s|$)/i.test(text)) {
    return listPapers(chatId, env);
  }

  if (/^\/search(?:@\w+)?(?:\s|$)/i.test(text)) {
    const query = text.replace(/^\/search(?:@\w+)?/i, "").trim();

    if (!query) {
      return sendMessage(
        env,
        chatId,
        "Usage: /search Mathematics 2023"
      );
    }

    return searchPapers(chatId, query, env);
  }

  if (/^\/delete(?:@\w+)?(?:\s|$)/i.test(text)) {
    if (!isAdmin) {
      return sendMessage(env, chatId, "Access denied. Administrator only.");
    }

    const id = text.replace(/^\/delete(?:@\w+)?/i, "").trim();

    if (!id) {
      return sendMessage(
        env,
        chatId,
        "Usage: /delete PAPER_ID\nFind the ID using /papers."
      );
    }

    const key = `paper:${id}`;
    const paper = await env.BOT_KV.get(key, "json");

    if (!paper) {
      return sendMessage(env, chatId, "Paper not found.");
    }

    await env.BOT_KV.delete(key);

    return sendMessage(env, chatId, `Deleted paper ${id}.`);
  }

  const isPhoto = Array.isArray(message.photo) && message.photo.length > 0;
  const isDocument = Boolean(message.document);

  if (isPhoto || isDocument) {
    if (!isAdmin) {
      return sendMessage(
        env,
        chatId,
        "Only the administrator can upload KCSE resources."
      );
    }

    return savePaper(message, env);
  }

  if (text) {
    return sendMessage(
      env,
      chatId,
      "Please use the menu commands to find KCSE resources.\nSend /start to begin."
    );
  }
}

async function showMenu(chatId, user, env) {
  const name = escapeHTML(user.first_name || "Student");
  const isAdmin = String(user.id) === String(env.ADMIN_ID);

  let menu =
    `<b>${BOT_NAME}</b>\n` +
    `KCSE Revision Resources\n\n` +
    `Welcome, ${name}.\n\n` +
    `<b>MAIN MENU</b>\n` +
    `/papers - Browse available papers\n` +
    `/search SUBJECT YEAR - Search papers\n` +
    `/help - Instructions\n`;

  if (isAdmin) {
    menu +=
      `\n<b>ADMINISTRATION</b>\n` +
      `Upload a PDF or image with its details in the caption.\n` +
      `/delete PAPER_ID - Remove a resource\n`;
  }

  menu +=
    `\nSearch, revise and prepare for your KCSE examinations.`;

  return sendMessage(env, chatId, menu, {
    parse_mode: "HTML"
  });
}

async function showHelp(chatId, env, isAdmin) {
  let help =
    `<b>KCSE PAST PAPERS — HELP</b>\n\n` +
    `/start — Main menu\n` +
    `/papers — Browse resources\n` +
    `/search Mathematics 2023 — Search by subject and year\n\n` +
    `<b>Available resources</b>\n` +
    `• KCSE past papers\n` +
    `• Marking schemes\n` +
    `• Scanned exam pages and images\n`;

  if (isAdmin) {
    help +=
      `\n<b>ADMIN UPLOAD FORMAT</b>\n` +
      `Subject | Year | Paper | Type\n\n` +
      `Example:\n` +
      `Mathematics | 2023 | Paper 1 | Past Paper\n\n` +
      `You may upload a PDF or an image. Add the caption before sending.`;
  }

  return sendMessage(env, chatId, help, {
    parse_mode: "HTML"
  });
}

async function savePaper(message, env) {
  const chatId = message.chat.id;
  const caption = (message.caption || "").trim();

  let fileId;
  let filename;
  let mediaType;

  if (message.photo?.length) {
    // Telegram photos are provided in multiple sizes.
    const photo = message.photo[message.photo.length - 1];

    fileId = photo.file_id;
    filename = "kcse-scan.jpg";
    mediaType = "photo";
  } else if (message.document) {
    const doc = message.document;
    const mime = (doc.mime_type || "").toLowerCase();

    const allowed =
      mime === "application/pdf" ||
      mime === "image/jpeg" ||
      mime === "image/png" ||
      mime === "image/webp";

    if (!allowed) {
      return sendMessage(
        env,
        chatId,
        "Unsupported file type. Upload a PDF, JPG, PNG or WEBP image."
      );
    }

    fileId = doc.file_id;
    filename = doc.file_name || "kcse-resource";
    mediaType = "document";
  } else {
    return;
  }

  if (!caption) {
    return sendMessage(
      env,
      chatId,
      "Please add the resource details as the caption.\n\n" +
      "Example:\nMathematics | 2023 | Paper 1 | Past Paper"
    );
  }

  const parts = caption.split("|").map(value => value.trim());

  if (
    parts.length < 3 ||
    parts.length > 4 ||
    parts.some(value => !value)
  ) {
    return sendMessage(
      env,
      chatId,
      "Invalid caption format.\n\n" +
      "Use:\nSubject | Year | Paper | Type\n\n" +
      "Example:\nEnglish | 2022 | Paper 2 | Marking Scheme"
    );
  }

  const [subject, year, paper, type = "Past Paper"] = parts;

  if (!/^\d{4}$/.test(year) || Number(year) < 1960 || Number(year) > 2099) {
    return sendMessage(
      env,
      chatId,
      "Enter a valid four-digit examination year."
    );
  }

  const id = crypto.randomUUID().slice(0, 8);

  const resource = {
    id,
    subject,
    year,
    paper,
    type,
    filename,
    fileId,
    mediaType,
    uploadedBy: String(message.from.id),
    createdAt: new Date().toISOString()
  };

  await env.BOT_KV.put(
    `paper:${id}`,
    JSON.stringify(resource)
  );

  return sendMessage(
    env,
    chatId,
    `<b>RESOURCE SAVED</b>\n\n` +
    `ID: <code>${id}</code>\n` +
    `Subject: ${escapeHTML(subject)}\n` +
    `Year: ${year}\n` +
    `Paper: ${escapeHTML(paper)}\n` +
    `Type: ${escapeHTML(type)}\n` +
    `Format: ${mediaType === "photo" ? "Image" : "File"}\n\n` +
    `The resource is now available to students.`,
    { parse_mode: "HTML" }
  );
}

async function allPapers(env) {
  const papers = [];
  let cursor;

  do {
    const options = { prefix: "paper:", limit: 100 };

    if (cursor) options.cursor = cursor;

    const page = await env.BOT_KV.list(options);

    for (const key of page.keys) {
      const item = await env.BOT_KV.get(key.name, "json");
      if (item) papers.push(item);
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
    return sendMessage(
      env,
      chatId,
      "No KCSE resources have been uploaded yet. Please check again later."
    );
  }

  await sendMessage(
    env,
    chatId,
    `KCSE PAST PAPERS\nAvailable resources: ${papers.length}\nShowing the latest ${Math.min(papers.length, MAX_RESULTS)}.`
  );

  for (const paper of papers.slice(0, MAX_RESULTS)) {
    await sendPaper(chatId, paper, env);
  }
}

async function searchPapers(chatId, query, env) {
  const papers = await allPapers(env);
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);

  const matches = papers.filter(item => {
    const searchable = [
      item.subject,
      item.year,
      item.paper,
      item.type,
      item.filename
    ].join(" ").toLowerCase();

    return terms.every(term => searchable.includes(term));
  });

  if (!matches.length) {
    return sendMessage(
      env,
      chatId,
      `No KCSE resources found for "${query}". Try a subject or year.`
    );
  }

  await sendMessage(
    env,
    chatId,
    `Search results: ${matches.length}\nShowing up to ${MAX_RESULTS} resources.`
  );

  for (const paper of matches.slice(0, MAX_RESULTS)) {
    await sendPaper(chatId, paper, env);
  }
}

async function sendPaper(chatId, paper, env) {
  const caption =
    `Subject: ${paper.subject}\n` +
    `Year: ${paper.year}\n` +
    `Paper: ${paper.paper}\n` +
    `Type: ${paper.type}\n` +
    `Resource ID: ${paper.id}`;

  if (paper.mediaType === "photo") {
    return telegram(env, "sendPhoto", {
      chat_id: chatId,
      photo: paper.fileId,
      caption
    });
  }

  return telegram(env, "sendDocument", {
    chat_id: chatId,
    document: paper.fileId,
    caption
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
    console.error(`Telegram ${method} failed:`, result);
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
  
