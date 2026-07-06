import type {
  CommandPreview,
  IperfConfig,
  IssueLevel,
  ValidationIssue,
} from './types'

export const DEFAULT_CONFIG: IperfConfig = {
  mode: 'client',
  host: '127.0.0.1',
  port: '5201',
  clientPort: '',
  customBinaryPath: '',
  protocol: 'tcp',
  direction: 'normal',
  transferMode: 'time',
  time: '10',
  bytes: '',
  blockcount: '',
  length: '',
  bitrate: '',
  pacingTimer: '',
  fqRate: '',
  noFqSocketPacing: false,
  parallel: '1',
  window: '',
  mss: '',
  noDelay: false,
  ipVersion: 'auto',
  bind: '',
  bindDev: '',
  tos: '',
  dscp: '',
  flowlabel: '',
  xbind: '',
  sctpStreams: '',
  zerocopy: false,
  skipRxCopy: false,
  omit: '',
  title: '',
  extraData: '',
  congestion: '',
  mptcp: false,
  udpCounters64bit: false,
  repeatingPayload: false,
  dontFragment: false,
  verbose: false,
  debug: false,
  format: 'm',
  outputMode: 'human',
  jsonStreamFullOutput: false,
  logfile: '',
  forceflush: true,
  timestamps: false,
  timestampFormat: '',
  rcvTimeout: '',
  sndTimeout: '',
  connectTimeout: '',
  getServerOutput: false,
  daemon: false,
  oneOff: false,
  pidfile: '',
  idleTimeout: '',
  serverMaxDuration: '',
  serverBitrateLimit: '',
  affinity: '',
  username: '',
  password: '',
  rsaPublicKeyPath: '',
  rsaPrivateKeyPath: '',
  authorizedUsersPath: '',
  timeSkewThreshold: '',
  usePkcs1Padding: false,
  expertMode: false,
  rawArgs: '',
}

const SIZE_PATTERN = /^\d+(?:\.\d+)?[kKmMgGtT]?$/
const BITRATE_PATTERN = /^\d+(?:\.\d+)?[kKmMgGtT]?(?:\/\d+)?$/
const INTEGER_PATTERN = /^\d+$/
const NUMBER_PATTERN = /^\d+(?:\.\d+)?$/
const FORMAT_VALUES = new Set(['', 'k', 'm', 'g', 't', 'K', 'M', 'G', 'T'])

function trimmed(value: string) {
  return value.trim()
}

function addIssue(
  issues: ValidationIssue[],
  level: IssueLevel,
  field: ValidationIssue['field'],
  message: string,
) {
  issues.push({ level, field, message })
}

function valueEnabled(value: string) {
  return trimmed(value).length > 0
}

function validateIntegerRange(
  issues: ValidationIssue[],
  config: IperfConfig,
  field: keyof IperfConfig,
  label: string,
  min: number,
  max: number,
) {
  const value = String(config[field])
  if (!valueEnabled(value)) return
  if (!INTEGER_PATTERN.test(trimmed(value))) {
    addIssue(issues, 'error', field, `${label} 必须是整数。`)
    return
  }
  const parsed = Number(trimmed(value))
  if (parsed < min || parsed > max) {
    addIssue(issues, 'error', field, `${label} 必须在 ${min}-${max} 之间。`)
  }
}

function validateNumber(
  issues: ValidationIssue[],
  config: IperfConfig,
  field: keyof IperfConfig,
  label: string,
) {
  const value = String(config[field])
  if (valueEnabled(value) && !NUMBER_PATTERN.test(trimmed(value))) {
    addIssue(issues, 'error', field, `${label} 必须是数字。`)
  }
}

function validateSize(
  issues: ValidationIssue[],
  config: IperfConfig,
  field: keyof IperfConfig,
  label: string,
) {
  const value = String(config[field])
  if (valueEnabled(value) && !SIZE_PATTERN.test(trimmed(value))) {
    addIssue(issues, 'error', field, `${label} 需要形如 128K、10M 或 1G。`)
  }
}

function validateBitrate(
  issues: ValidationIssue[],
  config: IperfConfig,
  field: keyof IperfConfig,
  label: string,
) {
  const value = String(config[field])
  if (valueEnabled(value) && !BITRATE_PATTERN.test(trimmed(value))) {
    addIssue(issues, 'error', field, `${label} 需要形如 10M、1G 或 10M/32。`)
  }
}

