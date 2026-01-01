const dotenv = require("dotenv");
dotenv.config();

// --- 1. Dependencies ---
const https = require("https");
const express = require("express");
const cors = require("cors");
const { createClient } = require("@supabase/supabase-js");

// --- 2. TFJS Handling (Graceful Fallback) ---
try {
  require('@tensorflow/tfjs-node');
} catch (error) {
  console.warn("⚠️ @tensorflow/tfjs-node not found. Falling back to CPU backend.");
  try {
    const tf = require('@tensorflow/tfjs');
    const tfNodePath = require.resolve('@tensorflow/tfjs-node');
    require.cache[tfNodePath] = { id: tfNodePath, filename: tfNodePath, loaded: true, exports: tf };
  } catch (e) {
    console.error("❌ Failed to mock tfjs-node:", e.message);
  }
}

// --- 3. Internal Modules ---
const downloadModels = require("./download-models");
const authRoutes = require("./routes/auth");
const adminRoutes = require("./routes/admin");
const employeeRoutes = require("./routes/employee");
const { runAutoCheckOut } = require("./controllers/employeeController");

// --- 4. App & Config ---
const app = express();
const PORT = process.env.PORT || 5000;

// Helper: Get Time in Cambodia
const getCambodiaTime = () => new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Phnom_Penh" }));

// --- 5. Database Initialization ---
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("❌ Missing Supabase environment variables");
}

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false }
});
app.locals.supabase = supabase; // Make available globally

// --- 6. Middleware ---
app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

// Request Logger
app.use((req, res, next) => {
  console.log(`[${getCambodiaTime().toISOString()}] ${req.method} ${req.url}`);
  if (req.path.startsWith('/admin') && !req.headers.authorization) {
    console.warn("⚠️  Admin access attempt without Authorization header");
  }
  next();
});

// --- 7. Telegram Notification Middleware ---
// Intercepts responses from /employee routes to send alerts
app.use("/employee", (req, res, next) => {
  const originalJson = res.json;
  res.json = function (data) {
    // Only proceed if request succeeded and is a check-in/out action
    if (res.statusCode >= 200 && res.statusCode < 300 && (req.path.includes('checkin') || req.path.includes('checkout'))) {
      const type = req.path.includes('checkin') ? 'checkin' : 'checkout';
      
      // Async Fire-and-Forget Notification
      (async () => {
        try {
          const { data: settings } = await supabase.from('settings').select('telegram_bot_token, telegram_group_id').maybeSingle();
          if (!settings?.telegram_bot_token || !settings?.telegram_group_id) return;

          let name = 'Employee';
          if (req.user?.id) {
            const { data: emp } = await supabase.from('employees').select('first_name, last_name').eq('id', req.user.id).maybeSingle();
            if (emp) name = `${emp.first_name} ${emp.last_name}`;
          }

          // Calculate Status (Early/Late/On Time)
          let statusLine = '';
          if (type === 'checkin') {
            let status = data?.status_time || data?.data?.status_time || 'On Time'; 
            // Fallback logic if backend didn't return status
            if (!data?.status_time) {
               const now = getCambodiaTime();
               const h = now.getHours(), m = now.getMinutes();
               if (h < 8) status = 'Early';
               else if (h > 8 || (h === 8 && m > 15)) status = 'Late';
            }
            statusLine = `\n📊 **Status:** ${status}`;
          }

          const timeStr = getCambodiaTime().toLocaleString("en-US", { hour: '2-digit', minute: '2-digit', hour12: true });
          const emoji = type === 'checkin' ? '🟢' : '🔴';
          const message = `${emoji} *Attendance Alert*\n\n👤 **User:** ${name}\n📋 **Type:** ${type.toUpperCase()}\n🕒 **Time:** ${timeStr}${statusLine}`;

          const payload = JSON.stringify({ chat_id: settings.telegram_group_id, text: message, parse_mode: 'Markdown' });
          const request = https.request(`https://api.telegram.org/bot${settings.telegram_bot_token}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
          });
          request.on('error', (e) => console.error('Telegram Error:', e.message));
          request.write(payload);
          request.end();

        } catch (err) {
          console.error("Notification Failed:", err.message);
        }
      })();
    }
    return originalJson.call(this, data);
  };
  next();
});

// --- 8. Routes ---
app.use("/api", authRoutes); // Standard API prefix
app.use("/auth", authRoutes); // Legacy support
app.use("/admin", adminRoutes);
app.use("/employee", employeeRoutes);

// Proxy: Get Telegram Updates (Bypasses CORS)
app.post("/admin/get-telegram-updates", (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: "Token required" });

  https.get(`https://api.telegram.org/bot${token}/getUpdates`, (resp) => {
    let data = '';
    resp.on('data', chunk => data += chunk);
    resp.on('end', () => {
      try { res.json(JSON.parse(data)); } 
      catch (e) { res.status(500).json({ error: "Invalid Telegram response" }); }
    });
  }).on('error', err => res.status(500).json({ error: err.message }));
});

// Utility: Manual Trigger for Auto Check-out
app.post("/admin/trigger-auto-checkout", async (req, res) => {
  await runAutoCheckOut();
  res.json({ message: "Auto check-out task triggered manually" });
});

// Health Checks
app.get(["/", "/health"], (req, res) => res.json({ status: "Attendance System API is running", timestamp: new Date() }));

// --- 9. Global Error Handler ---
app.use((err, req, res, next) => {
  console.error("🔥 Global Error:", err.message);
  res.status(500).json({ error: err.message || "Internal Server Error" });
});

// --- 10. Server Start (Local Dev) ---
if (require.main === module) {
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 Server running on port ${PORT}`);
  });

  // Background Model Download
  downloadModels()
    .then(() => console.log("✅ AI Models loaded"))
    .catch(err => console.error("⚠️ Model download failed:", err.message));
}

module.exports = app;