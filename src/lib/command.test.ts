import { describe, expect, it } from 'vitest'
import { buildCommandPreview, buildIperfArgs, DEFAULT_CONFIG, splitRawArgs, validateConfig } from './command'
import type { IperfConfig } from './types'

function config(overrides: Partial<IperfConfig>): IperfConfig {
  return { ...DEFAULT_CONFIG, ...overrides }
}

describe('iperf command builder', () => {
  it('builds a TCP client command with human output by default', () => {
    const args = buildIperfArgs(config({ host: '10.0.0.10', time: '5', parallel: '4' }))
    expect(args).toEqual(['-c', '10.0.0.10', '-p', '5201', '-f', 'm', '--forceflush', '-t', '5', '-P', '4'])
  })

  it('builds JSON output only when explicitly selected', () => {
    const args = buildIperfArgs(config({ outputMode: 'json' }))
    expect(args).toContain('-J')
  })

  it('builds UDP reverse tests with bandwidth and 64-bit counters', () => {
    const args = buildIperfArgs(
      config({
        protocol: 'udp',
        direction: 'reverse',
        bitrate: '100M',
        udpCounters64bit: true,
      }),
    )
    expect(args).toContain('-u')
    expect(args).toContain('-R')
    expect(args).toContain('--udp-counters-64bit')
    expect(args).toContain('100M')
  })

  it('builds server auth options', () => {
    const args = buildIperfArgs(
      config({
        mode: 'server',
        oneOff: true,
        rsaPrivateKeyPath: 'C:\\keys\\private.pem',
        authorizedUsersPath: 'C:\\keys\\users.csv',
      }),
    )
    expect(args).toContain('-s')
    expect(args).toContain('-1')
    expect(args).toContain('--rsa-private-key-path')
    expect(args).toContain('--authorized-users-path')
  })

  it('validates client host and port ranges', () => {
    const issues = validateConfig(config({ host: '', port: '70000' }))
    expect(issues.some((issue) => issue.field === 'host' && issue.level === 'error')).toBe(true)
    expect(issues.some((issue) => issue.field === 'port' && issue.level === 'error')).toBe(true)
  })

  it('does not leak server-only options into client commands', () => {
    const args = buildIperfArgs(config({ pidfile: 'C:\\tmp\\iperf.pid', idleTimeout: '60' }))
    expect(args).not.toContain('-I')
    expect(args).not.toContain('--idle-timeout')
  })

  it('ignores hidden client values while validating server mode', () => {
    const issues = validateConfig(
      config({
        mode: 'server',
        host: '',
        clientPort: 'not-a-port',
        time: 'not-a-number',
      }),
    )
    expect(issues.some((issue) => ['host', 'clientPort', 'time'].includes(String(issue.field)))).toBe(false)
  })

  it('filters protocol-specific stale values from command output', () => {
    const args = buildIperfArgs(
      config({
        protocol: 'udp',
        mptcp: true,
        congestion: 'bbr',
        mss: '1400',
        noDelay: true,
        xbind: '10.0.0.1',
        sctpStreams: '4',
        udpCounters64bit: true,
      }),
    )
    expect(args).toContain('--udp-counters-64bit')
    expect(args).not.toContain('-m')
    expect(args).not.toContain('-C')
    expect(args).not.toContain('-M')
    expect(args).not.toContain('-N')
    expect(args).not.toContain('-X')
    expect(args).not.toContain('--nstreams')
  })

  it('keeps command preview shell-safe by quoting arguments', () => {
    const preview = buildCommandPreview(config({ title: 'lab run & check' }), 'C:\\Program Files\\iperf3\\iperf3.exe')
    expect(preview.preview).toContain('"C:\\Program Files\\iperf3\\iperf3.exe"')
    expect(preview.preview).toContain('"lab run & check"')
  })

  it('splits raw args without invoking a shell', () => {
    expect(splitRawArgs('--extra-data "rack a" --forceflush')).toEqual(['--extra-data', 'rack a', '--forceflush'])
  })
})
