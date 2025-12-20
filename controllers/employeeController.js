require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const faceapi = require("face-api.js");
const path = require("path");
const fs = require("fs");

// Safely load canvas
let canvas = {};
try {
  canvas = require("canvas");
} catch (e) {
  console.warn("Canvas failed to load:", e.message);
}
const { Canvas, Image, ImageData, loadImage } = canvas;

// Initialize Supabase client
// Ensure SUPABASE_URL and SUPABASE_KEY (or SUPABASE_SERVICE_ROLE_KEY) are in your .env file
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

// Configure FaceAPI
if (Canvas) {
  faceapi.env.monkeyPatch({ Canvas, Image, ImageData });
}

const modelsPath = path.join(__dirname, "..", "models");
let modelsLoaded = false;

const loadModels = async () => {
  if (modelsLoaded || !Canvas) return;
  if (!fs.existsSync(modelsPath)) {
    throw new Error(`FaceAPI models not found at ${modelsPath}. Ensure 'node download-models.js' runs during build.`);
  }
  await faceapi.nets.ssdMobilenetv1.loadFromDisk(modelsPath);
  await faceapi.nets.faceLandmark68Net.loadFromDisk(modelsPath);
  await faceapi.nets.faceRecognitionNet.loadFromDisk(modelsPath);
  modelsLoaded = true;
};

const getEuclideanDistance = (face1, face2) => {
  if (!face1 || !face2 || face1.length !== face2.length) return Infinity;
  return Math.sqrt(face1.reduce((sum, val, i) => sum + Math.pow(val - face2[i], 2), 0));
};

const checkIn = async (req, res) => {
  try {
    let imageBuffer;
    if (req.file) {
      imageBuffer = req.file.buffer;
    } else if (req.body.image) {
      const base64Data = req.body.image.replace(/^data:image\/\w+;base64,\s*/i, "");
      imageBuffer = Buffer.from(base64Data, "base64");
    }

    if (!imageBuffer) {
      return res.status(400).json({ error: "Image capture is required for check-in" });
    }
    const user = req.user; // Populated by authMiddleware

    if (!user || !user.id) {
      return res.status(401).json({ error: 'Unauthorized: User not identified' });
    }

    // 1. Verify Face: Get registered encoding
    const { data: employee, error: empError } = await supabase
      .from('employees')
      .select('face_encoding')
      .eq('id', user.id)
      .single();

    if (empError || !employee) return res.status(404).json({ error: 'Employee record not found' });
    if (!employee.face_encoding) return res.status(400).json({ error: 'Face not registered. Please contact admin.' });

    // 2. Get encoding for current captured image locally
    if (!loadImage) {
      return res.status(500).json({ error: "Face verification unavailable: Server missing graphics libraries." });
    }

    if (!modelsLoaded) await loadModels();

    const img = await loadImage(imageBuffer);
    const detection = await faceapi.detectSingleFace(img).withFaceLandmarks().withFaceDescriptor();

    if (!detection) return res.status(400).json({ error: "No face detected in camera feed" });
    const currentEncoding = detection.descriptor;

    // 3. Compare Encodings
    const distance = getEuclideanDistance(employee.face_encoding, currentEncoding);
    if (distance > 0.5) { // Threshold: Lower is stricter
      return res.status(403).json({ error: "Face verification failed: Not your face" });
    }

    // Insert attendance record into the 'attendance' table
    const { data, error } = await supabase
      .from('attendance')
      .insert([
        {
          employee_id: user.id,
          check_in_time: new Date().toISOString(),
          status: 'present',
          check_in_image: imageBuffer.toString('base64')
        }
      ])
      .select();

    if (error) throw error;

    res.status(200).json({ message: 'Check-in successful', data });
  } catch (error) {
    console.error('Check-in Controller Error:', error);
    res.status(500).json({ error: error.message || 'Internal Server Error' });
  }
};

