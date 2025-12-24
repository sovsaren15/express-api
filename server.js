require('@tensorflow/tfjs-node');
const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const { createClient } = require("@supabase/supabase-js");

// Routes
const authRoutes = require("./routes/auth");
const adminRoutes = require("./routes/admin");
const employeeRoutes = require("./routes/employee");

dotenv.config();

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
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 Server running on port ${PORT}`);
  });
}

module.exports = app;
