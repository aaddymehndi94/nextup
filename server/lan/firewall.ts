import { spawn } from 'node:child_process'

// Windows Firewall and phones. When nexttupp first listens on the home address, Windows asks whether to allow it,
// ticking only "Private networks". Windows 11 calls a newly joined Wi-Fi "Public", and a dismissed prompt leaves
// block rules, so a phone's connection is dropped without a word and the phone waits forever. A web page can't fix
// that; this computer can, with the person's OK (UAC). See docs/adr/0006-watch-at-home.md.

export type FirewallState = 'open' | 'blocked' | 'unknown' | 'n/a'

/** What checkScript prints. Every value is PowerShell's own name for it, as a string. */
export interface FirewallInfo {
  /** The network's profile: Public, Private or DomainAuthenticated. */
  category: string
  /** Whether the firewall is on for that profile: "True" or "False". */
  enabled: string
  /** That profile's default for incoming connections: NotConfigured (= Block), Block or Allow. */
  inbound: string
  /** Inbound rules for nexttupp's program. */
  rules: Array<{ action: string; profile: string; enabled: string }>
}

export type Run = (args: string[], timeoutMs?: number) => Promise<{ code: number; stdout: string }>

const quote = (s: string) => `'${s.replace(/'/g, "''")}'`

export function checkScript (exe: string, alias: string | null): string {
  return [
    "$ErrorActionPreference = 'SilentlyContinue'",
    `$exe = ${quote(exe)}`,
    alias ? `$net = Get-NetConnectionProfile -InterfaceAlias ${quote(alias)} | Select-Object -First 1` : '$net = $null',
    'if (-not $net) { $net = Get-NetConnectionProfile | Select-Object -First 1 }',
    '$cat = "$($net.NetworkCategory)"',
    "$fw = Get-NetFirewallProfile -Name ($cat -replace 'DomainAuthenticated', 'Domain')",
    '$rules = @(Get-NetFirewallApplicationFilter -Program $exe | Get-NetFirewallRule | Where-Object { $_.Direction -eq \'Inbound\' } |',
    '  ForEach-Object { [pscustomobject]@{ action = "$($_.Action)"; profile = "$($_.Profile)"; enabled = "$($_.Enabled)" } })',
    '[pscustomobject]@{ category = $cat; enabled = "$($fw.Enabled)"; inbound = "$($fw.DefaultInboundAction)"; rules = $rules } | ConvertTo-Json -Compress -Depth 3',
  ].join('\n')
}

/** Lifts the blocks on nexttupp and lets in TCP from the home network only (LocalSubnet), on any profile. */
export function allowScript (exe: string): string {
  return [
    `$exe = ${quote(exe)}`,
    "Get-NetFirewallApplicationFilter -Program $exe -ErrorAction SilentlyContinue | Get-NetFirewallRule | Where-Object { $_.Direction -eq 'Inbound' -and $_.Action -eq 'Block' } | Remove-NetFirewallRule",
    "New-NetFirewallRule -DisplayName 'nexttupp: phones and TVs at home' -Direction Inbound -Action Allow -Program $exe -Protocol TCP -Profile Any -RemoteAddress LocalSubnet | Out-Null",
  ].join('\n')
}

/** PowerShell's -EncodedCommand: UTF-16LE in base64. */
export const encodeCommand = (script: string) => Buffer.from(script, 'utf16le').toString('base64')

const applies = (profile: string, category: string) => {
  const p = profile.split(',').map(s => s.trim())
  return p.includes('Any') || p.includes(category === 'DomainAuthenticated' ? 'Domain' : category)
}

export function verdict (i: FirewallInfo): FirewallState {
  if (i.enabled === 'False') return 'open'
  const rules = i.rules.filter(r => r.enabled === 'True' && applies(r.profile, i.category))
  if (rules.some(r => r.action === 'Block')) return 'blocked'
  if (rules.some(r => r.action === 'Allow')) return 'open'
  return i.inbound === 'Allow' ? 'open' : 'blocked'
}

const powershell: Run = (args, timeoutMs = 20_000) => new Promise((resolve, reject) => {
  const p = spawn('powershell.exe', args, { windowsHide: true, timeout: timeoutMs })
  let stdout = ''
  p.stdout.on('data', d => { stdout += d })
  p.on('error', reject)
  p.on('close', code => resolve({ code: code ?? 1, stdout }))
})

interface Opts { exe: string; alias: string | null; platform?: string; run?: Run }
const BASE = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass']

export async function checkFirewall ({ exe, alias, platform = process.platform, run = powershell }: Opts): Promise<FirewallState> {
  if (platform !== 'win32') return 'n/a'
  try {
    const r = await run([...BASE, '-EncodedCommand', encodeCommand(checkScript(exe, alias))])
    if (r.code !== 0) return 'unknown'
    const o = JSON.parse(r.stdout.trim())
    // ConvertTo-Json prints a one-item array as the item itself.
    const rules = Array.isArray(o.rules) ? o.rules : o.rules ? [o.rules] : []
    return verdict({ category: String(o.category), enabled: String(o.enabled), inbound: String(o.inbound), rules })
  } catch { return 'unknown' }
}

/**
 * Asks Windows (UAC) to let phones in, then checks again. 'declined' when the person said No. Waits up to two
 * minutes for them to answer the prompt.
 */
export async function letPhonesIn (opts: Opts): Promise<FirewallState | 'declined'> {
  const { platform = process.platform, run = powershell } = opts
  if (platform !== 'win32') return 'n/a'
  const inner = ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodeCommand(allowScript(opts.exe))].map(a => `'${a}'`).join(',')
  try {
    const r = await run([...BASE, '-Command', `Start-Process -FilePath powershell.exe -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList ${inner}`], 120_000)
    if (r.code !== 0) return 'declined'
  } catch { return 'unknown' }
  return checkFirewall(opts)
}
