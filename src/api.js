/**
 * api.js — PGAGI AI Screening Frontend API Layer
 * ------------------------------------------------
 * Centralised HTTP client with:
 *  - Per-call timeouts (default 30 s, 90 s for resume upload)
 *  - Slow-call logging (>3 s warns in console)
 *  - Proper error message extraction from FastAPI responses
 *  - Typed helpers for every backend endpoint
 */

const API_BASE_URL = (
  import.meta.env.VITE_API_BASE_URL || "https://pgagi-ml-assignement-backend-1.onrender.com/api/"
).replace(/\/$/, "");

/** Fetch with automatic timeout and response-time logging. */
async function request(path, options = {}, timeoutMs = 30_000) {
  const url    = `${API_BASE_URL}${path}`;
  const method = options.method || "GET";
  const t0     = performance.now();

  const controller = new AbortController();
  const timer      = setTimeout(() => controller.abort(), timeoutMs);

  const headers = {
    ...(options.body instanceof FormData ? {} : { "Content-Type": "application/json" }),
    Accept: "application/json",
    ...(options.headers || {}),
  };

  let response;
  try {
    response = await fetch(url, {
      method,
      credentials: "include",
      ...options,
      headers,
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (err.name === "AbortError") throw new Error(`Request timed out after ${timeoutMs / 1000}s`);
    throw err;
  } finally {
    clearTimeout(timer);
  }

  const elapsed = performance.now() - t0;
  if (elapsed > 3000) console.warn(`[API] Slow call (${(elapsed / 1000).toFixed(1)}s): ${method} ${path}`);

  const contentType = response.headers.get("content-type") || "";
  let payload;
  try {
    payload = contentType.includes("application/json")
      ? await response.json()
      : await response.blob();          // binary (PDF download)
  } catch {
    payload = "";
  }

  if (!response.ok) {
    const detail =
      typeof payload === "object" && !(payload instanceof Blob)
        ? payload.detail || payload.error || JSON.stringify(payload)
        : String(payload);
    throw new Error(detail || `Request failed with ${response.status}`);
  }

  return payload;
}

/** Trigger a file-save in the browser from a Blob. */
function _triggerDownload(blob, filename) {
  const url  = window.URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href     = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.URL.revokeObjectURL(url);
}

export const api = {
  baseUrl: API_BASE_URL,

  // ── System ──────────────────────────────────────────────────────────────
  health() {
    return request("/health");
  },

  getRoles() {
    return request("/roles");
  },

  getIngestStatus() {
    return request("/ingest/status");
  },

  // ── Session lifecycle ────────────────────────────────────────────────────
  startSession({ candidateName, role, totalQuestions }) {
    return request("/session/start", {
      method: "POST",
      body: JSON.stringify({
        candidate_name:  candidateName || "Candidate",
        role,
        total_questions: Number(totalQuestions),
      }),
    });
  },

  /** Upload resume — generous 90 s timeout for large files + parsing. */
  uploadResume({ sessionId, file }) {
    const form = new FormData();
    form.append("session_id", sessionId);
    form.append("file", file);
    return request("/session/upload-resume", { method: "POST", body: form }, 90_000);
  },

  /** Submit pasted resume text instead of uploading a file. */
  uploadResumeText({ sessionId, resumeText }) {
  return request("/session/upload-resume-text", {
    method: "POST",
    headers: { "Content-Type": "application/json" },   // ← add this
    body: JSON.stringify({
      session_id: sessionId,
      resume_text: resumeText,
      filename: "pasted-resume.txt",
    }),
  }, 90_000);
},

  getQuestion(sessionId) {
    return request(`/session/${sessionId}/question`);
  },

  submitAnswer({ sessionId, questionId, answer, timeTakenSeconds }) {
    return request(`/session/${sessionId}/answer`, {
      method: "POST",
      body: JSON.stringify({
        session_id:         sessionId,
        question_id:        questionId,
        answer,
        time_taken_seconds: timeTakenSeconds,
      }),
    });
  },

  getEvaluation({ sessionId, questionId }) {
    return request(
      `/session/${sessionId}/evaluation?question_id=${encodeURIComponent(questionId)}`
    );
  },

  completeSession(sessionId) {
    return request(`/session/${sessionId}/complete`, { method: "POST" }, 60_000);
  },

  getSummary(sessionId) {
    return request(`/session/${sessionId}/summary`);
  },

  // ── Session management ───────────────────────────────────────────────────
  /** List all sessions (admin). */
  listSessions(limit = 100) {
    return request(`/sessions?limit=${limit}`);
  },

  /** Load full session state. */
  loadSession(sessionId) {
    return request(`/session/${sessionId}`);
  },

  /** Hard-delete session and all its data. */
  deleteSession(sessionId) {
    return request(`/session/${sessionId}`, { method: "DELETE" });
  },

  /** Clear only answers + evaluations (keep questions & resume). */
  resetSessionAnswers(sessionId) {
    return request(`/session/${sessionId}/reset`, { method: "POST" });
  },

  /** Download session summary as PDF — triggers browser file-save. */
  async downloadSessionPdf(sessionId, candidateName = "summary") {
    const filename = `interview-${candidateName.replace(/\s+/g, "-")}-${sessionId.slice(0, 8)}.pdf`;
    const blob     = await request(`/session/${sessionId}/download-pdf`, {}, 60_000);
    if (!(blob instanceof Blob)) throw new Error("PDF download returned unexpected data.");
    _triggerDownload(blob, filename);
    return { success: true, filename };
  },
};
