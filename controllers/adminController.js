const faceapi = require("@vladmandic/face-api");
const path = require("path");
const fs = require("fs");

// --- 1. Face API & Canvas Initialization ---
let canvas = {};
let modelsLoaded = false;
const modelsPath = path.join(__dirname, "..", "models");

// Safely load canvas (prevents server crash if dependencies missing)
try {
  canvas = require("canvas");
} catch (e) {
  console.warn("⚠️ Canvas failed to load (Face API disabled):", e.message);
}
const { Canvas, Image, ImageData, loadImage } = canvas;

// MonkeyPatch FaceAPI for Node.js environment
if (Canvas) {
  faceapi.env.monkeyPatch({ Canvas, Image, ImageData, readFile: fs.promises.readFile });
}

// Load Models Helper
const loadModels = async () => {
  if (modelsLoaded || !Canvas) return;
  
  if (!fs.existsSync(modelsPath) || !fs.existsSync(path.join(modelsPath, "ssd_mobilenetv1_model-weights_manifest.json"))) {
    throw new Error(`❌ Models missing at ${modelsPath}. Run 'node download-models.js'.`);
  }

  console.log("⏳ Loading FaceAPI models...");
  await Promise.all([
    faceapi.nets.ssdMobilenetv1.loadFromDisk(modelsPath),
    faceapi.nets.faceLandmark68Net.loadFromDisk(modelsPath),
    faceapi.nets.faceRecognitionNet.loadFromDisk(modelsPath),
  ]);
  
  modelsLoaded = true;
  console.log("✅ FaceAPI models loaded.");
};

// Auto-init models on server start
loadModels().catch(err => console.error("❌ Failed to load FaceAPI models:", err.message));


// --- 2. Controller Functions ---

/**
 * Create a new Employee with optional Face ID
 */
exports.createEmployee = async (req, res) => {
  const supabase = req.app.locals.supabase;
  const { first_name, last_name, email, employee_id, password, is_admin, image } = req.body;

  // Validation
  if (!email || !password || !employee_id) {
    return res.status(400).json({ error: "Email, password, and employee ID are required" });
  }

  try {
    // A. Check for existing Employee ID
    const { data: existingEmp } = await supabase
      .from("employees")
      .select("employee_id")
      .eq("employee_id", employee_id)
      .maybeSingle();

    if (existingEmp) {
      return res.status(409).json({ error: "Employee ID already exists." });
    }

    // B. Create Auth User in Supabase Auth
    const { data: authData, error: authError } = await supabase.auth.admin.createUser({
      email: email.trim(),
      password,
      email_confirm: true,
      user_metadata: { first_name, last_name, employee_id, is_admin }
    });

    if (authError) throw authError;
    const createdAuthUser = authData.user;

    // C. Process Face Image (if provided)
    let face_encoding = null;
    let is_registered = false;

    if (image) {
      if (!loadImage) throw new Error("Server Error: Canvas not available.");
      if (!modelsLoaded) await loadModels();

      const imgBuffer = Buffer.from(image.replace(/^data:image\/\w+;base64,\s*/i, ""), "base64");
      const img = await loadImage(imgBuffer);
      const detection = await faceapi.detectSingleFace(img).withFaceLandmarks().withFaceDescriptor();

      if (!detection) {
        // Rollback: Delete created Auth user if face detection fails
        await supabase.auth.admin.deleteUser(createdAuthUser.id);
        return res.status(422).json({ error: "No face detected. Please try a clearer photo." });
      }
      
      face_encoding = Array.from(detection.descriptor);
      is_registered = true;
    }

    // D. Insert into 'employees' Database
    const { data: insertedEmployee, error: dbError } = await supabase
      .from("employees")
      .insert([{
          auth_uid: createdAuthUser.id,
          first_name,
          last_name,
          email: email.toLowerCase(),
          employee_id,
          is_admin: !!is_admin,
          is_registered,
          face_encoding
      }])
      .select()
      .single();

    if (dbError) {
      // Rollback: Delete Auth user if DB insert fails
      await supabase.auth.admin.deleteUser(createdAuthUser.id);
      throw dbError;
    }

    res.status(201).json({ 
      message: "Employee created successfully", 
      employee: insertedEmployee 
    });

  } catch (error) {
    console.error("Create Employee Error:", error);
    if (error.code === "23505") return res.status(409).json({ error: "Conflict: Record already exists." });
    res.status(400).json({ error: error.message });
  }
};

/**
 * Get Top Performers (Late, Early, Attendance, Overtime)
 */
