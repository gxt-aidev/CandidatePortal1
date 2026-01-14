// src/SetupPortal.jsx
import { useEffect, useRef, useState } from "react";
import "./App.css";
import gxLogo from "./assets/new-globalxperts-logo.png";

const SETUP_WEBHOOK = import.meta.env.VITE_SETUP_WEBHOOK;
const API_BASE = "https://dvar.globalxperts.org";
const SETUP_VALIDATE_API = `${API_BASE}/api/setup`;


function useQuery() {
  const p = new URLSearchParams(window.location.search);
  return Object.fromEntries(p.entries());
}

function StatusPill({ ok, label }) {
  return (
    <span className={`hx-pill ${ok ? "ok" : "off"}`}>
      <span className="dot" />
      <span>{label}</span>
    </span>
  );
}

export default function SetupPortal() {
  const { token } = useQuery();

  // link / interview validation
  const [interviewId, setInterviewId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [linkError, setLinkError] = useState("");

  // camera / mic
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const audioCtxRef = useRef(null);
  const analyserRef = useRef(null);
  const rafRef = useRef(null);
  const dataArrayRef = useRef(null);

  const [isTesting, setIsTesting] = useState(false);
  const [permError, setPermError] = useState("");
  const [audioLevel, setAudioLevel] = useState(0);
  const [camOk, setCamOk] = useState(false);
  const [micOk, setMicOk] = useState(false);

  // form
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [resumeFile, setResumeFile] = useState(null);

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState("");

  // -------------------- validate token & fetch interview --------------------
  useEffect(() => {
    const validate = async () => {
      if (!token) {
        setLinkError("Missing or invalid interview link.");
        setLoading(false);
        return;
      }

      try {
        const res = await fetch(
          `${SETUP_VALIDATE_API}?token=${encodeURIComponent(token)}`,
          { mode: "cors" }
        );

        const raw = await res.text();
        let data;
        try {
          data = JSON.parse(raw);
        } catch {
          data = { error: "Invalid response from server" };
        }

        if (!res.ok || !data.interviewId) {
          const reason = data.error || "unknown";
          setLinkError(
            reason === "expired"
              ? "This interview link has expired."
              : "We couldn’t validate your interview link."
          );
          setLoading(false);
          return;
        }

        setInterviewId(data.interviewId);
        sessionStorage.setItem("gx_interview_id", data.interviewId);

        if (data.candidateEmail) {
          sessionStorage.setItem("gx_candidate_email", data.candidateEmail);
          setEmail(data.candidateEmail);
        }
      } catch (err) {
        console.error(err);
        setLinkError(
          "We’re having trouble reaching the server. Please try again in a moment."
        );
      } finally {
        setLoading(false);
      }
    };

    validate();
  }, [token]);

  // -------------------- camera & mic test --------------------
  const stopTest = () => {
    try {
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      if (audioCtxRef.current) {
        audioCtxRef.current.close().catch(() => {});
        audioCtxRef.current = null;
      }
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
      }
      if (videoRef.current) {
        videoRef.current.srcObject = null;
      }
    } catch (e) {
      console.error("Error stopping test", e);
    } finally {
      setIsTesting(false);
      setAudioLevel(0);
      setCamOk(false);
      setMicOk(false);
    }
  };

  const startTest = async () => {
    setPermError("");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });

      streamRef.current = stream;
      const videoTracks = stream.getVideoTracks();
      const audioTracks = stream.getAudioTracks();
      setCamOk(videoTracks.length > 0);
      setMicOk(audioTracks.length > 0);

      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        try {
          await videoRef.current.play();
        } catch {
          // autoplay issues can be ignored; user can click play
        }
      }

      const audioCtx = new (window.AudioContext ||
        window.webkitAudioContext)();
      audioCtxRef.current = audioCtx;
      const source = audioCtx.createMediaStreamSource(stream);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 1024;
      analyserRef.current = analyser;
      source.connect(analyser);
      const dataArray = new Uint8Array(analyser.fftSize);
      dataArrayRef.current = dataArray;

      const tick = () => {
        if (!analyserRef.current || !dataArrayRef.current) return;
        analyserRef.current.getByteTimeDomainData(dataArrayRef.current);
        let sum = 0;
        for (let i = 0; i < dataArrayRef.current.length; i++) {
          const v = (dataArrayRef.current[i] - 128) / 128;
          sum += v * v;
        }
        const rms = Math.sqrt(sum / dataArrayRef.current.length);
        const lvl = Math.min(1, rms * 4);
        setAudioLevel(lvl);
        if (lvl > 0.03) setMicOk(true);
        rafRef.current = requestAnimationFrame(tick);
      };

      setIsTesting(true);
      tick();
    } catch (err) {
      console.error(err);
      setPermError(
        "We couldn’t access your camera/mic. Please allow permissions and try again."
      );
      stopTest();
    }
  };

  useEffect(() => {
    return () => {
      stopTest();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // -------------------- form submit --------------------
  const onSubmit = async (e) => {
    e.preventDefault();
    setSubmitError("");

    if (!name.trim() || !email.trim()) {
      return setSubmitError("Please enter your name and email.");
    }

    if (!resumeFile) {
      return setSubmitError("Please upload your resume.");
    }

    const okExt = [".pdf", ".doc", ".docx"].some((ext) =>
      resumeFile.name.toLowerCase().endsWith(ext)
    );
    if (!okExt) {
      return setSubmitError(
        "Resume must be a PDF or Word document (.pdf, .doc, .docx)."
      );
    }

    if (!camOk || !micOk) {
      return setSubmitError("Please complete the camera & mic test first.");
    }

    if (!SETUP_WEBHOOK) {
      return setSubmitError("Setup webhook is not configured.");
    }

    setSubmitting(true);
    try {
      const iid = interviewId;

      const form = new FormData();
      form.append("name", name);
      form.append("email", email);
      form.append("interview_id", iid);
      form.append("cam_ok", String(camOk));
      form.append("mic_ok", String(micOk));
      form.append("user_agent", navigator.userAgent);
      form.append("resume", resumeFile, resumeFile.name);

      const res = await fetch(SETUP_WEBHOOK, {
        method: "POST",
        body: form,
      });

      let payload = {};
      try {
        payload = await res.json();
      } catch (_) {
        payload = {};
      }

      if (!res.ok || payload.ok === false) {
        const msg =
          payload.message ||
          payload.error ||
          "Setup failed on the server. Please contact support.";
        throw new Error(msg);
      }

      const candidateId =
        payload.candidateId || payload.candidate_id || payload.id || null;

      if (!candidateId) {
        throw new Error(
          "Setup succeeded but no candidateId was returned. Please contact support."
        );
      }

      sessionStorage.setItem(
        "gx_candidate",
        JSON.stringify({ candidateId, name, email })
      );
      sessionStorage.setItem("gx_interview_id", iid);

      const nextUrl = `/interview?id=${encodeURIComponent(
        iid
      )}&token=${encodeURIComponent(token)}`;
      stopTest(); // stop camera/mic before leaving setup page
      window.location.replace(nextUrl); // replace so Back doesn’t return to setup/interview chain
      return;
    } catch (err) {
      console.error(err);
      setSubmitError(
        err.message || "Something went wrong during setup. Please try again."
      );
    } finally {
      setSubmitting(false);
    }
  };

  // -------------------- UI --------------------
  if (loading) {
    return (
      <div className="hx-shell">
        <div className="hx-loading-card">
          <div className="hx-spinner" />
          <p>Validating your secure interview link…</p>
        </div>
      </div>
    );
  }

  if (linkError) {
    return (
      <div className="hx-shell">
        <div className="hx-error-card">
          <img src={gxLogo} alt="GlobalXperts" className="hx-logo-sm" />
          <h1>We couldn’t open your interview</h1>
          <p>{linkError}</p>
          <p className="hx-muted">
            If this keeps happening, please contact your recruiter and share a
            screenshot of this page.
          </p>
        </div>
      </div>
    );
  }

  const resumeLabel = resumeFile ? resumeFile.name : "Click to upload or drag & drop";

  return (
    <div className="hx-shell">
      <header className="hx-topbar">
        <div className="hx-topbar-left">
          <img src={gxLogo} alt="GlobalXperts" className="hx-logo" />
          <div className="hx-topbar-text">
            <span className="hx-brand">GlobalXperts</span>
            <span className="hx-subbrand">One-Way Interview</span>
          </div>
        </div>
        <div className="hx-step">
          
          <span className="hx-step-title">Pre-interview check</span>
        </div>
      </header>

      <main className="hx-main-wrap">
        <section className="hx-card-shell">
          <div className="hx-card-header">
            <div>
              <h1>Let’s make sure you’re ready</h1>
              
            </div>
          </div>

          <div className="hx-card-body">
            {/* LEFT: camera & mic */}
            <div className="hx-panel hx-panel-left">
              <h2>Check your camera &amp; mic</h2>
              <p className="hx-panel-sub">
                Keep your face centered and speak normally. You’ll see the audio
                bar move if your mic is working.
              </p>

              <div className="hx-video-frame">
                <div className="hx-video-gradient" />
                <video
                  ref={videoRef}
                  playsInline
                  muted
                  autoPlay={false}
                  className="hx-video-el"
                />
                <div className="hx-video-badge">
                  {isTesting ? "Live preview" : "Preview paused"}
                </div>
              </div>

              <div className="hx-meter-row">
                <div className="hx-meter-label">Mic activity</div>
                <div className="hx-meter-bar">
                  <div
                    className="hx-meter-fill"
                    style={{ width: `${Math.round(audioLevel * 100)}%` }}
                  />
                </div>
              </div>

              <div className="hx-status-row">
                <StatusPill ok={camOk} label="Camera" />
                <StatusPill ok={micOk} label="Mic" />
              </div>

              {permError && (
                <div className="hx-banner error">{permError}</div>
              )}

              <div className="hx-actions-left">
                {!isTesting ? (
                  <button
                    type="button"
                    className="hx-btn primary"
                    onClick={startTest}
                  >
                    Start camera &amp; mic test
                  </button>
                ) : (
                  <button
                    type="button"
                    className="hx-btn ghost"
                    onClick={stopTest}
                  >
                    Stop test
                  </button>
                )}
                <span className="hx-hint">
                  Tip: if your browser asks for permission, choose{" "}
                  <strong>Allow</strong>.
                </span>
              </div>
            </div>

            {/* RIGHT: details + resume */}
            <form className="hx-panel hx-panel-right" onSubmit={onSubmit}>
              <h2>Before you start, a quick check-in</h2>
              <p className="hx-panel-sub">
                Confirm your details and upload your latest resume. We’ll only
                use this for this interview process.
              </p>

              <div className="hx-field">
                <label htmlFor="fullName">Full name</label>
                <input
                  id="fullName"
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Your full name"
                  autoComplete="name"
                  required
                />
              </div>

              <div className="hx-field">
                <label htmlFor="email">Email</label>
                <input
                  id="email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  autoComplete="email"
                  required
                />
              </div>

              <div className="hx-field">
                <label>Upload your resume (PDF / DOC / DOCX)</label>
                <label className="hx-dropzone">
                  <input
                    type="file"
                    accept=".pdf,.doc,.docx,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                    onChange={(e) =>
                      setResumeFile(e.target.files?.[0] || null)
                    }
                    style={{ display: "none" }}
                  />
                  <div className="hx-dropzone-icon">📄</div>
                  <div className="hx-dropzone-text">
                    <span className="hx-dropzone-main">{resumeLabel}</span>
                    <span className="hx-dropzone-sub">
                      Max 10MB. Make sure it’s up to date.
                    </span>
                  </div>
                </label>
              </div>

              {submitError && (
                <div className="hx-banner error">{submitError}</div>
              )}

              <div className="hx-actions-right">
                <button
                  type="submit"
                  className="hx-btn primary"
                  disabled={submitting}
                >
                  {submitting ? "Submitting…" : "Submit & continue"}
                </button>
                <p className="hx-privacy">
                  Your data is encrypted in transit and stored securely. Only
                  the hiring team can access it.
                </p>
              </div>
            </form>
          </div>
        </section>
      </main>
    </div>
  );
}
