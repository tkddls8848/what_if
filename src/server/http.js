"use strict";
function errorBody(errorCode, message, retryable = false) {
  return { ok: false, error: message, error_code: errorCode, message, retryable };
}

function watchDisconnect(res) {
  const controller = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) controller.abort();
  });
  return controller;
}

function startSse(res) {
  res.status(200);
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();
  // 끊긴 소켓에 쓰면 EPIPE가 응답 객체의 error로 올라온다. 보낼 곳이 없으면 조용히 버린다.
  const open = () => !res.writableEnded && !res.destroyed;
  return {
    send(event, data) {
      if (!open()) return;
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    },
    end() {
      if (!open()) return;
      res.end();
    }
  };
}


module.exports = { errorBody, watchDisconnect, startSse };
