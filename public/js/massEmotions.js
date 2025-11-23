// massEmotions.js
import ffmpeg from "fluent-ffmpeg";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import { RekognitionClient, DetectFacesCommand } from "@aws-sdk/client-rekognition";
import pLimit from "p-limit";

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

const REGION = "us-east-1";
const SAMPLE_FPS = 1;
const AWS_CONCURRENCY = 6;
const CENTER_DISTANCE_THRESHOLD = 0.15;

const rekognition = new RekognitionClient({ region: REGION });

function formatFaceData(face) {
  if (!face) return { faceFound: false };
  const emotions = face.Emotions || [];
  const topEmotion = emotions.reduce(
    (a, b) => (b.Confidence > a.Confidence ? b : a),
    emotions[0] || null
  );

  let eyeDirection = "Unknown";
  const eyeDir = face.EyeDirection;
  if (eyeDir?.Confidence > 50) {
    if (eyeDir.Yaw < -15) eyeDirection = "Left";
    else if (eyeDir.Yaw > 15) eyeDirection = "Right";
    else eyeDirection = "Center";
  }

  return {
    emotion: topEmotion?.Type || "Unknown",
    eyesOpen: face.EyesOpen?.Value ?? false,
    mouthOpen: face.MouthOpen?.Value ?? false,
    eyeDirection,
    boundingBox: face.BoundingBox || null,
    boundingBoxArea: (face.BoundingBox?.Width ?? 0) * (face.BoundingBox?.Height ?? 0)
  };
}

let nextPersonId = 1;
const tracked = {};

function assignFaceIdByGeometry(face, frameIndex) {
  const bb = face.boundingBox;
  const cx = bb ? (bb.Left + bb.Width / 2) : 0.5;
  const cy = bb ? (bb.Top + bb.Height / 2) : 0.5;

  let best = { id: null, dist: Infinity };
  for (const [id, data] of Object.entries(tracked)) {
    if (frameIndex - data.lastSeenFrame > 300) continue;
    const dist = Math.hypot(data.cx - cx, data.cy - cy);
    if (dist < best.dist) best = { id, dist };
  }

  if (best.id && best.dist < CENTER_DISTANCE_THRESHOLD) {
    tracked[best.id] = { cx, cy, lastSeenFrame: frameIndex };
    return best.id;
  }

  const newId = `person_${nextPersonId++}`;
  tracked[newId] = { cx, cy, lastSeenFrame: frameIndex };
  return newId;
}

async function analyzeBuffer(buffer) {
  const command = new DetectFacesCommand({
    Image: { Bytes: buffer },
    Attributes: ["ALL"]
  });
  const response = await rekognition.send(command);
  return response.FaceDetails || [];
}

async function extractFrames(videoPath, fps = SAMPLE_FPS) {
  return new Promise((resolve, reject) => {
    const frames = [];
    const command = ffmpeg(videoPath)
      .addOptions([`-vf fps=${fps},scale=640:-1`, "-qscale:v 4", "-vsync 0"])
      .format("mjpeg")
      .on("error", reject);

    const stream = command.pipe();
    stream.on("data", chunk => frames.push(chunk));
    stream.on("end", () => resolve(frames));
  });
}

function separateSpeaker(faces) {
  if (!faces.length) return { speaker: null, audience: [] };
  const sorted = faces.slice().sort((a, b) => b.boundingBoxArea - a.boundingBoxArea);
  return { speaker: sorted[0], audience: sorted.slice(1) };
}

export async function analyzeVideo(videoPath) {
  const frameBuffers = await extractFrames(videoPath);
  const limit = pLimit(AWS_CONCURRENCY);

  let speakerSpeaking = 0;
  let audienceSpeaking = 0;
  let audiencePositive = 0;
  let audienceNegative = 0;

  const positiveEmotions = new Set(["HAPPY", "SURPRISED"]);
  const negativeEmotions = new Set(["SAD", "ANGRY", "DISGUSTED", "CONFUSED", "FEAR"]);

  const eyeDirectionCounts = { Left: 0, Right: 0, Center: 0, Unknown: 0 };
  let eyesOpenCount = 0;
  let mouthOpenCount = 0;

  for (let i = 0; i < frameBuffers.length; i++) {
    const frame = frameBuffers[i];
    const rawFaces = await limit(() => analyzeBuffer(frame));

    const faces = rawFaces.map(f => formatFaceData(f));
    const { speaker, audience } = separateSpeaker(faces);

    if (speaker?.mouthOpen) speakerSpeaking++;
    if (audience?.length) {
      audience.forEach(face => {
        if (face.mouthOpen) audienceSpeaking++;
        if (positiveEmotions.has(face.emotion)) audiencePositive++;
        if (negativeEmotions.has(face.emotion)) audienceNegative++;

        eyesOpenCount += face.eyesOpen ? 1 : 0;
        mouthOpenCount += face.mouthOpen ? 1 : 0;
        eyeDirectionCounts[face.eyeDirection] = (eyeDirectionCounts[face.eyeDirection] || 0) + 1;

        assignFaceIdByGeometry(face, i);
      });
    }

    if (speaker) {
      eyesOpenCount += speaker.eyesOpen ? 1 : 0;
      mouthOpenCount += speaker.mouthOpen ? 1 : 0;
      eyeDirectionCounts[speaker.eyeDirection] = (eyeDirectionCounts[speaker.eyeDirection] || 0) + 1;
      assignFaceIdByGeometry(speaker, i);
    }
  }

  return {
    speakingRatio: { speakerSpeakingFrames: speakerSpeaking, audienceSpeakingFrames: audienceSpeaking },
    audienceEmotionBalance: { positive: audiencePositive, negative: audienceNegative },
    eyeDirectionCounts,
    eyesMouthCounts: { eyesOpen: eyesOpenCount, mouthOpen: mouthOpenCount }
  };
}
