// Errors every handler can throw. No Worker types here, so the validators (validate.ts, wire.ts) also run
// in plain Node: the local nexttupp server imports them to check rows before it pushes them.

export class HttpError extends Error {
  readonly status: number
  readonly code: string
  readonly headers: Record<string, string>
  constructor (status: number, code: string, message: string, headers: Record<string, string> = {}) {
    super(message)
    this.status = status
    this.code = code
    this.headers = headers
  }
}

export const bad = (message: string) => new HttpError(400, 'invalid', message)
