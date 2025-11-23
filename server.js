import express from "express";
import multer from "multer";
import path from "path";
import { analyzeVideo } from "./js/reflection.js";

const app = express();
const PORT = 3000;

// Serve front-end files
app.use(express.static(path.join(process.cwd(), "public")));

// Multer setup for file uploads
const storage = multer.memoryStorage();
const upload = multer({ storage });

// Upload video route
app.post("/upload-video", upload.single("video"), async (req, res) => {
  try {
    if (!req.file) return res.json({ success: false, error: "No file uploaded" });

    // Save to temp file for processing
    const tempPath = path.join(process.cwd(), "temp_video.mp4");
    await fs.promises.writeFile(tempPath, req.file.buffer);

    // Run analysis
    const timeline = await analyzeVideo(tempPath);

    // Return JSON to front-end
    res.json({ success: true, timeline });
  } catch (err) {
    console.error(err);
    res.json({ success: false, error: err.message });
  }
});

app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
