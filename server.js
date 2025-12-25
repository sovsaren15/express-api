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

// Routes
const authRoutes = require("./routes/auth");
const adminRoutes = require("./routes/admin");
const employeeRoutes = require("./routes/employee");

const app = express();

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
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
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
app.use("/", authRoutes);
app.use("/admin", adminRoutes);
app.use("/employee", employeeRoutes);

/* =========================
   Health Check
========================= */
app.get("/", (req, res) => {
  res.json({ status: "Attendance System API is running" });
});

app.get("/health", (req, res) => {
  res.json({ status: "OK" });
});

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
