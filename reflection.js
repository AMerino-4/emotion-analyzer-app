import ffmpeg from "fluent-ffmpeg";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import { RekognitionClient, DetectFacesCommand } from "@aws-sdk/client-rekognition";
import pLimit from "p-limit";
import fs from "fs";

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

const rekognition = new RekognitionClient({ region: "us-east-1" });

export async function analyzeBuffer(buffer) {
  const command = new DetectFacesCommand({ Image: { Bytes: buffer }, Attributes: ["ALL"] });
  const result = await rekognition.send(command);

  if (!result.FaceDetails?.length) return { faceFound: false };

  const face = result.FaceDetails[0];
  const emotions = face.Emotions || [];
  const topEmotion = emotions.sort((a, b) => b.Confidence - a.Confidence)[0] || { Type: "Unknown", Confidence: 0 };

  const eyeDir = face.EyeDirection;
  const classifiedEyeDirection = eyeDir && eyeDir.Confidence > 50
    ? (eyeDir.Yaw < -15 ? "Left" : eyeDir.Yaw > 15 ? "Right" : "Center")
    : "Unknown";

  return {
    faceFound: true,
    emotion: topEmotion.Type,
    confidence: topEmotion.Confidence,
    eyeDirection: classifiedEyeDirection,
    eyeDirectionConfidence: eyeDir?.Confidence ?? 0,
    eyesOpen: face.EyesOpen?.Value ?? null,
    eyesOpenConfidence: face.EyesOpen?.Confidence ?? 0,
    mouthOpen: face.MouthOpen?.Value ?? null,
    mouthOpenConfidence: face.MouthOpen?.Confidence ?? 0,
    smile: face.Smile?.Value ?? null,
    smileConfidence: face.Smile?.Confidence ?? 0,
    poseYaw: face.Pose?.Yaw ?? 0,
  };
}

function extractFramesToMemory(videoPath, fps = 1) {
  return new Promise((resolve, reject) => {
    const frames = [];
    ffmpeg(videoPath)
      .outputOptions(["-vf", `fps=${fps},scale=640:-1`, "-qscale:v", "5", "-vsync", "0"])
      .format("mjpeg")
      .on("start", cmd => console.log("Running FFmpeg:", cmd))
      .on("error", reject)
      .on("end", () => resolve(frames))
      .pipe()
      .on("data", chunk => frames.push(chunk));
  });
}

export async function analyzeVideo(videoPath) {
  console.log("Extracting frames...");
  const frameBuffers = await extractFramesToMemory(videoPath, 1);

  const limit = pLimit(10); // limit parallel AWS calls
  const results = await Promise.all(frameBuffers.map((buf, i) =>
    limit(async () => ({ timestamp_seconds: i, ...(await analyzeBuffer(buf)) }))
  ));

  console.log("Analysis complete");
  return results;
}
