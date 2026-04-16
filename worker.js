//
//  ───────────────────────────────────────────────────
//   ☁️ Cloudflare Worker :: TG-RelayX v0.0.1
//  ───────────────────────────────────────────────────
//   >> Author: Prince 👑 2026.4
//  ───────────────────────────────────────────────────
//

const CONFIG = {
    VERIFY_ID_LENGTH: 12,
    VERIFY_EXPIRE_SECONDS: 300,
    VERIFIED_EXPIRE_SECONDS: 2592000,
    MEDIA_GROUP_EXPIRE_SECONDS: 60,
    MEDIA_GROUP_DELAY_MS: 3000,
    PENDING_MAX_MESSAGES: 10,
    ADMIN_CACHE_TTL_SECONDS: 300,
    NEEDS_REVERIFY_TTL_SECONDS: 600,
    RATE_LIMIT_MESSAGE: 45,
    RATE_LIMIT_VERIFY: 3,
    RATE_LIMIT_WINDOW: 60,
    BUTTON_COLUMNS: 2,
    MAX_TITLE_LENGTH: 128,
    MAX_NAME_LENGTH: 30,
    API_TIMEOUT_MS: 10000,
    CLEANUP_BATCH_SIZE: 10,
    MAX_CLEANUP_DISPLAY: 20,
    CLEANUP_LOCK_TTL_SECONDS: 1800,
    MAX_RETRY_ATTEMPTS: 3,
    THREAD_HEALTH_TTL_MS: 60000,
    AUTO_DELETE_SECONDS: 1800,
    AUTO_DELETE_BATCH_SIZE: 50,
    INFO_CARD_ENABLED: true,
};

const threadHealthCache  = new Map();
const topicCreateInFlight = new Map();
const adminStatusCache   = new Map();

// ─── Unicode fancy font (Mathematical Bold Script) ────────────────
function f(text) {
    return [...String(text)].map(char => {
        const code = char.charCodeAt(0);
        if (code >= 65 && code <= 90)  return String.fromCodePoint(0x1D4D0 + (code - 65));
        if (code >= 97 && code <= 122) return String.fromCodePoint(0x1D4EA + (code - 97));
        return char;
    }).join('');
}
const textToFancyUnicode = f;

// ─── Verification question bank ───────────────────────────────────
const LOCAL_QUESTIONS = [
    { question: "What is 13 + 9?",           correct_answer: "22",        incorrect_answers: ["20", "21", "23"] },
    { question: "What is 7 × 8?",            correct_answer: "56",        incorrect_answers: ["48", "54", "63"] },
    { question: "What is 100 ÷ 4?",          correct_answer: "25",        incorrect_answers: ["20", "24", "30"] },
    { question: "What is 15 - 7?",           correct_answer: "8",         incorrect_answers: ["6", "7", "9"] },
    { question: "What is 6² (6 squared)?",   correct_answer: "36",        incorrect_answers: ["12", "30", "42"] },
    { question: "What is 3 × 3 × 3?",        correct_answer: "27",        incorrect_answers: ["9", "18", "33"] },
    { question: "If x + 5 = 12, what is x?", correct_answer: "7",         incorrect_answers: ["5", "6", "8"] },
    { question: "Which shape has 3 sides?",   correct_answer: "Triangle",  incorrect_answers: ["Circle", "Square", "Pentagon"] },
    { question: "Which number comes next: 2, 4, 8, 16, __?", correct_answer: "32", incorrect_answers: ["18", "24", "20"] },
    { question: "All cats are animals. Tom is a cat. Is Tom an animal?", correct_answer: "Yes", incorrect_answers: ["No", "Maybe", "Sometimes"] },
    { question: "Which is the odd one out: Apple, Banana, Carrot, Mango?", correct_answer: "Carrot", incorrect_answers: ["Apple", "Banana", "Mango"] },
    { question: "If today is Monday, what day is the day after tomorrow?", correct_answer: "Wednesday", incorrect_answers: ["Tuesday", "Thursday", "Sunday"] },
    { question: "What is the opposite of 'hot'?", correct_answer: "Cold",    incorrect_answers: ["Warm", "Dry", "Dark"] },
    { question: "Which word means 'very happy'?",  correct_answer: "Joyful",  incorrect_answers: ["Angry", "Sad", "Tired"] },
    { question: "What do we call baby dogs?",       correct_answer: "Puppies", incorrect_answers: ["Kittens", "Calves", "Chicks"] },
    { question: "How many days are in a week?",     correct_answer: "7",       incorrect_answers: ["5", "6", "8"] },
    { question: "Which planet is closest to the Sun?", correct_answer: "Mercury", incorrect_answers: ["Venus", "Earth", "Mars"] },
    { question: "What color do you get mixing blue and yellow?", correct_answer: "Green", incorrect_answers: ["Purple", "Orange", "Brown"] },
    { question: "How many months have 31 days?",    correct_answer: "7",       incorrect_answers: ["5", "6", "8"] },
    { question: "Which animal is known as the 'King of the Jungle'?", correct_answer: "Lion", incorrect_answers: ["Tiger", "Elephant", "Cheetah"] },
];

// ─── D1 message storage ───────────────────────────────────────────
async function d1SaveMessage(env, userId, chatId, messageId, expireSeconds = CONFIG.AUTO_DELETE_SECONDS) {
    if (!env.DB) return;
    const now = Math.floor(Date.now() / 1000);
    try {
        await env.DB.prepare(
            `INSERT INTO messages (user_id, chat_id, message_id, created_at, expire_at) VALUES (?, ?, ?, ?, ?)`
        ).bind(String(userId), String(chatId), Number(messageId), now, now + expireSeconds).run();
    } catch (e) {
        Logger.error('d1_save_failed', e, { userId, chatId, messageId });
    }
}

async function d1PopUserMessages(env, userId, chatId) {
    if (!env.DB) return [];
    try {
        const rows = await env.DB.prepare(
            `SELECT message_id FROM messages WHERE user_id = ? AND chat_id = ?`
        ).bind(String(userId), String(chatId)).all();
        const ids = (rows.results || []).map(r => r.message_id);
        if (ids.length > 0) {
            await env.DB.prepare(
                `DELETE FROM messages WHERE user_id = ? AND chat_id = ?`
            ).bind(String(userId), String(chatId)).run();
        }
        return ids;
    } catch (e) {
        Logger.error('d1_pop_user_failed', e, { userId });
        return [];
    }
}

