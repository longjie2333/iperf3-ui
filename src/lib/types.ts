export type RunMode = 'client' | 'server'
export type Protocol = 'tcp' | 'udp' | 'sctp'
export type TransferMode = 'time' | 'bytes' | 'blockcount'
export type DirectionMode = 'normal' | 'reverse' | 'bidir'
export type IpVersion = 'auto' | 'ipv4' | 'ipv6'
export type OutputMode = 'human' | 'json'
export type IssueLevel = 'error' | 'warning' | 'info'
export type OptionGroup =
  | 'general'
  | 'server'
  | 'client'
  | 'protocol'
  | 'transfer'
  | 'network'
  | 'output'
  | 'auth'
  | 'advanced'

export interface IperfConfig {
  mode: RunMode
  host: string
  port: string
  clientPort: string
  customBinaryPath: string
  protocol: Protocol
  direction: DirectionMode
  transferMode: TransferMode
  time: string
  bytes: string
  blockcount: string
  length: string
  bitrate: string
  pacingTimer: string
  fqRate: string
  noFqSocketPacing: boolean
  parallel: string
  window: string
  mss: string
  noDelay: boolean
  ipVersion: IpVersion
  bind: string
  bindDev: string
  tos: string
  dscp: string
  flowlabel: string
  xbind: string
  sctpStreams: string
  zerocopy: boolean
  skipRxCopy: boolean
  omit: string
  title: string
  extraData: string
  congestion: string
  mptcp: boolean
  udpCounters64bit: boolean
  repeatingPayload: boolean
  dontFragment: boolean
  verbose: boolean
  debug: boolean
  format: string
  outputMode: OutputMode
  jsonStreamFullOutput: boolean
  logfile: string
  forceflush: boolean
  timestamps: boolean
  timestampFormat: string
  rcvTimeout: string
  sndTimeout: string
  connectTimeout: string
  getServerOutput: boolean
  daemon: boolean
  oneOff: boolean
  pidfile: string
  idleTimeout: string
  serverMaxDuration: string
  serverBitrateLimit: string
  affinity: string
  username: string
  password: string
  rsaPublicKeyPath: string
  rsaPrivateKeyPath: string
  authorizedUsersPath: string
  timeSkewThreshold: string
  usePkcs1Padding: boolean
  expertMode: boolean
  rawArgs: string
}

export interface OptionSpec {
  id: keyof IperfConfig | 'mode-host'
  group: OptionGroup
  flags: string
  label: string
  value: 'boolean' | 'string' | 'number' | 'select'
  modes: RunMode[] | 'both'
  protocols?: Protocol[] | 'all'
  windowsNote?: string
  description: string
}

export interface ValidationIssue {
  level: IssueLevel
  field: keyof IperfConfig | 'command'
  message: string
}

export interface CommandPreview {
  binary: string
  args: string[]
  preview: string
  issues: ValidationIssue[]
}

export interface SshConfig {
  host: string
  username: string
  password: string
}

export interface BinaryResolution {
  path: string
  source: 'custom' | 'embedded' | 'bundled' | 'path' | 'missing'
  exists: boolean
  version?: string
}

export interface RunSession {
  id: string
  command: CommandPreview
  startedAt: string
  status: 'running' | 'completed' | 'failed' | 'stopped'
}

export interface RunEvent {
  id: string
  sessionId: string
  kind: 'status' | 'stdout' | 'stderr' | 'result' | 'error' | 'exit'
  timestamp: string
  message: string
  payload?: unknown
}

export interface IperfInterval {
  start: number
  end: number
  seconds: number
  bytes: number
  bitsPerSecond: number
  retransmits?: number
  jitterMs?: number
  lostPercent?: number
}

export interface IperfSummary {
  protocol: string
  durationSeconds: number
  bitsPerSecond: number
  bytes: number
  retransmits?: number
  jitterMs?: number
  lostPercent?: number
  cpuHostTotal?: number
  cpuRemoteTotal?: number
}

export interface IperfResult {
  summary?: IperfSummary
  intervals: IperfInterval[]
  rawText: string
  rawJson?: unknown
}

export interface SavedProfile {
  id: string
  name: string
  createdAt: string
  config: IperfConfig
  sshConfig?: SshConfig
}