export function validateConfig(config: IperfConfig): ValidationIssue[] {
  const issues: ValidationIssue[] = []

  if (config.mode === 'client' && !valueEnabled(config.host)) {
    addIssue(issues, 'error', 'host', '客户端模式必须填写服务端主机。')
  }

  validateIntegerRange(issues, config, 'port', '服务端端口', 1, 65535)
  validateIntegerRange(issues, config, 'rcvTimeout', '接收超时', 1, 2147483647)
  validateIntegerRange(issues, config, 'sndTimeout', '发送超时', 1, 2147483647)

  if (!FORMAT_VALUES.has(config.format)) {
    addIssue(issues, 'error', 'format', '输出单位只能是 k/m/g/t 或 K/M/G/T。')
  }

  if (config.outputMode === 'json') {
    addIssue(
      issues,
      'info',
      'outputMode',
      'JSON -J normally writes the complete result after the test finishes. Use human output for live logs.',
    )
  }

  if (config.mode === 'client') {
    validateIntegerRange(issues, config, 'clientPort', '客户端端口', 1, 65535)
    validateIntegerRange(issues, config, 'parallel', '并发流', 1, 4096)
    validateIntegerRange(issues, config, 'flowlabel', 'IPv6 flow label', 0, 1048575)
    validateIntegerRange(issues, config, 'connectTimeout', '连接超时', 1, 2147483647)
    validateNumber(issues, config, 'omit', '预热忽略')
    validateSize(issues, config, 'length', '缓冲区长度')
    validateSize(issues, config, 'window', '窗口/缓冲区')
    validateBitrate(issues, config, 'bitrate', '目标速率')
    validateBitrate(issues, config, 'pacingTimer', 'Pacing 间隔')
    validateBitrate(issues, config, 'fqRate', 'FQ 速率')

    if (config.transferMode === 'time') {
      validateNumber(issues, config, 'time', '测试时长')
    }
    if (config.transferMode === 'bytes') {
      validateSize(issues, config, 'bytes', '传输字节数')
    }
    if (config.transferMode === 'blockcount') {
      validateSize(issues, config, 'blockcount', '传输块数')
    }

    if (config.protocol !== 'udp') {
      validateIntegerRange(issues, config, 'mss', 'MSS', 1, 65535)
    }

    if (config.protocol === 'sctp') {
      validateIntegerRange(issues, config, 'sctpStreams', 'SCTP streams', 1, 65535)
    }
  }

  if (config.rawArgs.trim() && !config.expertMode) {
    addIssue(issues, 'warning', 'rawArgs', '原始参数只建议在专家模式下使用。')
  }

  if (config.mode === 'client' && config.protocol === 'sctp') {
    addIssue(issues, 'warning', 'protocol', 'SCTP 通常不适用于 Windows 社区版 iperf3。')
  }

  if (config.mode === 'client') {
    const platformSensitiveFields: Array<keyof IperfConfig> = ['flowlabel', 'fqRate']
    if (config.protocol === 'sctp') platformSensitiveFields.push('xbind')
    if (config.protocol === 'tcp') platformSensitiveFields.push('mptcp', 'congestion')
    for (const field of platformSensitiveFields) {
      const raw = config[field]
      const enabled = typeof raw === 'boolean' ? raw : valueEnabled(String(raw))
      if (enabled) {
        addIssue(issues, 'info', field, '该参数依赖系统或 iperf3 构建能力，Windows 上可能不可用。')
      }
    }
  }

  if (config.mode === 'server') {
    validateIntegerRange(issues, config, 'idleTimeout', '空闲超时', 1, 2147483647)
    validateIntegerRange(issues, config, 'serverMaxDuration', '服务端最大测试时长', 1, 2147483647)
    validateIntegerRange(issues, config, 'timeSkewThreshold', '时间偏移阈值', 1, 2147483647)
    validateBitrate(issues, config, 'serverBitrateLimit', '服务端带宽上限')
  }

  return issues
}

function pushArg(args: string[], flag: string, value?: string) {
  args.push(flag)
  if (value !== undefined && value.length > 0) args.push(value)
}

function pushValue(args: string[], flag: string, value: string) {
  const clean = trimmed(value)
  if (clean) pushArg(args, flag, clean)
}

export function splitRawArgs(input: string): string[] {
  const args: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  let escaped = false

  for (const char of input) {
    if (escaped) {
      current += char
      escaped = false
      continue
    }
    if (char === '\\') {
      escaped = true
      continue
    }
    if ((char === '"' || char === "'") && !quote) {
      quote = char
      continue
    }
    if (char === quote) {
      quote = null
      continue
    }
    if (/\s/.test(char) && !quote) {
      if (current) {
        args.push(current)
        current = ''
      }
      continue
    }
    current += char
  }
  if (current) args.push(current)
  return args
}

