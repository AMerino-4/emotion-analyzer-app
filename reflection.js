import ffmpeg from "fluent-ffmpeg";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import { RekognitionClient, DetectFacesCommand } from "@aws-sdk/client-rekognition";
import pLimit from "p-limit";

ffmpeg.setFfmpegPath(ffmpegInstaller.path);


const rekognition = new RekognitionClient({
    region: "us-east-1"
});

// -------------------------------------------
// Convert one raw image buffer → Rekognition
// -------------------------------------------
async function analyzeBuffer(buffer) {
    const command = new DetectFacesCommand({
        Image: { Bytes: buffer },
        Attributes: ["ALL"]
    });

    const result = await rekognition.send(command);

    if (!result.FaceDetails?.length) {
        return { faceFound: false };
    }

    const face = result.FaceDetails[0];

    const emotions = result.FaceDetails[0].Emotions;
    const topEmotions = emotions.sort((a, b) => b.Confidence - a.Confidence)[0];

    const eyeDir = face.EyeDirection;

    const classifiedEyeDirection =
        eyeDir && eyeDir.Confidence > 50
            ? classifyYaw(eyeDir.Yaw)
            : "Unknown";

    function classifyYaw(yaw) {
        if (yaw < -15) return "Left";
        if (yaw > 15) return "Right";
        return "Center";
    }

    const eyesOpen = face.EyesOpen || {};
    const eyesOpenValue = eyesOpen.Value ?? null;
    const eyesOpenConfidence = eyesOpen.Confidence ?? 0;


    const faceOccluded = face.FaceOccluded || {};
    const faceOccludedValue = faceOccluded.Value ?? null;
    const faceOccludedConfidence = faceOccluded.Confidence ?? 0;


    const mouthOpen = face.MouthOpen || {};
    const mouthOpenValue = mouthOpen.Value ?? null;
    const mouthOpenConfidence = mouthOpen.Confidence ?? 0;

    const pose = face.Pose || {};
    const poseYaw = pose.Yaw ?? 0;

    const smile = face.Smile || {};
    const smileValue = smile.Value ?? null;
    const smileConfidence = smile.Confidence ?? 0;


    return {
        faceFound: true,
        emotion: topEmotions.Type,
        confidence: topEmotions.Confidence,
        eyeDirection: classifiedEyeDirection,
        eyeDirectionConfidence: eyeDir?.Confidence ?? 0,
        eyesOpen: eyesOpenValue,
        eyesOpenConfidence,
        faceOccluded: faceOccludedValue,
        faceOccludedConfidence,
        mouthOpen: mouthOpenValue,
        mouthOpenConfidence,
        poseYaw,
        smile: smileValue,
        smileConfidence,
    };
}

// -------------------------------------------
// Extract JPEG frames → stream buffers in memory
// -------------------------------------------
function extractFramesToMemory(videoPath, fps = 1) {
    return new Promise((resolve, reject) => {
        const frames = [];

        ffmpeg(videoPath)
            .outputOptions([
                "-vf", `fps=${fps},scale=640:-1`, // 1 FPS + resize
                "-qscale:v", "5",                 // moderate quality JPEG
                "-vsync", "0"
            ])
            .format("mjpeg")    
            .on("start", cmd => console.log("Running FFmpeg:", cmd))
            .on("error", reject)
            .on("end", () => resolve(frames))
            .pipe()
            .on("data", chunk => {
                frames.push(chunk);
            });
    });
}

// -------------------------------------------
// Main video → emotion timeline
// -------------------------------------------
async function analyzeVideo(videoPath) {

    console.log("Extracting frames to memory...");
    const frameBuffers = await extractFramesToMemory(videoPath, 1); // 1 FPS

    console.log(`Extracted ${frameBuffers.length} frames from memory.`);

    const limit = pLimit(10); // 10 parallel AWS calls

    console.log("Sending frames to Rekognition...");

    const results = await Promise.all(
        frameBuffers.map((buf, i) =>
            limit(async () => {
                const result = await analyzeBuffer(buf);
                return {
                    timestamp_seconds: i, // 1 frame per second
                    ...result
                };
            })
        )
    );

    console.log("Done!");
    return results;
}

// -------------------------------------------
// Run
// -------------------------------------------
export { analyzeVideo };



