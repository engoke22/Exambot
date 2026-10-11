KCSE PAST PAPERS TELEGRAM BOT — CLOUDFLARE WORKER

FILES
- kcse-past-papers-worker.js: Worker source code. Upload/paste this as index.js in Cloudflare Workers.

CLOUDFLARE SETTINGS
1. Create a KV namespace, then add a Worker binding:
   Variable name: BOT_KV
   KV namespace: select the namespace you created
2. Add these Worker variables/secrets:
   BOT_TOKEN       Secret: your Telegram bot token from BotFather
   ADMIN_ID        Variable or secret: your numeric Telegram user ID
   WEBHOOK_SECRET  Optional secret; if configured, use the same value when registering the webhook
3. Deploy the Worker.
4. Set your Telegram webhook to:
   https://YOUR-WORKER.workers.dev/telegram
   Replace YOUR-WORKER with your actual Worker hostname. Use exactly one slash before telegram.

IMPORTANT
- Do not share BOT_TOKEN or WEBHOOK_SECRET publicly.
- If you set WEBHOOK_SECRET, the Telegram setWebhook request must include the same secret_token value.
- Use the Cloudflare dashboard editor if you do not have a Linux terminal.