export function buildIperfArgs(config: IperfConfig): string[] {
  const args: string[] = []

  if (config.mode === 'server') {
    args.push('-s')
  } else {
    args.push('-c', trimmed(config.host))
  }

  pushValue(args, '-p', config.port)
  pushValue(args, '-f', config.format)
  pushValue(args, '-A', config.affinity)
  pushValue(args, '-B', config.bind)
  pushValue(args, '--bind-dev', config.bindDev)

  if (config.verbose) args.push('-V')
  if (config.debug) args.push('-d')
  if (config.outputMode === 'json') args.push('-J')
  pushValue(args, '--logfile', config.logfile)
  if (config.forceflush) args.push('--forceflush')
  if (config.timestamps) {
    args.push(config.timestampFormat.trim() ? `--timestamps=${config.timestampFormat.trim()}` : '--timestamps')
  }
  pushValue(args, '--rcv-timeout', config.rcvTimeout)
  pushValue(args, '--snd-timeout', config.sndTimeout)
  if (config.usePkcs1Padding) args.push('--use-pkcs1-padding')

  if (config.mode === 'server') {
    if (config.daemon) args.push('-D')
    if (config.oneOff) args.push('-1')
    pushValue(args, '-I', config.pidfile)
    pushValue(args, '--idle-timeout', config.idleTimeout)
    pushValue(args, '--server-max-duration', config.serverMaxDuration)
    pushValue(args, '--server-bitrate-limit', config.serverBitrateLimit)
    pushValue(args, '--rsa-private-key-path', config.rsaPrivateKeyPath)
    pushValue(args, '--authorized-users-path', config.authorizedUsersPath)
    pushValue(args, '--time-skew-threshold', config.timeSkewThreshold)
  } else {
    if (config.protocol === 'udp') args.push('-u')
    if (config.protocol === 'sctp') args.push('--sctp')
    if (config.protocol === 'tcp' && config.mptcp) args.push('-m')
    pushValue(args, '--connect-timeout', config.connectTimeout)
    pushValue(args, '--cport', config.clientPort)
    pushValue(args, '-b', config.bitrate)
    pushValue(args, '--pacing-timer', config.pacingTimer)
    pushValue(args, '--fq-rate', config.fqRate)
    if (config.noFqSocketPacing) args.push('--no-fq-socket-pacing')

    if (config.transferMode === 'time') pushValue(args, '-t', config.time)
    if (config.transferMode === 'bytes') pushValue(args, '-n', config.bytes)
    if (config.transferMode === 'blockcount') pushValue(args, '-k', config.blockcount)

    pushValue(args, '-l', config.length)
    pushValue(args, '-P', config.parallel)
    if (config.direction === 'reverse') args.push('-R')
    if (config.direction === 'bidir') args.push('--bidir')
    pushValue(args, '-w', config.window)
    if (config.protocol !== 'udp') {
      pushValue(args, '-M', config.mss)
      if (config.noDelay) args.push('-N')
    }
    if (config.ipVersion === 'ipv4') args.push('-4')
    if (config.ipVersion === 'ipv6') args.push('-6')
    pushValue(args, '-S', config.tos)
    pushValue(args, '--dscp', config.dscp)
    pushValue(args, '-L', config.flowlabel)
    if (config.protocol === 'sctp') {
      pushValue(args, '-X', config.xbind)
      pushValue(args, '--nstreams', config.sctpStreams)
    }
    if (config.zerocopy) args.push('-Z')
    if (config.skipRxCopy) args.push('--skip-rx-copy')
    pushValue(args, '-O', config.omit)
    pushValue(args, '-T', config.title)
    pushValue(args, '--extra-data', config.extraData)
    if (config.protocol === 'tcp') pushValue(args, '-C', config.congestion)
    if (config.getServerOutput) args.push('--get-server-output')
    if (config.protocol === 'udp' && config.udpCounters64bit) args.push('--udp-counters-64bit')
    if (config.repeatingPayload) args.push('--repeating-payload')
    if (config.protocol === 'udp' && config.dontFragment) args.push('--dont-fragment')
    pushValue(args, '--username', config.username)
    pushValue(args, '--rsa-public-key-path', config.rsaPublicKeyPath)
  }

  args.push(...splitRawArgs(config.rawArgs))
  return args
}

export function quoteArg(arg: string): string {
  if (!arg) return '""'
  if (!/[\s"'`$&|<>^]/.test(arg)) return arg
  return `"${arg.replace(/"/g, '\\"')}"`
}

export function commandToString(binary: string, args: string[]) {
  return [quoteArg(binary), ...args.map(quoteArg)].join(' ')
}

export function buildCommandPreview(config: IperfConfig, binary = 'iperf3'): CommandPreview {
  const args = buildIperfArgs(config)
  return {
    binary,
    args,
    preview: commandToString(binary, args),
    issues: validateConfig(config),
  }
}
