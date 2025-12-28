const faceapi = require("@vladmandic/face-api")
const path = require("path")
const fs = require("fs")

// Safely load canvas to prevent server crash on environments where it's not supported
let canvas = {}
try {
  canvas = require("canvas")
} catch (e) {
  console.warn("Canvas failed to load (Face API will be disabled):", e.message)
}
const { Canvas, Image, ImageData, loadImage } = canvas

// 1. Configure FaceAPI for Node.js environment
if (Canvas) {
  faceapi.env.monkeyPatch({ Canvas, Image, ImageData, readFile: fs.promises.readFile })
}

// 2. Load Models (Ensure you have a 'models' folder in api/express-api/)
const modelsPath = path.join(__dirname, "..", "models")
let modelsLoaded = false

const loadModels = async () => {
  if (modelsLoaded || !Canvas) return
  if (!fs.existsSync(modelsPath)) {
    throw new Error(`FaceAPI models not found at ${modelsPath}. Ensure 'node download-models.js' runs during build (add as 'postinstall' script in package.json).`)
  }
  if (!fs.existsSync(path.join(modelsPath, "ssd_mobilenetv1_model-weights_manifest.json"))) {
    throw new Error(`Model files missing in ${modelsPath}. Please run 'node download-models.js'.`)
  }
  await faceapi.nets.ssdMobilenetv1.loadFromDisk(modelsPath)
  await faceapi.nets.faceLandmark68Net.loadFromDisk(modelsPath)
  await faceapi.nets.faceRecognitionNet.loadFromDisk(modelsPath)
  modelsLoaded = true
  console.log("FaceAPI models loaded successfully")
}

// Initialize models on startup
loadModels().catch(err => console.error("Failed to load FaceAPI models:", err))

exports.createEmployee = async (req, res) => {
  const supabase = req.app.locals.supabase;
  const { first_name, last_name, email, employee_id, password, is_admin, image } = req.body;

  // 1. Basic Validation
  if (!email || !password || !employee_id) {
    return res.status(400).json({ error: "Email, password, and employee ID are required" });
  }

  try {
    // 2. PRE-CHECK: Prevent sending data if employee_id already exists in DB
    const { data: existingEmp, error: checkError } = await supabase
      .from("employees")
      .select("employee_id")
      .eq("employee_id", employee_id)
      .maybeSingle();

    if (checkError) throw checkError;
    if (existingEmp) {
      return res.status(409).json({ error: "Employee ID already exists. Data not sent." });
    }

    let createdAuthUser = null;

    // 3. Create Auth User
    const { data: authData, error: authError } = await supabase.auth.admin.createUser({
      email: email.trim(),
      password,
      email_confirm: true,
      user_metadata: { first_name, last_name, employee_id, is_admin }
    });

    if (authError) throw authError;
    createdAuthUser = authData.user;

    // 4. Process Face Image
    let face_encoding = null;
    let is_registered = false;

    if (image) {
      if (!loadImage) {
        return res.status(500).json({ error: "Server Error: Face processing libraries (Canvas) are not available in this environment." });
      }

      if (!modelsLoaded) await loadModels();
      const base64Data = image.replace(/^data:image\/\w+;base64,\s*/i, "");
      const imgBuffer = Buffer.from(base64Data, "base64");
      const img = await loadImage(imgBuffer);
      const detection = await faceapi.detectSingleFace(img).withFaceLandmarks().withFaceDescriptor();

      if (!detection) {
        // Rollback Auth user because face detection failed
        await supabase.auth.admin.deleteUser(createdAuthUser.id);
        return res.status(422).json({ error: "No face detected. Employee creation cancelled." });
      }
      
      face_encoding = Array.from(detection.descriptor);
      is_registered = true;
    }

    // 5. Final Database Insert
    const { data: insertedEmployee, error: dbError } = await supabase
      .from("employees")
      .insert([{
          auth_uid: createdAuthUser.id,
          first_name,
          last_name,
          email: email.toLowerCase(),
          employee_id,
          is_admin: is_admin || false,
          is_registered,
          face_encoding
      }])
      .select().single();

    if (dbError) {
      // FINAL ROLLBACK: If DB fails for any reason (like a race condition), delete the Auth user
      if (createdAuthUser) {
        await supabase.auth.admin.deleteUser(createdAuthUser.id);
      }
      throw dbError;
    }

    res.status(201).json({ 
      message: "Employee created successfully", 
      employee: insertedEmployee 
    });

  } catch (error) {
    console.error("Create Employee Error:", error);
    
    // Handle specific Postgres unique constraint errors (Code 23505)
    if (error.code === "23505") {
      return res.status(409).json({ error: "Conflict: This record already exists." });
    }

    res.status(400).json({ error: error.message });
  }
};



