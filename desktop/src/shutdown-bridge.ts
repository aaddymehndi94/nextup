// Runs before the server module. Electron's utility process gets no POSIX signal on Windows (kill() there is
// TerminateProcess, which would orphan ffmpeg), so the app asks for shutdown over the parent port instead and
// this replays it as the SIGTERM the server already handles: stop ffmpeg, close torrents and the database.
const port = (process as unknown as { parentPort?: { on (event: 'message', fn: (e: { data: unknown }) => void): void } }).parentPort
port?.on('message', e => {
  if ((e.data as { type?: string } | null)?.type === 'shutdown') process.emit('SIGTERM')
})
export {}