async function d1DeleteExpiredMessages(env) {
    if (!env.DB) return { deleted: 0 };
    const now = Math.floor(Date.now() / 1000);
    let totalDeleted = 0;
    try {
        let hasMore = true;
        while (hasMore) {
            const rows = await env.DB.prepare(
                `SELECT id, chat_id, message_id FROM messages WHERE expire_at <= ? LIMIT ?`
            ).bind(now, CONFIG.AUTO_DELETE_BATCH_SIZE).all();
            const batch = rows.results || [];
            if (batch.length === 0) { hasMore = false; break; }
            await Promise.allSettled(
                batch.map(row => tgCall(env, "deleteMessage", { chat_id: row.chat_id, message_id: row.message_id }))
            );
            const ids = batch.map(r => r.id).join(",");
            await env.DB.prepare(`DELETE FROM messages WHERE id IN (${ids})`).run();
            totalDeleted += batch.length;
            hasMore = batch.length === CONFIG.AUTO_DELETE_BATCH_SIZE;
            if (hasMore) await new Promise(r => setTimeout(r, 100));
        }
        Logger.info('auto_delete_completed', { totalDeleted });
        return { deleted: totalDeleted };
    } catch (e) {
        Logger.error('d1_expire_delete_failed', e);
        return { deleted: totalDeleted, error: e.message };
    }
}

// ─── Compact user info card (Telegram native preview style) ───────
async function sendUserInfoCard(from, threadId, env) {
    const userId    = from.id;
    const firstName = (from.first_name || "").trim();
    const lastName  = (from.last_name  || "").trim();
    const fullName  = [firstName, lastName].filter(Boolean).join(" ") || "User";
    const username  = from.username ? `@${from.username}` : f("—");
    const langCode  = from.language_code ? from.language_code.toUpperCase() : "—";

    const header  = `🫧  ${f("New Contact")}`;
    const line1   = `[${fullName}](tg://user?id=${userId})  ·  ${username}`;
    const line2   = `🆔 \`${userId}\`  ·  🌐 ${langCode}`;
    const cardText = `${header}\n${line1}\n${line2}`;

    await tgCall(env, "sendMessage", {
        chat_id:                  env.SUPERGROUP_ID,
        message_thread_id:        threadId,
        text:                     cardText,
        parse_mode:               "Markdown",
        disable_web_page_preview: true,
        reply_markup: {
            inline_keyboard: [[
                { text: `👤  ${f("View Profile")}`, url: `tg://user?id=${userId}` }
            ]]
        }
    });
}

// ─── Welcome message (/start only — no verification trigger) ──────
async function sendWelcomeMessage(userId, env) {
    const bar = `✦  ·  ✦  ·  ✦  ·  ✦  ·  ✦  ·  ✦`;
    const text =
        `${bar}\n\n` +
        `        ✨  *${f("Welcome")}*  ✨\n\n` +
        `${bar}\n\n` +
        `  ${f("Secure private messaging relay.")}\n\n` +
        `📨  ${f("Text · Photo · File · Voice")}\n` +
        `  ${f("All message types supported.")}\n\n` +
        `🔒  ${f("Your identity is fully protected.")}\n\n` +
        `💬  ${f("Send a message to get started.")}\n\n` +
        `${bar}`;

    await tgCall(env, "sendMessage", {
        chat_id:    userId,
        text,
        parse_mode: "Markdown"
    });
}

// ─── Logger ───────────────────────────────────────────────────────
const Logger = {
    info(action, data = {})  { console.log(JSON.stringify({ timestamp: new Date().toISOString(), level: 'INFO',  action, ...data })); },
    warn(action, data = {})  { console.warn(JSON.stringify({ timestamp: new Date().toISOString(), level: 'WARN',  action, ...data })); },
    error(action, error, data = {}) {
        console.error(JSON.stringify({
            timestamp: new Date().toISOString(), level: 'ERROR', action,
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack  : undefined,
            ...data
        }));
    },
    debug(action, data = {}) { console.log(JSON.stringify({ timestamp: new Date().toISOString(), level: 'DEBUG', action, ...data })); }
};

// ─── Crypto utilities ─────────────────────────────────────────────
function secureRandomInt(min, max) {
    const bytes = new Uint32Array(1);
    crypto.getRandomValues(bytes);
    return min + (bytes[0] % (max - min));
}

function secureRandomId(length = 12) {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    const bytes = new Uint8Array(length);
    crypto.getRandomValues(bytes);
    return Array.from(bytes).map(b => chars[b % chars.length]).join('');
}

// ─── KV helpers ───────────────────────────────────────────────────
async function safeGetJSON(env, key, defaultValue = null) {
    try {
        const data = await env.TOPIC_MAP.get(key, { type: "json" });
        if (data === null || data === undefined) return defaultValue;
        if (typeof data !== 'object') { Logger.warn('kv_invalid_type', { key, type: typeof data }); return defaultValue; }
        return data;
    } catch (e) {
        Logger.error('kv_parse_failed', e, { key });
        return defaultValue;
    }
}

async function getAllKeys(env, prefix) {
    const allKeys = [];
    let cursor;
    do {
        const result = await env.TOPIC_MAP.list({ prefix, cursor });
        allKeys.push(...result.keys);
        cursor = result.list_complete ? undefined : result.cursor;
    } while (cursor);
    return allKeys;
}

// ─── Topic utilities ──────────────────────────────────────────────
function normalizeTgDescription(description) {
    return (description || "").toString().toLowerCase();
}

function isTopicMissingOrDeleted(description) {
    const desc = normalizeTgDescription(description);
    return desc.includes("thread not found")       ||
           desc.includes("topic not found")        ||
           desc.includes("message thread not found") ||
           desc.includes("topic deleted")          ||
           desc.includes("thread deleted")         ||
           desc.includes("forum topic not found")  ||
           desc.includes("topic closed permanently");
}

function isTestMessageInvalid(description) {
    const desc = normalizeTgDescription(description);
    return desc.includes("message text is empty") ||
           desc.includes("bad request: message text is empty");
}

async function getOrCreateUserTopicRec(from, key, env, userId) {
    const existing = await safeGetJSON(env, key, null);
    if (existing && existing.thread_id) return existing;

    const inflight = topicCreateInFlight.get(String(userId));
    if (inflight) return await inflight;

    const p = (async () => {
        const again = await safeGetJSON(env, key, null);
        if (again && again.thread_id) return again;
        return await createTopic(from, key, env, userId);
    })();

    topicCreateInFlight.set(String(userId), p);
    try { return await p; }
    finally {
        if (topicCreateInFlight.get(String(userId)) === p) topicCreateInFlight.delete(String(userId));
    }
}

function withMessageThreadId(body, threadId) {
    if (threadId === undefined || threadId === null) return body;
    return { ...body, message_thread_id: threadId };
}

