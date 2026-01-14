// CandidatePortal.jsx
import gxLogo from "./assets/new-globalxperts-logo.png";
import { useEffect, useMemo, useRef, useState } from "react";
import { FaceDetector, FilesetResolver } from "@mediapipe/tasks-vision";




/** ================== ENV / CONFIG ================== **/
// Use the protected external endpoint with API key
const INTERVIEWS_API = "https://hirexpert-1ecv.onrender.com/api/external/interviews";
const INTERVIEWS_API_KEY = "FetchingInterviewDetails@321$";

const UPLOAD_WEBHOOK = import.meta.env.VITE_UPLOAD_WEBHOOK; // https://n8n…/webhook/candidate-upload

// Try to capture in highest reasonable resolution (1080p). Browser will pick max it can.
const VIDEO_CONSTRAINTS = {
  width: { ideal: 1920 },
  height: { ideal: 1080 },
};
const AUDIO_CONSTRAINTS = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
};

const WARNING_AUTOHIDE_MS = 3500;

const progressKey = (iid, cid) =>
  `hirexpert_progress_${iid || "na"}_${cid || "na"}`;

/** ================== Small UI helpers (no layout change) ================== **/
function Header({ title, current, total }) {
  const pct = total ? Math.round((current / total) * 100) : 0;
  return (
    <header className="hx-header">
      <div className="hx-header-inner">
        <div className="hx-brand">
          <img className="hx-logo" src={gxLogo} alt="GlobalXperts logo" />
        </div>
        <div className="hx-head-center">
          <div className="hx-title">{title || "Loading…"}</div>
          <div className="hx-overall">
            <div className="hx-overall-text">Progress: {pct}%</div>
            <div className="hx-overall-bar">
              <div
                className="hx-overall-fill"
                style={{ width: `${pct}%` }}
              />
            </div>
          </div>
        </div>
        <div className="hx-head-right">
          <span
            className="hx-help"
            title="Stay in fullscreen, keep your face visible, and avoid switching tabs."
          >
            ?
          </span>
        </div>
      </div>
    </header>
  );
}
function Card({ children }) {
  return <div className="hx-card">{children}</div>;
}
function Chip({ children, tone = "neutral" }) {
  return <span className={`hx-chip ${tone}`}>{children}</span>;
}
function ProctorBanner({ message, onClose }) {
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    const t = setTimeout(() => setVisible(false), WARNING_AUTOHIDE_MS);
    return () => clearTimeout(t);
  }, []);
  useEffect(() => {
    if (!visible) {
      const t = setTimeout(onClose, 400);
      return () => clearTimeout(t);
    }
  }, [visible, onClose]);
  return (
    <div
      aria-live="polite"
      style={{
        position: "fixed",
        right: 16,
        top: 16,
        zIndex: 1000,
        transform: visible ? "translateX(0)" : "translateX(120%)",
        transition: "transform 0.35s ease",
        maxWidth: 360,
      }}
    >
      <div
        className="hx-card"
        style={{
          boxShadow: "0 8px 24px rgba(0,0,0,0.18)",
          borderLeft: "4px solid #F59E0B",
        }}
      >
        <div style={{ padding: 12 }}>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>
            Proctoring notice
          </div>
          <div style={{ fontSize: 14, opacity: 0.9 }}>{message}</div>
        </div>
      </div>
    </div>
  );
}

