// massEmotions_with_distraction.js
import fs from "fs";
import ffmpeg from "fluent-ffmpeg";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import { RekognitionClient, DetectFacesCommand } from "@aws-sdk/client-rekognition";
import pLimit from "p-limit";

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

/* --------------------------------------------------
   CONFIG
-------------------------------------------------- */
const REGION = "us-east-1";
const SAMPLE_FPS = 1;                    // Frames per second to sample
const AWS_CONCURRENCY = 6;               // Parallel Rekognition calls
const CENTER_DISTANCE_THRESHOLD = 0.15;  // Face-tracking matching threshold
const TURN_YAW_THRESHOLD = 25;           // Yaw angle threshold for "turned" distraction

const rekognition = new RekognitionClient({ region: REGION });

/* --------------------------------------------------
   HELPERS: Format Rekognition face data
-------------------------------------------------- */
function formatFaceData(face) {
    if (!face) return { faceFound: false };

    const emotions = face.Emotions || [];
    const topEmotion = emotions.reduce(
        (a, b) => (b.Confidence > a.Confidence ? b : a),
        emotions[0] || null
    );

    const eyeDir = face.EyeDirection;
    let eyeDirection = "Unknown";
    if (eyeDir?.Confidence > 50) {
        if (eyeDir.Yaw < -15) eyeDirection = "Left";
        else if (eyeDir.Yaw > 15) eyeDirection = "Right";
        else eyeDirection = "Center";
    }

    return {
        faceFound: true,
        emotion: topEmotion?.Type || "Unknown",
        emotionConfidence: topEmotion?.Confidence || 0,

        eyeDirection,
        eyeDirectionConfidence: eyeDir?.Confidence ?? 0,

        eyesOpen: face.EyesOpen?.Value ?? null,
        eyesOpenConfidence: face.EyesOpen?.Confidence ?? 0,

        faceOccluded: face.FaceOccluded?.Value ?? null,
        faceOccludedConfidence: face.FaceOccluded?.Confidence ?? 0,

        mouthOpen: face.MouthOpen?.Value ?? null,
        mouthOpenConfidence: face.MouthOpen?.Confidence ?? 0,

        smile: face.Smile?.Value ?? null,
        smileConfidence: face.Smile?.Confidence ?? 0,

        poseYaw: face.Pose?.Yaw ?? 0,
        boundingBox: face.BoundingBox || null
    };
}

/* --------------------------------------------------
   FACE TRACKING (centerpoint geometry)
-------------------------------------------------- */
let nextPersonId = 1;
const tracked = {}; // id -> { cx, cy, lastSeenFrame }

