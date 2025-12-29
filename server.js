const dotenv = require("dotenv");
dotenv.config();
const downloadModels = require("./download-models");

try {
  require('@tensorflow/tfjs-node');
} catch (error) {
  console.error("⚠️ Failed to load @tensorflow/tfjs-node. Using default CPU backend.");
  console.error("   Reason:", error.message);
  // Mock tfjs-node with the pure JS tfjs library to prevent crashes and provide a valid tf object
  try {
    const tf = require('@tensorflow/tfjs');
    const tfNodePath = require.resolve('@tensorflow/tfjs-node');
    require.cache[tfNodePath] = {
      id: tfNodePath,
      filename: tfNodePath,
      loaded: true,
      exports: tf
    };
  } catch (e) {
    console.error("Failed to mock tfjs-node:", e.message);
  }
}
const express = require("express");
const cors = require("cors");
const { createClient } = require("@supabase/supabase-js");
const https = require("https");

// Routes
const authRoutes = require("./routes/auth");
const adminRoutes = require("./routes/admin");
const employeeRoutes = require("./routes/employee");
const { runAutoCheckOut } = require("./controllers/employeeController");

const app = express();

const getCambodiaTime = () => {
  return new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Phnom_Penh" }));
};

/* =========================
   Middleware
========================= */
app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

// Request Logger - Helps verify if requests are hitting the server
app.use((req, res, next) => {
  console.log(`[${getCambodiaTime().toISOString()}] ${req.method} ${req.url}`);
  if (req.path.startsWith('/admin') && !req.headers.authorization) {
    console.warn("⚠️  Warning: Admin route accessed without Authorization header (Expect 403/401)");
  }
  next();
});

/* =========================
   Supabase Init
========================= */
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error("❌ Missing Supabase environment variables");
  // DO NOT process.exit() on Vercel
  throw new Error("Supabase env vars not set");
}

const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false
  }
});

// make supabase available in routes
app.locals.supabase = supabase;

/* =========================
   Routes
   IMPORTANT:
   Vercel auto adds /api
========================= */
app.use("/api", authRoutes);
app.use("/auth", authRoutes);

// Proxy for Telegram getUpdates (Avoids CORS on frontend)
app.post("/admin/get-telegram-updates", (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: "Token required" });
  
  https.get(`https://api.telegram.org/bot${token}/getUpdates`, (resp) => {
    let data = '';
    resp.on('data', (chunk) => data += chunk);
    resp.on('end', () => {
      try {
        res.json(JSON.parse(data));
      } catch (e) {
        res.status(500).json({ error: "Invalid response from Telegram" });
      }
    });
  }).on('error', (err) => res.status(500).json({ error: err.message }));
});

app.use("/admin", adminRoutes);

// Middleware to intercept Check-In/Out and send Telegram Message
app.use("/employee", (req, res, next) => {
  const originalJson = res.json;
  res.json = function (data) {
    // Check if request was successful and is a checkin/checkout endpoint
    if (res.statusCode >= 200 && res.statusCode < 300 && (req.path.includes('checkin') || req.path.includes('checkout'))) {
      const supabase = req.app.locals.supabase;
      const type = req.path.includes('checkin') ? 'checkin' : 'checkout';
      
      // Execute asynchronously (fire and forget)
      (async () => {
        try {
          const { data: settings, error: settingsError } = await supabase
            .from('settings')
            .select('telegram_bot_token, telegram_group_id')
            .limit(1)
            .maybeSingle();

          if (settingsError) {
            console.error("❌ Telegram Settings DB Error:", settingsError.message);
            return;
          }

          if (settings?.telegram_bot_token && settings?.telegram_group_id) {
            console.log("🔔 Sending Telegram notification...");
            let name = 'Employee';

            // Fetch employee name using the authenticated user ID
            if (req.user && req.user.id) {
              const { data: emp } = await supabase
                .from('employees')
                .select('first_name, last_name')
                .eq('id', req.user.id)
                .maybeSingle();
              if (emp) name = `${emp.first_name} ${emp.last_name}`;
            }

            const time = getCambodiaTime().toLocaleString("en-US", {
              year: 'numeric',
              month: '2-digit',
              day: '2-digit',
              hour: '2-digit',
              minute: '2-digit',
              hour12: true
            });
            const emoji = type === 'checkin' ? '🟢' : '🔴';

            let statusLine = '';
            if (type === 'checkin') {
              let status = data?.status_time || data?.data?.status_time || data?.data?.[0]?.status_time || data?.status || data?.data?.status;
              if (!status) {
                const now = getCambodiaTime();
                const startThreshold = getCambodiaTime();
                startThreshold.setHours(8, 0, 0, 0);
                const lateThreshold = getCambodiaTime();
                lateThreshold.setHours(8, 15, 0, 0);
                
                if (now < startThreshold) status = 'Early';
                else if (now > lateThreshold) status = 'Late';
                else status = 'On Time';
              }
              statusLine = `\n📊 **Status:** ${status}`;
            }

            const message = `${emoji} *Attendance Alert*\n\n👤 **User:** ${name}\n📋 **Type:** ${type.toUpperCase()}\n🕒 **Time:** ${time}${statusLine}`;

            const payload = JSON.stringify({
              chat_id: settings.telegram_group_id,
              text: message,
              parse_mode: 'Markdown'
            });

            const request = https.request(`https://api.telegram.org/bot${settings.telegram_bot_token}/sendMessage`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
            });
            request.on('error', (e) => console.error('Telegram Request Error:', e));
            request.write(payload);
            request.end();
          }
        } catch (err) {
          console.error("Telegram Notification Failed:", err);
        }
      })();
    }
    return originalJson.call(this, data);
  };
  next();
});

app.use("/employee", employeeRoutes);

/* =========================
   Auto Check-out Scheduler
========================= */
// Manual Trigger Route for Testing
app.post("/admin/trigger-auto-checkout", async (req, res) => {
  await runAutoCheckOut();
  res.json({ message: "Auto check-out task triggered manually" });
});

/* =========================
   Health Check
========================= */
app.get("/", (req, res) => {
  res.json({ status: "Attendance System API is running" });
});

app.get("/health", (req, res) => {
  res.json({ status: "OK" });
});

app.use("/", authRoutes);

/* =========================
   Error Handler
========================= */
app.use((err, req, res, next) => {
  console.error("🔥 Error:", err.message);
  res.status(500).json({
    error: err.message || "Internal Server Error"
  });
});

/* =========================
   Local Dev Only
========================= */
const PORT = process.env.PORT || 5000;

if (require.main === module) {
  // Attempt to download models if missing (runs in background to not block startup)
  downloadModels()
    .then(() => {
      app.listen(PORT, "0.0.0.0", () => {
        console.log(`🚀 Server running on port ${PORT}`);
      });
    })
    .catch(err => {
      console.error("Failed to download models:", err);
      // Start server anyway, but face recognition endpoints might fail until fixed
      app.listen(PORT, "0.0.0.0", () => console.log(`🚀 Server running on port ${PORT} (Models failed)`));
    });
}

module.exports = app;
