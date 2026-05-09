"use strict";

const path = require("path");
const express = require("express");

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const MAX_PORT_ATTEMPTS = 20;
const ROOT = __dirname;

app.use(
  express.static(ROOT, {
    extensions: ["html"],
    setHeaders(res, filePath) {
      if (filePath.endsWith(".txt")) {
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
      }
    }
  })
);

app.get("/", (_req, res) => {
  res.sendFile(path.join(ROOT, "index.html"));
});

function listen(port, attemptsLeft = MAX_PORT_ATTEMPTS) {
  const server = app.listen(port, () => {
    console.log(`Novel IF  http://localhost:${port}`);
  });

  server.on("error", (error) => {
    if (error.code === "EADDRINUSE" && !process.env.PORT && attemptsLeft > 0) {
      console.warn(`Port ${port} is in use. Trying ${port + 1}...`);
      listen(port + 1, attemptsLeft - 1);
      return;
    }

    console.error(error.message);
    process.exit(1);
  });
}

listen(PORT);