function assignFaceIdByGeometry(face, frameIndex) {
    const bb = face.boundingBox;
    const cx = bb ? (bb.Left + bb.Width / 2) : 0.5;
    const cy = bb ? (bb.Top + bb.Height / 2) : 0.5;

    let best = { id: null, dist: Infinity };

    for (const [id, data] of Object.entries(tracked)) {
        if (frameIndex - data.lastSeenFrame > 300) continue;
        const dx = data.cx - cx;
        const dy = data.cy - cy;
        const dist = Math.hypot(dx, dy);

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

/* --------------------------------------------------
   REKOGNITION CALL WRAPPER
-------------------------------------------------- */
async function analyzeBuffer(buffer) {
    const command = new DetectFacesCommand({
        Image: { Bytes: buffer },
        Attributes: ["ALL"]
    });
    const response = await rekognition.send(command);
    return response.FaceDetails || [];
}

/* --------------------------------------------------
   FRAME EXTRACTION
-------------------------------------------------- */
async function extractFrames(videoPath, fps = SAMPLE_FPS) {
    return new Promise((resolve, reject) => {
        const frames = [];
        const command = ffmpeg(videoPath)
            .addOptions([
                "-vf", `fps=${fps},scale=640:-1`,
                "-qscale:v", "4",
                "-vsync", "0"
            ])
            .format("mjpeg")
            .on("start", cmd => console.log("FFmpeg:", cmd))
            .on("error", reject);

        const stream = command.pipe();
        stream.on("data", chunk => frames.push(chunk));
        stream.on("end", () => resolve(frames));
    });
}

/* --------------------------------------------------
   DISTRACTION DETECTION (Balanced)
-------------------------------------------------- */
function detectDistraction(face) {
    const turned = Math.abs(face.poseYaw) > TURN_YAW_THRESHOLD;
    const eyesAway = face.eyeDirection !== "Center" && face.eyeDirection !== "Unknown";
    const occluded = face.faceOccluded === true;

    const triggers = [];
    if (turned) triggers.push("turned");
    if (eyesAway) triggers.push("eyesAway");
    if (occluded) triggers.push("occluded");

    if (triggers.length === 0) return { distracted: false, reason: null };
    if (triggers.length === 1) return { distracted: true, reason: triggers[0] };
    return { distracted: true, reason: "multiple" };
}

/* --------------------------------------------------
   SPEAKER SELECTION (largest face)
-------------------------------------------------- */
function separateSpeaker(faces) {
    if (faces.length === 0) return { speaker: null, audience: [] };
    const sorted = faces.slice().sort((a, b) => b.boundingBoxArea - a.boundingBoxArea);
    return { speaker: sorted[0], audience: sorted.slice(1) };
}

/* --------------------------------------------------
   MAIN ANALYSIS PIPELINE
-------------------------------------------------- */
async function analyzeVideo(videoPath) {
    console.log("Extracting frames...");
    const frameBuffers = await extractFrames(videoPath);
    console.log("Frames extracted:", frameBuffers.length);

    const limit = pLimit(AWS_CONCURRENCY);

    const csvRows = [];
    const emotionCounts = {};
    const distractionSummary = {};

    // NEW METRICS
    let speakerSpeaking = 0;
    let audienceSpeaking = 0;

    let audiencePositive = 0;
    let audienceNegative = 0;

    const positiveEmotions = new Set(["HAPPY", "SURPRISED"]);
    const negativeEmotions = new Set(["SAD", "ANGRY", "DISGUSTED", "CONFUSED", "FEAR"]);

    for (let i = 0; i < frameBuffers.length; i++) {
        const frame = frameBuffers[i];
        const rawFaces = await limit(() => analyzeBuffer(frame));

        const faces = rawFaces.map(f => {
            const formatted = formatFaceData(f);
            const area = (f.BoundingBox?.Width ?? 0) * (f.BoundingBox?.Height ?? 0);
            return { ...formatted, boundingBoxArea: area };
        });

        const { speaker, audience } = separateSpeaker(faces);

        const allFaces = [];
        if (speaker) allFaces.push({ ...speaker, role: "speaker" });
        audience.forEach(a => allFaces.push({ ...a, role: "audience" }));

        for (const face of allFaces) {

            /* --- SPEAKING RATIO --- */
            if (face.mouthOpen && face.mouthOpenConfidence > 70) {
                if (face.role === "speaker") speakerSpeaking++;
                else audienceSpeaking++;
            }

            /* --- AUDIENCE EMOTION BALANCE --- */
            if (face.role === "audience") {
                const emo = face.emotion || "Unknown";
                if (positiveEmotions.has(emo)) audiencePositive++;
                if (negativeEmotions.has(emo)) audienceNegative++;
            }

            /* --- ID ASSIGNMENT --- */
            const personId = assignFaceIdByGeometry(face, i);
            face.personId = personId;

            /* --- EMOTION COUNTS --- */
            if (!emotionCounts[personId]) emotionCounts[personId] = {};
            emotionCounts[personId][face.emotion] =
                (emotionCounts[personId][face.emotion] || 0) + 1;

            /* --- DISTRACTION --- */
            const { distracted, reason } = detectDistraction(face);

            if (!distractionSummary[personId]) {
                distractionSummary[personId] = {
                    totalFrames: 0,
                    distractedFrames: 0,
                    reasonBreakdown: {
                        turned: 0,
                        eyesAway: 0,
                        occluded: 0,
                        multiple: 0,
                        unknown: 0
                    }
                };
            }

            const rec = distractionSummary[personId];
            rec.totalFrames += 1;
            if (distracted) {
                rec.distractedFrames++;
                rec.reasonBreakdown[reason || "unknown"]++;
            }

            /* --- CSV ROW --- */
            csvRows.push([
                i,
                personId,
                face.role,
                face.emotion,
                face.emotionConfidence,
                face.eyeDirection,
                face.eyesOpen,
                face.mouthOpen,
                face.smile,
                face.poseYaw,
                distracted,
                reason || ""
            ].join(","));
        }
    }

    /* --------------------------------------------------
       FINAL OUTPUTS
    -------------------------------------------------- */

    // Distraction summary rates
    for (const id of Object.keys(distractionSummary)) {
        const rec = distractionSummary[id];
        rec.distractionRate = rec.totalFrames
            ? rec.distractedFrames / rec.totalFrames
            : 0;
    }

    fs.writeFileSync(
        "emotion_data.csv",
        [
            "timestamp,personId,role,emotion,emotionConfidence,eyeDirection,eyesOpen,mouthOpen,smile,poseYaw,distracted,distractionReason",
            ...csvRows
        ].join("\n")
    );

    fs.writeFileSync(
        "emotion_frequencies.json",
        JSON.stringify(emotionCounts, null, 2)
    );

    fs.writeFileSync(
        "audience_distraction.json",
        JSON.stringify(distractionSummary, null, 2)
    );

    /* --- Speaking Ratio File --- */
    const speakingOutput = {
        speakerSpeakingFrames: speakerSpeaking,
        audienceSpeakingFrames: audienceSpeaking,
        speakerVsAudienceRatio:
            audienceSpeaking === 0 ? "Infinity" :
            (speakerSpeaking / audienceSpeaking).toFixed(3),
    };
    fs.writeFileSync(
        "speaking_ratio.json",
        JSON.stringify(speakingOutput, null, 2)
    );

    /* --- Audience Emotion Balance File --- */
    const totalEmotions = audiencePositive + audienceNegative;
    const emotionBalance = {
        positive: audiencePositive,
        negative: audienceNegative,
        positiveRate: totalEmotions === 0 ? 0 : (audiencePositive / totalEmotions).toFixed(3),
        negativeRate: totalEmotions === 0 ? 0 : (audienceNegative / totalEmotions).toFixed(3)
    };
    fs.writeFileSync(
        "audience_emotion_balance.json",
        JSON.stringify(emotionBalance, null, 2)
    );

    console.log("All results saved.");
}

/* --------------------------------------------------
   RUN
-------------------------------------------------- */
(async () => {
    await analyzeVideo("./videosample.mp4");
})();
