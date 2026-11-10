// The app is TCP-only (docs/adr/0001), so WebRTC's native libdatachannel is left out of the bundle.
// With these undefined, simple-peer reports no WebRTC support and WebTorrent skips WebSocket trackers.
export const RTCPeerConnection = undefined
export const RTCSessionDescription = undefined
export const RTCIceCandidate = undefined
export default {}
