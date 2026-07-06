import type { IperfInterval, IperfResult, IperfSummary } from './types'

type JsonRecord = Record<string, unknown>
export type RateUnit = 'auto' | 'bit/s' | 'Kbit/s' | 'Mbit/s' | 'Gbit/s' | 'Tbit/s'
export type ByteUnit = 'auto' | 'B' | 'KiB' | 'MiB' | 'GiB' | 'TiB'

const RATE_UNIT_FACTORS: Record<Exclude<RateUnit, 'auto'>, number> = {
  'bit/s': 1,
  'Kbit/s': 1_000,
  'Mbit/s': 1_000_000,
  'Gbit/s': 1_000_000_000,
  'Tbit/s': 1_000_000_000_000,
}

const BYTE_UNIT_FACTORS: Record<Exclude<ByteUnit, 'auto'>, number> = {
  B: 1,
  KiB: 1024,
  MiB: 1024 ** 2,
  GiB: 1024 ** 3,
  TiB: 1024 ** 4,
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function numberFrom(value: unknown, fallback = 0) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function numberFromText(value: string) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function recordFrom(value: unknown): JsonRecord {
  return isRecord(value) ? value : {}
}

function arrayFrom(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function pickSummary(end: JsonRecord): JsonRecord {
  const candidates = [
    end.sum,
    end.sum_received,
    end.sum_sent,
    end.sum_bidir_reverse,
    end.sum_bidir,
  ]
  return recordFrom(candidates.find(isRecord))
}

function parseJsonFromText(rawText: string): unknown | undefined {
  const start = rawText.indexOf('{')
  const end = rawText.lastIndexOf('}')
  if (start < 0 || end <= start) return undefined
  try {
    return JSON.parse(rawText.slice(start, end + 1))
  } catch {
    return undefined
  }
}

function parseJsonStreamFromText(rawText: string): JsonRecord | undefined {
  const root: JsonRecord = { intervals: [] }
  let parsedAny = false

  for (const line of rawText.split(/\r?\n/)) {
    const clean = line.trim()
    if (!clean.startsWith('{') || !clean.endsWith('}')) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(clean)
    } catch {
      continue
    }
    if (!isRecord(parsed)) continue

    parsedAny = true
    const event = typeof parsed.event === 'string' ? parsed.event : ''
    const data = recordFrom(parsed.data)

    if (event === 'start') {
      root.start = data
    } else if (event === 'interval') {
      arrayFrom(root.intervals).push(data)
    } else if (event === 'end') {
      root.end = data
    } else if (isRecord(parsed.start) || isRecord(parsed.end) || Array.isArray(parsed.intervals)) {
      return parsed
    } else if (isRecord(parsed.sum)) {
      arrayFrom(root.intervals).push(parsed)
    }
  }

  return parsedAny ? root : undefined
}

function intervalFromJson(interval: JsonRecord): IperfInterval {
  const sum = recordFrom(interval.sum)
  return {
    start: numberFrom(sum.start),
    end: numberFrom(sum.end),
    seconds: numberFrom(sum.seconds),
    bytes: numberFrom(sum.bytes),
    bitsPerSecond: numberFrom(sum.bits_per_second),
    retransmits: typeof sum.retransmits === 'number' ? sum.retransmits : undefined,
    jitterMs: typeof sum.jitter_ms === 'number' ? sum.jitter_ms : undefined,
    lostPercent: typeof sum.lost_percent === 'number' ? sum.lost_percent : undefined,
  }
}

function protocolFromRoot(root: JsonRecord) {
  const start = recordFrom(root.start)
  const testStart = recordFrom(start.test_start)
  return String(testStart.protocol ?? 'unknown').toUpperCase()
}

function summaryFromJson(root: JsonRecord): IperfSummary | undefined {
  const end = recordFrom(root.end)
  const sum = pickSummary(end)
  if (!Object.keys(sum).length) return undefined
  const cpu = recordFrom(end.cpu_utilization_percent)

  return {
    protocol: protocolFromRoot(root),
    durationSeconds: numberFrom(sum.seconds),
    bitsPerSecond: numberFrom(sum.bits_per_second),
    bytes: numberFrom(sum.bytes),
    retransmits: typeof sum.retransmits === 'number' ? sum.retransmits : undefined,
    jitterMs: typeof sum.jitter_ms === 'number' ? sum.jitter_ms : undefined,
    lostPercent: typeof sum.lost_percent === 'number' ? sum.lost_percent : undefined,
    cpuHostTotal: typeof cpu.host_total === 'number' ? cpu.host_total : undefined,
    cpuRemoteTotal: typeof cpu.remote_total === 'number' ? cpu.remote_total : undefined,
  }
}

function liveSummaryFromIntervals(root: JsonRecord, intervals: IperfInterval[]): IperfSummary | undefined {
  if (!intervals.length) return undefined
  const durationSeconds = intervals.reduce((total, interval) => total + interval.seconds, 0)
  const bytes = intervals.reduce((total, interval) => total + interval.bytes, 0)
  const weightedBits = intervals.reduce(
    (total, interval) => total + interval.bitsPerSecond * Math.max(interval.seconds, 0),
    0,
  )
  const hasRetransmits = intervals.some((interval) => interval.retransmits !== undefined)
  const retransmits = intervals.reduce((total, interval) => total + (interval.retransmits ?? 0), 0)
  let latestJitter: number | undefined
  let latestLoss: number | undefined
  for (const interval of intervals) {
    if (interval.jitterMs !== undefined) latestJitter = interval.jitterMs
    if (interval.lostPercent !== undefined) latestLoss = interval.lostPercent
  }
  const latestInterval = intervals[intervals.length - 1]

  return {
    protocol: protocolFromRoot(root),
    durationSeconds,
    bitsPerSecond: durationSeconds > 0 ? weightedBits / durationSeconds : latestInterval?.bitsPerSecond ?? 0,
    bytes,
    retransmits: hasRetransmits ? retransmits : undefined,
    jitterMs: latestJitter,
    lostPercent: latestLoss,
  }
}

function bytesFromHuman(value: string, unit: string) {
  const factors: Record<string, number> = {
    byte: 1,
    bytes: 1,
    kbyte: 1024,
    kbytes: 1024,
    mbyte: 1024 ** 2,
    mbytes: 1024 ** 2,
    gbyte: 1024 ** 3,
    gbytes: 1024 ** 3,
    tbyte: 1024 ** 4,
    tbytes: 1024 ** 4,
  }
  return numberFromText(value) * (factors[unit.toLowerCase()] ?? 1)
}

function bitsPerSecondFromHuman(value: string, unit: string) {
  const normalized = unit.toLowerCase()
  const unitName = normalized.replace('/sec', '')
  const isByteRate = unitName.includes('byte')
  const factors: Record<string, number> = {
    bit: 1,
    bits: 1,
    kbit: 1_000,
    kbits: 1_000,
    mbit: 1_000_000,
    mbits: 1_000_000,
    gbit: 1_000_000_000,
    gbits: 1_000_000_000,
    tbit: 1_000_000_000_000,
    tbits: 1_000_000_000_000,
    byte: 8,
    bytes: 8,
    kbyte: 8_000,
    kbytes: 8_000,
    mbyte: 8_000_000,
    mbytes: 8_000_000,
    gbyte: 8_000_000_000,
    gbytes: 8_000_000_000,
    tbyte: 8_000_000_000_000,
    tbytes: 8_000_000_000_000,
  }
  return numberFromText(value) * (factors[unitName] ?? (isByteRate ? 8 : 1))
}

interface TextSample extends IperfInterval {
  isSummary: boolean
  isSum: boolean
  protocol: string
}

const HUMAN_LINE_PATTERN =
  /^\[\s*(SUM|[^\]]+)\]\s+(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)\s+sec\s+(\d+(?:\.\d+)?)\s+([KMGT]?Bytes?)\s+(\d+(?:\.\d+)?)\s+([KMGT]?(?:bits|Bytes)\/sec)(.*)$/i

