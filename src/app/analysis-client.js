export async function requestOllamaAnalysis(text, model, { force = false, onProgress = () => {} } = {}) {
  const response = await fetch("/api/analyze/ollama", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
    body: JSON.stringify({ text, model, force })
  });

  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("text/event-stream")) {
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.message || payload.error || "Ollama analysis failed");
    return { model: payload.model || model, analysis: payload.analysis || {}, diagnostics: payload.diagnostics || {} };
  }

  const finalPayload = await readSseStream(response, onProgress);
  return {
    model: finalPayload.model || model,
    analysis: finalPayload.analysis || {},
    diagnostics: finalPayload.diagnostics || {}
  };
}

async function readSseStream(response, onProgress) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let donePayload = null;
  let errorPayload = null;

  const handleEvent = (chunk) => {
    let event = "message";
    let data = "";
    for (const line of chunk.split("\n")) {
      if (line.startsWith("event: ")) event = line.slice(7).trim();
      else if (line.startsWith("data: ")) data += line.slice(6);
    }
    if (!data) return;
    let parsed;
    try {
      parsed = JSON.parse(data);
    } catch (_error) {
      return;
    }
    if (event === "progress") onProgress(parsed);
    else if (event === "done") donePayload = parsed;
    else if (event === "error") errorPayload = parsed;
  };

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split("\n\n");
    buffer = events.pop();
    events.forEach(handleEvent);
  }
  if (buffer.trim()) handleEvent(buffer);

  if (errorPayload) throw new Error(errorPayload.message || errorPayload.error || "Ollama analysis failed");
  if (!donePayload) throw new Error("로컬 AI 분석 스트림이 완료 없이 종료되었습니다.");
  return donePayload;
}