async function probeForumThread(env, expectedThreadId, { userId, reason, doubleCheckOnMissingThreadId = true } = {}) {
    const attemptOnce = async () => {
        const res = await tgCall(env, "sendMessage", {
            chat_id: env.SUPERGROUP_ID, message_thread_id: expectedThreadId, text: "🔎"
        });
        const actualThreadId = res.result?.message_thread_id;
        const probeMessageId = res.result?.message_id;
        if (res.ok && probeMessageId) {
            try { await tgCall(env, "deleteMessage", { chat_id: env.SUPERGROUP_ID, message_id: probeMessageId }); } catch (_) {}
        }
        if (!res.ok) {
            if (isTopicMissingOrDeleted(res.description)) return { status: "missing",       description: res.description };
            if (isTestMessageInvalid(res.description))    return { status: "probe_invalid",  description: res.description };
            return { status: "unknown_error", description: res.description };
        }
        if (actualThreadId === undefined || actualThreadId === null) return { status: "missing_thread_id" };
        if (Number(actualThreadId) !== Number(expectedThreadId))     return { status: "redirected", actualThreadId };
        return { status: "ok" };
    };

    const first = await attemptOnce();
    if (first.status !== "missing_thread_id" || !doubleCheckOnMissingThreadId) return first;
    const second = await attemptOnce();
    if (second.status === "missing_thread_id") Logger.warn('thread_probe_missing_thread_id', { userId, expectedThreadId, reason });
    return second;
}

async function resetUserVerificationAndRequireReverify(env, { userId, userKey, oldThreadId, pendingMsgId, reason }) {
    await env.TOPIC_MAP.delete(`verified:${userId}`);
    await env.TOPIC_MAP.put(`needs_verify:${userId}`, "1", { expirationTtl: CONFIG.NEEDS_REVERIFY_TTL_SECONDS });
    await env.TOPIC_MAP.delete(`retry:${userId}`);
    if (userKey) await env.TOPIC_MAP.delete(userKey);
    if (oldThreadId !== undefined && oldThreadId !== null) {
        await env.TOPIC_MAP.delete(`thread:${oldThreadId}`);
        await env.TOPIC_MAP.delete(`thread_ok:${oldThreadId}`);
        threadHealthCache.delete(oldThreadId);
    }
    Logger.info('verification_reset_due_to_topic_loss', { userId, oldThreadId, pendingMsgId, reason });
    await sendVerificationChallenge(userId, env, pendingMsgId || null);
}

// ─── Admin helpers ────────────────────────────────────────────────
function parseAdminIdAllowlist(env) {
    const raw = (env.ADMIN_IDS || "").toString().trim();
    if (!raw) return null;
    const ids = raw.split(/[,;\s]+/g).map(s => s.trim()).filter(Boolean);
    const set = new Set();
    for (const id of ids) { const n = Number(id); if (Number.isFinite(n)) set.add(String(n)); }
    return set.size > 0 ? set : null;
}

async function isAdminUser(env, userId) {
    const allowlist = parseAdminIdAllowlist(env);
    if (allowlist && allowlist.has(String(userId))) return true;
    const cacheKey = String(userId);
    const now = Date.now();
    const cached = adminStatusCache.get(cacheKey);
    if (cached && (now - cached.ts < CONFIG.ADMIN_CACHE_TTL_SECONDS * 1000)) return cached.isAdmin;
    const kvVal = await env.TOPIC_MAP.get(`admin:${userId}`);
    if (kvVal === "1" || kvVal === "0") {
        const isAdmin = kvVal === "1";
        adminStatusCache.set(cacheKey, { ts: now, isAdmin });
        return isAdmin;
    }
    try {
        const res = await tgCall(env, "getChatMember", { chat_id: env.SUPERGROUP_ID, user_id: userId });
        const status  = res.result?.status;
        const isAdmin = res.ok && (status === "creator" || status === "administrator");
        await env.TOPIC_MAP.put(`admin:${userId}`, isAdmin ? "1" : "0", { expirationTtl: CONFIG.ADMIN_CACHE_TTL_SECONDS });
        adminStatusCache.set(cacheKey, { ts: now, isAdmin });
        return isAdmin;
    } catch (_) { Logger.warn('admin_check_failed', { userId }); return false; }
}

