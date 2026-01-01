const { createClient } = require('@supabase/supabase-js');
const faceapi = require("@vladmandic/face-api");
const path = require("path");
const fs = require("fs");
const cron = require('node-cron');

// --- 1. Configuration & Setup ---

// Safely load canvas (Prevents crash on non-supported environments)
let canvas = {};
try {
  canvas = require("canvas");
} catch (e) {
  console.warn("⚠️ Canvas failed to load (Face API disabled):", e.message);
}
const { Canvas, Image, ImageData, loadImage } = canvas;

// Initialize Supabase
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;
if (!supabaseUrl || !supabaseKey) throw new Error("Missing Supabase credentials in .env");
const supabase = createClient(supabaseUrl, supabaseKey);

// Configure FaceAPI for Node.js
if (Canvas) {
  faceapi.env.monkeyPatch({ Canvas, Image, ImageData, readFile: fs.promises.readFile });
}

// --- 2. AI Model Loading ---
const modelsPath = path.join(__dirname, "..", "models");
let modelsLoaded = false;

const loadModels = async () => {
  if (modelsLoaded || !Canvas) return;
  
  if (!fs.existsSync(modelsPath) || !fs.existsSync(path.join(modelsPath, "tiny_face_detector_model-weights_manifest.json"))) {
    throw new Error(`❌ FaceAPI models missing at ${modelsPath}. Run 'node download-models.js'.`);
  }

  console.log("⏳ Loading FaceAPI models...");
  await Promise.all([
    faceapi.nets.tinyFaceDetector.loadFromDisk(modelsPath),
    faceapi.nets.faceLandmark68Net.loadFromDisk(modelsPath),
    faceapi.nets.faceRecognitionNet.loadFromDisk(modelsPath)
  ]);
  modelsLoaded = true;
  console.log("✅ FaceAPI models loaded.");
};

// Preload models on startup
loadModels().catch(console.error);

// --- 3. Helper Functions ---

const getCambodiaTime = () => {
  const now = new Date();
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: "Asia/Phnom_Penh",
    year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', second: 'numeric',
    hour12: false
  });
  const parts = formatter.formatToParts(now);
  const part = (type) => parseInt(parts.find(p => p.type === type).value, 10);
  // Returns a Date object shifted to Cambodia time
  return new Date(Date.UTC(part('year'), part('month') - 1, part('day'), part('hour'), part('minute'), part('second')));
};

const getEuclideanDistance = (face1, face2) => {
  if (!face1 || !face2 || face1.length !== face2.length) return Infinity;
  return Math.sqrt(face1.reduce((sum, val, i) => sum + Math.pow(val - face2[i], 2), 0));
};

const getImageBuffer = (req) => {
  if (req.file) return req.file.buffer;
  if (req.body.image) {
    const base64Data = req.body.image.replace(/^data:image\/\w+;base64,\s*/i, "");
    return Buffer.from(base64Data, "base64");
  }
  return null;
};

// Helper to run face detection logic
const detectFace = async (imageBuffer) => {
  if (!loadImage) throw new Error("Face verification unavailable: Server missing graphics libraries.");
  if (!modelsLoaded) await loadModels();
  
  const img = await loadImage(imageBuffer);
  return faceapi.detectSingleFace(img, new faceapi.TinyFaceDetectorOptions({ inputSize: 224, scoreThreshold: 0.5 }))
    .withFaceLandmarks()
    .withFaceDescriptor();
};

// --- 4. Controller Functions ---

