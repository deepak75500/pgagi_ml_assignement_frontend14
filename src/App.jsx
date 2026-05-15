import React, { useEffect, useMemo, useRef, useState, useCallback } from "react";
import {
  Activity, AlertCircle, BriefcaseBusiness, CheckCircle2,
  ClipboardList, Database, FileText, LoaderCircle, Play,
  Plus, RotateCcw, Send, Upload, User, Trash2, RefreshCw,
  Download, Clock, ChevronDown, ChevronUp, BookOpen, History
} from "lucide-react";
import { api } from "./api.js";

const DEFAULT_ROLES = [
  "AI/ML Engineer", "Data Scientist", "Backend Engineer",
  "Full Stack Engineer", "ML Researcher"
];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function formatList(items, max = 6, fallback = "—") {
  if (!items || items.length === 0) return fallback;
  return items.slice(0, max).join(", ");
}
function scoreClass(score) {
  if (score >= 8) return "score good";
  if (score >= 5) return "score warn";
  return "score bad";
}
function fmtTime(ts) {
  if (!ts) return "—";
  return new Date(ts * 1000).toLocaleDateString("en-IN", {
    day: "2-digit", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit"
  });
}
function statusBadge(status) {
  const map = {
    active: "badge-active", completed: "badge-done",
    abandoned: "badge-abandon"
  };
  return map[status] || "badge-active";
}

