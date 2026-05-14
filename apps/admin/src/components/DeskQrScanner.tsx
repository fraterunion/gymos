"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";

import type { Html5Qrcode } from "html5-qrcode";

export type DeskQrScanResult = { success: boolean };

type DeskQrScannerProps = {
  /** When false, start is disabled (e.g. no studio). */
  enabled: boolean;
  /** Submit decoded payload; return `{ success: true }` only after API accepted check-in. Do not log the token. */
  onScan: (token: string) => Promise<DeskQrScanResult>;
};

function mapCameraStartError(err: unknown): string {
  const name = err && typeof err === "object" && "name" in err ? String((err as { name?: string }).name) : "";
  const message = err instanceof Error ? err.message : String(err);
  const combined = `${name} ${message}`.toLowerCase();
  if (combined.includes("notallowed") || combined.includes("permission denied")) {
    return "Camera access was denied. Allow the camera for this site in your browser settings, or use paste below.";
  }
  if (combined.includes("notfound") || combined.includes("no camera")) {
    return "No usable camera was found on this device. Use paste below or try another device.";
  }
  if (combined.includes("notreadable") || combined.includes("in use")) {
    return "The camera is in use or unavailable. Close other apps using the camera and try again.";
  }
  return "Could not start the camera. Use paste below or try again.";
}

const SUCCESS_COOLDOWN_MS = 1600;
const SAME_FRAME_DEBOUNCE_MS = 700;

export function DeskQrScanner({ enabled, onScan }: DeskQrScannerProps) {
  const reactId = useId().replace(/:/g, "");
  const containerId = `desk-qr-${reactId}`;
  const scannerRef = useRef<Html5Qrcode | null>(null);
  const processingRef = useRef(false);
  const cooldownUntilRef = useRef(0);
  const lastDecodeRef = useRef<{ text: string; at: number }>({ text: "", at: 0 });
  const onScanRef = useRef(onScan);

  useEffect(() => {
    onScanRef.current = onScan;
  }, [onScan]);

  const [running, setRunning] = useState(false);
  const [starting, setStarting] = useState(false);
  const [scanPhase, setScanPhase] = useState<"idle" | "reading" | "cooldown">("idle");
  const [cameraError, setCameraError] = useState<string | null>(null);

  const stopScanner = useCallback(async () => {
    const instance = scannerRef.current;
    scannerRef.current = null;
    if (!instance) {
      setRunning(false);
      setScanPhase("idle");
      return;
    }
    try {
      await instance.stop();
    } catch {
      /* already stopped */
    }
    try {
      instance.clear();
    } catch {
      /* */
    }
    setRunning(false);
    setScanPhase("idle");
  }, []);

  const processDecode = useCallback(
    async (raw: string) => {
      const token = raw.trim();
      if (!token) return;

      const now = Date.now();
      if (processingRef.current) return;
      if (now < cooldownUntilRef.current) return;
      if (token === lastDecodeRef.current.text && now - lastDecodeRef.current.at < SAME_FRAME_DEBOUNCE_MS) {
        return;
      }
      lastDecodeRef.current = { text: token, at: now };

      const instance = scannerRef.current;
      if (!instance?.isScanning) return;

      processingRef.current = true;
      setScanPhase("reading");
      try {
        try {
          instance.pause(true);
        } catch {
          /* pause is best-effort */
        }

        let success = false;
        try {
          success = (await onScanRef.current(token)).success;
        } catch {
          success = false;
        }
        if (success) {
          cooldownUntilRef.current = Date.now() + SUCCESS_COOLDOWN_MS;
          setScanPhase("cooldown");
          await new Promise((r) => setTimeout(r, SUCCESS_COOLDOWN_MS));
          setScanPhase("idle");
        } else {
          lastDecodeRef.current = { text: "", at: 0 };
          setScanPhase("idle");
        }
      } finally {
        processingRef.current = false;
        const live = scannerRef.current;
        if (live?.isScanning) {
          try {
            live.resume();
          } catch {
            /* */
          }
        }
      }
    },
    [],
  );

  const startScanner = useCallback(async () => {
    if (!enabled || starting || running) return;
    setCameraError(null);
    setStarting(true);
    try {
      const { Html5Qrcode } = await import("html5-qrcode");
      const instance = new Html5Qrcode(containerId, { verbose: false });
      scannerRef.current = instance;

      await instance.start(
        { facingMode: "environment" },
        {
          fps: 8,
          qrbox: (viewfinderWidth, viewfinderHeight) => {
            const edge = Math.min(viewfinderWidth, viewfinderHeight);
            const size = Math.min(280, Math.max(160, Math.floor(edge * 0.68)));
            return { width: size, height: size };
          },
          aspectRatio: 1,
        },
        (decodedText) => {
          void processDecode(decodedText);
        },
        () => {
          /* frame decode noise — intentionally silent */
        },
      );

      setRunning(true);
      setScanPhase("idle");
    } catch (err) {
      await stopScanner();
      setCameraError(mapCameraStartError(err));
    } finally {
      setStarting(false);
    }
  }, [containerId, enabled, processDecode, running, starting, stopScanner]);

  useEffect(() => {
    return () => {
      void stopScanner();
    };
  }, [stopScanner]);

  useEffect(() => {
    if (!enabled) {
      void stopScanner();
    }
  }, [enabled, stopScanner]);

  const scanningLabel =
    scanPhase === "reading" ? "Reading code…" : scanPhase === "cooldown" ? "Ready for next member…" : "Scanning…";

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span
            className={`h-2 w-2 rounded-full ${
              running && scanPhase === "idle" ? "animate-pulse bg-emerald-400" : running ? "bg-amber-400" : "bg-zinc-600"
            }`}
            aria-hidden
          />
          <span className="text-xs font-medium uppercase tracking-wide text-zinc-400">
            {running ? scanningLabel : "Camera off"}
          </span>
        </div>
        <div className="flex gap-2">
          {!running ? (
            <button
              type="button"
              disabled={!enabled || starting}
              onClick={() => void startScanner()}
              className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white shadow-sm hover:bg-emerald-500 disabled:opacity-50 dark:bg-emerald-500 dark:hover:bg-emerald-400"
            >
              {starting ? "Starting…" : "Start camera"}
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void stopScanner()}
              className="rounded-lg border border-zinc-600 bg-zinc-800 px-3 py-1.5 text-xs font-semibold text-zinc-100 hover:bg-zinc-700 dark:border-zinc-600 dark:bg-zinc-900 dark:hover:bg-zinc-800"
            >
              Stop camera
            </button>
          )}
        </div>
      </div>

      <div
        className="relative overflow-hidden rounded-xl border border-zinc-700 bg-zinc-950 shadow-inner dark:border-zinc-600"
        style={{ minHeight: 220 }}
      >
        <div id={containerId} className="min-h-[220px] w-full [&_video]:rounded-xl" />
        {!running && !starting ? (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-zinc-950/80">
            <p className="px-4 text-center text-xs text-zinc-500">Camera preview appears when you start scanning</p>
          </div>
        ) : null}
      </div>

      {cameraError ? (
        <div className="rounded-lg border border-amber-900/50 bg-amber-950/40 px-3 py-2 text-xs text-amber-100">{cameraError}</div>
      ) : null}

      <p className="text-xs text-zinc-500 dark:text-zinc-400">
        Point the member&apos;s QR at the frame. Codes are sent securely and are not shown on screen after scan.
      </p>
    </div>
  );
}