function parseHumanLine(line: string): TextSample | undefined {
  const match = line.match(HUMAN_LINE_PATTERN)
  if (!match) return undefined

  const tail = match[8] ?? ''
  const jitter = tail.match(/(\d+(?:\.\d+)?)\s+ms/i)
  const loss = tail.match(/\((\d+(?:\.\d+)?)%\)/)
  const firstTailToken = tail.trim().split(/\s+/)[0] ?? ''
  const retransmits = /^\d+$/.test(firstTailToken) && !jitter ? Number(firstTailToken) : undefined

  return {
    start: numberFromText(match[2]),
    end: numberFromText(match[3]),
    seconds: Math.max(0, numberFromText(match[3]) - numberFromText(match[2])),
    bytes: bytesFromHuman(match[4], match[5]),
    bitsPerSecond: bitsPerSecondFromHuman(match[6], match[7]),
    retransmits,
    jitterMs: jitter ? numberFromText(jitter[1]) : undefined,
    lostPercent: loss ? numberFromText(loss[1]) : undefined,
    isSummary: /\b(sender|receiver)\b/i.test(tail),
    isSum: match[1].trim().toUpperCase() === 'SUM',
    protocol: jitter || loss ? 'UDP' : 'TCP',
  }
}

function summaryFromText(sample: TextSample): IperfSummary {
  return {
    protocol: sample.protocol,
    durationSeconds: Math.max(sample.seconds, sample.end - sample.start),
    bitsPerSecond: sample.bitsPerSecond,
    bytes: sample.bytes,
    retransmits: sample.retransmits,
    jitterMs: sample.jitterMs,
    lostPercent: sample.lostPercent,
  }
}

