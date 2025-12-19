const fs = require("fs")
const path = require("path")
const https = require("https")

const modelsDir = path.join(__dirname, "models")
const baseUrl = "https://raw.githubusercontent.com/justadudewhohacks/face-api.js/master/weights"

const files = [
  "ssd_mobilenetv1_model-weights_manifest.json",
  "ssd_mobilenetv1_model-shard1",
  "ssd_mobilenetv1_model-shard2",
  "face_landmark_68_model-weights_manifest.json",
  "face_landmark_68_model-shard1",
  "face_recognition_model-weights_manifest.json",
  "face_recognition_model-shard1",
  "face_recognition_model-shard2",
]

if (!fs.existsSync(modelsDir)) {
  console.log(`Creating models directory at ${modelsDir}`)
  fs.mkdirSync(modelsDir, { recursive: true })
}

console.log("Starting model downloads...")

files.forEach((file) => {
  const filePath = path.join(modelsDir, file)
  const url = `${baseUrl}/${file}`

  if (fs.existsSync(filePath)) {
    console.log(`Skipping ${file} - already exists`)
    return
  }

  const fileStream = fs.createWriteStream(filePath)
  
  https.get(url, (res) => {
    if (res.statusCode !== 200) {
      console.error(`Failed to download ${file}: HTTP ${res.statusCode}`)
      res.resume()
      return
    }
    
    res.pipe(fileStream)
    
    fileStream.on("finish", () => {
      fileStream.close()
      console.log(`Downloaded ${file}`)
    })
  }).on("error", (err) => {
    console.error(`Error downloading ${file}: ${err.message}`)
    fs.unlink(filePath, () => {}) // Delete partial file
  })
})