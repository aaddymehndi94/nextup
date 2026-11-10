// Entry point of the bundled server (build/server/server.mjs), run in an Electron utility process.
import './shutdown-bridge.ts'
import '../../server/index.ts'