const checkOut = async (req, res) => {
  try {
    let imageBuffer;
    if (req.file) {
      imageBuffer = req.file.buffer;
    } else if (req.body.image) {
      const base64Data = req.body.image.replace(/^data:image\/\w+;base64,\s*/i, "");
      imageBuffer = Buffer.from(base64Data, "base64");
    }

    if (!imageBuffer) {
      return res.status(400).json({ error: "Image capture is required for check-out" });
    }
    const user = req.user;

    if (!user || !user.id) {
      return res.status(401).json({ error: 'Unauthorized: User not identified' });
    }

    // 1. Verify Face: Get registered encoding
    const { data: employee, error: empError } = await supabase
      .from('employees')
      .select('face_encoding')
      .eq('id', user.id)
      .single();

    if (empError || !employee) return res.status(404).json({ error: 'Employee record not found' });
    if (!employee.face_encoding) return res.status(400).json({ error: 'Face not registered. Please contact admin.' });

    // 2. Get encoding for current captured image locally
    if (!loadImage) {
      return res.status(500).json({ error: "Face verification unavailable: Server missing graphics libraries." });
    }

    if (!modelsLoaded) await loadModels();

    const img = await loadImage(imageBuffer);
    const detection = await faceapi.detectSingleFace(img).withFaceLandmarks().withFaceDescriptor();

    if (!detection) return res.status(400).json({ error: "No face detected in camera feed" });
    const currentEncoding = detection.descriptor;

    // 3. Compare Encodings
    const distance = getEuclideanDistance(employee.face_encoding, currentEncoding);
    if (distance > 0.5) {
      return res.status(403).json({ error: "Face verification failed: Not your face" });
    }

    // 1. Find the latest open check-in (where check_out_time is null)
    const { data: lastCheckIn, error: findError } = await supabase
      .from('attendance')
      .select('*')
      .eq('employee_id', user.id)
      .is('check_out_time', null)
      .order('check_in_time', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (findError) throw findError;
    if (!lastCheckIn) {
      return res.status(400).json({ error: 'No active check-in found. Please check in first.' });
    }

    // 2. Update that record
    const { data, error } = await supabase
      .from('attendance')
      .update({
        check_out_time: new Date().toISOString(),
        status: 'present',
        check_out_image: imageBuffer.toString('base64')
      })
      .eq('id', lastCheckIn.id)
      .select();

    if (error) throw error;

    res.status(200).json({ message: 'Check-out successful', data });
  } catch (error) {
    console.error('Check-out Controller Error:', error);
    res.status(500).json({ error: error.message || 'Internal Server Error' });
  }
};

const getAttendanceHistory = async (req, res) => {
  try {
    const user = req.user;

    if (!user || !user.id) {
      return res.status(401).json({ error: 'Unauthorized: User not identified' });
    }

    const { data: employee } = await supabase
      .from('employees')
      .select('first_name, last_name')
      .eq('id', user.id)
      .single();

    const { data, error } = await supabase
      .from('attendance')
      .select('*')
      .eq('employee_id', user.id)
      .order('check_in_time', { ascending: false });

    if (error) throw error;

    res.status(200).json({ data, employee });
  } catch (error) {
    console.error('Get Attendance History Error:', error);
    res.status(500).json({ error: error.message || 'Internal Server Error' });
  }
};

const getAllEmployees = async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('employees')
      .select('*');

    if (error) throw error;

    res.status(200).json({ data });
  } catch (error) {
    console.error('Get All Employees Error:', error);
    res.status(500).json({ error: error.message || 'Internal Server Error' });
  }
};

const deleteEmployee = async (req, res) => {
  try {
    const { id } = req.params;
    
    const { error } = await supabase
      .from('employees')
      .delete()
      .eq('id', id);

    if (error) throw error;

    res.status(200).json({ success: true, message: 'Employee deleted successfully' });
  } catch (error) {
    console.error('Delete Employee Error:', error);
    res.status(500).json({ error: error.message || 'Internal Server Error' });
  }
};

module.exports = { checkIn, checkOut, getAttendanceHistory, getAllEmployees, deleteEmployee };