import { describe, expect, it } from 'vitest'
import { allowScript, checkFirewall, checkScript, encodeCommand, letPhonesIn, verdict, type FirewallInfo } from './firewall.ts'

const EXE = 'C:\\Users\\Sam O\'Neil\\AppData\\Local\\Programs\\nexttupp\\nexttupp.exe'
const info = (over: Partial<FirewallInfo>): FirewallInfo => ({ category: 'Private', enabled: 'True', inbound: 'NotConfigured', rules: [], ...over })

describe('is Windows Firewall letting phones in?', () => {
  it('a home Wi-Fi Windows calls Public, where the first-run prompt only allowed Private: blocked', () => {
    // What Windows' "allow access" prompt leaves with its defaults: an allow for Private, a block for Public.
    const rules = [{ action: 'Allow', profile: 'Private', enabled: 'True' }, { action: 'Block', profile: 'Public', enabled: 'True' }]
    expect(verdict(info({ category: 'Public', rules }))).toBe('blocked')
    expect(verdict(info({ category: 'Private', rules }))).toBe('open')
  })

  it('the prompt dismissed: block rules everywhere, and a block beats any allow', () => {
    expect(verdict(info({ rules: [{ action: 'Allow', profile: 'Any', enabled: 'True' }, { action: 'Block', profile: 'Private, Public', enabled: 'True' }] }))).toBe('blocked')
  })

  it('no rule for nexttupp at all: Windows blocks by default', () => {
    expect(verdict(info({ rules: [] }))).toBe('blocked')
    expect(verdict(info({ rules: [], inbound: 'Allow' }))).toBe('open')
  })

  it('our own rule, or the firewall off on this network: open', () => {
    expect(verdict(info({ category: 'Public', rules: [{ action: 'Allow', profile: 'Any', enabled: 'True' }] }))).toBe('open')
    expect(verdict(info({ category: 'Public', enabled: 'False' }))).toBe('open')
  })

  it('ignores disabled rules, and reads a work network as the Domain profile', () => {
    expect(verdict(info({ rules: [{ action: 'Block', profile: 'Private', enabled: 'False' }, { action: 'Allow', profile: 'Private', enabled: 'True' }] }))).toBe('open')
    expect(verdict(info({ category: 'DomainAuthenticated', rules: [{ action: 'Allow', profile: 'Domain', enabled: 'True' }] }))).toBe('open')
  })
})

describe('the PowerShell it runs', () => {
  it('names nexttupp by its own path, quoted, and the network it listens on', () => {
    const s = checkScript(EXE, 'Wi-Fi')
    expect(s).toContain("'C:\\Users\\Sam O''Neil\\AppData\\Local\\Programs\\nexttupp\\nexttupp.exe'")
    expect(s).toContain("-InterfaceAlias 'Wi-Fi'")
    expect(s).toMatch(/ConvertTo-Json/)
  })

  it('letting phones in removes the blocks on nexttupp and allows TCP from the home network only', () => {
    const s = allowScript(EXE)
    expect(s).toMatch(/Where-Object \{ \$_\.Direction -eq 'Inbound' -and \$_\.Action -eq 'Block' \} \| Remove-NetFirewallRule/)
    expect(s).toMatch(/New-NetFirewallRule .*-Direction Inbound -Action Allow -Program \$exe -Protocol TCP -Profile Any -RemoteAddress LocalSubnet/)
  })

  it('passes scripts encoded, so no path can break the quoting', () => {
    expect(Buffer.from(encodeCommand("Write-Output 'x'"), 'base64').toString('utf16le')).toBe("Write-Output 'x'")
  })
})

describe('checking and fixing', () => {
  const answer = (out: FirewallInfo) => async () => ({ code: 0, stdout: JSON.stringify({ ...out, rules: out.rules.length === 1 ? out.rules[0] : out.rules }) })

  it('only on Windows', async () => {
    let ran = false
    expect(await checkFirewall({ exe: EXE, alias: 'Wi-Fi', platform: 'linux', run: async () => { ran = true; return { code: 0, stdout: '' } } })).toBe('n/a')
    expect(ran).toBe(false)
  })

  it('reads PowerShell’s answer, a single rule included (it prints one object, not a list)', async () => {
    expect(await checkFirewall({ exe: EXE, alias: 'Wi-Fi', platform: 'win32', run: answer(info({ category: 'Public', rules: [{ action: 'Allow', profile: 'Any', enabled: 'True' }] })) })).toBe('open')
    expect(await checkFirewall({ exe: EXE, alias: 'Wi-Fi', platform: 'win32', run: async () => ({ code: 1, stdout: '' }) })).toBe('unknown')
    expect(await checkFirewall({ exe: EXE, alias: 'Wi-Fi', platform: 'win32', run: async () => { throw new Error('no powershell') } })).toBe('unknown')
  })

  it('asks Windows for permission (UAC) to change the firewall, then checks again', async () => {
    const calls: string[][] = []
    let fixed = false
    const run = async (args: string[]) => {
      calls.push(args)
      if (args.join(' ').includes('RunAs')) { fixed = true; return { code: 0, stdout: '' } }
      return { code: 0, stdout: JSON.stringify(info(fixed ? { rules: [{ action: 'Allow', profile: 'Any', enabled: 'True' }] } : {})) }
    }
    expect(await letPhonesIn({ exe: EXE, alias: 'Wi-Fi', platform: 'win32', run })).toBe('open')
    const elevated = calls.find(a => a.join(' ').includes('RunAs'))!.join(' ')
    expect(elevated).toMatch(/Start-Process -FilePath powershell\.exe -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList '-NoProfile','-NonInteractive','-EncodedCommand','[A-Za-z0-9+/=]+'/)
  })

  it('someone saying No to Windows’ prompt leaves it blocked, and says so', async () => {
    const run = async (args: string[]) => args.join(' ').includes('RunAs') ? { code: 1, stdout: '' } : { code: 0, stdout: JSON.stringify(info({})) }
    expect(await letPhonesIn({ exe: EXE, alias: 'Wi-Fi', platform: 'win32', run })).toBe('declined')
  })
})
