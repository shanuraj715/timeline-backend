import os from "os";
import path from "path";
import fs from "fs/promises";
import { randomUUID } from "crypto";
import ffmpeg from "fluent-ffmpeg";
import ffmpegPath from "ffmpeg-static";
import ffprobeStatic from "ffprobe-static";

ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobeStatic.path);

/** @param {string} filePath local path to a video file */
export function probeVideo(filePath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, data) => {
      if (err) return reject(err);
      const videoStream = data.streams.find((s) => s.codec_type === "video");
      resolve({
        duration: data.format?.duration ? Math.round(Number(data.format.duration)) : null,
        width: videoStream?.width || null,
        height: videoStream?.height || null,
      });
    });
  });
}

/** Extracts a single frame as a JPEG buffer, ~1s in (or the midpoint for very short clips). */
export async function extractVideoFrame(filePath, durationSeconds) {
  const frameTime = Math.min(1, Math.max(0, (durationSeconds || 2) / 2));
  const tmpDir = os.tmpdir();
  const outFile = path.join(tmpDir, `${randomUUID()}.jpg`);

  await new Promise((resolve, reject) => {
    ffmpeg(filePath)
      .on("end", resolve)
      .on("error", reject)
      .screenshots({
        timestamps: [frameTime],
        filename: path.basename(outFile),
        folder: tmpDir,
        size: "1600x?",
      });
  });

  const buffer = await fs.readFile(outFile);
  await fs.rm(outFile, { force: true });
  return buffer;
}
