import { describe, expect, it } from 'vitest'
import { formatBitsPerSecond, parseIperfOutput } from './results'

describe('iperf result parser', () => {
  it('extracts summary and intervals from iperf3 JSON', () => {
    const result = parseIperfOutput([
      JSON.stringify({
        start: { test_start: { protocol: 'TCP' } },
        intervals: [{ sum: { start: 0, end: 1, seconds: 1, bytes: 1000, bits_per_second: 8000, retransmits: 1 } }],
        end: {
          sum_received: { seconds: 1, bytes: 1000, bits_per_second: 8000, retransmits: 1 },
          cpu_utilization_percent: { host_total: 2.5 },
        },
      }),
    ])

    expect(result.summary?.protocol).toBe('TCP')
    expect(result.summary?.bitsPerSecond).toBe(8000)
    expect(result.intervals).toHaveLength(1)
    expect(result.intervals[0]?.retransmits).toBe(1)
  })

  it('returns text-only result when JSON is absent', () => {
    const result = parseIperfOutput(['[  5]   0.00-1.00 sec  10 MBytes  80 Mbits/sec'])
    expect(result.summary?.bitsPerSecond).toBe(80000000)
    expect(result.summary?.bytes).toBe(10485760)
    expect(result.intervals).toHaveLength(1)
    expect(result.rawText).toContain('80 Mbits/sec')
  })

  it('extracts TCP retransmits from human iperf3 output', () => {
    const result = parseIperfOutput([
      '[  5]   0.00-1.00   sec  10.0 MBytes  80.0 Mbits/sec    1',
      '[  5]   1.00-2.00   sec  20.0 MBytes   160 Mbits/sec    2',
    ])

    expect(result.summary?.bitsPerSecond).toBe(120000000)
    expect(result.summary?.bytes).toBe(31457280)
    expect(result.summary?.retransmits).toBe(3)
  })

  it('extracts UDP loss and jitter from human iperf3 output', () => {
    const result = parseIperfOutput([
      '[  5]   0.00-1.00   sec  1.25 MBytes  10.5 Mbits/sec  0.039 ms  0/893 (0%)',
    ])

    expect(result.summary?.protocol).toBe('UDP')
    expect(result.summary?.jitterMs).toBe(0.039)
    expect(result.summary?.lostPercent).toBe(0)
  })

  it('extracts intervals from iperf3 JSON stream events', () => {
    const result = parseIperfOutput([
      JSON.stringify({ event: 'start', data: { test_start: { protocol: 'UDP' } } }),
      JSON.stringify({
        event: 'interval',
        data: { sum: { start: 0, end: 1, seconds: 1, bytes: 1250000, bits_per_second: 10000000, jitter_ms: 0.1 } },
      }),
      JSON.stringify({
        event: 'end',
        data: {
          sum: { seconds: 1, bytes: 1250000, bits_per_second: 10000000, jitter_ms: 0.1, lost_percent: 0 },
        },
      }),
    ])

    expect(result.summary?.protocol).toBe('UDP')
    expect(result.summary?.bitsPerSecond).toBe(10000000)
    expect(result.intervals).toHaveLength(1)
    expect(result.intervals[0]?.jitterMs).toBe(0.1)
  })

  it('computes a live summary before the JSON stream end event arrives', () => {
    const result = parseIperfOutput([
      JSON.stringify({ event: 'start', data: { test_start: { protocol: 'TCP' } } }),
      JSON.stringify({
        event: 'interval',
        data: { sum: { start: 0, end: 1, seconds: 1, bytes: 1000, bits_per_second: 8000, retransmits: 1 } },
      }),
      JSON.stringify({
        event: 'interval',
        data: { sum: { start: 1, end: 2, seconds: 1, bytes: 2000, bits_per_second: 16000, retransmits: 2 } },
      }),
    ])

    expect(result.summary?.bitsPerSecond).toBe(12000)
    expect(result.summary?.bytes).toBe(3000)
    expect(result.summary?.retransmits).toBe(3)
  })

  it('formats rates with useful units', () => {
    expect(formatBitsPerSecond(1250000000)).toBe('1.25 Gbit/s')
  })
})
