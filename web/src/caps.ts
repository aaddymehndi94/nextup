import type { ClientCaps } from '../../shared/types.ts'

// What this browser can decode, so the server does the least conversion possible.
// MediaSource.isTypeSupported is stricter and more honest than canPlayType ("maybe").

function supported (mime: string): boolean {
  const ms = (window as { MediaSource?: typeof MediaSource }).MediaSource
  if (ms?.isTypeSupported) return ms.isTypeSupported(mime)
  return document.createElement('video').canPlayType(mime) === 'probably'
}

let cached: ClientCaps | undefined

export function detectCaps (): ClientCaps {
  cached ??= {
    h264: supported('video/mp4; codecs="avc1.640028"'),
    hevc: supported('video/mp4; codecs="hvc1.1.6.L120.90"'),
    hevc10: supported('video/mp4; codecs="hvc1.2.4.L153.B0"'),
    av1: supported('video/mp4; codecs="av01.0.08M.08"'),
    vp9: supported('video/mp4; codecs="vp09.00.40.08"'),
    aac: supported('audio/mp4; codecs="mp4a.40.2"'),
    ac3: supported('audio/mp4; codecs="ac-3"'),
    eac3: supported('audio/mp4; codecs="ec-3"'),
    opus: supported('audio/mp4; codecs="opus"'),
    mp3: supported('audio/mpeg'),
    flac: supported('audio/mp4; codecs="flac"'),
  }
  return cached
}