exports.getTopPerformers = async (req, res) => {
  const supabase = req.app.locals.supabase

  try {
    const { data: records, error } = await supabase
      .from("time_logs")
      .select("*, employees(first_name, last_name)")
      .not("check_in_time", "is", null)

    if (error) throw error

    const stats = {}

    records.forEach((record) => {
      const empId = record.employee_id
      if (!record.employees) return // Skip if employee data is missing

      if (!stats[empId]) {
        stats[empId] = {
          id: empId,
          name: `${record.employees.first_name} ${record.employees.last_name}`,
          lateCount: 0,
          earlyCount: 0,
          attendanceCount: 0,
          overtimeHours: 0,
        }
      }

      const checkIn = new Date(record.check_in_time)

      // 1. Attendance Count
      stats[empId].attendanceCount++

      // 2. Late Check-in (> 8:15 AM)
      const lateThreshold = new Date(checkIn)
      lateThreshold.setHours(8, 15, 0, 0)
      if (checkIn > lateThreshold) stats[empId].lateCount++

      // 3. Early Arrival (< 8:00 AM)
      const earlyThreshold = new Date(checkIn)
      earlyThreshold.setHours(8, 0, 0, 0)
      if (checkIn < earlyThreshold) stats[empId].earlyCount++

      // 4. Overtime (> 8 hours)
      if (record.check_out_time) {
        const checkOut = new Date(record.check_out_time)
        const durationHours = (checkOut - checkIn) / (1000 * 60 * 60)
        if (durationHours > 8) stats[empId].overtimeHours += durationHours - 8
      }
    })

    const allStats = Object.values(stats)
    const getTop3 = (key) => [...allStats].sort((a, b) => b[key] - a[key]).slice(0, 3)

    res.status(200).json({
      success: true,
      topLate: getTop3("lateCount"),
      topEarly: getTop3("earlyCount"),
      topAttendance: getTop3("attendanceCount"),
      topOvertime: getTop3("overtimeHours"),
    })
  } catch (error) {
    console.error("Get Top Performers Error:", error)
    res.status(500).json({ error: error.message })
  }
}



exports.getSettings = async (req, res) => {
  const supabase = req.app.locals.supabase

  try {
    const { data, error } = await supabase
      .from("settings")
      .select("*")
      .limit(1)
      .maybeSingle()

    if (error) throw error

    res.status(200).json(data || {})
  } catch (error) {
    console.error("Get Settings Error:", error)
    res.status(500).json({ error: error.message })
  }
}

exports.updateSettings = async (req, res) => {
  const supabase = req.app.locals.supabase
  const {
    office_latitude,
    office_longitude,
    office_radius_meters,
    telegram_bot_token,
    telegram_group_id,
  } = req.body

  try {
    // Check if a settings row already exists
    const { data: existing } = await supabase.from("settings").select("id").limit(1).maybeSingle()

    let result
    if (existing) {
      const { data, error } = await supabase
        .from("settings")
        .update({
          office_latitude,
          office_longitude,
          office_radius_meters,
          telegram_bot_token,
          telegram_group_id,
        })
        .eq("id", existing.id)
        .select()
        .single()

      if (error) throw error
      result = data
    } else {
      const { data, error } = await supabase
        .from("settings")
        .insert([{ office_latitude, office_longitude, office_radius_meters, telegram_bot_token, telegram_group_id }])
        .select()
        .single()

      if (error) throw error
      result = data
    }

    res.status(200).json(result)
  } catch (error) {
    console.error("Update Settings Error:", error)
    res.status(500).json({ error: error.message })
  }
}

exports.getAllAttendanceHistory = async (req, res) => {
  const supabase = req.app.locals.supabase

  try {
    const { data, error } = await supabase
      .from("attendance")
      .select("*, employees(first_name, last_name, employee_id)")
      .order("check_in_time", { ascending: false })

    if (error) throw error

    // Calculate Absent Stats for Current Month
    const now = new Date()
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1)

    const { count: totalEmployees, error: empError } = await supabase
      .from("employees")
      .select("*", { count: "exact", head: true })

    if (empError) throw empError

    let workingDays = 0
    const d = new Date(startOfMonth)
    while (d <= now) {
      const day = d.getDay()
      if (day !== 0 && day !== 6) workingDays++
      d.setDate(d.getDate() + 1)
    }

    const uniquePresent = new Set()
    data.forEach((record) => {
      const recordDate = new Date(record.check_in_time)
      if (recordDate >= startOfMonth && recordDate <= now) {
        if (record.status === "present") {
          uniquePresent.add(`${record.employee_id}-${recordDate.toDateString()}`)
        }
      }
    })

    const totalAbsent = Math.max(0, (totalEmployees || 0) * workingDays - uniquePresent.size)

    res.status(200).json({ 
      data, 
      stats: { 
        absent: totalAbsent,
        workingDays,
        present: uniquePresent.size
      } 
    })
  } catch (error) {
    console.error("Get All Attendance Error:", error)
    res.status(500).json({ error: error.message })
  }
}
