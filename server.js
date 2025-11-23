import express from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import { analyzeVideo } from "./massEmotions.js";

const app = express();
const upload = multer({ dest: "uploads/" });

app.use(express.static("public"));

app.post("/upload-video", upload.single("video"), async (req, res) => {
  if (!req.file) return res.json({ success: false, error: "No video uploaded" });

  try {
    const result = await analyzeVideo(req.file.path);

    // Clean up uploaded file
    fs.unlinkSync(req.file.path);

    res.json({ success: true, ...result });
  } catch (err) {
    console.error(err);
    res.json({ success: false, error: err.message });
  }
});

app.listen(3000, () => console.log("Server running on http://localhost:3000"));