const checkIn = async (req, res) => {
  try {
    const imageBuffer = getImageBuffer(req);
    const user = req.user;

    if (!imageBuffer) return res.status(400).json({ error: "Image capture is required for check-in" });
    if (!user || !user.id) return res.status(401).json({ error: 'Unauthorized: User not identified' });

    // 1. Run DB Fetch and Face Detection in Parallel
    const employeeTask = supabase.from('employees').select('face_encoding').eq('id', user.id).single();
    const detectionTask = detectFace(imageBuffer);

    const [{ data: employee, error: empError }, detection] = await Promise.all([employeeTask, detectionTask]);

    // 2. Validations
    if (empError || !employee) return res.status(404).json({ error: 'Employee record not found' });
    if (!employee.face_encoding) return res.status(400).json({ error: 'Face not registered. Please contact admin.' });
    if (!detection) return res.status(400).json({ error: "No face detected in camera feed" });

    // 3. Verify Face
    const distance = getEuclideanDistance(employee.face_encoding, detection.descriptor);
    if (distance > 0.5) return res.status(403).json({ error: "Face verification failed: Not your face" });

    // 4. Calculate Status (Early/Late)
    const checkInDate = getCambodiaTime();
    const startTime = new Date(checkInDate); startTime.setHours(8, 0, 0, 0);
    const lateTime = new Date(checkInDate); lateTime.setHours(8, 15, 0, 0);

    let statusTime = 'On Time';
    if (checkInDate < startTime) statusTime = 'Early';
    else if (checkInDate > lateTime) statusTime = 'Late';

    // 5. Insert Record
    const { data, error } = await supabase.from('attendance').insert([{
      employee_id: user.id,
      check_in_time: checkInDate.toISOString(),
      status: 'present',
      status_time: statusTime,
      check_in_image: imageBuffer.toString('base64')
    }]).select();

    if (error) throw error;
    res.status(200).json({ message: 'Check-in successful', data });

  } catch (error) {
    console.error('Check-in Error:', error);
    res.status(500).json({ error: error.message || 'Internal Server Error' });
  }
};

const checkOut = async (req, res) => {
  try {
    const imageBuffer = getImageBuffer(req);
    const user = req.user;

    if (!imageBuffer) return res.status(400).json({ error: "Image capture is required for check-out" });
    if (!user || !user.id) return res.status(401).json({ error: 'Unauthorized: User not identified' });

    // 1. Run Tasks in Parallel
    const employeeTask = supabase.from('employees').select('face_encoding').eq('id', user.id).single();
    
    // Find latest active check-in
    const lastCheckInTask = supabase.from('attendance')
      .select('*')
      .eq('employee_id', user.id)
      .is('check_out_time', null)
      .order('check_in_time', { ascending: false })
      .limit(1)
      .maybeSingle();

    const detectionTask = detectFace(imageBuffer);

    const [
      { data: employee, error: empError },
      { data: lastCheckIn, error: findError },
      detection
    ] = await Promise.all([employeeTask, lastCheckInTask, detectionTask]);

    // 2. Validations
    if (empError || !employee) return res.status(404).json({ error: 'Employee record not found' });
    if (!employee.face_encoding) return res.status(400).json({ error: 'Face not registered. Please contact admin.' });
    if (!detection) return res.status(400).json({ error: "No face detected in camera feed" });

    // 3. Verify Face
    const distance = getEuclideanDistance(employee.face_encoding, detection.descriptor);
    if (distance > 0.5) return res.status(403).json({ error: "Face verification failed: Not your face" });

    if (findError) throw findError;
    if (!lastCheckIn) return res.status(400).json({ error: 'No active check-in found. Please check in first.' });

    // 4. Update Record
    const checkOutDate = getCambodiaTime();
    const { data, error } = await supabase.from('attendance')
      .update({
        check_out_time: checkOutDate.toISOString(),
        status: 'present',
        check_out_image: imageBuffer.toString('base64')
      })
      .eq('id', lastCheckIn.id)
      .select();

    if (error) throw error;
    res.status(200).json({ message: 'Check-out successful', data });

  } catch (error) {
    console.error('Check-out Error:', error);
    res.status(500).json({ error: error.message || 'Internal Server Error' });
  }
};

