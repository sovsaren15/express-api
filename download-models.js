const fs = require("fs");
const path = require("path");
const https = require("https");

const modelsPath = path.join(__dirname, "models");

const models = [
  "ssd_mobilenetv1_model-weights_manifest.json",
  "ssd_mobilenetv1_model-shard1",
  "ssd_mobilenetv1_model-shard2",
  "face_landmark_68_model-weights_manifest.json",
  "face_landmark_68_model-shard1",
  "face_recognition_model-weights_manifest.json",
  "face_recognition_model-shard1",
  "face_recognition_model-shard2",
  "tiny_face_detector_model-weights_manifest.json",
  "tiny_face_detector_model-shard1",
];

const isFileValid = (filePath) => {
  try {
    const stats = fs.statSync(filePath);
    if (stats.size < 50) return false; // Valid models are much larger

    const content = fs.readFileSync(filePath);
    const head = content.slice(0, 50).toString().trim();
    
    // Check for HTML or 404 error text
    if (head.toLowerCase().startsWith("<!doctype") || head.toLowerCase().startsWith("<html") || head.includes("404: Not Found")) return false;
    
    if (filePath.endsWith(".json")) {
      const json = JSON.parse(content.toString());
      // Strict check: Manifests must be Arrays with 'paths' property
      if (!Array.isArray(json) || json.length === 0 || !json[0].paths || !json[0].weights) {
        return false;
      }
      // Ensure manifest points to shards, not .bin files (which causes ENOENT errors if .bin is missing)
      if (json[0].paths.some(p => p.endsWith('.bin'))) {
        return false;
      }
    }
    return true;
  } catch (e) {
    return false;
  }
};

const downloadFile = (url, dest) => {
  return new Promise((resolve, reject) => {
    const tempDest = dest + ".tmp";
    const file = fs.createWriteStream(tempDest);
    https.get(url, (response) => {
      if (response.statusCode !== 200) {
        fs.unlink(tempDest, () => {}); // Clean up temp
        reject(new Error(`Failed to download: ${response.statusCode}`));
        return;
      }
      response.pipe(file);
      file.on("finish", () => {
        file.close(() => {
          fs.renameSync(tempDest, dest); // Atomic rename: ensures file is only visible when complete
          resolve();
        });
      });
    }).on("error", (err) => {
      fs.unlink(tempDest, () => {});
      reject(err);
    });
  });
};

const main = async () => {
  if (!fs.existsSync(modelsPath)) {
    fs.mkdirSync(modelsPath, { recursive: true });
  }

  // Clean up any .bin files that might have been created by previous incorrect downloads
  // to ensure face-api doesn't try to load them by mistake.
  fs.readdirSync(modelsPath).forEach(file => {
    if (file.endsWith('.bin')) {
      try { fs.unlinkSync(path.join(modelsPath, file)); } catch(e) {}
    }
  });

  console.log("Downloading FaceAPI models...");

  let hasErrors = false;
  for (const model of models) {
    // Using the original repo for weights as it is the canonical source and avoids 404s
    const modelUrl = `https://raw.githubusercontent.com/justadudewhohacks/face-api.js/master/weights/${model}`;
    const destPath = path.join(modelsPath, model);

    if (fs.existsSync(destPath)) {
      if (isFileValid(destPath)) {
        console.log(`Skipping ${model} (already exists)`);
        continue;
      }
      console.log(`Found empty/corrupt file ${model}. Redownloading...`);
      fs.unlinkSync(destPath);
    }

    try {
      console.log(`Downloading ${model}...`);
      await downloadFile(modelUrl, destPath);
    } catch (error) {
      console.error(`Error downloading ${model}:`, error.message);
      hasErrors = true;
    }
  }

  if (hasErrors) {
    throw new Error("One or more models failed to download.");
  }
  console.log("All models downloaded.");
};

if (require.main === module) {
  main();
}

module.exports = main;