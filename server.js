const express = require("express")
const cors = require("cors")
const dotenv = require("dotenv")
const { createClient } = require("@supabase/supabase-js")
const authMiddleware = require("./middleware/auth")
const adminRoutes = require("./routes/admin")
const employeeRoutes = require("./routes/employee")
const authRoutes = require("./routes/auth")

dotenv.config()

const app = express()

// Middleware
app.use(cors())
app.use(express.json({ limit: "50mb" }))
app.use(express.urlencoded({ limit: "50mb", extended: true }))

// Initialize Supabase
// Use Service Role Key if available to bypass RLS for backend operations
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!supabaseKey) {
  console.error("FATAL: SUPABASE_SERVICE_ROLE_KEY is not set in .env. This key is required to bypass RLS policies and avoid recursion errors.")
  process.exit(1)
}

const supabase = createClient(process.env.SUPABASE_URL, supabaseKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false
  }
})

// Make supabase available to routes
app.locals.supabase = supabase

// Routes
app.use("/api", authRoutes)
app.use("/admin", adminRoutes)
app.use("/employee", employeeRoutes)

// Health check
app.get("/health", (req, res) => {
  res.json({ status: "API is running" })
})

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack)
  res.status(err.status || 500).json({ error: err.message || "Internal Server Error" })
})

const PORT = process.env.PORT || 5000

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Express server running on port ${PORT}`)
  })
}

module.exports = app
