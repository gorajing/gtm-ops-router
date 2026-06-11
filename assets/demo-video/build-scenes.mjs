#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const timelinePath = resolve(ROOT, "timeline.json");

const timeline = {
  output: "../demo.mp4",
  width: 1280,
  height: 720,
  fps: 30,
  transition: 0,
  fade_in: 0.12,
  fade_out: 0.45,
  clips: [
    {
      id: "operator-session",
      file: "clips/operator-session.mp4",
    },
  ],
};

await writeFile(timelinePath, `${JSON.stringify(timeline, null, 2)}\n`);
console.log(`Wrote ${timelinePath}`);
