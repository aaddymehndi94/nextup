import { describe, expect, it } from 'vitest'
import { installFailure, outsideRestriction } from './update-check.ts'

describe('outsideRestriction: starting the installer or the new version from a process that may not gain rights', () => {
  const env = { DISPLAY: ':0', XAUTHORITY: '/run/user/1000/gdm/Xauthority', PATH: '/usr/bin' }

  it('runs the command itself when this process may gain rights', () => {
    expect(outsideRestriction('pkexec', ['dpkg', '-i', '/tmp/a.deb'], { restricted: false, wait: true, env }))
      .toEqual(['pkexec', ['dpkg', '-i', '/tmp/a.deb']])
  })

  it('has systemd start it, waiting for it and passing its output and exit code back, when it may not', () => {
    expect(outsideRestriction('pkexec', ['dpkg', '-i', '/tmp/a.deb'], { restricted: true, wait: true, env }))
      .toEqual(['systemd-run', ['--user', '--collect', '--quiet', '--wait', '--pipe', '--setenv=DISPLAY', '--setenv=XAUTHORITY', 'pkexec', 'dpkg', '-i', '/tmp/a.deb']])
  })

  it('lets a restart run on by itself', () => {
    const [cmd, args] = outsideRestriction('/bin/sh', ['-c', 'x'], { restricted: true, wait: false, env: {} })
    expect([cmd, args]).toEqual(['systemd-run', ['--user', '--collect', '--quiet', '/bin/sh', '-c', 'x']])
  })
})

describe('installFailure: what to tell the person when pkexec stops', () => {
  it('says cancelled when the password prompt was dismissed', () => {
    expect(installFailure(126, 'Error executing command as another user: Request dismissed')).toBe('Installing was cancelled.')
  })

  it("says the password couldn't be asked for, with the reason, when pkexec couldn't ask", () => {
    expect(installFailure(127, 'pkexec must be setuid root\n')).toBe("nexttupp couldn't ask for the computer's password (pkexec must be setuid root).")
  })

  it('says the installer stopped otherwise', () => {
    expect(installFailure(1, 'dpkg: error processing archive\n')).toBe('The installer stopped (1). dpkg: error processing archive')
  })
})