/** ================== Main Component ================== **/
export default function CandidatePortal() {
  /** -------- Session guard -------- **/
  const params = new URLSearchParams(window.location.search);
  const interviewId = params.get("id") || "";
  const token = params.get("token") || "";

  // -------- Consume Interview Token (one-time use) --------
  useEffect(() => {
    // Token is mandatory: without it, never allow interview UI
    if (!token) {
      window.location.replace(
        `/thank-you?id=${encodeURIComponent(interviewId)}&reason=invalid_link`
      );
      return;
    }
  
    let cancelled = false;
  
    (async () => {
      try {
        const res = await fetch(
          "https://hirexpert-1ecv.onrender.com/api/consume-token",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ token }),
          }
        );
  
        const data = await res.json().catch(() => ({}));
  
        // Flexible checks (depends on your backend response shape)
        const ok =
          res.ok &&
          data?.ok !== false &&
          data?.used !== true &&
          data?.valid !== false &&
          data?.status !== "used";
  
        if (!ok && !cancelled) {
          window.location.replace(
            `/thank-you?id=${encodeURIComponent(interviewId)}&reason=link_used`
          );
        }
      } catch (err) {
        console.error("Token consume error:", err);
        // Optional: fail-closed (more secure)
        // if (!cancelled) window.location.replace(`/thank-you?id=${encodeURIComponent(interviewId)}&reason=token_check_failed`);
      }
    })();
  
    return () => {
      cancelled = true;
    };
  }, [token, interviewId]);


  const candidate = useMemo(() => {
    try {
      return JSON.parse(sessionStorage.getItem("gx_candidate") || "{}");
    } catch {
      return {};
    }
  }, []);

  /** -------- Data state -------- **/
  const [loading, setLoading] = useState(true);
  const [interview, setInterview] = useState(null);
  const [error, setError] = useState("");

  /** -------- Flow state -------- **/
  const [idx, setIdx] = useState(0);
  const [stage, setStage] = useState("question"); // question | review | uploading | done
  
  const stageRef = useRef(stage);
  useEffect(() => {
    stageRef.current = stage;
  }, [stage]);
  const shuttingDownRef = useRef(false);


  const total = interview?.questions?.length || 0;
  const currentQ = interview?.questions?.[idx] || null;

  /** -------- Media & recorder -------- **/
  const videoEl = useRef(null);
  const streamRef = useRef(null);
  const recorderRef = useRef(null);
  const isStartingRef = useRef(false); // debounce start
  const [isRecording, setIsRecording] = useState(false);
  const [recordedBlob, setRecordedBlob] = useState(null);
  const [recordingUrl, setRecordingUrl] = useState("");
  const [permError, setPermError] = useState("");
  const [timeLeft, setTimeLeft] = useState(0);

  /** -------- Proctoring -------- **/
  const [tabSwitchCount, setTabSwitchCount] = useState(0);
  const [fsGate, setFsGate] = useState(false);
  const fsExitThrottleRef = useRef(0);
  const fsEverEnteredRef = useRef(false);     // track if fullscreen was ever actually entered
  const [fsGateMode, setFsGateMode] = useState("enter"); // "enter" | "exit"

  /** -------- Face proctoring (MediaPipe) -------- **/
  const faceDetectorRef = useRef(null);
  const faceInitPromiseRef = useRef(null);
  
  const faceMonitorTimerRef = useRef(null);
  const faceScanTimerRef = useRef(null);
  const faceScanRunIdRef = useRef(0);
  const faceFullScanDoneRef = useRef(false);
  
  const noFaceSinceRef = useRef(0);
  const multiFaceSinceRef = useRef(0);
  const frameBadSinceRef = useRef(0);
  
  const noFaceLastWarnAtRef = useRef(0);
  const multiFaceLastWarnAtRef = useRef(0);
  const frameLastBannerAtRef = useRef(0);
  
  const [faceScanPhase, setFaceScanPhase] = useState("idle"); // idle | discover | mini | locked
  const [faceBox, setFaceBox] = useState(null); // { l,t,w,h } in %
  const [faceStatus, setFaceStatus] = useState({ tone: "neutral", text: "" });
  const faceStatusRef = useRef({ tone: "neutral", text: "" });
  
  const setFaceStatusSafe = (next) => {
    const cur = faceStatusRef.current;
    if (cur.tone === next.tone && cur.text === next.text) return;
    faceStatusRef.current = next;
    setFaceStatus(next);
  };
  
  const stopFaceTimers = () => {
    if (faceMonitorTimerRef.current) {
      clearInterval(faceMonitorTimerRef.current);
      faceMonitorTimerRef.current = null;
    }
    if (faceScanTimerRef.current) {
      clearInterval(faceScanTimerRef.current);
      faceScanTimerRef.current = null;
    }
  };
  
  const waitForVideoReady = async (timeoutMs = 2500) => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const v = videoEl.current;
      if (v && v.readyState >= 2 && v.videoWidth > 0 && v.videoHeight > 0) return true;
      await new Promise((r) => setTimeout(r, 100));
    }
    return false;
  };
  
  const ensureFaceDetector = async () => {
    if (faceDetectorRef.current) return faceDetectorRef.current;
  
    if (!faceInitPromiseRef.current) {
      faceInitPromiseRef.current = (async () => {
        // WASM loader path: CDN is simplest for Vite. (We’ll add the npm dep separately.)
        const vision = await FilesetResolver.forVisionTasks(
          "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.20/wasm"
        );
  
        const detector = await FaceDetector.createFromOptions(vision, {
          baseOptions: {
            // BlazeFace short range model (good for laptop webcam)
            modelAssetPath:
              "https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite",
          },
          runningMode: "VIDEO",
          minDetectionConfidence: 0.6,
        });
  
        faceDetectorRef.current = detector;
        return detector;
      })();
    }
  
    return faceInitPromiseRef.current;
  };
  
  const evaluateFace = (detections, W, H) => {
    const dets = Array.isArray(detections) ? detections : [];
  
    if (dets.length === 0) return { kind: "no-face" };
    if (dets.length > 1) return { kind: "multiple-faces" };
  
    const d = dets[0];
    const score = d?.categories?.[0]?.score ?? 1;
    if (score < 0.6) return { kind: "no-face" };
  
    const bb = d?.boundingBox;
    if (!bb) return { kind: "no-face" };
  
    const x = bb.originX ?? 0;
    const y = bb.originY ?? 0;
    const w = bb.width ?? 0;
    const h = bb.height ?? 0;
  
    // Convert to % for drawing overlay box
    const boxPct = {
      l: Math.max(0, (x / W) * 100),
      t: Math.max(0, (y / H) * 100),
      w: Math.max(0, (w / W) * 100),
      h: Math.max(0, (h / H) * 100),
    };
  
    // “80% in frame” (practical): safe inset margins (5%)
    const insetX = 0.05 * W;
    const insetY = 0.05 * H;
  
    const clipped =
      x < insetX ||
      y < insetY ||
      x + w > W - insetX ||
      y + h > H - insetY;
  
    // Distance check by face area ratio
    const ratio = (w * h) / (W * H);
    if (ratio < 0.08) return { kind: "too-far", boxPct };
    if (ratio > 0.45) return { kind: "too-close", boxPct };
    if (clipped) return { kind: "cropped", boxPct };
  
    return { kind: "ok", boxPct };
  };
  
  const detectFacesNow = async () => {
    const v = videoEl.current;
    if (!v || v.readyState < 2 || v.videoWidth === 0 || v.videoHeight === 0) return null;
  
    const detector = await ensureFaceDetector();
    const res = detector.detectForVideo(v, performance.now());
    const dets = res?.detections ?? res ?? [];
    return { dets, W: v.videoWidth, H: v.videoHeight };
  };
  
  const runFaceScan = async (mode) => {
    // mode: "full" (5–6s) or "mini" (1–2s)
    const durationMs = mode === "full" ? 5600 : 1500;
    const phase = mode === "full" ? "discover" : "mini";
  
    const myRunId = ++faceScanRunIdRef.current;
  
    stopFaceTimers(); // stop any previous scan/monitor timers
    setFaceScanPhase(phase);
    setFaceStatusSafe({
      tone: "neutral",
      text: mode === "full" ? "Finding your face…" : "Checking face…",
    });
  
    // ensure preview is alive and video has dimensions
    await ensurePreview();
    const ready = await waitForVideoReady(3000);
    if (!ready) {
      setFaceScanPhase("idle");
      return false;
    }
  
    const okWindow = [];
    const start = Date.now();
  
    return await new Promise((resolve) => {
      faceScanTimerRef.current = setInterval(async () => {
        // cancelled/replaced
        if (myRunId !== faceScanRunIdRef.current) {
          stopFaceTimers();
          resolve(false);
          return;
        }
  
        try {
          const snap = await detectFacesNow();
          if (!snap) return;
  
          const { dets, W, H } = snap;
          const r = evaluateFace(dets, W, H);
  
          if (r.boxPct) setFaceBox(r.boxPct);
  
          // Update status text (scan mode only — no warnings counted here)
          if (r.kind === "ok") {
            setFaceStatusSafe({ tone: "ok", text: "Face OK" });
            okWindow.push(1);
          } else if (r.kind === "multiple-faces") {
            setFaceStatusSafe({ tone: "danger", text: "Multiple faces" });
            okWindow.push(0);
          } else if (r.kind === "no-face") {
            setFaceStatusSafe({ tone: "danger", text: "No face" });
            okWindow.push(0);
          } else {
            setFaceStatusSafe({ tone: "warn", text: "Adjust your face" });
            okWindow.push(0);
          }
  
          // keep last 10 results
          while (okWindow.length > 10) okWindow.shift();
  
          const okCount = okWindow.reduce((a, b) => a + b, 0);
          const stable = okWindow.length >= 6 && okCount >= 5; // stable enough
  
          if (stable) {
            setFaceScanPhase("locked");
            setFaceStatusSafe({ tone: "ok", text: "Locked ✓" });
            stopFaceTimers();
            setTimeout(() => {
              // only clear if not replaced
              if (myRunId === faceScanRunIdRef.current) setFaceScanPhase("idle");
            }, 650);
            resolve(true);
            return;
          }
  
          if (Date.now() - start >= durationMs) {
            stopFaceTimers();
            setFaceScanPhase("idle");
            resolve(false);
          }
        } catch {
          // ignore per-tick errors
        }
      }, 140);
    });
  };



  const [answerMeta, setAnswerMeta] = useState({}); // { qid: { warnings:[{type,ts}] } }
  const [banners, setBanners] = useState([]);
  const pushBanner = (msg) =>
    setBanners((b) => [
      ...b,
      { id: Math.random().toString(36).slice(2), message: msg },
    ]);
  const removeBanner = (id) =>
    setBanners((b) => b.filter((x) => x.id !== id));

  const addWarning = (reason) => {
    const qid = interview?.questions?.[idx]?.id || `q${idx + 1}`;
    setAnswerMeta((prev) => {
      const next = { ...prev };
      const entry = next[qid] || { warnings: [] };
      entry.warnings = [...entry.warnings, { type: reason, ts: Date.now() }];
      next[qid] = entry;
      return next;
    });
    if (["visibility", "blur"].includes(reason)) setTabSwitchCount((n) => n + 1);

    pushBanner(
      reason === "visibility"
        ? "We detected a tab/app switch. Please stay focused on the interview."
        : reason === "blur"
        ? "Window focus lost. Please return to the interview."
        : reason === "fs-exit"
        ? "Exiting Full Screen is not allowed. Click “Return to Full Screen” to continue."
        : reason === "multiple-faces"
        ? "Multiple faces detected. Continue solo to avoid flags."
        : reason === "no-face"
        ? "No face detected. Please stay in frame."
        : "Session policy warning."
    );
  };
  const getTotalWarningCount = (meta) =>
    Object.values(meta || {}).reduce(
      (s, m) => s + (m?.warnings?.length || 0),
      0
    );

  /** ================== Fetch questions ================== **/
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        setLoading(true);
        setError("");

        if (!interviewId) {
          throw new Error("Missing interview id");
        }

        const url = `${INTERVIEWS_API}?id=${encodeURIComponent(
          interviewId
        )}`;

        const res = await fetch(url, {
          headers: {
            "x-api-key": INTERVIEWS_API_KEY,
          },
        });

        if (!res.ok) {
          throw new Error(`API ${res.status}`);
        }

        const rows = await res.json();
        const item = Array.isArray(rows) ? rows[0] : rows;

        if (!item) {
          throw new Error("Interview not found");
        }

        const qs = (item.questions || []).map((q, i) => ({
          id: `q${i + 1}`,
          text: q?.text || q,
          timeLimit:
            item.time_limits?.[i] ??
            item.timeLimits?.[i] ??
            q?.timeLimit ??
            120,
        }));

        if (cancelled) return;

        setInterview({
          interviewId: item.id,
          title: item.title || "Interview",
          questions: qs,
        });
        setTimeLeft(qs[0]?.timeLimit || 120);

        // restore progress
        try {
          const raw = localStorage.getItem(
            progressKey(
              item.id,
              candidate?.candidateId || candidate?.id
            )
          );
          if (raw) {
            const saved = JSON.parse(raw);
            if (Number.isInteger(saved.currentIndex)) {
              const safeIndex = Math.max(
                0,
                Math.min(qs.length - 1, saved.currentIndex)
              );
              setIdx(safeIndex);
              setTimeLeft(qs[safeIndex]?.timeLimit ?? 120);
            }
            if (typeof saved.tabSwitchCount === "number")
              setTabSwitchCount(saved.tabSwitchCount);
            if (saved.answerMeta && typeof saved.answerMeta === "object")
              setAnswerMeta(saved.answerMeta);
          }
        } catch {
          // ignore restore errors
        }
      } catch (e) {
        console.error(e);
        if (!cancelled)
          setError(
            "Couldn’t load interview. Check your link and try again."
          );
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [interviewId, candidate]);

  /** persist progress */
  useEffect(() => {
    if (!interview?.interviewId) return;
    try {
      localStorage.setItem(
        progressKey(
          interview.interviewId,
          candidate?.candidateId || candidate?.id
        ),
        JSON.stringify({
          currentIndex: idx,
          tabSwitchCount,
          answerMeta,
          savedAt: Date.now(),
        })
      );
    } catch {
      // ignore
    }
  }, [interview?.interviewId, candidate, idx, tabSwitchCount, answerMeta]);
  

  /** ================== Fullscreen on entry with gesture fallback ================== **/
  /** ================== Fullscreen on entry with gesture fallback ================== **/
  useEffect(() => {
    const warnAndGate = () => {
      if (shuttingDownRef.current) return;
      if (stageRef.current === "done") return;
  
      const now = Date.now();
      if (now - fsExitThrottleRef.current < 800) return;
      fsExitThrottleRef.current = now;
  
      setFsGateMode("exit");
      addWarning("fs-exit");      // counts warning
      setFsGate(true);            // blocks UI
    };
  
    const onFsChange = () => {
      if (document.fullscreenElement) {
        fsEverEnteredRef.current = true; // now we consider fullscreen "active once"
        setFsGate(false);
        return;
      }
  
      // If fullscreen was never entered (browser blocked on load), DO NOT gate here.
      // Only gate when user exits fullscreen after having entered it once.
      if (fsEverEnteredRef.current) warnAndGate();
    };
  
    const enterFs = async () => {
      try {
        if (!document.fullscreenElement) {
          await document.documentElement.requestFullscreen();
        }
      } catch {
        // browser may block until a gesture
      }
    };
  
    // Attempt once on mount (may fail without gesture)
    enterFs();
  
    // Try again on first user gesture (this will usually succeed)
    const onFirstGesture = async () => {
      await enterFs();
    };
  
    document.addEventListener("fullscreenchange", onFsChange);
    window.addEventListener("pointerdown", onFirstGesture, { once: true });
  
    return () => {
      document.removeEventListener("fullscreenchange", onFsChange);
      window.removeEventListener("pointerdown", onFirstGesture);
    };
  }, []);





  /** ================== Proctoring events ================== **/
  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState !== "visible") addWarning("visibility");
    };
    const onBlur = () => addWarning("blur");
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("blur", onBlur);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("blur", onBlur);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idx, interview?.interviewId]);

  /** ================== Face proctoring monitor (recording only) ================== **/
  useEffect(() => {
    stopFaceTimers();
  
    // Only proctor during active recording and only on question stage
    if (!(isRecording && stage === "question")) {
      // keep a calm status when idle
      setFaceStatusSafe({ tone: "neutral", text: "" });
      return;
    }
  
    let cancelled = false;
  
    // reset streak timers
    noFaceSinceRef.current = 0;
    multiFaceSinceRef.current = 0;
    frameBadSinceRef.current = 0;
  
    const COOLDOWN_WARN_MS = 15000; // for warning-count types
    const COOLDOWN_FRAME_MS = 10000; // banner-only framing
    const PERSIST_MS = 2000;
  
    (async () => {
      try {
        await ensureFaceDetector();
        if (cancelled) return;
  
        faceMonitorTimerRef.current = setInterval(async () => {
          if (cancelled) return;
          if (shuttingDownRef.current) return;
          if (stageRef.current !== "question") return;
  
          const snap = await detectFacesNow();
          if (!snap) return;
  
          const { dets, W, H } = snap;
          const r = evaluateFace(dets, W, H);
  
          // Draw face box if we have one
          if (r.boxPct) setFaceBox(r.boxPct);
          else setFaceBox(null);
  
          const now = Date.now();
  
          const clearAll = () => {
            noFaceSinceRef.current = 0;
            multiFaceSinceRef.current = 0;
            frameBadSinceRef.current = 0;
          };
  
          if (r.kind === "ok") {
            clearAll();
            setFaceStatusSafe({ tone: "ok", text: "Face OK" });
            return;
          }
  
          if (r.kind === "no-face") {
            setFaceStatusSafe({ tone: "danger", text: "No face" });
  
            if (!noFaceSinceRef.current) noFaceSinceRef.current = now;
            // reset other streaks
            multiFaceSinceRef.current = 0;
            frameBadSinceRef.current = 0;
  
            if (now - noFaceSinceRef.current >= PERSIST_MS) {
              if (now - noFaceLastWarnAtRef.current >= COOLDOWN_WARN_MS) {
                noFaceLastWarnAtRef.current = now;
                addWarning("no-face"); // ✅ warning count + banner
              }
              // keep streak alive but allow re-warn after cooldown
              noFaceSinceRef.current = now;
            }
            return;
          }
  
          if (r.kind === "multiple-faces") {
            setFaceStatusSafe({ tone: "danger", text: "Multiple faces" });
  
            if (!multiFaceSinceRef.current) multiFaceSinceRef.current = now;
            // reset other streaks
            noFaceSinceRef.current = 0;
            frameBadSinceRef.current = 0;
  
            if (now - multiFaceSinceRef.current >= PERSIST_MS) {
              if (now - multiFaceLastWarnAtRef.current >= COOLDOWN_WARN_MS) {
                multiFaceLastWarnAtRef.current = now;
                addWarning("multiple-faces"); // ✅ warning count + banner
              }
              multiFaceSinceRef.current = now;
            }
            return;
          }
  
          // Framing issues: banner only
          setFaceStatusSafe({ tone: "warn", text: "Adjust face" });
  
          if (!frameBadSinceRef.current) frameBadSinceRef.current = now;
          noFaceSinceRef.current = 0;
          multiFaceSinceRef.current = 0;
  
          if (now - frameBadSinceRef.current >= PERSIST_MS) {
            if (now - frameLastBannerAtRef.current >= COOLDOWN_FRAME_MS) {
              frameLastBannerAtRef.current = now;
  
              pushBanner(
                r.kind === "too-close"
                  ? "You are too close. Please move slightly back."
                  : r.kind === "too-far"
                  ? "You are too far. Please move closer so your face is clear."
                  : "Your face is not fully in frame. Please center your face."
              );
            }
            frameBadSinceRef.current = now;
          }
        }, 200); // ~5 fps (good balance)
      } catch {
        // If detector fails to load, do nothing (don’t break interview)
      }
    })();
  
    return () => {
      cancelled = true;
      stopFaceTimers();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isRecording, stage, idx]);


  /** ================== Preview lifecycle (robust) ================== **/
  const tracksEnded = (s) =>
    !s || s.getTracks().every((t) => t.readyState === "ended");

  const ensurePreview = async () => {
    // start or repair the stream
    if (!streamRef.current || tracksEnded(streamRef.current)) {
      try {
        const s = await navigator.mediaDevices.getUserMedia({
          video: VIDEO_CONSTRAINTS,
          audio: AUDIO_CONSTRAINTS,
        });
        streamRef.current = s;
      } catch (err) {
        console.error(err);
        setPermError(
          "Camera/mic blocked. Allow permissions in your browser and refresh."
        );
        return false;
      }
    }

    // attach to element
    if (videoEl.current && videoEl.current.srcObject !== streamRef.current) {
      videoEl.current.srcObject = streamRef.current;
    }

    // try play with retries & gesture fallback
    let attempts = 0;
    while (attempts < 3) {
      attempts++;
      try {
        videoEl.current.muted = true;
        videoEl.current.playsInline = true;
        if (videoEl.current.readyState < 2) {
          await new Promise((r) => setTimeout(r, 120)); // wait for metadata
        }
        await videoEl.current.play();
        return true;
      } catch {
        await new Promise((r) => setTimeout(r, 150));
      }
    }

    // final fallback: arm one-time gesture
    const onGesture = async () => {
      try {
        await videoEl.current.play();
      } catch {
        /* ignore */
      }
      window.removeEventListener("pointerdown", onGesture);
    };
    window.addEventListener("pointerdown", onGesture, { once: true });
    return false;
  };

  useEffect(() => {
  let cancelled = false;

  (async () => {
    await ensurePreview();

    // Full scan only once per interview page load
    if (!faceFullScanDoneRef.current) {
      faceFullScanDoneRef.current = true;
      try {
        await ensureFaceDetector();
        if (!cancelled && stageRef.current === "question") {
          await runFaceScan("full"); // 5–6s discovery
        }
      } catch {
        // ignore
      }
    }
  })();

  return () => {
    cancelled = true;

    // stop face timers + detector
    stopFaceTimers();
    try {
      faceDetectorRef.current?.close?.();
    } catch {}
    faceDetectorRef.current = null;
    faceInitPromiseRef.current = null;

    // stop camera/mic
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    if (recordingUrl) URL.revokeObjectURL(recordingUrl);
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, []);


  // nudge preview when interview/question changes (covers fresh mounts)
  useEffect(() => {
    if (streamRef.current && videoEl.current && videoEl.current.paused) {
      (async () => {
        try {
          videoEl.current.muted = true;
          videoEl.current.playsInline = true;
          await videoEl.current.play();
        } catch {
          /* ignore */
        }
      })();
    }
  }, [interview?.interviewId, idx]);

  /** ================== Recording ================== **/
  const pickMime = () => {
    const choices = [
      "video/webm;codecs=vp9,opus",
      "video/webm;codecs=vp8,opus",
      "video/webm",
      "video/mp4;codecs=h264,aac", // Safari fallback
    ];
    for (const m of choices)
      if (window.MediaRecorder && MediaRecorder.isTypeSupported(m)) return m;
    return "video/webm";
  };

  const startRecording = async () => {
    // Require fullscreen before recording begins
    if (!document.fullscreenElement) {
      setFsGateMode("enter");
      setFsGate(true);      // block until user clicks Return to fullscreen
      return;
    }

    if (isStartingRef.current) return;
    isStartingRef.current = true;
    try {
      if (!currentQ) return;

      // make sure preview is alive before recorder
      const ok = await ensurePreview();
      if (!ok || !streamRef.current || tracksEnded(streamRef.current)) {
        pushBanner("Unable to start camera/mic. Check permissions.");
        return;
      }
      // Mini face check for each question (1–2s)
      try {
        await runFaceScan("mini");
      } catch {
        // ignore — do not block recording
      }


      const mimeType = pickMime();

      // NOTE: we are no longer passing explicit bitrates; let the browser decide.
      const mr = new MediaRecorder(streamRef.current, {
        mimeType,
      });

      const chunks = [];
      mr.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) chunks.push(e.data);
      };
      mr.onstop = async () => {
        const blob = new Blob(chunks, {
          type: mimeType || "video/webm",
        });
        setRecordedBlob(blob);

        // switch to playback
        if (videoEl.current) {
          videoEl.current.pause();
          videoEl.current.srcObject = null;
          const url = URL.createObjectURL(blob);
          setRecordingUrl(url);
          videoEl.current.src = url;
          videoEl.current.muted = false;
          await videoEl.current.play().catch(() => {});
        }
        if (streamRef.current) {
          streamRef.current.getTracks().forEach((t) => t.stop());
          streamRef.current = null;
        }
        setIsRecording(false);
        setStage("review");
      };

      setRecordedBlob(null);
      URL.revokeObjectURL(recordingUrl);
      setRecordingUrl("");

      setIsRecording(true);
      setTimeLeft(currentQ.timeLimit || 120);
      recorderRef.current = mr;
      mr.start(3000); // chunked
    } finally {
      isStartingRef.current = false;
    }
  };

  const stopRecording = () => {
    if (
      recorderRef.current &&
      recorderRef.current.state === "recording"
    )
      recorderRef.current.stop();
  };

  useEffect(() => {
    if (!isRecording) return;
    if (timeLeft <= 0) {
      stopRecording();
      return;
    }
    const t = setTimeout(() => setTimeLeft((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [isRecording, timeLeft]);

  /** ================== Save & Upload ================== **/
  const saveLocalProgress = (nextIndex = idx) => {
    if (!interview?.interviewId) return;
    try {
      localStorage.setItem(
        progressKey(
          interview.interviewId,
          candidate?.candidateId || candidate?.id
        ),
        JSON.stringify({
          currentIndex: nextIndex,
          tabSwitchCount,
          answerMeta,
          savedAt: Date.now(),
        })
      );
    } catch {
      // ignore
    }
  };
  const clearLocalProgress = () => {
    try {
      const iid = interview?.interviewId || interviewId || "";
      const cid = candidate?.candidateId || candidate?.id || "";
      localStorage.removeItem(progressKey(iid, cid));
    } catch {}
  };
  
  const stopAllConnections = async () => {
    // Stop face proctoring timers + detector
    stopFaceTimers();
    try {
      faceDetectorRef.current?.close?.();
    } catch {}
    faceDetectorRef.current = null;
    faceInitPromiseRef.current = null;

    // Stop recorder
    try {
      const r = recorderRef.current;
      if (r) {
        r.ondataavailable = null;
        r.onstop = null;
        if (r.state !== "inactive") r.stop();
      }
      recorderRef.current = null;
    } catch {}
  
    // Stop camera/mic tracks
    try {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
      }
    } catch {}
  
    // Detach video element
    try {
      if (videoEl.current) {
        videoEl.current.pause?.();
        videoEl.current.srcObject = null;
        videoEl.current.src = "";
      }
    } catch {}
  
    // Exit fullscreen
    if (document.fullscreenElement) {
      try {
        await document.exitFullscreen();
      } catch {}
    }
  
    // Clear session values
    try {
      sessionStorage.removeItem("gx_candidate");
      sessionStorage.removeItem("gx_interview_id");
    } catch {}
  
    // Clear progress saved in localStorage
    clearLocalProgress();
  };
  
  const redirectToThankYou = async (reason = "completed") => {
    shuttingDownRef.current = true;  // <— IMPORTANT
    stageRef.current = "done";       // <— IMPORTANT
    setStage("done");                // <— optional but clean
  
    await stopAllConnections();
  
    const iid = interview?.interviewId || interviewId || "";
    const cid = candidate?.candidateId || candidate?.id || "";
  
    window.location.replace(
      `/thank-you?id=${encodeURIComponent(iid)}&cid=${encodeURIComponent(
        cid
      )}&reason=${encodeURIComponent(reason)}`
    );
  };



  const uploadAnswer = async () => {
    if (!UPLOAD_WEBHOOK) {
      alert("Upload webhook is not configured.");
      return;
    }
    if (!recordedBlob || !currentQ || !interview) return;

    setStage("uploading");

    const token =
      candidate.candidateId ||
      candidate.candidate_token ||
      candidate.candidate_id ||
      "";
    const ext = recordedBlob.type.includes("mp4") ? "mp4" : "webm";
    const filePath = `${interview.interviewId}/${currentQ.id}.${ext}`;

    const thisQWarnings = answerMeta[currentQ.id]?.warnings || [];
    const totalWarnings = getTotalWarningCount(answerMeta);

    const form = new FormData();
    form.append("interview_id", interview.interviewId);
    form.append("question_id", currentQ.id);
    form.append("candidate_token", token);
    form.append("file_path", filePath);
    form.append("mimeType", recordedBlob.type || "video/webm");
    form.append("userAgent", navigator.userAgent);
    form.append("tab_switch_count", String(tabSwitchCount));
    form.append("total_warnings", String(totalWarnings));
    form.append("question_warning_count", String(thisQWarnings.length));
    form.append("warnings_json", JSON.stringify(thisQWarnings));
    form.append("file", recordedBlob, `${currentQ.id}.${ext}`);

    try {
      const res = await fetch(UPLOAD_WEBHOOK, {
        method: "POST",
        body: form,
      });
      if (!res.ok) throw new Error(`Upload failed: ${res.status}`);

      const next = idx + 1;
      if (recordingUrl) URL.revokeObjectURL(recordingUrl);
      setRecordedBlob(null);
      setRecordingUrl("");

      if (next < total) {
        setIdx(next);
        saveLocalProgress(next);
        await ensurePreview();
        setStage("question");
        setTimeLeft(interview.questions[next]?.timeLimit ?? 120);
      } else {
        // Interview completed:
        // 1) DO NOT save progress (prevents resume/edit)
        // 2) Clear progress
        // 3) Stop all connections
        // 4) Hard redirect (replace history so Back can’t return to interview)
        clearLocalProgress();
        setIdx(total);
      
        await redirectToThankYou("completed");
        return;
      }
    } catch (e) {
      console.error(e);
      alert("Upload failed. Please try again.");
      setStage("review");
    }
  };
  /** ================== Keyboard shortcuts ================== **/
  useEffect(() => {
    const onKey = (e) => {
      if (e.code === "Space" && stage === "question") {
        e.preventDefault();
        if (!isRecording) startRecording();
        else stopRecording();
      }
      if (e.code === "Enter" && stage === "review") {
        e.preventDefault();
        uploadAnswer();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [stage, isRecording, recordedBlob, currentQ]);

  /** ================== UI ================== **/
  const pctThisQ = currentQ
    ? Math.max(
        0,
        Math.min(
          100,
          (timeLeft / (currentQ.timeLimit || 1)) * 100
        )
      )
    : 0;

  return (
    <div className="hx-root">
      <Header
        title={interview?.title}
        current={idx}
        total={total}
      />
      {fsGate && stage !== "done" && (
        <div className="hx-fs-gate" role="dialog" aria-modal="true">
          <div className="hx-fs-card">
            <div className="hx-fs-title">Fullscreen required</div>
            <div className="hx-fs-text">
              {fsGateMode === "exit"
                ? "Exiting fullscreen is not allowed. This attempt has been counted as a warning. Click below to return to fullscreen to continue the interview."
                : "Please enter fullscreen to start/continue the interview. Click below to go fullscreen."}
            </div>
      
            <button
              className="hx-btn primary"
              onClick={async () => {
                try {
                  await document.documentElement.requestFullscreen();
                  fsEverEnteredRef.current = true;
                  setFsGate(false);
                } catch {
                  // keep them blocked
                }
              }}
            >
              Return to fullscreen
            </button>
          </div>
        </div>
      )}


      <main className="hx-main">
        {/* LEFT RAIL */}
        <aside className="hx-rail">
          <div className="hx-rail-head">Questions</div>
          <ol className="hx-steps" aria-label="Interview questions list">
            {Array.from({ length: total }).map((_, i) => (
              <li
                key={i}
                className={`hx-step ${
                  i < idx ? "done" : ""
                } ${i === idx ? "current" : ""}`}
              >
                <span className="hx-step-dot" />
                <span className="hx-step-text">
                  Question {i + 1}
                </span>
              </li>
            ))}
          </ol>
          <div className="hx-rail-note">
            Stay in fullscreen while answering.
          </div>
          <div className="hx-rail-note">
            Tab switches: <strong>{tabSwitchCount}</strong>
          </div>
          <div className="hx-rail-note">
            Total warnings:{" "}
            <strong>{getTotalWarningCount(answerMeta)}</strong>
          </div>
        </aside>

        {/* CONTENT */}
        <section className="hx-content">
          {loading && (
            <Card>
              <div className="hx-skel-title" />
              <div className="hx-skel-media" />
              <div className="hx-skel-actions" />
            </Card>
          )}
          {!loading && error && (
            <Card>
              <div className="hx-error">{error}</div>
            </Card>
          )}

          {!loading &&
            interview &&
            currentQ &&
            stage !== "done" && (
              <Card>
                <div className="hx-card-head">
                  <div className="hx-question-index">
                    Question {idx + 1} of {total}
                  </div>
                  <div className="hx-chips">
                    <Chip tone="neutral">
                      Time limit: {currentQ.timeLimit}s
                    </Chip>
                    {isRecording && (
                      <Chip tone="danger">
                        <span className="hx-dot" /> Recording
                      </Chip>
                    )}
                  </div>
                </div>

                <div className="hx-question">
                  {currentQ.text}
                </div>

                <div className="hx-progress">
                  <div
                    className="hx-progress-fill"
                    style={{ width: `${pctThisQ}%` }}
                  />
                </div>

                <div className="hx-media">
                  <video
                    ref={videoEl}
                    className="hx-video"
                    playsInline
                    autoPlay={stage === "question"}
                    muted={stage === "question"}
                    controls={stage === "review"}
                    aria-label={
                      stage === "question"
                        ? "Camera preview"
                        : "Review your recording"
                    }
                  />
                  {stage === "question" && (
                    <div className="hx-face-overlay" style={{ pointerEvents: "none" }}>
                      {(faceScanPhase === "discover" ||
                        faceScanPhase === "mini" ||
                        faceScanPhase === "locked") && (
                        <div className={`hx-scan-frame ${faceScanPhase === "locked" ? "locked" : ""}`}>
                          <div className="hx-scan-line" />
                          <div className="hx-scan-text">
                            {faceScanPhase === "locked"
                              ? "Locked ✓"
                              : faceScanPhase === "mini"
                              ? "Checking face…"
                              : "Finding your face…"}
                          </div>
                        </div>
                      )}
                  
                      {faceBox && (
                        <div
                          className={`hx-face-box ${faceStatus.tone}`}
                          style={{
                            left: `${faceBox.l}%`,
                            top: `${faceBox.t}%`,
                            width: `${faceBox.w}%`,
                            height: `${faceBox.h}%`,
                          }}
                        />
                      )}
                  
                      {faceStatus.text && (
                        <div className={`hx-face-status ${faceStatus.tone}`}>
                          {faceStatus.text}
                        </div>
                      )}
                    </div>
                  )}

                  {permError && (
                    <div className="hx-perm">{permError}</div>
                  )}
                  {!isRecording &&
                    !recordingUrl &&
                    stage === "question" && (
                      <div className="hx-play-overlay">
                        <button
                          className="hx-btn"
                          onClick={startRecording}
                        >
                          Start
                        </button>
                      </div>
                    )}
                </div>

                <div
                  className="hx-controls"
                  style={{
                    display: "flex",
                    gap: 8,
                    alignItems: "center",
                  }}
                >
                  <div className="hx-timer">
                    {stage === "question" &&
                      (isRecording ? (
                        <>
                          Time left: <b>{timeLeft}s</b>
                        </>
                      ) : (
                        <>Ready to record</>
                      ))}
                  </div>
                  <div
                    className="hx-actions"
                    style={{ marginLeft: "auto" }}
                  >
                    {stage === "question" && isRecording && (
                      <button
                        className="hx-btn danger"
                        onClick={stopRecording}
                        aria-label="Stop recording (Space)"
                      >
                        Stop
                      </button>
                    )}
                    {stage === "review" && (
                      <>
                        <button
                          className="hx-btn"
                          onClick={uploadAnswer}
                          aria-label="Upload (Enter)"
                        >
                          Looks good — Upload
                        </button>
                        <button
                          className="hx-btn ghost"
                          onClick={async () => {
                            if (recordingUrl)
                              URL.revokeObjectURL(recordingUrl);
                            setRecordedBlob(null);
                            setRecordingUrl("");
                            await ensurePreview();
                            setStage("question");
                          }}
                        >
                          Re-record
                        </button>
                      </>
                    )}
                  </div>
                </div>
              </Card>
            )}

          {stage === "done" && (
            <Card>
              <div className="hx-done">
                🎉 All set! Thanks for completing the interview. 
                <br />
                We shall get back to you shortly!
              </div>
            </Card>
          )}
        </section>
      </main>

      {banners.map((b) => (
        <ProctorBanner
          key={b.id}
          message={b.message}
          onClose={() => removeBanner(b.id)}
        />
      ))}
    </div>
  );
}
