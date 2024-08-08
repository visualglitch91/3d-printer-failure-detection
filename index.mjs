import path from "path";
import { fileURLToPath } from "url";
import express from "express";
import fetch from "node-fetch";
import { createCanvas, loadImage } from "canvas";
import fs from "fs-extra";
import config from "./config.json" assert { type: "json" };

const printers = config.PRINTERS;
const obicoMlApiHost = config.OBICO_ML_API_HOST;
const serverBaseHost = config.SERVER_BASE_HOST;
const minimumConfidence = config.MINIMUM_CONFIDENCE;
const checkInterval = parseInt(config.CHECK_INTERVAL, 10);
const port = parseInt(config.PORT, 10);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicFolderPath = path.join(__dirname, "failures");

let isPrinting = new Array(printers.length).fill(false);
let hasFailed = new Array(printers.length).fill(false);

// Ensure the public folder exists
fs.ensureDirSync(publicFolderPath);

// Create an Express app to serve static files
const app = express();
app.use("/failures", express.static(publicFolderPath));

// Start the server
const server = app.listen(port, "0.0.0.0", () => {
  console.log(`Server is running on port ${port}`);
});

async function checkPrinterStatus(printer) {
  const moonrakerApiHost = printer.MOONRAKER_API_HOST;

  try {
    const response = await fetch(`${moonrakerApiHost}/api/printer`);
    const data = await response.json();

    return data.state.flags.printing;
  } catch (_) {
    return false;
  }
}

async function drawBoundingBoxes(cameraSnapshotUrl, detections) {
  try {
    const response = await fetch(cameraSnapshotUrl);
    const buffer = await response.arrayBuffer();
    const img = await loadImage(Buffer.from(buffer));

    const canvas = createCanvas(img.width, img.height);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0, img.width, img.height);

    ctx.strokeStyle = "red";
    ctx.lineWidth = 2;

    detections.forEach((detection) => {
      const [type, , [xc, yc, w, h]] = detection;

      if (type === "failure") {
        const x = xc - w / 2;
        const y = yc - h / 2;
        ctx.strokeRect(x, y, w, h);
      }
    });

    const timestamp = Date.now();
    const outputFilePath = path.join(
      publicFolderPath,
      `snapshot_${timestamp}.png`
    );

    const out = fs.createWriteStream(outputFilePath);
    const stream = canvas.createPNGStream();

    stream.pipe(out);

    return new Promise((resolve, reject) => {
      out.on("finish", () => resolve(outputFilePath));
      out.on("error", reject);
    });
  } catch (error) {
    console.error("Error drawing bounding boxes:", error);
  }
}

async function checkForFailures(printer, index) {
  const cameraSnapshotUrl = printer.CAMERA_SNAPSHOT_URL;
  const notificationWebhookUrl = printer.NOTIFICATION_WEBHOOK_URL;

  try {
    const response = await fetch(
      `${obicoMlApiHost}/p?img=${encodeURIComponent(cameraSnapshotUrl)}`
    );

    const data = await response.json();
    const detections = data.detections;

    let failureDetected = false;

    for (const detection of detections) {
      if (detection[0] === "failure" && detection[1] > minimumConfidence) {
        failureDetected = true;
        break;
      }
    }

    if (failureDetected && !hasFailed[index]) {
      hasFailed[index] = true;
      const imagePath = await drawBoundingBoxes(cameraSnapshotUrl, detections);
      const imageUrl = `${serverBaseHost}/failures/${path.basename(imagePath)}`;

      console.log(`${printer.LABEL}: Failure detected`, imageUrl);
      console.log(JSON.stringify(detections, null, 2));
      await fetch(notificationWebhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "PrintFailure", image: imageUrl }),
      });
    } else if (!failureDetected && hasFailed[index]) {
      hasFailed[index] = false;
      console.log(`${printer.LABEL}: Recovered from failure`);
    }
  } catch (error) {
    console.error(`${printer.LABEL}: Error checking for failures`, error);
  }
}

async function detectionLoop() {
  for (let index in printers) {
    const printer = printers[index];
    const nextIsPrinting = await checkPrinterStatus(printer);

    if (isPrinting[index] !== nextIsPrinting) {
      isPrinting[index] = nextIsPrinting;
      hasFailed[index] = false;

      console.log(
        `${printer.LABEL}: Print ${isPrinting[index] ? "started" : "stopped"}`
      );
    }

    if (isPrinting[index]) {
      await checkForFailures(printer, index);
    }
  }

  setTimeout(detectionLoop, checkInterval);
}

// Clear the public folder when the app exits
function cleanUp() {
  fs.emptyDirSync(publicFolderPath);

  server.close(() => {
    console.log("Server closed and public folder cleaned up.");
    process.exit();
  });
}

process.on("SIGINT", cleanUp);
process.on("SIGTERM", cleanUp);

// Start the monitoring process
detectionLoop();
