const jwt = require("jsonwebtoken")
const { createClient } = require("@supabase/supabase-js")

exports.login = async (req, res) => {
  const { email, employee_id, password } = req.body
  const supabase = req.app.locals.supabase

  try {
    // Find employee by email or employee_id
    let query = supabase.from("employees").select("*")

    if (email) {
      query = query.eq("email", email)
    } else if (employee_id) {
      query = query.eq("employee_id", employee_id)
    } else {
      return res.status(400).json({ error: "Email or employee_id required" })
    }

    const { data: employee, error } = await query.single()

    if (error || !employee) {
      console.error("Login failed: Employee not found in database or query error:", error)
      return res.status(401).json({ error: "Invalid credentials" })
    }

    // Verify password via Supabase Auth
    // Use a separate client instance for authentication to avoid tainting the global service role client
    const authClient = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    })

    const { data, error: authError } = await authClient.auth.signInWithPassword({
      email: employee.email,
      password,
    })

    if (authError) {
      console.error("Login failed: Supabase Auth password verification failed:", authError.message)
      return res.status(401).json({ error: "Invalid credentials" })
    }

    // Generate JWT token
    const token = jwt.sign(
      {
        id: employee.id,
        email: employee.email,
        role: employee.is_admin ? "admin" : "employee",
        employee_id: employee.employee_id,
      },
      process.env.JWT_SECRET,
      { expiresIn: "1y" },
    )

    res.json({
      token,
      employee: {
        id: employee.id,
        first_name: employee.first_name,
        last_name: employee.last_name,
        email: employee.email,
        employee_id: employee.employee_id,
        is_admin: employee.is_admin,
      },
    })
  } catch (err) {
    console.error("Login Error:", err)
    res.status(500).json({ error: "Internal server error" })
  }
}