const runAutoCheckOut = async () => {
  const now = getCambodiaTime();
  const timeString = now.toISOString().replace('T', ' ').substring(0, 19);
  console.log(`⏰ Running Auto Check-out Task at ${timeString} (Cambodia Time)...`);

  try {
    // 1. Define Range (Today)
    const startOfDay = new Date(now); startOfDay.setUTCHours(0, 0, 0, 0);
    const endOfDay = new Date(now); endOfDay.setUTCHours(23, 59, 59, 999);

    // 2. Find forgotten check-outs
    const { data: records, error } = await supabase
      .from('attendance')
      .select('id, check_in_time')
      .is('check_out_time', null)
      .gte('check_in_time', startOfDay.toISOString())
      .lte('check_in_time', endOfDay.toISOString());

    if (error) throw error;

    if (records && records.length > 0) {
      console.log(`   Found ${records.length} forgotten check-outs.`);

      // 4. Update All Records concurrently (Optimized)
      const updates = records.map(async (record) => {
        // Use current Cambodia time (when script runs) as checkout time
        const checkOutTime = new Date(now);

        return supabase.from('attendance')
          .update({ 
            check_out_time: checkOutTime.toISOString(),
            status: 'present'
          })
          .eq('id', record.id);
      });

      await Promise.all(updates);
      console.log(`✅ Auto Check-out applied to ${records.length} records.`);
    } else {
      console.log("   No forgotten check-outs found.");
    }
  } catch (err) {
    console.error("❌ Auto Check-out Error:", err.message);
  }
};

const getAttendanceHistory = async (req, res) => {
  try {
    const user = req.user;
    if (!user || !user.id) return res.status(401).json({ error: 'Unauthorized' });

    // Parallel fetch: Employee details & Attendance Logs
    const [{ data: employee }, { data, error }] = await Promise.all([
      supabase.from('employees').select('first_name, last_name').eq('id', user.id).single(),
      supabase.from('attendance')
        .select('id, employee_id, check_in_time, check_out_time, status, status_time')
        .eq('employee_id', user.id)
        .order('check_in_time', { ascending: false })
    ]);

    if (error) throw error;

    // Stats Calculation
    const now = getCambodiaTime();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    
    let workingDays = 0;
    const d = new Date(startOfMonth);
    while (d <= now) {
      const day = d.getUTCDay();
      if (day !== 0 && day !== 6) workingDays++; // Exclude Sun (0) & Sat (6)
      d.setUTCDate(d.getUTCDate() + 1);
    }

    const uniquePresent = new Set();
    data.forEach((record) => {
      const recordDate = new Date(record.check_in_time);
      if (recordDate >= startOfMonth && recordDate <= now && record.status === 'present') {
        uniquePresent.add(recordDate.toISOString().split('T')[0]); // YYYY-MM-DD
      }
    });

    const absentCount = Math.max(0, workingDays - uniquePresent.size);

    res.status(200).json({ 
      data, 
      employee, 
      stats: { absent: absentCount, workingDays, present: uniquePresent.size } 
    });
  } catch (error) {
    console.error('Get History Error:', error);
    res.status(500).json({ error: error.message });
  }
};

const getAllEmployees = async (req, res) => {
  try {
    const { data, error } = await supabase.from('employees').select('*');
    if (error) throw error;
    res.status(200).json({ data });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

const deleteEmployee = async (req, res) => {
  try {
    const { id } = req.params;
    const { error } = await supabase.from('employees').delete().eq('id', id);
    if (error) throw error;
    res.status(200).json({ success: true, message: 'Employee deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// --- 5. Scheduler ---
// Run every day at 11:59 PM Cambodia Time
cron.schedule('59 23 * * *', runAutoCheckOut, { timezone: "Asia/Phnom_Penh" });

// --- 6. Exports ---
module.exports = { 
  checkIn, 
  checkOut, 
  getAttendanceHistory, 
  getAllEmployees, 
  deleteEmployee, 
  runAutoCheckOut 
};