# 🤖 TG-RelayX (v0.0.1)

**TG-RelayX** is a lightweight, high-performance two-way private chat bot for Telegram, powered by **Cloudflare Workers**.

It acts as a secure relay layer between users and administrators, enabling real-time communication while effectively filtering spam and unwanted messages.

With a built-in zero-latency human verification system, topic-based session management, and powerful admin controls, TG-RelayX turns any Telegram group into a clean and efficient support system.

No servers required — deploy instantly on Cloudflare’s global edge network.

---

## 🛠️ Admin Commands

> **Note:** These commands only work inside **admin group topics**.  
> Any /xxx outside may be silently ignored.

| Command | Description | Typical Use |
| :--- | :--- | :--- |
| `/close` | Close the conversation and stop receiving messages from the user. | Ticket resolved |
| `/open` | Reopen the conversation and resume message forwarding. | Re-enable communication |
| `/rm` | Delete all messages from the user (requires D1). | Remove sensitive or unwanted content |
| `/ban` | Ban the user (all messages will be ignored silently). | Spam or abuse |
| `/unban` | Unban the user and restore communication. | Allow user again |
| `/trust` | Mark user as trusted (skip verification permanently). | VIP or known users |
| `/reset` | Reset verification status (user must verify again). | Security or testing |
| `/info` | Show user information (UID, topic ID, link). | Debugging / lookup |
| `/cleanup` | Remove data for deleted topics. | Maintenance |

---

## 🚀 Deployment Guide

### 1. Prerequisites

#### 🤖 Telegram Bot
- Create a bot via [@BotFather](https://t.me/BotFather)
- Obtain your `BOT_TOKEN`
- Disable **Group Privacy**:
  - `/mybots` → Settings → Group Privacy → Turn off

---

#### 👥 Admin Group Setup
- Create a Telegram group
- Enable **Topics**
- Add the bot as **administrator**
  - Grant permission to manage topics
- Obtain your `SUPERGROUP_ID`

**How to get SUPERGROUP_ID:**
- Right-click any message in Telegram Desktop → Copy link  
- Extract group ID:
  - If it starts with `-100`, use it directly  
  - Otherwise, prepend `-100`

---

### 2. Deploy on Cloudflare Workers

1. Go to https://dash.cloudflare.com/
2. Navigate to **Workers & Pages**
3. Click **Create Application → Create Worker**
4. Deploy the default template
5. Click **Edit Code**
6. Replace with your `worker.js`
7. Click **Deploy**

---

### 3. Configure KV & Environment Variables

Go to:

**Settings → Variables**

Add:

#### KV Binding
- Name: `TOPIC_MAP`

#### Environment Variables
- `BOT_TOKEN`
- `SUPERGROUP_ID`

Click **Save and Deploy**

---

## ➕ Optional: D1 Database (for /rm & auto-delete)

This feature enables message tracking, deletion, and automatic cleanup.

---

### Create Database

Go to:

**Storage & Databases → D1 → Create database**

Name:

```

telegram-bot-db

````

---

### Initialize Tables

Run in SQL console:

```sql
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  message_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  expire_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_expire ON messages(expire_at);
CREATE INDEX IF NOT EXISTS idx_user ON messages(user_id, chat_id);
````

---

### Bind D1 to Worker

Go to:

**Workers & Pages → Your Worker → Settings → Bindings**

Add:

* Type: **D1 database**
* Variable name: `DB`
* Database: `telegram-bot-db`

---

### Enable Auto Cleanup (Cron Trigger)

Go to:

**Settings → Triggers → Add Cron Trigger**

```cron
0 * * * *
```

Runs every hour to remove expired messages.

---

### ⚠️ Notes

* If `DB` is not configured:

  * Bot will still function normally
  * `/rm` and auto-delete features will be disabled

---

## 🔗 Final Step: Activate Webhook (IMPORTANT)

Open the following URL in your browser:

```
https://api.telegram.org/bot<YOUR_TOKEN>/setWebhook?url=<YOUR_WORKER_URL>
```

Replace:

* `<YOUR_TOKEN>` → your bot token
* `<YOUR_WORKER_URL>` → your Cloudflare Worker URL

Example:

```
https://api.telegram.org/bot123456:ABC/setWebhook?url=https://xxx.workers.dev
```

If successful, you should see:

```json
{"ok":true, "result":true, "description":"Webhook was set"}
```

---

## ❓ FAQ

### Q1: Verification button not working?

Ensure webhook is correctly set and `callback_query` events are enabled.

---

### Q2: Bot cannot create topics?

Check the following:

* Group ID is correct (`-100` format)
* Topics are enabled in the group
* Bot has admin permissions with topic management rights

---

### Q3: Messages are not being relayed after verification?

* Verify all environment variables are correct
* Try resetting webhook:

```
https://api.telegram.org/bot<YOUR_TOKEN>/deleteWebhook?drop_pending_updates=true
```

---

### Q4: Webhook setup failed?

* Try using `workers.dev` domain instead of custom domain
* DNS or network restrictions may cause failures

---

## 🔒 Security Notice

> ⚠️ **Important**
>
> Keep your `BOT_TOKEN` secure and never expose it publicly.
> It controls full access to your bot.

---

## 📌 Credits

Based on:[https://github.com/jikssha/telegram_private_chatbot](https://github.com/jikssha/telegram_private_chatbot)

Licensed under the MIT License.

Modified and enhanced by **Prince**

---

## ⭐ Support

If this project helps you, please consider giving it a **Star** on GitHub.