function parseHumanOutput(rawText: string): IperfResult | undefined {
  const samples = rawText
    .split(/\r?\n/)
    .map(parseHumanLine)
    .filter((sample): sample is TextSample => Boolean(sample))

  if (!samples.length) return undefined

  const intervalCandidates = samples.filter((sample) => !sample.isSummary)
  const hasSumIntervals = intervalCandidates.some((sample) => sample.isSum)
  const intervals = intervalCandidates
    .filter((sample) => !hasSumIntervals || sample.isSum)
    .map((sample) => ({
      start: sample.start,
      end: sample.end,
      seconds: sample.seconds,
      bytes: sample.bytes,
      bitsPerSecond: sample.bitsPerSecond,
      retransmits: sample.retransmits,
      jitterMs: sample.jitterMs,
      lostPercent: sample.lostPercent,
    }))

  const summaryCandidates = samples.filter((sample) => sample.isSummary)
  const hasSumSummaries = summaryCandidates.some((sample) => sample.isSum)
  const scopedSummaries = summaryCandidates.filter((sample) => !hasSumSummaries || sample.isSum)
  const summarySample =
    scopedSummaries.findLast((sample) => sample.retransmits !== undefined || sample.jitterMs !== undefined) ??
    scopedSummaries.at(-1)
  const protocol = samples.find((sample) => sample.protocol === 'UDP') ? 'UDP' : 'TCP'
  const summary =
    (summarySample && summaryFromText(summarySample)) ??
    liveSummaryFromIntervals({ start: { test_start: { protocol } } }, intervals)

  return {
    summary,
    intervals,
    rawText,
  }
}

export function parseIperfOutput(lines: string[]): IperfResult {
  const rawText = lines.join('\n')
  const rawJson = parseJsonFromText(rawText) ?? parseJsonStreamFromText(rawText)
  if (!isRecord(rawJson)) {
    return parseHumanOutput(rawText) ?? { intervals: [], rawText }
  }

  const intervals = arrayFrom(rawJson.intervals)
    .filter(isRecord)
    .map(intervalFromJson)
    .filter((interval) => interval.end > interval.start || interval.bitsPerSecond > 0)

  return {
    summary: summaryFromJson(rawJson) ?? liveSummaryFromIntervals(rawJson, intervals),
    intervals,
    rawText,
    rawJson,
  }
}

function formatScaled(value: number, unit: string) {
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(2)} ${unit}`
}

export function formatBitsPerSecond(value: number, unit: RateUnit = 'auto') {
  if (!Number.isFinite(value) || value <= 0) return '0 bit/s'
  if (unit !== 'auto') {
    return formatScaled(value / RATE_UNIT_FACTORS[unit], unit)
  }
  const units = ['bit/s', 'Kbit/s', 'Mbit/s', 'Gbit/s', 'Tbit/s']
  let scaled = value
  let unitIndex = 0
  while (scaled >= 1000 && unitIndex < units.length - 1) {
    scaled /= 1000
    unitIndex += 1
  }
  return formatScaled(scaled, units[unitIndex])
}

export function formatBytes(value: number, unit: ByteUnit = 'auto') {
  if (!Number.isFinite(value) || value <= 0) return '0 B'
  if (unit !== 'auto') {
    return formatScaled(value / BYTE_UNIT_FACTORS[unit], unit)
  }
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
  let scaled = value
  let unitIndex = 0
  while (scaled >= 1024 && unitIndex < units.length - 1) {
    scaled /= 1024
    unitIndex += 1
  }
  return formatScaled(scaled, units[unitIndex])
}
