const jwt = require("jsonwebtoken");

exports.login = async (req, res) => {
  const { email, employee_id, password } = req.body;
  const supabase = req.app.locals.supabase;

  // 1. Basic Validation
  if ((!email && !employee_id) || !password) {
    return res.status(400).json({ error: "Email/ID and password are required" });
  }

  try {
    // 2. Find Employee in DB
    // Construct filter: checks email OR employee_id depending on what was sent
    const searchFilter = email ? `email.eq.${email}` : `employee_id.eq.${employee_id}`;
    
    const { data: employee, error: findError } = await supabase
      .from("employees")
      .select("*")
      .or(searchFilter)
      .maybeSingle(); // Returns null if not found, instead of throwing error

    if (findError || !employee) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    // 3. Verify Password via Supabase Auth
    // Use the email from the DB record to ensure we authenticate the correct user
    const { data: authData, error: authError } = await supabase.auth.signInWithPassword({
      email: employee.email,
      password,
    });

    if (authError || !authData.user) {
      console.warn(`Login failed: Password mismatch for user ${employee.email}`);
      return res.status(401).json({ error: "Invalid credentials" });
    }

    // 4. Generate Custom JWT
    const token = jwt.sign(
      {
        id: employee.id,            // Primary Key in 'employees' table
        auth_uid: authData.user.id, // Supabase Auth User ID
        email: employee.email,
        role: employee.is_admin ? "admin" : "employee",
        employee_id: employee.employee_id,
      },
      process.env.JWT_SECRET,
      { expiresIn: "1y" }
    );

    res.json({
      message: "Login successful",
      token,
      employee: {
        id: employee.id,
        first_name: employee.first_name,
        last_name: employee.last_name,
        email: employee.email,
        employee_id: employee.employee_id,
        is_admin: employee.is_admin,
      },
    });

  } catch (err) {
    console.error("Login Controller Error:", err.message);
    res.status(500).json({ error: "Internal server error" });
  }
};