/* ─────────────────────────────────────────────────────────────
   Main App
───────────────────────────────────────────────────────────── */
export default function App() {
  // ── system ──────────────────────────────────────────────
  const [roles, setRoles]       = useState(DEFAULT_ROLES);
  const [kbStatus, setKbStatus] = useState(null);
  const [health, setHealth]     = useState(null);

  // ── setup form ──────────────────────────────────────────
  const [candidateName, setCandidateName] = useState("");
  const [role, setRole]                   = useState(DEFAULT_ROLES[0]);
  const [totalQuestions, setTotalQuestions] = useState(5);
  const [resumeFile, setResumeFile]         = useState(null);
  const [resumeText, setResumeText]         = useState("");

  // ── interview state ──────────────────────────────────────
  const [session, setSession]               = useState(null);
  const [analysis, setAnalysis]             = useState(null);
  const [currentQuestion, setCurrentQuestion] = useState(null);
  const [questionStatus, setQuestionStatus] = useState("setup");
  const [answerText, setAnswerText]         = useState("");
  const [answers, setAnswers]               = useState([]);
  const [evaluations, setEvaluations]       = useState({});
  const [summary, setSummary]               = useState(null);

  // ── session history ─────────────────────────────────────
  const [sessionList, setSessionList] = useState([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyBusy, setHistoryBusy] = useState(false);

  // ── ui ───────────────────────────────────────────────────
  const [busy, setBusy]           = useState(false);
  const [pdfBusy, setPdfBusy]     = useState(false);
  const [error, setError]         = useState("");
  const [statusText, setStatusText] = useState("Ready");
  const questionStartedAt = useRef(null);

  const answeredCount   = answers.length;
  const progressPercent = session
    ? Math.min(100, Math.round((answeredCount / session.total_questions) * 100))
    : 0;

  const stage = useMemo(() => {
    if (summary)                        return "summary";
    if (questionStatus === "complete")  return "complete";
    if (currentQuestion)                return "interview";
    if (session)                        return "generating";
    return "setup";
  }, [currentQuestion, questionStatus, session, summary]);

  // ── bootstrap ────────────────────────────────────────────
  useEffect(() => { void bootstrap(); }, []);

  async function bootstrap() {
    try {
      const [rolePayload, healthPayload, ingestPayload, sessionsPayload] =
        await Promise.all([
          api.getRoles().catch(() => null),
          api.health().catch(() => null),
          api.getIngestStatus().catch(() => null),
          api.listSessions().catch(() => null),
        ]);

      if (rolePayload) {
        const vals = Array.isArray(rolePayload)
          ? rolePayload.map(r => typeof r === "string" ? r : r.value)
          : (rolePayload.roles || []).map(r => r.value || r);
        if (vals.length > 0) {
          setRoles(vals);
          setRole(p => vals.includes(p) ? p : vals[0]);
        }
      }
      setHealth(healthPayload);
      setKbStatus(ingestPayload);
      if (sessionsPayload?.sessions) setSessionList(sessionsPayload.sessions);
    } catch (err) {
      setError(err.message);
    }
  }

  // ── question polling ─────────────────────────────────────
  useEffect(() => {
    if (!session || currentQuestion || summary) return;
    if (!["generating", "awaiting_resume"].includes(questionStatus)) return;
    let cancelled = false;
    let delay = 2000;
    const poll = async () => {
      while (!cancelled) {
        await loadQuestion(session.session_id);
        await sleep(delay);
        delay = Math.min(delay + 500, 4000); // back-off up to 4 s
      }
    };
    void poll();
    return () => { cancelled = true; };
  }, [session, currentQuestion, questionStatus, summary]);

  // ── actions ──────────────────────────────────────────────
  async function startInterview(event) {
    event.preventDefault();
    if (!resumeFile && !resumeText.trim()) {
      setError("Please upload a resume file or paste resume text.");
      return;
    }
    setBusy(true);
    setError("");
    setSummary(null);
    setCurrentQuestion(null);
    setAnswerText("");
    setAnswers([]);
    setEvaluations({});
    setQuestionStatus("generating");
    setStatusText("Creating session…");
    try {
      const created = await api.startSession({ candidateName, role, totalQuestions });
      setSession(created);
      setStatusText(resumeFile ? "Uploading resume…" : "Parsing pasted resume…");
      const uploaded = resumeFile
        ? await api.uploadResume({ sessionId: created.session_id, file: resumeFile })
        : await api.uploadResumeText({ sessionId: created.session_id, resumeText: resumeText.trim() });
      setAnalysis(uploaded.analysis);
      setQuestionStatus(uploaded.generation_status || "generating");
      setStatusText("Generating questions…");
      await loadQuestion(created.session_id);
      // refresh history
      refreshSessionList();
    } catch (err) {
      setQuestionStatus("setup");
      setError(err.message);
      setStatusText("Error");
    } finally {
      setBusy(false);
    }
  }

  async function loadQuestion(sessionId) {
    try {
      const payload = await api.getQuestion(sessionId);
      setQuestionStatus(payload.status);
      if (payload.status === "active") {
        setCurrentQuestion(payload.question);
        setAnswerText("");
        setStatusText(`Question ${payload.current_index} of ${payload.total}`);
        questionStartedAt.current = Date.now();
      } else if (payload.status === "complete") {
        setCurrentQuestion(null);
        setStatusText("All questions answered");
      } else if (payload.status === "failed") {
        setCurrentQuestion(null);
        setError(payload.error || payload.message || "Question generation failed.");
        setStatusText("Generation failed");
      } else {
        setStatusText(payload.message || "Generating questions…");
      }
      return payload;
    } catch (err) {
      setError(err.message);
      setStatusText("Connection error");
      return null;
    }
  }

  async function submitAnswer(event) {
    event.preventDefault();
    if (!session || !currentQuestion || !answerText.trim()) return;
    setBusy(true);
    setError("");
    const questionId = currentQuestion.question_id;
    const elapsed = questionStartedAt.current
      ? Math.max(1, Math.round((Date.now() - questionStartedAt.current) / 1000))
      : null;
    try {
      await api.submitAnswer({ sessionId: session.session_id, questionId, answer: answerText.trim(), timeTakenSeconds: elapsed });
      setAnswers(prev => [...prev, {
        question_id: questionId,
        question_text: currentQuestion.question_text,
        answer: answerText.trim(),
        topic: currentQuestion.topic,
        time_seconds: elapsed,
      }]);
      setEvaluations(prev => ({ ...prev, [questionId]: { status: "pending" } }));
      setCurrentQuestion(null);
      setAnswerText("");
      setStatusText("Answer saved");
      void pollEvaluation(questionId);
      await sleep(400);
      await loadQuestion(session.session_id);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function pollEvaluation(questionId) {
    if (!session) return;
    for (let i = 0; i < 16; i++) {
      try {
        const p = await api.getEvaluation({ sessionId: session.session_id, questionId });
        if (p.status === "complete") {
          setEvaluations(prev => ({ ...prev, [questionId]: { status: "complete", ...p.evaluation } }));
          return;
        }
      } catch { return; }
      await sleep(2000);
    }
  }

  async function finishSession() {
    if (!session) return;
    setBusy(true);
    setError("");
    setStatusText("Finalizing…");
    try {
      const payload = await api.completeSession(session.session_id);
      setSummary(payload);
      setStatusText("Summary ready");
      refreshSessionList();
    } catch (err) {
      setError(err.message);
      setStatusText("Finalize failed");
    } finally {
      setBusy(false);
    }
  }

  async function downloadPdf() {
    if (!session) return;
    setPdfBusy(true);
    try {
      
      await api.downloadSessionPdf(session.session_id, session.candidate_name || candidateName);
    } catch (err) {
      setError("PDF download failed: " + err.message);
    } finally {
      setPdfBusy(false);
    }
  }

  function resetFlow() {
    setSession(null); setAnalysis(null); setCurrentQuestion(null);
    setQuestionStatus("setup"); setAnswerText(""); setAnswers([]);
    setEvaluations({}); setSummary(null); setError(""); setStatusText("Ready");
    setCandidateName(""); setResumeFile(null); setResumeText("");
    questionStartedAt.current = null;
    refreshSessionList();
  }

  // ── session history helpers ───────────────────────────────
  const refreshSessionList = useCallback(async () => {
    setHistoryBusy(true);
    try {
      const r = await api.listSessions();
      if (r?.sessions) setSessionList(r.sessions);
    } catch { /* silent */ } finally {
      setHistoryBusy(false);
    }
  }, []);

  async function handleDeleteSession(sid, e) {
    e.stopPropagation();
    if (!window.confirm("Permanently delete this session and all its data?")) return;
    try {
      await api.deleteSession(sid);
      setSessionList(prev => prev.filter(s => s.session_id !== sid));
      if (session?.session_id === sid) resetFlow();
    } catch (err) {
      setError("Delete failed: " + err.message);
    }
  }

  async function handleClearChat(sid, e) {
    e.stopPropagation();
    if (!window.confirm("Clear all answers and evaluations for this session?")) return;
    try {
      await api.resetSessionAnswers(sid);
      refreshSessionList();
      if (session?.session_id === sid) {
        setAnswers([]); setEvaluations({}); setQuestionStatus("generating");
        setCurrentQuestion(null); setSummary(null);
        await loadQuestion(sid);
      }
    } catch (err) {
      setError("Clear chat failed: " + err.message);
    }
  }

  async function handleLoadSession(sid) {
    if (session?.session_id === sid) return;
    setBusy(true);
    setError("");
    setSummary(null);
    setCurrentQuestion(null);
    setAnswerText("");
    setStatusText("Loading session…");
    try {
      const data = await api.loadSession(sid);

      // Set basic session info
      setSession({
        session_id: data.session_id,
        candidate_name: data.candidate_name,
        role: data.role,
        total_questions: data.total_questions,
        status: data.status,
        kb_ready: true,
      });
      setCandidateName(data.candidate_name || "");
      setRole(data.role || role);
      setTotalQuestions(data.total_questions || 8);

      // Set resume analysis
      setAnalysis(data.resume_analysis || null);

      // Map answers to the UI format
      const loadedAnswers = (data.answers || []).map(a => {
        const q = (data.questions || []).find(q => q.question_id === a.question_id);
        return {
          question_id: a.question_id,
          question_text: q?.question_text || "",
          answer: a.answer_text,
          topic: q?.topic || "",
          time_seconds: a.time_taken_seconds,
        };
      });
      setAnswers(loadedAnswers);

      // Map evaluations to the UI format
      const loadedEvals = {};
      for (const e of (data.evaluations || [])) {
        loadedEvals[e.question_id] = { status: "complete", ...e };
      }
      setEvaluations(loadedEvals);

      // Handle based on session status
      if (data.status === "completed") {
        setQuestionStatus("complete");
        setCurrentQuestion(null);
        // Try to load summary for completed sessions
        try {
          const summaryData = await api.getSummary(sid);
          setSummary(summaryData);
          setStatusText("Summary ready");
        } catch {
          // Build a basic local summary from evaluations if LLM call fails
          const scores = (data.evaluations || []).map(e => e.score).filter(s => s != null);
          const overall = scores.length ? +(scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(2) : 0;
          const allCovered = (data.evaluations || []).flatMap(e => e.key_concepts_covered || []);
          const allMissed = (data.evaluations || []).flatMap(e => e.missed_concepts || []);
          setSummary({
            session_id: sid,
            candidate_name: data.candidate_name,
            role: data.role,
            total_questions: data.total_questions,
            answered: loadedAnswers.length,
            overall_score: overall,
            recommendation: overall >= 8.5 ? "STRONG_HIRE" : overall >= 7 ? "HIRE" : overall >= 5 ? "MAYBE" : "NO_HIRE",
            strengths: [...new Set(allCovered)].slice(0, 5),
            improvement_areas: [...new Set(allMissed)].slice(0, 5),
            narrative_summary: `${data.candidate_name} scored ${overall}/10 overall.`,
            detailed_results: (data.questions || []).map(q => {
              const ev = (data.evaluations || []).find(e => e.question_id === q.question_id);
              const ans = (data.answers || []).find(a => a.question_id === q.question_id);
              return {
                question: q.question_text,
                topic: q.topic,
                difficulty: q.difficulty,
                type: q.question_type,
                answer: ans?.answer_text || "Not answered",
                score: ev?.score ?? null,
                feedback: ev?.feedback ?? null,
                source: q.context_source,
              };
            }),
          });
          setStatusText("Session loaded (offline summary)");
        }
      } else if (data.status === "active") {
        // Active session — determine current state
        const genStatus = data.question_generation_status || "awaiting_resume";
        if (genStatus === "ready" && data.questions?.length > 0) {
          const idx = data.current_question_index || 0;
          if (idx >= data.questions.length) {
            setQuestionStatus("complete");
            setCurrentQuestion(null);
            setStatusText("All questions answered");
          } else {
            setQuestionStatus("active");
            setCurrentQuestion(data.questions[idx]);
            setAnswerText("");
            setStatusText(`Question ${idx + 1} of ${data.questions.length}`);
            questionStartedAt.current = Date.now();
          }
        } else if (genStatus === "generating") {
          setQuestionStatus("generating");
          setStatusText("Generating questions…");
        } else if (genStatus === "failed") {
          setQuestionStatus("generating");
          setError(data.question_generation_error || "Question generation failed.");
          setStatusText("Generation failed");
        } else {
          setQuestionStatus("generating");
          setStatusText("Awaiting resume upload…");
        }
      }
    } catch (err) {
      setError("Failed to load session: " + err.message);
      setStatusText("Load failed");
    } finally {
      setBusy(false);
    }
  }

  /* ── render ─────────────────────────────────────────────── */
  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">AI Screening Console</p>
          <h1>Candidate Interview</h1>
        </div>
        <div className="topbar-actions">
          <button
            className="new-session-action"
            type="button"
            onClick={resetFlow}
            disabled={busy || pdfBusy}
            title="Create a new session"
          >
            <Plus size={17} /> New session
          </button>
          <StatusPill icon={<Activity size={16} />} label={statusText} />
          <StatusPill
            icon={<Database size={16} />}
            label={health?.status === "ok" ? "Backend online" : "Backend check…"}
          />
        </div>
      </header>

      {error && (
        <div className="alert" role="alert">
          <AlertCircle size={18} />
          <span>{error}</span>
          <button className="alert-close" onClick={() => setError("")}>✕</button>
        </div>
      )}

      <main className="workspace">
        {/* ── Sidebar ─────────────────────────────────────── */}
        <aside className="sidebar">
          <StageRail stage={stage} />

          {/* Session meta */}
          <section className="side-section">
            <h2>Session</h2>
            <dl className="facts">
              <div><dt>Role</dt><dd>{session?.role || role}</dd></div>
              <div><dt>Questions</dt><dd>{answeredCount}/{session?.total_questions || totalQuestions}</dd></div>
              <div><dt>API</dt><dd className="api-url">{api.baseUrl}</dd></div>
            </dl>
            <div className="progress-track" aria-label="Interview progress">
              <span style={{ width: `${progressPercent}%` }} />
            </div>
          </section>

          {/* Resume signals */}
          {analysis && (
            <section className="side-section">
              <h2>Resume Signals</h2>
              <dl className="facts compact">
                <div><dt>Skills</dt><dd>{formatList(analysis.skills)}</dd></div>
                <div><dt>Tech</dt><dd>{formatList(analysis.technologies)}</dd></div>
                <div><dt>Exp</dt><dd>{analysis.experience_years != null ? `${analysis.experience_years} yrs` : "—"}</dd></div>
                <div><dt>Seniority</dt><dd>{analysis.seniority_level}</dd></div>
                <div><dt>Domains</dt><dd>{formatList(analysis.domains)}</dd></div>
                <div><dt>Education</dt><dd>{formatList(analysis.education)}</dd></div>
              </dl>
            </section>
          )}

          {/* Knowledge base */}
          <section className="side-section">
            <h2>Knowledge Base</h2>
            <p className="muted">{kbStatus?.books_dir || "data/books"}</p>
            <p className="muted">{kbStatus ? "Embedding status loaded" : "Checking…"}</p>
          </section>

          {/* Session History */}
          <section className="side-section history-section">
            <button
              className="history-toggle"
              onClick={() => { setHistoryOpen(o => !o); if (!historyOpen) refreshSessionList(); }}
            >
              <History size={15} />
              <span>Session History ({sessionList.length})</span>
              {historyOpen ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
              {historyBusy && <LoaderCircle size={13} className="spin" />}
            </button>

            {historyOpen && (
              <div className="history-list">
                {sessionList.length === 0 ? (
                  <p className="muted" style={{ padding: "0.5rem" }}>No sessions found.</p>
                ) : (
                  sessionList.map(s => (
                    <div
                      key={s.session_id}
                      className={`history-item ${session?.session_id === s.session_id ? "history-item--active" : ""}`}
                      onClick={() => handleLoadSession(s.session_id)}
                      title="Click to load this session"
                    >
                      <div className="history-item-meta">
                        <span className="history-name">{s.candidate_name}</span>
                        <span className={`badge ${statusBadge(s.status)}`}>{s.status}</span>
                      </div>
                      <span className="history-role">{s.role}</span>
                      <span className="history-time">{fmtTime(s.updated_at)}</span>
                      <div className="history-actions">
                        <button
                          className="hist-btn hist-btn--clear"
                          title="Clear chat (keep questions)"
                          onClick={(e) => handleClearChat(s.session_id, e)}
                        >
                          <RefreshCw size={12} /> Clear
                        </button>
                        <button
                          className="hist-btn hist-btn--delete"
                          title="Delete session permanently"
                          onClick={(e) => handleDeleteSession(s.session_id, e)}
                        >
                          <Trash2 size={12} /> Delete
                        </button>
                      </div>
                    </div>
                  ))
                )}
              </div>
            )}
          </section>
        </aside>

        {/* ── Main content ─────────────────────────────────── */}
        <section className="content">
          {stage === "setup" && (
            <SetupPanel
              roles={roles} candidateName={candidateName} setCandidateName={setCandidateName}
              role={role} setRole={setRole} totalQuestions={totalQuestions}
              setTotalQuestions={setTotalQuestions} resumeFile={resumeFile}
              setResumeFile={setResumeFile} resumeText={resumeText}
              setResumeText={setResumeText} busy={busy} onSubmit={startInterview}
            />
          )}
          {stage === "generating" && <GeneratingPanel analysis={analysis} />}
          {stage === "interview" && currentQuestion && (
            <InterviewPanel
              question={currentQuestion} answerText={answerText}
              setAnswerText={setAnswerText} busy={busy} onSubmit={submitAnswer}
            />
          )}
          {stage === "complete" && (
            <CompletePanel
              busy={busy} answeredCount={answeredCount}
              totalQuestions={session?.total_questions || totalQuestions}
              evaluations={evaluations} onFinish={finishSession}
            />
          )}
          {stage === "summary" && summary && (
            <SummaryPanel
              summary={summary} evaluations={evaluations}
              onReset={resetFlow} onDownloadPdf={downloadPdf} pdfBusy={pdfBusy}
            />
          )}
          {answers.length > 0 && !summary && (
            <AnswerTimeline answers={answers} evaluations={evaluations} />
          )}
        </section>
      </main>
    </div>
  );
}

/* ── Sub-components ───────────────────────────────────────── */

function StatusPill({ icon, label }) {
  return <span className="status-pill">{icon}{label}</span>;
}

function StageRail({ stage }) {
  const stages = [["setup","Profile"],["generating","RAG"],["interview","Interview"],["complete","Finalize"],["summary","Summary"]];
  const activeIdx = Math.max(0, stages.findIndex(([k]) => k === stage));
  return (
    <nav className="stage-rail" aria-label="Interview stage">
      {stages.map(([key, label], i) => (
        <div key={key} className={`stage-item ${i === activeIdx ? "active" : ""} ${i < activeIdx ? "done" : ""}`}>
          <span>{i < activeIdx ? <CheckCircle2 size={16} /> : i + 1}</span>
          <strong>{label}</strong>
        </div>
      ))}
    </nav>
  );
}

function SetupPanel({ roles, candidateName, setCandidateName, role, setRole, totalQuestions, setTotalQuestions, resumeFile, setResumeFile, resumeText, setResumeText, busy, onSubmit }) {
  const [useFileUpload, setUseFileUpload] = useState(true);
  const hasResume = resumeFile || (resumeText && resumeText.trim().length >= 20);
  
  return (
    <form className="panel setup-panel" onSubmit={onSubmit}>
      <div className="panel-heading">
        <div><p className="eyebrow">Candidate Entry</p><h2>Start Interview</h2></div>
        <ClipboardList size={24} />
      </div>
      <div className="form-grid">
        <label>
          <span><User size={16} /> Candidate name</span>
          <input value={candidateName} onChange={e => setCandidateName(e.target.value)} placeholder="Candidate name" />
        </label>
        <label>
          <span><BriefcaseBusiness size={16} /> Target role</span>
          <select value={role} onChange={e => setRole(e.target.value)}>
            {roles.map(r => <option key={r} value={r}>{r}</option>)}
          </select>
        </label>
        <label>
          <span><ClipboardList size={16} /> Questions</span>
          <input type="number" min="3" max="15" value={totalQuestions} onChange={e => setTotalQuestions(e.target.value)} />
        </label>
        
        <div className="resume-section">
          <div className="resume-tabs">
            <button
              type="button"
              className={`resume-tab ${useFileUpload ? 'active' : ''}`}
              onClick={() => setUseFileUpload(true)}
            >
              <Upload size={14} /> Upload File
            </button>
            <button
              type="button"
              className={`resume-tab ${!useFileUpload ? 'active' : ''}`}
              onClick={() => setUseFileUpload(false)}
            >
              <FileText size={14} /> Paste Text
            </button>
          </div>
          
          {useFileUpload ? (
            <label className="file-input">
              <span><FileText size={16} /> Upload Resume</span>
              <input type="file" accept=".pdf,.doc,.docx,.txt,.text,.md" onChange={e => setResumeFile(e.target.files?.[0] || null)} />
              <em>{resumeFile ? resumeFile.name : "Click to select PDF, DOC, DOCX, TXT, or MD"}</em>
              {resumeFile && <div className="resume-selected"><CheckCircle2 size={14} /> {resumeFile.name}</div>}
            </label>
          ) : (
            <label className="resume-text-input">
              <span><FileText size={16} /> Paste Resume Text</span>
              <textarea
                value={resumeText}
                onChange={e => setResumeText(e.target.value)}
                rows={8}
                placeholder="Paste your resume text here (minimum 20 characters required)."
              />
              {resumeText.length > 0 && <div className="char-count">{resumeText.length} characters</div>}
            </label>
          )}
        </div>
      </div>
      
      {hasResume && (
        <div className="resume-status">
          <CheckCircle2 size={16} className="accent" />
          <span>{useFileUpload ? `Uploaded: ${resumeFile.name}` : `${resumeText.length} characters pasted`}</span>
        </div>
      )}
      
      <button className="primary-action" type="submit" disabled={busy || !hasResume}>
        {busy ? <LoaderCircle className="spin" size={18} /> : <Play size={18} />} Start Interview
      </button>
    </form>
  );
}

function GeneratingPanel({ analysis }) {
  return (
    <section className="panel center-panel">
      <LoaderCircle className="spin accent" size={34} />
      <h2>Preparing questions…</h2>
      {analysis && (
        <div className="signal-row">
          <span>{analysis.seniority_level}</span>
          <span>{analysis.skills?.length || 0} skills</span>
          <span>{analysis.technologies?.length || 0} technologies</span>
        </div>
      )}
      <p className="muted" style={{ marginTop: "0.5rem" }}>
        This usually takes 30–60 seconds. Sit tight!
      </p>
    </section>
  );
}

function InterviewPanel({ question, answerText, setAnswerText, busy, onSubmit }) {
  return (
    <form className="panel interview-panel" onSubmit={onSubmit}>
      <div className="question-meta">
        <span>{question.index}/{question.total}</span>
        <span>{question.topic}</span>
        <span>{question.difficulty}</span>
        <span>{question.question_type}</span>
      </div>
      <h2>{question.question_text}</h2>
      {question.source_excerpt && (
        <div className="source-box">
          <strong>{question.context_source || "Knowledge base"}</strong>
          <p>{question.source_excerpt}</p>
        </div>
      )}
      <label className="answer-box">
        <span>Answer</span>
        <textarea value={answerText} onChange={e => setAnswerText(e.target.value)} rows={9} placeholder="Type the candidate response here…" />
      </label>
      <button className="primary-action" type="submit" disabled={busy || !answerText.trim()}>
        {busy ? <LoaderCircle className="spin" size={18} /> : <Send size={18} />} Submit answer
      </button>
    </form>
  );
}

function CompletePanel({ busy, answeredCount, totalQuestions, evaluations, onFinish }) {
  const done = Object.values(evaluations).filter(e => e.status === "complete").length;
  return (
    <section className="panel center-panel">
      <CheckCircle2 className="accent" size={36} />
      <h2>Interview complete</h2>
      <div className="signal-row">
        <span>{answeredCount}/{totalQuestions} answered</span>
        <span>{done} evaluated</span>
      </div>
      <button className="primary-action" type="button" disabled={busy} onClick={onFinish}>
        {busy ? <LoaderCircle className="spin" size={18} /> : <ClipboardList size={18} />}
        Generate summary
      </button>
    </section>
  );
}

function SummaryPanel({ summary, evaluations, onReset, onDownloadPdf, pdfBusy }) {
  const details = summary.detailed_results || [];
  const [openIndex, setOpenIndex] = useState(null);
  return (
    <section className="summary-layout">
      <div className="panel summary-head">
        <div>
          <p className="eyebrow">Final Output</p>
          <h2>{summary.candidate_name}</h2>
          <p className="muted">{summary.role}</p>
        </div>
        <div className={scoreClass(summary.overall_score)}>{summary.overall_score}/10</div>
      </div>

      <div className="summary-actions-row">
        <button className="secondary-action" type="button" onClick={onReset}>
          <RotateCcw size={17} /> New session
        </button>
        <button className="pdf-action" type="button" onClick={onDownloadPdf} disabled={pdfBusy}>
          {pdfBusy ? <LoaderCircle className="spin" size={17} /> : <Download size={17} />}
          {pdfBusy ? "Generating PDF…" : "Download PDF"}
        </button>
      </div>

      <div className="summary-grid">
        <section className="panel">
          <h3>Recommendation</h3>
          <p className="recommendation">{summary.recommendation}</p>
          <p>{summary.narrative_summary}</p>
        </section>
        <section className="panel">
          <h3>Strengths</h3>
          <TagList items={summary.strengths} fallback="No strengths captured yet" />
        </section>
        <section className="panel">
          <h3>Improvement Areas</h3>
          <TagList items={summary.improvement_areas} fallback="No gaps captured yet" />
        </section>
      </div>

      <section className="panel">
        <h3>Detailed Results</h3>
        <div className="results-list">
          {details.map((item, i) => {
            const isOpen = openIndex === i;
            return (
              <article className={`result-item ${isOpen ? "result-item--open" : ""}`} key={`${item.question}-${i}`}>
                <button
                  className="result-main"
                  type="button"
                  onClick={() => setOpenIndex(isOpen ? null : i)}
                  title="Show saved answer"
                >
                  <div>
                    <strong>{item.topic || `Question ${i + 1}`}</strong>
                    <p>{item.question}</p>
                    <small>{isOpen ? "Hide answer" : "Show answer"}</small>
                  </div>
                  <span className={scoreClass(item.score || 0)}>{item.score ?? "—"}</span>
                  {isOpen ? <ChevronUp size={18} /> : <ChevronDown size={18} />}
                </button>
                {isOpen && (
                  <div className="result-answer">
                    <strong>Answer</strong>
                    <p>{item.answer || "No answer saved for this question."}</p>
                    {item.feedback && (
                      <>
                        <strong>Feedback</strong>
                        <p>{item.feedback}</p>
                      </>
                    )}
                  </div>
                )}
              </article>
            );
          })}
        </div>
      </section>
    </section>
  );
}

function TagList({ items, fallback }) {
  if (!items || items.length === 0) return <p className="muted">{fallback}</p>;
  return <div className="tag-list">{items.map(t => <span key={t}>{t}</span>)}</div>;
}

function AnswerTimeline({ answers, evaluations }) {
  return (
    <section className="timeline">
      <h2>Responses so far</h2>
      {answers.map((a, i) => {
        const ev = evaluations[a.question_id];
        return (
          <article className="timeline-item" key={a.question_id}>
            <span>{i + 1}</span>
            <div>
              <strong>{a.topic}</strong>
              <p>{a.answer}</p>
              {a.time_seconds && (
                <small className="time-chip"><Clock size={11} /> {a.time_seconds}s</small>
              )}
            </div>
            {ev?.status === "complete" ? (
              <em className={scoreClass(ev.score)}>{ev.score}/10</em>
            ) : (
              <em><LoaderCircle className="spin" size={14} /> scoring</em>
            )}
          </article>
        );
      })}
    </section>
  );
}