function shuffleArray(arr) {
    const array = [...arr];
    for (let i = array.length - 1; i > 0; i--) {
        const j = secureRandomInt(0, i + 1);
        [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
}

async function checkRateLimit(userId, env, action = 'message', limit = 20, window = 60) {
    const key   = `ratelimit:${action}:${userId}`;
    const count = parseInt(await env.TOPIC_MAP.get(key) || "0");
    if (count >= limit) return { allowed: false, remaining: 0 };
    await env.TOPIC_MAP.put(key, String(count + 1), { expirationTtl: window });
    return { allowed: true, remaining: limit - count - 1 };
}

// ─── Parse command (strips @botname suffix) ───────────────────────
function parseCommand(rawText) {
    if (!rawText) return null;
    const text = rawText.trim();
    if (!text.startsWith('/')) return null;
    const match = text.match(/^\/([A-Za-z0-9_]+)(?:@\S+)?(?:\s|$)/);
    return match ? `/${match[1].toLowerCase()}` : null;
}

// ══════════════════════════════════════════════════════════════════
//  Workers entry points
// ══════════════════════════════════════════════════════════════════
export default {

    async fetch(request, env, ctx) {
        if (!env.TOPIC_MAP)     return new Response("Error: KV 'TOPIC_MAP' not bound.");
        if (!env.BOT_TOKEN)     return new Response("Error: BOT_TOKEN not set.");
        if (!env.SUPERGROUP_ID) return new Response("Error: SUPERGROUP_ID not set.");

        const normalizedEnv = {
            ...env,
            SUPERGROUP_ID: String(env.SUPERGROUP_ID),
            BOT_TOKEN:     String(env.BOT_TOKEN)
        };

        if (!normalizedEnv.SUPERGROUP_ID.startsWith("-100"))
            return new Response("Error: SUPERGROUP_ID must start with -100");

        if (request.method !== "POST") return new Response("OK");

        const contentType = request.headers.get("content-type") || "";
        if (!contentType.includes("application/json")) { Logger.warn('invalid_content_type', { contentType }); return new Response("OK"); }

        let update;
        try {
            update = await request.json();
            if (!update || typeof update !== 'object') { Logger.warn('invalid_json_structure'); return new Response("OK"); }
        } catch (e) { Logger.error('json_parse_failed', e); return new Response("OK"); }

        if (update.callback_query) {
            await handleCallbackQuery(update.callback_query, normalizedEnv, ctx);
            return new Response("OK");
        }

        const msg = update.message;
        if (!msg) return new Response("OK");

        ctx.waitUntil(flushExpiredMediaGroups(normalizedEnv, Date.now()));

        if (msg.chat && msg.chat.type === "private") {
            try {
                await handlePrivateMessage(msg, normalizedEnv, ctx);
            } catch (e) {
                await tgCall(normalizedEnv, "sendMessage", {
                    chat_id: msg.chat.id,
                    text:    `⚠️  ${f("System busy, please try again later.")}`
                });
                Logger.error('private_message_failed', e, { userId: msg.chat.id });
            }
            return new Response("OK");
        }

        if (msg.chat && String(msg.chat.id) === normalizedEnv.SUPERGROUP_ID) {
            if (msg.forum_topic_closed   && msg.message_thread_id) { await updateThreadStatus(msg.message_thread_id, true,  normalizedEnv); return new Response("OK"); }
            if (msg.forum_topic_reopened && msg.message_thread_id) { await updateThreadStatus(msg.message_thread_id, false, normalizedEnv); return new Response("OK"); }
            const text = (msg.text || "").trim();
            if (msg.message_thread_id || (!!text && text.startsWith("/"))) {
                await handleAdminReply(msg, normalizedEnv, ctx);
            }
        }

        return new Response("OK");
    },

    async scheduled(event, env, ctx) {
        const normalizedEnv = {
            ...env,
            SUPERGROUP_ID: String(env.SUPERGROUP_ID || ""),
            BOT_TOKEN:     String(env.BOT_TOKEN     || "")
        };
        ctx.waitUntil(d1DeleteExpiredMessages(normalizedEnv));
    }
};

// ══════════════════════════════════════════════════════════════════
//  Private message handler
// ══════════════════════════════════════════════════════════════════
async function handlePrivateMessage(msg, env, ctx) {
    const userId = msg.chat.id;
    const key    = `user:${userId}`;

    const rateLimit = await checkRateLimit(userId, env, 'message', CONFIG.RATE_LIMIT_MESSAGE, CONFIG.RATE_LIMIT_WINDOW);
    if (!rateLimit.allowed) {
        await tgCall(env, "sendMessage", { chat_id: userId, text: `⚠️  ${f("Too many messages, please wait.")}` });
        return;
    }

    // /start — welcome display only, no verification trigger
    if (msg.text && msg.text.trim() === "/start") {
        await sendWelcomeMessage(userId, env);
        return;
    }

    // Silently ignore all other slash commands
    if (msg.text && msg.text.startsWith("/")) return;

    // Ban check
    if (await env.TOPIC_MAP.get(`banned:${userId}`)) return;

    // Verification gate — only triggered by real messages, never by /start
    const verified = await env.TOPIC_MAP.get(`verified:${userId}`);
    if (!verified) {
        await sendVerificationChallenge(userId, env, msg.message_id);
        return;
    }

    await forwardToTopic(msg, userId, key, env, ctx);
}

// ══════════════════════════════════════════════════════════════════
//  Forward user message to supergroup topic
// ══════════════════════════════════════════════════════════════════
async function forwardToTopic(msg, userId, key, env, ctx) {
    const needsVerify = await env.TOPIC_MAP.get(`needs_verify:${userId}`);
    if (needsVerify) { await sendVerificationChallenge(userId, env, msg.message_id || null); return; }

    let rec = await safeGetJSON(env, key, null);
    if (rec && rec.closed) {
        await tgCall(env, "sendMessage", { chat_id: userId, text: `🚫  ${f("This conversation has been closed by admin.")}` });
        return;
    }

    const retryKey   = `retry:${userId}`;
    const retryCount = parseInt(await env.TOPIC_MAP.get(retryKey) || "0");
    if (retryCount > CONFIG.MAX_RETRY_ATTEMPTS) {
        await tgCall(env, "sendMessage", { chat_id: userId, text: `❌  ${f("System busy, please try again later.")}` });
        await env.TOPIC_MAP.delete(retryKey);
        return;
    }

    if (!rec || !rec.thread_id) {
        rec = await getOrCreateUserTopicRec(msg.from, key, env, userId);
        if (!rec || !rec.thread_id) throw new Error("Failed to create topic");
    }

    if (rec.thread_id) {
        const mapped = await env.TOPIC_MAP.get(`thread:${rec.thread_id}`);
        if (!mapped) await env.TOPIC_MAP.put(`thread:${rec.thread_id}`, String(userId));
    }

    // Thread health check with instance cache + KV cache
    if (rec.thread_id) {
        const cacheKey = rec.thread_id;
        const now      = Date.now();
        const cached   = threadHealthCache.get(cacheKey);
        if (!cached || (now - cached.ts >= CONFIG.THREAD_HEALTH_TTL_MS)) {
            const kvHealthKey = `thread_ok:${rec.thread_id}`;
            const kvHealthOk  = await env.TOPIC_MAP.get(kvHealthKey);
            if (kvHealthOk === "1") {
                threadHealthCache.set(cacheKey, { ts: now, ok: true });
            } else {
                const probe = await probeForumThread(env, rec.thread_id, { userId, reason: "health_check" });
                if (probe.status === "redirected" || probe.status === "missing" || probe.status === "missing_thread_id") {
                    await resetUserVerificationAndRequireReverify(env, { userId, userKey: key, oldThreadId: rec.thread_id, pendingMsgId: msg.message_id, reason: `health_check:${probe.status}` });
                    return;
                } else if (probe.status === "probe_invalid") {
                    Logger.warn('topic_health_probe_invalid', { userId, threadId: rec.thread_id });
                    threadHealthCache.set(cacheKey, { ts: now, ok: true });
                    await env.TOPIC_MAP.put(kvHealthKey, "1", { expirationTtl: Math.ceil(CONFIG.THREAD_HEALTH_TTL_MS / 1000) });
                } else if (probe.status === "unknown_error") {
                    Logger.warn('topic_health_unknown_error', { userId, threadId: rec.thread_id });
                } else {
                    await env.TOPIC_MAP.delete(retryKey);
                    threadHealthCache.set(cacheKey, { ts: now, ok: true });
                    await env.TOPIC_MAP.put(kvHealthKey, "1", { expirationTtl: Math.ceil(CONFIG.THREAD_HEALTH_TTL_MS / 1000) });
                }
            }
        }
    }

    if (msg.media_group_id) {
        await handleMediaGroup(msg, env, ctx, { direction: "p2t", targetChat: env.SUPERGROUP_ID, threadId: rec.thread_id });
        return;
    }

    const res = await tgCall(env, "forwardMessage", {
        chat_id: env.SUPERGROUP_ID, from_chat_id: userId, message_id: msg.message_id, message_thread_id: rec.thread_id
    });

    const resThreadId = res.result?.message_thread_id;
    if (res.ok && resThreadId !== undefined && resThreadId !== null && Number(resThreadId) !== Number(rec.thread_id)) {
        if (res.result?.message_id) {
            try { await tgCall(env, "deleteMessage", { chat_id: env.SUPERGROUP_ID, message_id: res.result.message_id }); } catch (_) {}
        }
        await resetUserVerificationAndRequireReverify(env, { userId, userKey: key, oldThreadId: rec.thread_id, pendingMsgId: msg.message_id, reason: "forward_redirected_to_general" });
        return;
    }

    if (res.ok && (resThreadId === undefined || resThreadId === null)) {
        const probe = await probeForumThread(env, rec.thread_id, { userId, reason: "forward_result_missing_thread_id" });
        if (probe.status !== "ok") {
            if (res.result?.message_id) {
                try { await tgCall(env, "deleteMessage", { chat_id: env.SUPERGROUP_ID, message_id: res.result.message_id }); } catch (_) {}
            }
            await resetUserVerificationAndRequireReverify(env, { userId, userKey: key, oldThreadId: rec.thread_id, pendingMsgId: msg.message_id, reason: `forward_missing_thread_id:${probe.status}` });
            return;
        }
    }

    if (!res.ok) {
        const desc = normalizeTgDescription(res.description);
        if (isTopicMissingOrDeleted(desc)) {
            await resetUserVerificationAndRequireReverify(env, { userId, userKey: key, oldThreadId: rec.thread_id, pendingMsgId: msg.message_id, reason: "forward_failed_topic_missing" });
            return;
        }
        if (desc.includes("chat not found"))    throw new Error(`SUPERGROUP_ID error: ${env.SUPERGROUP_ID}`);
        if (desc.includes("not enough rights")) throw new Error("Bot lacks Manage Topics permission");
        await tgCall(env, "copyMessage", {
            chat_id: env.SUPERGROUP_ID, from_chat_id: userId, message_id: msg.message_id, message_thread_id: rec.thread_id
        });
    }
}

// ══════════════════════════════════════════════════════════════════
//  Admin reply handler
// ══════════════════════════════════════════════════════════════════
async function handleAdminReply(msg, env, ctx) {
    const threadId = msg.message_thread_id;
    const text     = (msg.text || "").trim();
    const senderId = msg.from?.id;

    if (!senderId || !(await isAdminUser(env, senderId))) return;

    const cmd = parseCommand(text);

    if (cmd === "/cleanup") {
        ctx.waitUntil(handleCleanupCommand(threadId, env));
        return;
    }

    let userId = null;
    const mappedUser = await env.TOPIC_MAP.get(`thread:${threadId}`);
    if (mappedUser) {
        userId = Number(mappedUser);
    } else {
        const allKeys = await getAllKeys(env, "user:");
        for (const { name } of allKeys) {
            const rec = await safeGetJSON(env, name, null);
            if (rec && Number(rec.thread_id) === Number(threadId)) { userId = Number(name.slice(5)); break; }
        }
    }
    if (!userId) return;

    if (cmd === "/close") {
        const userKey = `user:${userId}`;
        const rec = await safeGetJSON(env, userKey, null);
        if (rec) {
            rec.closed = true;
            await env.TOPIC_MAP.put(userKey, JSON.stringify(rec));
            await tgCall(env, "closeForumTopic",  { chat_id: env.SUPERGROUP_ID, message_thread_id: threadId });
            await tgCall(env, "sendMessage", { chat_id: env.SUPERGROUP_ID, message_thread_id: threadId, text: `🚫  *${f("Conversation forcibly closed")}*`, parse_mode: "Markdown" });
        }
        return;
    }

    if (cmd === "/open") {
        const userKey = `user:${userId}`;
        const rec = await safeGetJSON(env, userKey, null);
        if (rec) {
            rec.closed = false;
            await env.TOPIC_MAP.put(userKey, JSON.stringify(rec));
            await tgCall(env, "reopenForumTopic", { chat_id: env.SUPERGROUP_ID, message_thread_id: threadId });
            await tgCall(env, "sendMessage", { chat_id: env.SUPERGROUP_ID, message_thread_id: threadId, text: `✅  *${f("Conversation reopened")}*`, parse_mode: "Markdown" });
        }
        return;
    }

    if (cmd === "/reset") {
        await env.TOPIC_MAP.delete(`verified:${userId}`);
        await tgCall(env, "sendMessage", { chat_id: env.SUPERGROUP_ID, message_thread_id: threadId, text: `🔄  *${f("Verification reset")}*`, parse_mode: "Markdown" });
        return;
    }

    if (cmd === "/trust") {
        await env.TOPIC_MAP.put(`verified:${userId}`, "trusted");
        await env.TOPIC_MAP.delete(`needs_verify:${userId}`);
        await tgCall(env, "sendMessage", { chat_id: env.SUPERGROUP_ID, message_thread_id: threadId, text: `🌟  *${f("Permanent trust granted")}*`, parse_mode: "Markdown" });
        return;
    }

    if (cmd === "/ban") {
        await env.TOPIC_MAP.put(`banned:${userId}`, "1");
        await tgCall(env, "sendMessage", { chat_id: env.SUPERGROUP_ID, message_thread_id: threadId, text: `🚫  *${f("User banned")}*`, parse_mode: "Markdown" });
        return;
    }

    if (cmd === "/unban") {
        await env.TOPIC_MAP.delete(`banned:${userId}`);
        await tgCall(env, "sendMessage", { chat_id: env.SUPERGROUP_ID, message_thread_id: threadId, text: `✅  *${f("User unbanned")}*`, parse_mode: "Markdown" });
        return;
    }

    if (cmd === "/info") {
        const userRec      = await safeGetJSON(env, `user:${userId}`, null);
        const verifyStatus = await env.TOPIC_MAP.get(`verified:${userId}`);
        const banStatus    = await env.TOPIC_MAP.get(`banned:${userId}`);
        const info =
            `👤  *${f("User Info")}*\n\n` +
            `🆔  ${f("UID")}: \`${userId}\`\n` +
            `🧵  ${f("Topic ID")}: \`${threadId}\`\n` +
            `📛  ${f("Title")}: ${userRec?.title || f("Unknown")}\n` +
            `✅  ${f("Verified")}: ${verifyStatus ? (verifyStatus === 'trusted' ? `🌟 ${f("Permanent Trust")}` : `✅ ${f("Verified")}`) : `❌ ${f("Not Verified")}`}\n` +
            `🚫  ${f("Banned")}: ${banStatus ? `🚫 ${f("Yes")}` : `✅ ${f("No")}`}\n` +
            `🔗  [${f("Open Profile")}](tg://user?id=${userId})`;
        await tgCall(env, "sendMessage", { chat_id: env.SUPERGROUP_ID, message_thread_id: threadId, text: info, parse_mode: "Markdown" });
        return;
    }

    if (cmd === "/rm") {
        const messageIds = await d1PopUserMessages(env, userId, String(userId));
        let deletedCount = 0;
        for (const msgId of messageIds) {
            const res = await tgCall(env, "deleteMessage", { chat_id: userId, message_id: msgId });
            if (res.ok) deletedCount++;
        }
        await tgCall(env, "sendMessage", {
            chat_id:           env.SUPERGROUP_ID,
            message_thread_id: threadId,
            text:              `🗑  *${f("Recall complete")}*\n\n${f("Deleted")} \`${deletedCount}\` ${f("message(s) from user's chat.")}`,
            parse_mode:        "Markdown"
        });
        return;
    }

    // Silently drop all unrecognised slash commands — prevents accidental forwarding to user
    if (cmd !== null) return;

    // Forward admin message to user
    if (msg.media_group_id) {
        await handleMediaGroup(msg, env, ctx, { direction: "t2p", targetChat: userId, threadId: undefined });
        return;
    }

    const copyRes = await tgCall(env, "copyMessage", {
        chat_id: userId, from_chat_id: env.SUPERGROUP_ID, message_id: msg.message_id
    });

    if (copyRes.ok && copyRes.result?.message_id) {
        await d1SaveMessage(env, userId, String(userId), copyRes.result.message_id, CONFIG.AUTO_DELETE_SECONDS);
    }
}

// ══════════════════════════════════════════════════════════════════
//  Verification system
// ══════════════════════════════════════════════════════════════════
async function sendVerificationChallenge(userId, env, pendingMsgId) {
    const existingChallenge = await env.TOPIC_MAP.get(`user_challenge:${userId}`);
    if (existingChallenge) {
        const chalKey = `chal:${existingChallenge}`;
        const state   = await safeGetJSON(env, chalKey, null);
        if (!state || state.userId !== userId) {
            await env.TOPIC_MAP.delete(`user_challenge:${userId}`);
        } else {
            if (pendingMsgId) {
                let pendingIds = Array.isArray(state.pending_ids) ? state.pending_ids.slice() : (state.pending ? [state.pending] : []);
                if (!pendingIds.includes(pendingMsgId)) {
                    pendingIds.push(pendingMsgId);
                    if (pendingIds.length > CONFIG.PENDING_MAX_MESSAGES)
                        pendingIds = pendingIds.slice(pendingIds.length - CONFIG.PENDING_MAX_MESSAGES);
                    state.pending_ids = pendingIds;
                    delete state.pending;
                    await env.TOPIC_MAP.put(chalKey, JSON.stringify(state), { expirationTtl: CONFIG.VERIFY_EXPIRE_SECONDS });
                }
            }
            return;
        }
    }

    const verifyLimit = await checkRateLimit(userId, env, 'verify', CONFIG.RATE_LIMIT_VERIFY, 300);
    if (!verifyLimit.allowed) {
        await tgCall(env, "sendMessage", { chat_id: userId, text: `⚠️  ${f("Too many verification attempts. Please wait 5 minutes.")}` });
        return;
    }

    const q        = LOCAL_QUESTIONS[secureRandomInt(0, LOCAL_QUESTIONS.length)];
    const options  = shuffleArray([...q.incorrect_answers, q.correct_answer]);
    const verifyId = secureRandomId(CONFIG.VERIFY_ID_LENGTH);
    const answerIdx = options.indexOf(q.correct_answer);

    const state = {
        answerIndex: answerIdx,
        options,
        pending_ids: pendingMsgId ? [pendingMsgId] : [],
        userId
    };

    await env.TOPIC_MAP.put(`chal:${verifyId}`,         JSON.stringify(state), { expirationTtl: CONFIG.VERIFY_EXPIRE_SECONDS });
    await env.TOPIC_MAP.put(`user_challenge:${userId}`, verifyId,              { expirationTtl: CONFIG.VERIFY_EXPIRE_SECONDS });

    Logger.info('verification_sent', { userId, verifyId, question: q.question });

    const buttons  = options.map((opt, idx) => ({ text: textToFancyUnicode(opt), callback_data: `verify:${verifyId}:${idx}` }));
    const keyboard = [];
    for (let i = 0; i < buttons.length; i += CONFIG.BUTTON_COLUMNS) keyboard.push(buttons.slice(i, i + CONFIG.BUTTON_COLUMNS));

    const bar  = "─".repeat(22);
    const text =
        `${bar}\n` +
        `🛡  *${f("Security Verification")}*\n` +
        `${bar}\n\n` +
        `${textToFancyUnicode(q.question)}\n\n` +
        `💡  ${f("Tap the correct answer below.")}\n` +
        `${bar}`;

    await tgCall(env, "sendMessage", {
        chat_id:      userId,
        text,
        parse_mode:   "Markdown",
        reply_markup: { inline_keyboard: keyboard }
    });
}

async function handleCallbackQuery(query, env, ctx) {
    try {
        const data = query.data;
        if (!data.startsWith("verify:")) return;

        const parts = data.split(":");
        if (parts.length !== 3) return;

        const verifyId      = parts[1];
        const selectedIndex = parseInt(parts[2]);
        const userId        = query.from.id;

        const stateStr = await env.TOPIC_MAP.get(`chal:${verifyId}`);
        if (!stateStr) {
            await tgCall(env, "answerCallbackQuery", { callback_query_id: query.id, text: `❌  ${f("Verification expired, please resend your message.")}`, show_alert: true });
            return;
        }

        let state;
        try { state = JSON.parse(stateStr); }
        catch (_) {
            await tgCall(env, "answerCallbackQuery", { callback_query_id: query.id, text: `❌  ${f("Data error.")}`, show_alert: true });
            return;
        }

        if (state.userId && state.userId !== userId) {
            await tgCall(env, "answerCallbackQuery", { callback_query_id: query.id, text: `❌  ${f("Invalid verification.")}`, show_alert: true });
            return;
        }

        if (isNaN(selectedIndex) || selectedIndex < 0 || selectedIndex >= state.options.length) {
            await tgCall(env, "answerCallbackQuery", { callback_query_id: query.id, text: `❌  ${f("Invalid option.")}`, show_alert: true });
            return;
        }

        if (selectedIndex === state.answerIndex) {
            await tgCall(env, "answerCallbackQuery", { callback_query_id: query.id, text: `✅  ${f("Verification passed!")}` });
            Logger.info('verification_passed', { userId, verifyId });

            await env.TOPIC_MAP.put(`verified:${userId}`, "1", { expirationTtl: CONFIG.VERIFIED_EXPIRE_SECONDS });
            await env.TOPIC_MAP.delete(`needs_verify:${userId}`);
            await env.TOPIC_MAP.delete(`chal:${verifyId}`);
            await env.TOPIC_MAP.delete(`user_challenge:${userId}`);

            await tgCall(env, "editMessageText", {
                chat_id:    userId,
                message_id: query.message.message_id,
                text:
                    `✅  *${f("Verification Successful")}*\n\n` +
                    `${f("You are now verified. Send me a message anytime!")}`,
                parse_mode: "Markdown"
            });

            const hasPending = (Array.isArray(state.pending_ids) && state.pending_ids.length > 0) || !!state.pending;
            if (hasPending) {
                try {
                    let pendingIds = Array.isArray(state.pending_ids) ? state.pending_ids.slice() : (state.pending ? [state.pending] : []);
                    if (pendingIds.length > CONFIG.PENDING_MAX_MESSAGES)
                        pendingIds = pendingIds.slice(pendingIds.length - CONFIG.PENDING_MAX_MESSAGES);

                    let forwardedCount = 0;
                    for (const pendingId of pendingIds) {
                        if (!pendingId) continue;
                        const fwdKey = `forwarded:${userId}:${pendingId}`;
                        if (await env.TOPIC_MAP.get(fwdKey)) continue;
                        const fakeMsg = { message_id: pendingId, chat: { id: userId, type: "private" }, from: query.from };
                        await forwardToTopic(fakeMsg, userId, `user:${userId}`, env, ctx);
                        await env.TOPIC_MAP.put(fwdKey, "1", { expirationTtl: 3600 });
                        forwardedCount++;
                    }
                    if (forwardedCount > 0) {
                        await tgCall(env, "sendMessage", {
                            chat_id: userId,
                            text:    `📩  ${textToFancyUnicode(`Your ${forwardedCount} pending message(s) have been forwarded.`)}`
                        });
                    }
                } catch (e) {
                    Logger.error('pending_forward_failed', e, { userId });
                    await tgCall(env, "sendMessage", { chat_id: userId, text: `⚠️  ${f("Auto-send failed, please resend your message.")}` });
                }
            }
        } else {
            Logger.info('verification_failed', { userId, verifyId, selectedIndex, correctIndex: state.answerIndex });
            await tgCall(env, "answerCallbackQuery", { callback_query_id: query.id, text: `❌  ${f("Wrong answer, please try again!")}`, show_alert: true });
        }
    } catch (e) {
        Logger.error('callback_query_error', e, { userId: query.from?.id });
        await tgCall(env, "answerCallbackQuery", { callback_query_id: query.id, text: `⚠️  ${f("System error, please retry.")}`, show_alert: true });
    }
}

// ══════════════════════════════════════════════════════════════════
//  Cleanup command
// ══════════════════════════════════════════════════════════════════
async function handleCleanupCommand(threadId, env) {
    const lockKey = "cleanup:lock";
    if (await env.TOPIC_MAP.get(lockKey)) {
        await tgCall(env, "sendMessage", withMessageThreadId({ chat_id: env.SUPERGROUP_ID, text: `⏳  *${f("A cleanup task is already running.")}*`, parse_mode: "Markdown" }, threadId));
        return;
    }
    await env.TOPIC_MAP.put(lockKey, "1", { expirationTtl: CONFIG.CLEANUP_LOCK_TTL_SECONDS });
    await tgCall(env, "sendMessage", withMessageThreadId({ chat_id: env.SUPERGROUP_ID, text: `🔄  *${f("Scanning for stale records...")}*`, parse_mode: "Markdown" }, threadId));

    let cleanedCount = 0, errorCount = 0, scannedCount = 0;
    const cleanedUsers = [];

    try {
        let cursor;
        do {
            const result = await env.TOPIC_MAP.list({ prefix: "user:", cursor });
            const names  = (result.keys || []).map(k => k.name);
            scannedCount += names.length;

            for (let i = 0; i < names.length; i += CONFIG.CLEANUP_BATCH_SIZE) {
                const batch   = names.slice(i, i + CONFIG.CLEANUP_BATCH_SIZE);
                const results = await Promise.allSettled(batch.map(async (name) => {
                    const rec = await safeGetJSON(env, name, null);
                    if (!rec || !rec.thread_id) return null;
                    const uid   = name.slice(5);
                    const probe = await probeForumThread(env, rec.thread_id, { userId: uid, reason: "cleanup_check", doubleCheckOnMissingThreadId: false });
                    if (probe.status === "redirected" || probe.status === "missing") {
                        await env.TOPIC_MAP.delete(name);
                        await env.TOPIC_MAP.delete(`verified:${uid}`);
                        await env.TOPIC_MAP.delete(`thread:${rec.thread_id}`);
                        return { userId: uid, threadId: rec.thread_id, title: rec.title || f("Unknown") };
                    }
                    return null;
                }));

                results.forEach(r => {
                    if (r.status === 'fulfilled' && r.value) { cleanedCount++; cleanedUsers.push(r.value); Logger.info('cleanup_user', r.value); }
                    else if (r.status === 'rejected') { errorCount++; Logger.error('cleanup_batch_error', r.reason); }
                });

                if (i + CONFIG.CLEANUP_BATCH_SIZE < names.length) await new Promise(r => setTimeout(r, 600));
            }

            cursor = result.list_complete ? undefined : result.cursor;
            if (cursor) await new Promise(r => setTimeout(r, 200));
        } while (cursor);

        let report = `✅  *${f("Cleanup Complete")}*\n\n`;
        report += `📊  *${f("Statistics")}*\n`;
        report += `${f("Scanned")}: ${scannedCount}\n`;
        report += `${f("Cleaned")}: ${cleanedCount}\n`;
        report += `${f("Errors")}: ${errorCount}\n\n`;
        if (cleanedCount > 0) {
            report += `🗑  *${f("Cleaned Users")}*:\n`;
            for (const u of cleanedUsers.slice(0, CONFIG.MAX_CLEANUP_DISPLAY))
                report += `• UID: \`${u.userId}\` | ${u.title}\n`;
            if (cleanedUsers.length > CONFIG.MAX_CLEANUP_DISPLAY)
                report += `\n...(+${cleanedUsers.length - CONFIG.MAX_CLEANUP_DISPLAY} ${f("more")})\n`;
            report += `\n💡  ${f("These users will re-verify on next message.")}`;
        } else {
            report += `✨  ${f("No stale records found.")}`;
        }

        Logger.info('cleanup_completed', { cleanedCount, errorCount, totalUsers: scannedCount });
        await tgCall(env, "sendMessage", withMessageThreadId({ chat_id: env.SUPERGROUP_ID, text: report, parse_mode: "Markdown" }, threadId));
    } catch (e) {
        Logger.error('cleanup_failed', e, { threadId });
        await tgCall(env, "sendMessage", withMessageThreadId({
            chat_id: env.SUPERGROUP_ID,
            text:    `❌  *${f("Cleanup error")}*\n\n\`${e.message}\``,
            parse_mode: "Markdown"
        }, threadId));
    } finally {
        await env.TOPIC_MAP.delete(lockKey);
    }
}

// ─── Topic creation ───────────────────────────────────────────────
async function createTopic(from, key, env, userId) {
    const title = buildTopicTitle(from);
    if (!env.SUPERGROUP_ID.startsWith("-100")) throw new Error("SUPERGROUP_ID must start with -100");
    const res = await tgCall(env, "createForumTopic", { chat_id: env.SUPERGROUP_ID, name: title });
    if (!res.ok) throw new Error(`createForumTopic failed: ${res.description}`);
    const rec = { thread_id: res.result.message_thread_id, title, closed: false };
    await env.TOPIC_MAP.put(key, JSON.stringify(rec));
    if (userId) await env.TOPIC_MAP.put(`thread:${rec.thread_id}`, String(userId));

    if (CONFIG.INFO_CARD_ENABLED) {
        try { await sendUserInfoCard(from, rec.thread_id, env); }
        catch (e) { Logger.error('info_card_failed', e, { userId }); }
    }

    return rec;
}

async function updateThreadStatus(threadId, isClosed, env) {
    try {
        const mappedUser = await env.TOPIC_MAP.get(`thread:${threadId}`);
        if (mappedUser) {
            const userKey = `user:${mappedUser}`;
            const rec     = await safeGetJSON(env, userKey, null);
            if (rec && Number(rec.thread_id) === Number(threadId)) {
                rec.closed = isClosed;
                await env.TOPIC_MAP.put(userKey, JSON.stringify(rec));
                Logger.info('thread_status_updated', { threadId, isClosed });
                return;
            }
            await env.TOPIC_MAP.delete(`thread:${threadId}`);
        }
        const allKeys = await getAllKeys(env, "user:");
        const updates = [];
        for (const { name } of allKeys) {
            const rec = await safeGetJSON(env, name, null);
            if (rec && Number(rec.thread_id) === Number(threadId)) { rec.closed = isClosed; updates.push(env.TOPIC_MAP.put(name, JSON.stringify(rec))); }
        }
        await Promise.all(updates);
        Logger.info('thread_status_updated', { threadId, isClosed, updatedCount: updates.length });
    } catch (e) { Logger.error('thread_status_update_failed', e, { threadId, isClosed }); throw e; }
}

function buildTopicTitle(from) {
    const firstName   = (from.first_name || "").trim().substring(0, CONFIG.MAX_NAME_LENGTH);
    const lastName    = (from.last_name  || "").trim().substring(0, CONFIG.MAX_NAME_LENGTH);
    const username    = from.username ? from.username.replace(/[^\w]/g, '').substring(0, 20) : "";
    const cleanName   = (firstName + " " + lastName).replace(/[\u0000-\u001F\u007F-\u009F]/g, '').replace(/\s+/g, ' ').trim() || "User";
    const usernameStr = username ? ` @${username}` : "";
    return (cleanName + usernameStr).substring(0, CONFIG.MAX_TITLE_LENGTH);
}

// ─── Telegram API wrapper ─────────────────────────────────────────
async function tgCall(env, method, body, timeout = CONFIG.API_TIMEOUT_MS) {
    let base = env.API_BASE || "https://api.telegram.org";
    if (base.startsWith("http://")) { Logger.warn('api_http_upgraded', { base }); base = base.replace("http://", "https://"); }
    try { new URL(`${base}/test`); } catch (_) { base = "https://api.telegram.org"; }

    const controller = new AbortController();
    const timeoutId  = setTimeout(() => controller.abort(), timeout);

    try {
        const resp = await fetch(`${base}/bot${env.BOT_TOKEN}/${method}`, {
            method:  "POST",
            headers: { "content-type": "application/json" },
            body:    JSON.stringify(body),
            signal:  controller.signal
        });
        clearTimeout(timeoutId);
        if (!resp.ok && resp.status >= 500) Logger.warn('telegram_api_server_error', { method, status: resp.status });
        const result = await resp.json();
        if (!result.ok && result.description?.includes('Too Many Requests'))
            Logger.warn('telegram_api_rate_limit', { method, retryAfter: result.parameters?.retry_after || 5 });
        return result;
    } catch (e) {
        clearTimeout(timeoutId);
        if (e.name === 'AbortError') { Logger.error('telegram_api_timeout', e, { method, timeout }); return { ok: false, description: 'Request timeout' }; }
        Logger.error('telegram_api_failed', e, { method });
        throw e;
    }
}

// ─── Media group handling ─────────────────────────────────────────
async function handleMediaGroup(msg, env, ctx, { direction, targetChat, threadId }) {
    const groupId = msg.media_group_id;
    const key     = `mg:${direction}:${groupId}`;
    const item    = extractMedia(msg);
    if (!item) {
        await tgCall(env, "copyMessage", withMessageThreadId({ chat_id: targetChat, from_chat_id: msg.chat.id, message_id: msg.message_id }, threadId));
        return;
    }
    let rec = await safeGetJSON(env, key, null);
    if (!rec) rec = { direction, targetChat, threadId: (threadId === null ? undefined : threadId), items: [], last_ts: Date.now() };
    rec.items.push({ ...item, msg_id: msg.message_id });
    rec.last_ts = Date.now();
    await env.TOPIC_MAP.put(key, JSON.stringify(rec), { expirationTtl: CONFIG.MEDIA_GROUP_EXPIRE_SECONDS });
    ctx.waitUntil(delaySend(env, key, rec.last_ts));
}

function extractMedia(msg) {
    if (msg.photo     && msg.photo.length > 0) return { type: "photo",     id: msg.photo[msg.photo.length - 1].file_id, cap: msg.caption || "" };
    if (msg.video)                              return { type: "video",     id: msg.video.file_id,     cap: msg.caption || "" };
    if (msg.document)                           return { type: "document",  id: msg.document.file_id,  cap: msg.caption || "" };
    if (msg.audio)                              return { type: "audio",     id: msg.audio.file_id,     cap: msg.caption || "" };
    if (msg.animation)                          return { type: "animation", id: msg.animation.file_id, cap: msg.caption || "" };
    return null;
}

async function flushExpiredMediaGroups(env, now) {
    try {
        const allKeys = await getAllKeys(env, "mg:");
        let deletedCount = 0;
        for (const { name } of allKeys) {
            const rec = await safeGetJSON(env, name, null);
            if (rec && rec.last_ts && (now - rec.last_ts > 300000)) { await env.TOPIC_MAP.delete(name); deletedCount++; }
        }
        if (deletedCount > 0) Logger.info('media_groups_cleaned', { deletedCount });
    } catch (e) { Logger.error('media_group_cleanup_failed', e); }
}

async function delaySend(env, key, ts) {
    await new Promise(r => setTimeout(r, CONFIG.MEDIA_GROUP_DELAY_MS));
    const rec = await safeGetJSON(env, key, null);
    if (!rec || rec.last_ts !== ts) return;
    if (!rec.items || rec.items.length === 0) { await env.TOPIC_MAP.delete(key); return; }

    const media = rec.items.map((it, i) => {
        if (!it.type || !it.id) { Logger.warn('media_group_invalid_item', { key, item: it }); return null; }
        return { type: it.type, media: it.id, caption: i === 0 ? (it.cap || "").substring(0, 1024) : "" };
    }).filter(Boolean);

    if (media.length > 0) {
        try {
            const result = await tgCall(env, "sendMediaGroup", withMessageThreadId({ chat_id: rec.targetChat, media }, rec.threadId));
            if (!result.ok) Logger.error('media_group_send_failed', result.description, { key, mediaCount: media.length });
            else Logger.info('media_group_sent', { key, mediaCount: media.length });
        } catch (e) { Logger.error('media_group_send_exception', e, { key }); }
    }
    await env.TOPIC_MAP.delete(key);
}
