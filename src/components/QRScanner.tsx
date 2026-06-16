// Camera-backed QR scanner used by the linking-flow's `Link from
// iOS` tab. Built on the native `BarcodeDetector` API (Chromium-
// based browsers, including Chrome / Edge / mobile Chrome). Safari
// and Firefox don't ship it as of writing — there we render a
// graceful "not supported" message and expect the user to paste
// the linking blob.
//
// Flow:
//   1. getUserMedia({ video: { facingMode: 'environment' } })
//   2. attach stream to <video>
//   3. on each requestAnimationFrame, ask BarcodeDetector for QR
//      results; first non-empty hit fires `onScan(rawValue)` and
//      stops the loop.
//   4. unmount tears down the stream + cancels the rAF.

import { useEffect, useRef, useState } from 'react'

interface Props {
  onScan: (raw: string) => void
  onError?: (message: string) => void
}

// Type-shim — TS lib doesn't ship `BarcodeDetector` declarations
// across all targets. We narrow at use-site to the methods we
// actually call.
declare global {
  interface Window {
    BarcodeDetector?: {
      new (init?: { formats: string[] }): {
        detect(source: HTMLVideoElement | ImageBitmap): Promise<{ rawValue: string }[]>
      }
      getSupportedFormats?(): Promise<string[]>
    }
  }
}

export function QRScanner({ onScan, onError }: Props) {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const rafRef = useRef<number | null>(null)
  const stoppedRef = useRef(false)
  const [supported, setSupported] = useState<boolean | null>(null)
  const [permissionDenied, setPermissionDenied] = useState(false)

  useEffect(() => {
    let cancelled = false
    const detector = window.BarcodeDetector
      ? new window.BarcodeDetector({ formats: ['qr_code'] })
      : null
    if (!detector) {
      setSupported(false)
      return
    }
    setSupported(true)

    ;(async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' } },
          audio: false,
        })
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop())
          return
        }
        streamRef.current = stream
        const video = videoRef.current
        if (!video) return
        video.srcObject = stream
        await video.play()

        const tick = async () => {
          if (stoppedRef.current) return
          if (!video.videoWidth) {
            rafRef.current = requestAnimationFrame(tick)
            return
          }
          try {
            const results = await detector.detect(video)
            if (results.length > 0 && results[0].rawValue) {
              stoppedRef.current = true
              onScan(results[0].rawValue)
              return
            }
          } catch {
            // detector.detect can throw on shutdown — ignore and
            // let the next frame retry.
          }
          rafRef.current = requestAnimationFrame(tick)
        }
        tick()
      } catch (e: unknown) {
        if (cancelled) return
        const msg = e instanceof Error ? e.message : 'Camera error'
        if (msg.includes('Permission') || msg.includes('NotAllowed')) {
          setPermissionDenied(true)
        }
        onError?.(msg)
      }
    })()

    return () => {
      cancelled = true
      stoppedRef.current = true
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current)
      const stream = streamRef.current
      if (stream) {
        stream.getTracks().forEach((t) => t.stop())
        streamRef.current = null
      }
    }
  }, [onScan, onError])

  if (supported === false) {
    return (
      <div className="text-xs text-fg-secondary bg-surface-dim border border-line rounded-md p-3">
        QR-scanner needs a browser with the BarcodeDetector API
        (Chrome / Edge / mobile Chrome). Safari and Firefox don't
        ship it yet — paste the linking blob instead.
      </div>
    )
  }

  if (permissionDenied) {
    return (
      <div className="text-xs text-fg-secondary bg-surface-dim border border-line rounded-md p-3">
        Camera permission denied. Allow camera access for chat.rcq.app
        in your browser settings, or paste the linking blob instead.
      </div>
    )
  }

  return (
    <div className="relative aspect-square w-full max-w-xs mx-auto bg-black rounded-lg overflow-hidden">
      <video
        ref={videoRef}
        playsInline
        muted
        className="absolute inset-0 w-full h-full object-cover"
      />
      <div className="absolute inset-0 pointer-events-none">
        {/* Targeting reticle — four corners. Helps the user line up
            the QR while moving the device into focus. */}
        <Corner className="top-3 left-3" rotate={0} />
        <Corner className="top-3 right-3" rotate={90} />
        <Corner className="bottom-3 right-3" rotate={180} />
        <Corner className="bottom-3 left-3" rotate={270} />
      </div>
    </div>
  )
}

function Corner({ className, rotate }: { className: string; rotate: number }) {
  return (
    <div
      className={`absolute w-7 h-7 ${className}`}
      style={{ transform: `rotate(${rotate}deg)` }}
    >
      <div className="absolute top-0 left-0 w-7 h-1 bg-accent rounded" />
      <div className="absolute top-0 left-0 w-1 h-7 bg-accent rounded" />
    </div>
  )
}