exports.getTopPerformers = async (req, res) => {
  const supabase = req.app.locals.supabase;

  try {
    const { data: records, error } = await supabase
      .from("attendance")
      .select("*, employees(first_name, last_name)")
      .not("check_in_time", "is", null);

    if (error) throw error;

    const stats = {};

    records.forEach((record) => {
      const empId = record.employee_id;
      if (!record.employees) return;

      if (!stats[empId]) {
        stats[empId] = {
          id: empId,
          name: `${record.employees.first_name} ${record.employees.last_name}`,
          lateCount: 0,
          earlyCount: 0,
          attendanceCount: 0,
          overtimeHours: 0,
        };
      }

      const checkIn = new Date(record.check_in_time);
      
      // 1. Attendance Count
      stats[empId].attendanceCount++;

      // 2. Late Check-in (> 8:15 AM)
      const lateThreshold = new Date(checkIn);
      lateThreshold.setHours(8, 15, 0, 0);
      if (checkIn > lateThreshold) stats[empId].lateCount++;

      // 3. Early Arrival (< 8:00 AM)
      const earlyThreshold = new Date(checkIn);
      earlyThreshold.setHours(8, 0, 0, 0);
      if (checkIn < earlyThreshold) stats[empId].earlyCount++;

      // 4. Overtime (> 8 hours)
      if (record.check_out_time) {
        const checkOut = new Date(record.check_out_time);
        const durationHours = (checkOut - checkIn) / 36e5; // 36e5 = 1000 * 60 * 60
        if (durationHours > 8) stats[empId].overtimeHours += (durationHours - 8);
      }
    });

    const allStats = Object.values(stats);
    // Sort descending by value for each category
    const getTop3 = (key) => [...allStats].sort((a, b) => b[key] - a[key]).slice(0, 3);

    res.status(200).json({
      success: true,
      topLate: getTop3("lateCount"),
      topEarly: getTop3("earlyCount"),
      topAttendance: getTop3("attendanceCount"),
      topOvertime: getTop3("overtimeHours"),
    });

  } catch (error) {
    console.error("Get Top Performers Error:", error);
    res.status(500).json({ error: error.message });
  }
};

/**
 * Get Global Settings
 */
exports.getSettings = async (req, res) => {
  const supabase = req.app.locals.supabase;
  try {
    const { data, error } = await supabase.from("settings").select("*").limit(1).maybeSingle();
    if (error) throw error;
    res.status(200).json(data || {});
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

/**
 * Update Global Settings (Upsert)
 */
exports.updateSettings = async (req, res) => {
  const supabase = req.app.locals.supabase;
  const { office_latitude, office_longitude, office_radius_meters, telegram_bot_token, telegram_group_id } = req.body;

  try {
    // Check if settings row exists to get ID for upsert
    const { data: existing } = await supabase.from("settings").select("id").limit(1).maybeSingle();
    const id = existing ? existing.id : undefined;

    const { data, error } = await supabase
      .from("settings")
      .upsert({ 
        id, // If ID exists, it updates; otherwise, it inserts a new row
        office_latitude, 
        office_longitude, 
        office_radius_meters, 
        telegram_bot_token, 
        telegram_group_id 
      })
      .select()
      .single();

    if (error) throw error;
    res.status(200).json(data);

  } catch (error) {
    console.error("Update Settings Error:", error);
    res.status(500).json({ error: error.message });
  }
};

/**
 * Get All Attendance History with Stats
 */
exports.getAllAttendanceHistory = async (req, res) => {
  const supabase = req.app.locals.supabase;

  try {
    const { data, error } = await supabase
      .from("attendance")
      .select("*, employees(first_name, last_name, employee_id)")
      .order("check_in_time", { ascending: false });

    if (error) throw error;

    // --- Statistics Calculation ---
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    
    // 1. Get Total Employee Count
    const { count: totalEmployees, error: empError } = await supabase
      .from("employees")
      .select("*", { count: "exact", head: true });

    if (empError) throw empError;

    // 2. Calculate Business Days so far this month (Mon-Sat)
    let workingDays = 0;
    const d = new Date(startOfMonth);
    while (d <= now) {
      const day = d.getDay();
      if (day !== 0) workingDays++; // Assuming Sunday (0) is off
      d.setDate(d.getDate() + 1);
    }

    // 3. Count Unique Present Employees
    const uniquePresent = new Set();
    data.forEach((record) => {
      const recordDate = new Date(record.check_in_time);
      if (recordDate >= startOfMonth && recordDate <= now && record.status === "present") {
        uniquePresent.add(`${record.employee_id}-${recordDate.toDateString()}`);
      }
    });

    // 4. Calculate Absences
    const totalAbsent = Math.max(0, (totalEmployees || 0) * workingDays - uniquePresent.size);

    res.status(200).json({ 
      data, 
      stats: { 
        absent: totalAbsent, 
        workingDays, 
        present: uniquePresent.size 
      } 
    });

  } catch (error) {
    console.error("Get All Attendance Error:", error);
    res.status(500).json({ error: error.message });
  }
};