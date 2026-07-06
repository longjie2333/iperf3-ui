import { useEffect, useMemo, useRef, useState } from 'react'
import clsx from 'clsx'
import {
  AlertTriangle,
  BadgeInfo,
  BookOpen,
  Check,
  ChevronDown,
  Copy,
  FileJson,
  FolderCog,
  Gauge,
  HelpCircle,
  Network,
  PauseCircle,
  Pencil,
  Play,
  Save,
  Server,
  Settings2,
  Shield,
  SlidersHorizontal,
  Square,
  TerminalSquare,
  Trash2,
  UploadCloud,
  Wifi,
  X,
} from 'lucide-react'
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import './App.css'
import {
  deleteProfile,
  getRunEvents,
  loadProfiles,
  renameProfile,
  resolveBinary,
  resultFromEvents,
  saveProfile,
  selectIperfBinary,
  startRun,
  startSshCommand,
  stopRun,
} from './lib/backend'
import { buildCommandPreview, DEFAULT_CONFIG, validateConfig } from './lib/command'
import { findOptionSpec } from './lib/options'
import { formatBitsPerSecond, formatBytes } from './lib/results'
import type { ByteUnit, RateUnit } from './lib/results'
import type {
  BinaryResolution,
  IperfConfig,
  IperfResult,
  OptionGroup,
  RunEvent,
  RunMode,
  RunSession,
  SavedProfile,
  SshConfig,
  ValidationIssue,
} from './lib/types'

const GROUPS: Array<{
  id: OptionGroup
  label: string
  icon: typeof Settings2
  modes: IperfConfig['mode'][] | 'both'
}> = [
  { id: 'general', label: '基础', icon: Settings2, modes: 'both' },
  { id: 'protocol', label: '协议', icon: Network, modes: ['client'] },
  { id: 'transfer', label: '传输', icon: Gauge, modes: ['client'] },
  { id: 'network', label: '网络', icon: Wifi, modes: ['client'] },
  { id: 'output', label: '输出', icon: TerminalSquare, modes: 'both' },
  { id: 'server', label: '服务端', icon: Server, modes: ['server'] },
  { id: 'auth', label: '认证', icon: Shield, modes: 'both' },
  { id: 'advanced', label: '高级', icon: SlidersHorizontal, modes: 'both' },
]

type FieldName = keyof IperfConfig
type ResultView = 'overview' | 'logs' | 'raw'
type ModeRunState = {
  session?: RunSession
  events: RunEvent[]
  resultView: ResultView
  autoScrollLogs: boolean
  showScrollToBottom: boolean
  hiddenEventIds: string[]
}

const RUN_MODES: RunMode[] = ['client', 'server']

function createModeRunState(): ModeRunState {
  return {
    events: [],
    resultView: 'overview',
    autoScrollLogs: true,
    showScrollToBottom: false,
    hiddenEventIds: [],
  }
}

function createModeRunStates(): Record<RunMode, ModeRunState> {
  return {
    client: createModeRunState(),
    server: createModeRunState(),
  }
}

function emptyResult(): IperfResult {
  return { intervals: [], rawText: '' }
}

function updateModeRunState(
  states: Record<RunMode, ModeRunState>,
  mode: RunMode,
  updater: (state: ModeRunState) => ModeRunState,
) {
  return {
    ...states,
    [mode]: updater(states[mode]),
  }
}

function modeIsRunning(state: ModeRunState) {
  return Boolean(state.session?.status === 'running' && !state.events.some((event) => event.kind === 'exit'))
}

const RATE_UNIT_OPTIONS: Array<{ value: RateUnit; label: string }> = [
  { value: 'auto', label: '自动' },
  { value: 'bit/s', label: 'bit/s' },
  { value: 'Kbit/s', label: 'Kbit/s' },
  { value: 'Mbit/s', label: 'Mbit/s' },
  { value: 'Gbit/s', label: 'Gbit/s' },
  { value: 'Tbit/s', label: 'Tbit/s' },
]

const BYTE_UNIT_OPTIONS: Array<{ value: ByteUnit; label: string }> = [
  { value: 'auto', label: '自动' },
  { value: 'B', label: 'B' },
  { value: 'KiB', label: 'KiB' },
  { value: 'MiB', label: 'MiB' },
  { value: 'GiB', label: 'GiB' },
  { value: 'TiB', label: 'TiB' },
]

const RATE_UNIT_FACTORS: Record<Exclude<RateUnit, 'auto'>, number> = {
  'bit/s': 1,
  'Kbit/s': 1_000,
  'Mbit/s': 1_000_000,
  'Gbit/s': 1_000_000_000,
  'Tbit/s': 1_000_000_000_000,
}

function isTauriRuntime() {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

const EMPTY_SSH_CONFIG: SshConfig = { host: '', username: '', password: '' }

function normalizeConfig(config: Partial<IperfConfig>): IperfConfig {
  const outputMode = (config as { outputMode?: string }).outputMode
  return {
    ...DEFAULT_CONFIG,
    ...config,
    outputMode: outputMode === 'json' || outputMode === 'human' ? outputMode : DEFAULT_CONFIG.outputMode,
    forceflush: config.forceflush ?? DEFAULT_CONFIG.forceflush,
  }
}

function normalizeSshConfig(ssh?: Partial<SshConfig>): SshConfig {
  return {
    host: ssh?.host ?? '',
    username: ssh?.username ?? '',
    password: ssh?.password ?? '',
  }
}

function normalizeProfile(profile: SavedProfile): SavedProfile {
  return {
    ...profile,
    config: normalizeConfig(profile.config),
    sshConfig: normalizeSshConfig(profile.sshConfig),
  }
}

function fileUrlToWindowsPath(value: string) {
  const firstLine = value.split(/\r?\n/).find(Boolean)
  if (!firstLine?.startsWith('file:')) return ''
  try {
    const url = new URL(firstLine)
    return decodeURIComponent(url.pathname)
      .replace(/^\/([A-Za-z]:)/, '$1')
      .replace(/\//g, '\\')
  } catch {
    return ''
  }
}

function pathFromFileDrop(event: React.DragEvent) {
  const file = event.dataTransfer.files.item(0) as (File & { path?: string }) | null
  if (file?.path) return file.path
  return fileUrlToWindowsPath(event.dataTransfer.getData('text/uri-list') || event.dataTransfer.getData('text/plain'))
}

function pathFromInputFile(file: File | null) {
  const tauriFile = file as (File & { path?: string }) | null
  return tauriFile?.path ?? ''
}

function pointInsideElement(element: HTMLElement | null, position?: { x: number; y: number }) {
  if (!element || !position) return false
  const rect = element.getBoundingClientRect()
  return position.x >= rect.left && position.x <= rect.right && position.y >= rect.top && position.y <= rect.bottom
}

const FIELD_HELP: Partial<Record<FieldName | 'mode-host', string>> = {
  host: '客户端要连接的服务端地址，可以是 IPv4、IPv6 或域名，例如 127.0.0.1。',
  customBinaryPath: '留空时优先使用随应用打包的 iperf3.exe，找不到时再尝试系统 PATH。',
  password: 'iperf3 认证密码通过 IPERF3_PASSWORD 环境变量传给进程，不会作为命令行参数显示。',
  timestampFormat: '仅在追加时间戳时生效，可以填写 iperf3 支持的 strftime 格式。',
  bytes: '按总传输字节数结束测试，支持 K、M、G、T 等单位。',
  blockcount: '按发送的块数量结束测试，块大小由缓冲区长度决定。',
}

function getParameterHelp(field: FieldName | 'mode-host') {
  const spec = findOptionSpec(field)
  const parts = [
    spec?.flags ? `参数：${spec.flags}。` : '',
    spec?.description ?? FIELD_HELP[field],
    spec?.windowsNote ? `提示：${spec.windowsNote}` : '',
  ].filter(Boolean)
  return parts.join(' ')
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max)
}

function quoteSshPreviewCommand(command: string) {
  return `"${command.replace(/(["\\])/g, '\\$1')}"`
}

function sshHasValue(ssh: SshConfig) {
  return Boolean(ssh.host.trim() || ssh.username.trim() || ssh.password.trim())
}

function sshTargetLabel(ssh: SshConfig, fallback = false) {
  const host = ssh.host.trim()
  const username = ssh.username.trim()
  if (!host && !username && !fallback) return ''
  return `${username || 'root'}@${host || 'host'}`
}

function validateSshTarget(ssh: SshConfig): ValidationIssue[] {
  if (!sshHasValue(ssh)) return []
  const issues: ValidationIssue[] = []
  if (!ssh.host.trim()) {
    issues.push({ level: 'error', field: 'command', message: 'SSH 主机地址不能为空。' })
  }
  return issues
}

function chartRateUnit(unit: RateUnit): Exclude<RateUnit, 'auto'> {
  return unit === 'auto' ? 'Mbit/s' : unit
}

async function sizeWindowForCurrentScreen() {
  if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) return
  const { LogicalSize, currentMonitor, getCurrentWindow } = await import('@tauri-apps/api/window')
  const appWindow = getCurrentWindow()
  const monitor = await currentMonitor()
  const logicalWorkArea = monitor?.workArea.size.toLogical(monitor.scaleFactor)
  const workWidth = logicalWorkArea?.width ?? window.screen.availWidth
  const workHeight = logicalWorkArea?.height ?? window.screen.availHeight
  const aspect = workWidth / Math.max(workHeight, 1)
  const maxWidth = Math.max(900, workWidth - 48)
  const maxHeight = Math.max(640, workHeight - 48)
  const minWidth = Math.min(960, maxWidth)
  const minHeight = Math.min(680, maxHeight)

  let width = Math.round(workWidth * (aspect >= 1.65 ? 0.78 : 0.88))
  let height = Math.round(width / Math.max(aspect, 0.75))

  if (height < minHeight) {
    height = minHeight
    width = Math.round(height * aspect)
  }
  if (height > maxHeight) {
    height = maxHeight
    width = Math.round(height * aspect)
  }
  if (width > maxWidth) {
    width = maxWidth
    height = Math.round(width / Math.max(aspect, 0.75))
  }

  await appWindow.setSize(new LogicalSize(clamp(width, minWidth, maxWidth), clamp(height, minHeight, maxHeight)))
  await appWindow.center()
}

function fieldIssue(issues: ValidationIssue[], field: FieldName) {
  return issues.find((issue) => issue.field === field && issue.level === 'error')
}

function setField<K extends FieldName>(
  setter: React.Dispatch<React.SetStateAction<IperfConfig>>,
  field: K,
  value: IperfConfig[K],
) {
  setter((current) => ({ ...current, [field]: value }))
}

function ParameterLabel({
  description,
  helpId,
  label,
}: {
  description?: string
  helpId?: string
  label: string
}) {
  return (
    <span className="label-row">
      <span>{label}</span>
      {description && helpId && (
        <span className="t-tt-wrap">
          <span
            className="t-tt-trigger help-trigger"
            tabIndex={0}
            aria-describedby={helpId}
            aria-label={`${label}说明`}
          >
            <HelpCircle size={14} aria-hidden="true" />
          </span>
          <span className="t-tt parameter-tooltip" id={helpId} role="tooltip">
            {description}
          </span>
        </span>
      )}
    </span>
  )
}

function TextInput({
  config,
  field,
  label,
  placeholder,
  issues,
  setConfig,
  type = 'text',
  description,
  showHelp = true,
}: {
  config: IperfConfig
  field: FieldName
  label: string
  placeholder?: string
  issues: ValidationIssue[]
  setConfig: React.Dispatch<React.SetStateAction<IperfConfig>>
  type?: string
  description?: string
  showHelp?: boolean
}) {
  const issue = fieldIssue(issues, field)
  const help = showHelp ? (description ?? getParameterHelp(field)) : undefined
  return (
    <label className="field">
      <ParameterLabel label={label} description={help} helpId={`help-${field}`} />
      <input
        className={clsx(issue && 'field-error')}
        type={type}
        value={String(config[field])}
        placeholder={placeholder}
        onChange={(event) => setField(setConfig, field, event.target.value as never)}
      />
      {issue && <small>{issue.message}</small>}
    </label>
  )
}

function CheckboxField({
  config,
  field,
  label,
  issues,
  setConfig,
  description,
  showHelp = true,
}: {
  config: IperfConfig
  field: FieldName
  label: string
  issues: ValidationIssue[]
  setConfig: React.Dispatch<React.SetStateAction<IperfConfig>>
  description?: string
  showHelp?: boolean
}) {
  const issue = fieldIssue(issues, field)
  const help = showHelp ? (description ?? getParameterHelp(field)) : undefined
  return (
    <label className={clsx('check-field', issue && 'field-error-box')}>
      <input
        type="checkbox"
        checked={Boolean(config[field])}
        onChange={(event) => setField(setConfig, field, event.target.checked as never)}
      />
      <ParameterLabel label={label} description={help} helpId={`help-${field}`} />
    </label>
  )
}

function SelectField({
  config,
  field,
  label,
  issues,
  options,
  setConfig,
  description,
  showHelp = true,
}: {
  config: IperfConfig
  field: FieldName
  label: string
  issues: ValidationIssue[]
  options: Array<{ value: string; label: string }>
  setConfig: React.Dispatch<React.SetStateAction<IperfConfig>>
  description?: string
  showHelp?: boolean
}) {
  const issue = fieldIssue(issues, field)
  const help = showHelp ? (description ?? getParameterHelp(field)) : undefined
  return (
    <label className="field">
      <ParameterLabel label={label} description={help} helpId={`help-${field}`} />
      <select
        className={clsx(issue && 'field-error')}
        value={String(config[field])}
        onChange={(event) => setField(setConfig, field, event.target.value as never)}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      {issue && <small>{issue.message}</small>}
    </label>
  )
}

function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
  description,
  helpId,
  showHelp = true,
  showOptionTitles = true,
}: {
  label: string
  value: T
  options: Array<{ value: T; label: string; icon?: typeof Settings2 }>
  onChange: (value: T) => void
  description?: string
  helpId: string
  showHelp?: boolean
  showOptionTitles?: boolean
}) {
  return (
    <div className="segmented-field">
      {label && <ParameterLabel label={label} description={showHelp ? description : undefined} helpId={helpId} />}
      <div className="segmented-control">
        {options.map((option) => {
          const Icon = option.icon
          return (
            <button
              key={option.value}
              type="button"
              className={clsx(value === option.value && 'active')}
              onClick={() => onChange(option.value)}
              title={showOptionTitles ? option.label : undefined}
            >
              {Icon && <Icon size={16} aria-hidden="true" />}
              <span>{option.label}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

function UnitGuideCard() {
  return (
    <section className="unit-guide-card full-span" aria-label="网络单位换算">
      <h3>网络传输单位速查</h3>
      <p>网络速率常用 bit/s，文件大小常用 Byte；1 Byte = 8 bit，所以 100 Mbit/s 理论下载约等于 12.5 MB/s。</p>
    </section>
  )
}

function StatusPill({ resolution }: { resolution?: BinaryResolution }) {
  if (!resolution) {
    return <span className="status-pill neutral">检测中</span>
  }
  if (resolution.exists) {
    return <span className="status-pill ok">{resolution.source}</span>
  }
  return <span className="status-pill warn">未找到</span>
}

function splitMetricValue(value: string) {
  const parts = value.trim().split(/\s+/)
  if (parts.length < 2) return { amount: value, unit: '' }
  return { amount: parts.slice(0, -1).join(' '), unit: parts.at(-1) ?? '' }
}

function SummaryMetric({
  label,
  onUnitChange,
  unitOptions,
  unitValue,
  value,
}: {
  label: string
  onUnitChange?: (value: string) => void
  unitOptions?: Array<{ value: string; label: string }>
  unitValue?: string
  value: string
}) {
  const metric = splitMetricValue(value)
  return (
    <div className="metric-tile">
      <span>{label}</span>
      <div className="metric-value-row">
        <strong>{metric.amount}</strong>
        {unitOptions && unitValue && onUnitChange && metric.unit ? (
          <label className="metric-unit-picker" aria-label={`${label}单位`}>
            <span>{metric.unit}</span>
            <ChevronDown size={15} aria-hidden="true" />
            <select value={unitValue} onChange={(event) => onUnitChange(event.target.value)}>
              {unitOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
        ) : (
          metric.unit && <strong>{metric.unit}</strong>
        )}
      </div>
    </div>
  )
}

function buildProfileName(config: IperfConfig) {
  if (config.mode === 'server') return `Server :${config.port || '5201'}`
  return `${config.protocol.toUpperCase()} ${config.host || 'target'}`
}

function App() {
  const binaryDropRef = useRef<HTMLButtonElement>(null)
  const binaryFileInputRef = useRef<HTMLInputElement>(null)
  const logPreRef = useRef<HTMLPreElement>(null)
  const [config, setConfig] = useState<IperfConfig>(DEFAULT_CONFIG)
  const [activeGroup, setActiveGroup] = useState<OptionGroup>('general')
  const [rateUnit, setRateUnit] = useState<RateUnit>('auto')
  const [byteUnit, setByteUnit] = useState<ByteUnit>('auto')
  const [binary, setBinary] = useState<BinaryResolution>()
  const [profiles, setProfiles] = useState<SavedProfile[]>([])
  const [editingProfileId, setEditingProfileId] = useState('')
  const [profileNameDraft, setProfileNameDraft] = useState('')
  const [modeRunStates, setModeRunStates] = useState(createModeRunStates)
  const [toast, setToast] = useState('')
  const [binaryDragOver, setBinaryDragOver] = useState(false)
  const [sshConfig, setSshConfig] = useState<SshConfig>(EMPTY_SSH_CONFIG)
  const modeRunStatesRef = useRef(modeRunStates)

  const localIssues = useMemo(() => validateConfig(config), [config])
  const sshIssues = useMemo(() => (config.mode === 'server' ? validateSshTarget(sshConfig) : []), [config.mode, sshConfig])
  const commandIssues = useMemo(() => [...localIssues, ...sshIssues], [localIssues, sshIssues])
  const customBinaryPath = config.customBinaryPath
  const isClientMode = config.mode === 'client'
  const isServerMode = config.mode === 'server'
  const isTcp = config.protocol === 'tcp'
  const isUdp = config.protocol === 'udp'
  const isSctp = config.protocol === 'sctp'
  const currentRunState = modeRunStates[config.mode]
  const session = currentRunState.session
  const events = currentRunState.events
  const resultView = currentRunState.resultView
  const autoScrollLogs = currentRunState.autoScrollLogs
  const showScrollToBottom = currentRunState.showScrollToBottom
  const result = useMemo(() => (events.length ? resultFromEvents(events) : emptyResult()), [events])
  const visibleGroups = useMemo(
    () => GROUPS.filter((group) => group.modes === 'both' || group.modes.includes(config.mode)),
    [config.mode],
  )
  const currentGroup = visibleGroups.find((group) => group.id === activeGroup) ?? visibleGroups[0]
  const selectedGroupId = currentGroup?.id ?? 'general'
  const sshRunEnabled = isServerMode && sshHasValue(sshConfig)
  const blockingIssues = commandIssues.filter((issue) => issue.level === 'error')
  const logs = useMemo(
    () => events.filter((event) => ['stdout', 'stderr', 'status', 'error', 'exit'].includes(event.kind)),
    [events],
  )
  const isRunning = modeIsRunning(currentRunState)
  const command = useMemo(() => {
    const binaryPath = binary?.path || customBinaryPath.trim() || 'iperf3'
    return buildCommandPreview(config, binaryPath)
  }, [binary?.path, config, customBinaryPath])
  const remoteServerCommand = useMemo(() => buildCommandPreview(config, 'iperf3').preview, [config])
  const sshCommandPreview = useMemo(() => {
    const target = sshTargetLabel(sshConfig, true)
    return `ssh ${target} ${quoteSshPreviewCommand(remoteServerCommand)}`
  }, [remoteServerCommand, sshConfig])

  function setCurrentRunState(updater: (state: ModeRunState) => ModeRunState) {
    const mode = config.mode
    setModeRunStates((current) => updateModeRunState(current, mode, updater))
  }

  function setCurrentResultView(nextView: ResultView) {
    setCurrentRunState((state) => ({ ...state, resultView: nextView }))
  }

  useEffect(() => {
    sizeWindowForCurrentScreen().catch(() => undefined)
  }, [])

  useEffect(() => {
    modeRunStatesRef.current = modeRunStates
  }, [modeRunStates])

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Tab' || !event.ctrlKey) return
      event.preventDefault()
      setConfig((current) => ({
        ...current,
        mode: current.mode === 'client' ? 'server' : 'client',
      }))
      setActiveGroup('general')
    }

    window.addEventListener('keydown', handleKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', handleKeyDown, { capture: true })
  }, [])

  useEffect(() => {
    let cancelled = false
    resolveBinary(customBinaryPath).then((value) => {
      if (!cancelled) setBinary(value)
    })
    return () => {
      cancelled = true
    }
  }, [customBinaryPath])

  useEffect(() => {
    if (!visibleGroups.some((group) => group.id === activeGroup)) {
      setActiveGroup(visibleGroups[0]?.id ?? 'general')
    }
  }, [activeGroup, visibleGroups])

  useEffect(() => {
    loadProfiles().then((items) => setProfiles(items.map(normalizeProfile)))
  }, [])

  useEffect(() => {
    if (!isTauriRuntime()) return
    let active = true
    let unlisten: (() => void) | undefined

    import('@tauri-apps/api/webview')
      .then(({ getCurrentWebview }) =>
        getCurrentWebview().onDragDropEvent((event) => {
          const payload = event.payload as {
            type: 'enter' | 'over' | 'drop' | 'leave'
            paths?: string[]
            position?: { x: number; y: number }
          }
          const inside = pointInsideElement(binaryDropRef.current, payload.position)
          if (payload.type === 'enter' || payload.type === 'over') {
            if (active) setBinaryDragOver(inside)
            return
          }
          if (payload.type === 'drop') {
            if (active) {
              setBinaryDragOver(false)
              if (inside && payload.paths?.[0]) {
                setField(setConfig, 'customBinaryPath', payload.paths[0])
              }
            }
            return
          }
          if (active) setBinaryDragOver(false)
        }),
      )
      .then((dispose) => {
        if (active) {
          unlisten = dispose
        } else {
          dispose()
        }
      })
      .catch(() => undefined)

    return () => {
      active = false
      unlisten?.()
    }
  }, [])

  useEffect(() => {
    if (!isTauriRuntime()) return
    let active = true
    let unlisten: (() => void) | undefined

    import('@tauri-apps/api/event')
      .then(({ listen }) =>
        listen<RunEvent>('iperf-run-event', (event) => {
          const runEvent = event.payload
          if (!active) return
          setModeRunStates((current) => {
            const owner = RUN_MODES.find((mode) => current[mode].session?.id === runEvent.sessionId)
            if (!owner) return current
            const state = current[owner]
            if (state.hiddenEventIds.includes(runEvent.id)) return current
            if (state.events.some((item) => item.id === runEvent.id)) return current
            return updateModeRunState(current, owner, (currentState) => ({
              ...currentState,
              events: [...currentState.events, runEvent],
            }))
          })
        }),
      )
      .then((dispose) => {
        if (active) {
          unlisten = dispose
        } else {
          dispose()
        }
      })
      .catch(() => undefined)

    return () => {
      active = false
      unlisten?.()
    }
  }, [])

  useEffect(() => {
    const timer = window.setInterval(() => {
      const snapshot = modeRunStatesRef.current
      for (const mode of RUN_MODES) {
        const state = snapshot[mode]
        if (!modeIsRunning(state) || !state.session) continue
        const sessionId = state.session.id
        getRunEvents(sessionId).then((next) => {
          setModeRunStates((current) => {
            const currentState = current[mode]
            if (currentState.session?.id !== sessionId) return current
            const hidden = new Set(currentState.hiddenEventIds)
            return updateModeRunState(current, mode, (targetState) => ({
              ...targetState,
              events: next.filter((item) => !hidden.has(item.id)),
            }))
          })
        })
      }
    }, 300)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    if (resultView !== 'logs') return
    if (!autoScrollLogs) {
      if (logs.length) setCurrentRunState((state) => ({ ...state, showScrollToBottom: true }))
      return
    }
    const element = logPreRef.current
    if (!element) return
    element.scrollTop = element.scrollHeight
    setCurrentRunState((state) => ({ ...state, showScrollToBottom: false }))
  }, [autoScrollLogs, logs.length, resultView])

  useEffect(() => {
    if (resultView !== 'logs' || !autoScrollLogs) return
    requestAnimationFrame(scrollLogsToBottom)
  }, [autoScrollLogs, resultView])

  async function handleStart() {
    if (blockingIssues.length) return
    const mode = config.mode
    const nextSession = sshRunEnabled ? await startSshCommand(sshConfig, config) : await startRun(config)
    setModeRunStates((current) =>
      updateModeRunState(current, mode, (state) => ({
        ...state,
        session: nextSession,
        events: [],
        resultView: sshRunEnabled ? 'logs' : state.resultView,
        autoScrollLogs: true,
        showScrollToBottom: false,
        hiddenEventIds: [],
      })),
    )
    const initialEvents = await getRunEvents(nextSession.id)
    setModeRunStates((current) =>
      updateModeRunState(current, mode, (state) => ({
        ...state,
        events: initialEvents.filter((item) => !state.hiddenEventIds.includes(item.id)),
      })),
    )
  }

  async function handleStop() {
    if (!session) return
    const mode = config.mode
    const sessionId = session.id
    await stopRun(sessionId)
    const next = await getRunEvents(sessionId)
    setModeRunStates((current) => {
      const hidden = new Set(current[mode].hiddenEventIds)
      return updateModeRunState(current, mode, (state) => ({
        ...state,
        events: next.filter((item) => !hidden.has(item.id)),
      }))
    })
  }

  function handleClearOutput() {
    const mode = config.mode
    setModeRunStates((current) =>
      updateModeRunState(current, mode, (state) => {
        const stillRunning = modeIsRunning(state)
        const hiddenEventIds = stillRunning
          ? Array.from(new Set([...state.hiddenEventIds, ...state.events.map((event) => event.id)]))
          : []
        return {
          ...state,
          session: stillRunning ? state.session : undefined,
          events: [],
          autoScrollLogs: true,
          showScrollToBottom: false,
          hiddenEventIds,
        }
      }),
    )
  }

  function logIsAtBottom(element: HTMLPreElement) {
    return element.scrollHeight - element.scrollTop - element.clientHeight < 8
  }

  function handleLogScroll() {
    const element = logPreRef.current
    if (!element) return
    if (logIsAtBottom(element)) {
      setCurrentRunState((state) => ({ ...state, autoScrollLogs: true, showScrollToBottom: false }))
    } else {
      setCurrentRunState((state) => ({ ...state, autoScrollLogs: false, showScrollToBottom: true }))
    }
  }

  function scrollLogsToBottom() {
    const element = logPreRef.current
    if (!element) return
    element.scrollTop = element.scrollHeight
    setCurrentRunState((state) => ({ ...state, autoScrollLogs: true, showScrollToBottom: false }))
  }

  async function handleSaveProfile() {
    const profile: SavedProfile = {
      id: `${Date.now()}`,
      name: buildProfileName(config),
      createdAt: new Date().toISOString(),
      config,
      sshConfig: normalizeSshConfig(sshConfig),
    }
    const next = await saveProfile(profile)
    setProfiles(next.map(normalizeProfile))
    setToast('预设已保存')
  }

  async function handleRenameProfile(profile: SavedProfile) {
    const name = profileNameDraft.trim()
    if (!name) {
      setToast('预设名称不能为空')
      return
    }
    const next = await renameProfile(profile.id, name)
    setProfiles(next.map(normalizeProfile))
    setEditingProfileId('')
    setProfileNameDraft('')
    setToast('预设已重命名')
  }

  async function handleDeleteProfile(profile: SavedProfile) {
    if (!window.confirm(`删除预设“${profile.name}”？`)) return
    const next = await deleteProfile(profile.id)
    setProfiles(next.map(normalizeProfile))
    if (editingProfileId === profile.id) {
      setEditingProfileId('')
      setProfileNameDraft('')
    }
    setToast('预设已删除')
  }

  async function handleSelectBinary() {
    if (!isTauriRuntime()) {
      binaryFileInputRef.current?.click()
      return
    }
    const path = await selectIperfBinary()
    if (path) setField(setConfig, 'customBinaryPath', path)
  }

  async function handleCopyCommand() {
    await navigator.clipboard.writeText(command.preview)
    setToast('命令已复制')
  }

  async function handleCopySshCommand() {
    await navigator.clipboard.writeText(sshCommandPreview)
    setToast('SSH 命令已复制')
  }

  function setSshField(field: keyof SshConfig, value: string) {
    setSshConfig((current) => ({ ...current, [field]: value }))
  }

  const selectedChartRateUnit = chartRateUnit(rateUnit)
  const chartData = result.intervals.map((interval) => ({
    name: `${interval.start.toFixed(0)}-${interval.end.toFixed(0)}s`,
    rate: Number((interval.bitsPerSecond / RATE_UNIT_FACTORS[selectedChartRateUnit]).toFixed(2)),
    retransmits: interval.retransmits ?? 0,
    loss: interval.lostPercent ?? 0,
  }))

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <section className="side-section">
          <Segmented<IperfConfig['mode']>
            label=""
            value={config.mode}
            helpId="help-mode"
            description={getParameterHelp('mode-host')}
            showHelp={false}
            showOptionTitles={false}
            options={[
              { value: 'client', label: '客户端', icon: UploadCloud },
              { value: 'server', label: '服务端', icon: Server },
            ]}
            onChange={(value) => {
              setField(setConfig, 'mode', value)
              setActiveGroup('general')
            }}
          />
          {isClientMode && (
            <TextInput
              config={config}
              setConfig={setConfig}
              issues={localIssues}
              field="host"
              label="服务端主机"
              placeholder="127.0.0.1"
              showHelp={false}
            />
          )}
          <TextInput
            config={config}
            setConfig={setConfig}
            issues={localIssues}
            field="port"
            label="端口"
            placeholder="5201"
            showHelp={false}
          />
        </section>

        <section className="side-section">
          <div className="section-title">
            <FolderCog size={16} aria-hidden="true" />
            <span>二进制</span>
            <StatusPill resolution={binary} />
          </div>
          <button
            ref={binaryDropRef}
            type="button"
            className={clsx('binary-upload-target', binaryDragOver && 'drag-over')}
            onClick={handleSelectBinary}
            onDragEnter={(event) => {
              event.preventDefault()
              setBinaryDragOver(true)
            }}
            onDragOver={(event) => {
              event.preventDefault()
              event.dataTransfer.dropEffect = 'copy'
              setBinaryDragOver(true)
            }}
            onDragLeave={() => setBinaryDragOver(false)}
            onDrop={(event) => {
              event.preventDefault()
              setBinaryDragOver(false)
              const path = pathFromFileDrop(event)
              if (path) setField(setConfig, 'customBinaryPath', path)
            }}
          >
            <span className="binary-upload-icon">
              <UploadCloud size={30} aria-hidden="true" />
            </span>
            <strong>选择 iperf3.exe</strong>
            <span className="binary-path">{config.customBinaryPath || binary?.path || '使用内置版本'}</span>
          </button>
          <input
            ref={binaryFileInputRef}
            className="hidden-file-input"
            type="file"
            accept=".exe"
            onChange={(event) => {
              const path = pathFromInputFile(event.currentTarget.files?.item(0) ?? null)
              if (path) {
                setField(setConfig, 'customBinaryPath', path)
              } else if (event.currentTarget.files?.length) {
                setToast('浏览器预览无法读取完整路径，请在桌面应用中选择')
              }
              event.currentTarget.value = ''
            }}
          />
        </section>

        <section className="side-section">
          <div className="section-title">
            <Save size={16} aria-hidden="true" />
            <span>预设</span>
            <button type="button" className="icon-button" aria-label="保存当前预设" onClick={handleSaveProfile}>
              <Save size={16} aria-hidden="true" />
            </button>
          </div>
          <div className="profile-list">
            {profiles.length === 0 && <p className="hint">暂无预设。</p>}
            {profiles.slice(0, 6).map((profile) => (
              <div key={profile.id} className="profile-row">
                {editingProfileId === profile.id ? (
                  <input
                    className="profile-name-input"
                    value={profileNameDraft}
                    autoFocus
                    onChange={(event) => setProfileNameDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') void handleRenameProfile(profile)
                      if (event.key === 'Escape') {
                        setEditingProfileId('')
                        setProfileNameDraft('')
                      }
                    }}
                  />
                ) : (
                  <button
                    type="button"
                    className="profile-load"
                    onClick={() => {
                      setConfig(normalizeConfig(profile.config))
                      setSshConfig(normalizeSshConfig(profile.sshConfig))
                    }}
                  >
                    <span>{profile.name}</span>
                    <small>{new Date(profile.createdAt).toLocaleDateString()}</small>
                  </button>
                )}
                <div className="profile-actions">
                  {editingProfileId === profile.id ? (
                    <>
                      <button type="button" className="profile-action" aria-label="确认重命名" onClick={() => handleRenameProfile(profile)}>
                        <Check size={15} aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        className="profile-action"
                        aria-label="取消重命名"
                        onClick={() => {
                          setEditingProfileId('')
                          setProfileNameDraft('')
                        }}
                      >
                        <X size={15} aria-hidden="true" />
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        type="button"
                        className="profile-action"
                        aria-label="重命名预设"
                        onClick={() => {
                          setEditingProfileId(profile.id)
                          setProfileNameDraft(profile.name)
                        }}
                      >
                        <Pencil size={15} aria-hidden="true" />
                      </button>
                      <button type="button" className="profile-action danger" aria-label="删除预设" onClick={() => handleDeleteProfile(profile)}>
                        <Trash2 size={15} aria-hidden="true" />
                      </button>
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
        </section>
      </aside>

      <section className="workspace">
        <div className="group-tabs-shell">
          <div className="group-tabs-wrapper">
            <nav className="group-tabs" aria-label="鍙傛暟鍒嗙粍">
              {visibleGroups.map((group) => {
                const Icon = group.icon
                return (
                  <button
                    key={group.id}
                    type="button"
                    className={clsx(selectedGroupId === group.id && 'active')}
                    onClick={() => setActiveGroup(group.id)}
                  >
                    <Icon size={16} aria-hidden="true" />
                    <span>{group.label}</span>
                  </button>
                )
              })}
            </nav>
          </div>
        </div>

        <div className="main-grid">
          <section className="parameter-panel">
            <div className="panel-heading">
              <div>
                <h2>{currentGroup?.label}参数</h2>
              </div>
              {selectedGroupId === 'advanced' && (
                <label className="expert-toggle">
                  <input
                    type="checkbox"
                    checked={config.expertMode}
                    onChange={(event) => setField(setConfig, 'expertMode', event.target.checked)}
                  />
                  <span>专家模式</span>
                </label>
              )}
            </div>

            <div className="form-grid">
              {selectedGroupId === 'general' && (
                <>
                  <SelectField
                    config={config}
                    setConfig={setConfig}
                    issues={localIssues}
                    field="format"
                    label="输出单位"
                    options={[
                      { value: 'k', label: 'Kbit/s' },
                      { value: 'm', label: 'Mbit/s' },
                      { value: 'g', label: 'Gbit/s' },
                      { value: 't', label: 'Tbit/s' },
                      { value: 'K', label: 'KByte/s' },
                      { value: 'M', label: 'MByte/s' },
                      { value: 'G', label: 'GByte/s' },
                    ]}
                  />
                  <TextInput config={config} setConfig={setConfig} issues={localIssues} field="bind" label="绑定地址" />
                  <TextInput
                    config={config}
                    setConfig={setConfig}
                    issues={localIssues}
                    field="affinity"
                    label="CPU 亲和性"
                    placeholder="0 或 0,1"
                  />
                  <CheckboxField config={config} setConfig={setConfig} issues={localIssues} field="verbose" label="详细输出" />
                  <UnitGuideCard />
                </>
              )}

              {selectedGroupId === 'protocol' && (
                <>
                  <Segmented<IperfConfig['protocol']>
                    label="协议"
                    value={config.protocol}
                    helpId="help-protocol"
                    description={getParameterHelp('protocol')}
                    options={[
                      { value: 'tcp', label: 'TCP' },
                      { value: 'udp', label: 'UDP' },
                      { value: 'sctp', label: 'SCTP' },
                    ]}
                    onChange={(value) =>
                      setConfig((current) => ({
                        ...current,
                        protocol: value,
                        mptcp: value === 'tcp' ? current.mptcp : false,
                        congestion: value === 'tcp' ? current.congestion : '',
                        udpCounters64bit: value === 'udp' ? current.udpCounters64bit : false,
                        dontFragment: value === 'udp' ? current.dontFragment : false,
                        xbind: value === 'sctp' ? current.xbind : '',
                        sctpStreams: value === 'sctp' ? current.sctpStreams : '',
                      }))
                    }
                  />
                  {isTcp && (
                    <CheckboxField
                      config={config}
                      setConfig={setConfig}
                      issues={localIssues}
                      field="mptcp"
                      label="MPTCP"
                    />
                  )}
                  {isUdp && (
                    <>
                      <CheckboxField
                        config={config}
                        setConfig={setConfig}
                        issues={localIssues}
                        field="udpCounters64bit"
                        label="UDP 64 位计数"
                      />
                      <CheckboxField
                        config={config}
                        setConfig={setConfig}
                        issues={localIssues}
                        field="dontFragment"
                        label="UDP/IPv4 不分片"
                      />
                    </>
                  )}
                  <CheckboxField
                    config={config}
                    setConfig={setConfig}
                    issues={localIssues}
                    field="repeatingPayload"
                    label="重复 payload"
                  />
                  {isSctp && (
                    <>
                      <TextInput config={config} setConfig={setConfig} issues={localIssues} field="xbind" label="SCTP xbind" />
                      <TextInput
                        config={config}
                        setConfig={setConfig}
                        issues={localIssues}
                        field="sctpStreams"
                        label="SCTP streams"
                      />
                    </>
                  )}
                </>
              )}

              {selectedGroupId === 'transfer' && (
                <>
                  <Segmented<IperfConfig['direction']>
                    label="方向"
                    value={config.direction}
                    helpId="help-direction"
                    description={getParameterHelp('direction')}
                    options={[
                      { value: 'normal', label: '普通' },
                      { value: 'reverse', label: '反向' },
                      { value: 'bidir', label: '双向' },
                    ]}
                    onChange={(value) => setField(setConfig, 'direction', value)}
                  />
                  <Segmented<IperfConfig['transferMode']>
                    label="结束条件"
                    value={config.transferMode}
                    helpId="help-transferMode"
                    description={getParameterHelp('transferMode')}
                    options={[
                      { value: 'time', label: '时长' },
                      { value: 'bytes', label: '字节' },
                      { value: 'blockcount', label: '块数' },
                    ]}
                    onChange={(value) => setField(setConfig, 'transferMode', value)}
                  />
                  {config.transferMode === 'time' && (
                    <TextInput config={config} setConfig={setConfig} issues={localIssues} field="time" label="时长秒" />
                  )}
                  {config.transferMode === 'bytes' && (
                    <TextInput config={config} setConfig={setConfig} issues={localIssues} field="bytes" label="字节数" placeholder="1G" />
                  )}
                  {config.transferMode === 'blockcount' && (
                    <TextInput
                      config={config}
                      setConfig={setConfig}
                      issues={localIssues}
                      field="blockcount"
                      label="块数"
                      placeholder="100K"
                    />
                  )}
                  <TextInput
                    config={config}
                    setConfig={setConfig}
                    issues={localIssues}
                    field="bitrate"
                    label="目标速率"
                    placeholder="100M"
                  />
                  <TextInput
                    config={config}
                    setConfig={setConfig}
                    issues={localIssues}
                    field="parallel"
                    label="并发流"
                    placeholder="1"
                  />
                  <TextInput
                    config={config}
                    setConfig={setConfig}
                    issues={localIssues}
                    field="length"
                    label="缓冲区长度"
                    placeholder="128K"
                  />
                  <TextInput config={config} setConfig={setConfig} issues={localIssues} field="omit" label="预热忽略秒" />
                </>
              )}

              {selectedGroupId === 'network' && (
                <>
                  <SelectField
                    config={config}
                    setConfig={setConfig}
                    issues={localIssues}
                    field="ipVersion"
                    label="IP 版本"
                    options={[
                      { value: 'auto', label: '自动' },
                      { value: 'ipv4', label: 'IPv4' },
                      { value: 'ipv6', label: 'IPv6' },
                    ]}
                  />
                  <TextInput config={config} setConfig={setConfig} issues={localIssues} field="window" label="窗口/缓冲区" />
                  {!isUdp && <TextInput config={config} setConfig={setConfig} issues={localIssues} field="mss" label="MSS" />}
                  <TextInput config={config} setConfig={setConfig} issues={localIssues} field="tos" label="TOS" placeholder="0x10" />
                  <TextInput config={config} setConfig={setConfig} issues={localIssues} field="dscp" label="DSCP" placeholder="AF11" />
                  <TextInput config={config} setConfig={setConfig} issues={localIssues} field="flowlabel" label="IPv6 flow label" />
                  <TextInput config={config} setConfig={setConfig} issues={localIssues} field="bindDev" label="绑定设备" />
                  {isTcp && <TextInput config={config} setConfig={setConfig} issues={localIssues} field="congestion" label="拥塞控制" />}
                  {!isUdp && <CheckboxField config={config} setConfig={setConfig} issues={localIssues} field="noDelay" label="No delay" />}
                </>
              )}

              {selectedGroupId === 'output' && (
                <>
                  <SelectField
                    config={config}
                    setConfig={setConfig}
                    issues={localIssues}
                    field="outputMode"
                    label="输出模式"
                    options={[
                      { value: 'human', label: '人类可读' },
                      { value: 'json', label: 'JSON' },
                    ]}
                  />
                  <CheckboxField
                    config={config}
                    setConfig={setConfig}
                    issues={localIssues}
                    field="forceflush"
                    label="实时刷新"
                  />
                  <CheckboxField
                    config={config}
                    setConfig={setConfig}
                    issues={localIssues}
                    field="timestamps"
                    label="追加时间戳"
                  />
                  {config.timestamps && (
                    <TextInput config={config} setConfig={setConfig} issues={localIssues} field="timestampFormat" label="时间戳格式" />
                  )}
                  <TextInput config={config} setConfig={setConfig} issues={localIssues} field="logfile" label="日志文件" />
                  {isClientMode && (
                    <>
                      <TextInput config={config} setConfig={setConfig} issues={localIssues} field="title" label="标题前缀" />
                      <TextInput config={config} setConfig={setConfig} issues={localIssues} field="extraData" label="JSON 附加数据" />
                      <CheckboxField
                        config={config}
                        setConfig={setConfig}
                        issues={localIssues}
                        field="getServerOutput"
                        label="获取服务端输出"
                      />
                    </>
                  )}
                </>
              )}

              {selectedGroupId === 'server' && (
                <>
                  <CheckboxField config={config} setConfig={setConfig} issues={localIssues} field="oneOff" label="单次连接后退出" />
                  <CheckboxField config={config} setConfig={setConfig} issues={localIssues} field="daemon" label="后台运行" />
                  <TextInput config={config} setConfig={setConfig} issues={localIssues} field="pidfile" label="PID 文件" />
                  <TextInput config={config} setConfig={setConfig} issues={localIssues} field="idleTimeout" label="空闲超时秒" />
                  <TextInput
                    config={config}
                    setConfig={setConfig}
                    issues={localIssues}
                    field="serverMaxDuration"
                    label="最大测试时长"
                  />
                  <TextInput
                    config={config}
                    setConfig={setConfig}
                    issues={localIssues}
                    field="serverBitrateLimit"
                    label="带宽上限"
                    placeholder="1G/5"
                  />
                </>
              )}

              {selectedGroupId === 'auth' && (
                <>
                  {isClientMode && (
                    <>
                      <TextInput config={config} setConfig={setConfig} issues={localIssues} field="username" label="用户名" />
                      <TextInput config={config} setConfig={setConfig} issues={localIssues} field="password" label="密码环境值" type="password" />
                      <TextInput config={config} setConfig={setConfig} issues={localIssues} field="rsaPublicKeyPath" label="RSA 公钥" />
                    </>
                  )}
                  {isServerMode && (
                    <>
                      <TextInput config={config} setConfig={setConfig} issues={localIssues} field="rsaPrivateKeyPath" label="RSA 私钥" />
                      <TextInput
                        config={config}
                        setConfig={setConfig}
                        issues={localIssues}
                        field="authorizedUsersPath"
                        label="授权用户 CSV"
                      />
                      <TextInput
                        config={config}
                        setConfig={setConfig}
                        issues={localIssues}
                        field="timeSkewThreshold"
                        label="时间偏移阈值"
                      />
                    </>
                  )}
                  <CheckboxField
                    config={config}
                    setConfig={setConfig}
                    issues={localIssues}
                    field="usePkcs1Padding"
                    label="使用 PKCS#1 padding"
                  />
                </>
              )}

              {selectedGroupId === 'advanced' && (
                <>
                  {isClientMode && (
                    <>
                      <CheckboxField config={config} setConfig={setConfig} issues={localIssues} field="zerocopy" label="Zero copy" />
                      <CheckboxField config={config} setConfig={setConfig} issues={localIssues} field="skipRxCopy" label="跳过接收拷贝" />
                    </>
                  )}
                  <CheckboxField config={config} setConfig={setConfig} issues={localIssues} field="debug" label="调试输出" />
                  {isClientMode && (
                    <>
                      <CheckboxField
                        config={config}
                        setConfig={setConfig}
                        issues={localIssues}
                        field="noFqSocketPacing"
                        label="禁用 FQ socket pacing"
                      />
                      <TextInput config={config} setConfig={setConfig} issues={localIssues} field="pacingTimer" label="Pacing timer" />
                      <TextInput config={config} setConfig={setConfig} issues={localIssues} field="fqRate" label="FQ rate" />
                      <TextInput config={config} setConfig={setConfig} issues={localIssues} field="clientPort" label="客户端端口" />
                      <TextInput config={config} setConfig={setConfig} issues={localIssues} field="connectTimeout" label="连接超时毫秒" />
                    </>
                  )}
                  <TextInput config={config} setConfig={setConfig} issues={localIssues} field="rcvTimeout" label="接收超时" />
                  <TextInput config={config} setConfig={setConfig} issues={localIssues} field="sndTimeout" label="发送超时" />
                  <label className="field full-span">
                    <ParameterLabel label="原始参数" description={getParameterHelp('rawArgs')} helpId="help-rawArgs" />
                    <textarea
                      value={config.rawArgs}
                      placeholder='--extra-data "rack a"'
                      onChange={(event) => setField(setConfig, 'rawArgs', event.target.value)}
                    />
                  </label>
                </>
              )}
            </div>
          </section>

          <aside className="run-panel">
            <div className="command-box">
              <div className="section-title">
                <TerminalSquare size={16} aria-hidden="true" />
                <span>命令预览</span>
                <button type="button" className="icon-button" onClick={handleCopyCommand} title="复制命令">
                  <Copy size={16} aria-hidden="true" />
                </button>
              </div>
              <pre>{command.preview}</pre>
              {commandIssues.length > 0 && (
                <div className="command-issues">
                  {commandIssues.map((issue, index) => (
                    <div key={`${issue.field}-${index}`} className={clsx('issue-row', issue.level)}>
                      {issue.level === 'error' ? <AlertTriangle size={15} /> : <BadgeInfo size={15} />}
                      <span>{issue.message}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {isServerMode && (
              <div className="ssh-box">
                <div className="section-title">
                  <Server size={16} aria-hidden="true" />
                  <span>SSH 目标</span>
                  <button type="button" className="icon-button" aria-label="复制 SSH 命令" onClick={handleCopySshCommand} title="复制 SSH 命令">
                    <Copy size={16} aria-hidden="true" />
                  </button>
                </div>
                <div className="ssh-target-row">
                  <input
                    aria-label="SSH 主机地址"
                    value={sshConfig.host}
                    placeholder="主机地址"
                    onChange={(event) => setSshField('host', event.target.value)}
                  />
                  <input
                    aria-label="SSH 用户名"
                    value={sshConfig.username}
                    placeholder="root"
                    onChange={(event) => setSshField('username', event.target.value)}
                  />
                  <input
                    aria-label="SSH 密码"
                    type="password"
                    value={sshConfig.password}
                    placeholder="密码"
                    onChange={(event) => setSshField('password', event.target.value)}
                  />
                </div>
              </div>
            )}

            <div className="run-actions">
              <button type="button" className="primary-action" onClick={handleStart} disabled={blockingIssues.length > 0 || isRunning}>
                <Play size={17} aria-hidden="true" />
                <span>运行</span>
              </button>
              <button type="button" className="secondary-action" onClick={handleStop} disabled={!isRunning}>
                <Square size={16} aria-hidden="true" />
                <span>停止</span>
              </button>
              <button
                type="button"
                className="secondary-action"
                onClick={handleClearOutput}
              >
                <PauseCircle size={16} aria-hidden="true" />
                <span>清空</span>
              </button>
            </div>
          </aside>
        </div>

        <section className="results-band">
          <div className="result-header">
            <div>
              <h2>结果与日志</h2>
            </div>
            <div className="result-toolbar">
              <div className="result-tabs" role="tablist" aria-label="结果视图">
                {[
                  { id: 'overview', label: '概览' },
                  { id: 'logs', label: '实时日志' },
                  { id: 'raw', label: '原始输出' },
                ].map((tab) => (
                  <button
                    key={tab.id}
                    type="button"
                    role="tab"
                    aria-selected={resultView === tab.id}
                    className={clsx(resultView === tab.id && 'active')}
                    onClick={() => setCurrentResultView(tab.id as ResultView)}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {resultView === 'overview' && (
            <>
              <div className="metrics-grid">
                <SummaryMetric label="协议" value={result.summary?.protocol ?? config.protocol.toUpperCase()} />
                <SummaryMetric
                  label="平均速率"
                  value={formatBitsPerSecond(result.summary?.bitsPerSecond ?? 0, rateUnit)}
                  unitValue={rateUnit}
                  unitOptions={RATE_UNIT_OPTIONS}
                  onUnitChange={(value) => setRateUnit(value as RateUnit)}
                />
                <SummaryMetric
                  label="传输量"
                  value={formatBytes(result.summary?.bytes ?? 0, byteUnit)}
                  unitValue={byteUnit}
                  unitOptions={BYTE_UNIT_OPTIONS}
                  onUnitChange={(value) => setByteUnit(value as ByteUnit)}
                />
                <SummaryMetric label="重传/丢包" value={result.summary?.retransmits !== undefined ? String(result.summary.retransmits) : `${result.summary?.lostPercent ?? 0}%`} />
              </div>

              <div className="chart-shell">
                <ResponsiveContainer width="100%" height={220}>
                  <AreaChart data={chartData} margin={{ top: 10, right: 18, left: 0, bottom: 0 }}>
                    <defs>
                      <linearGradient id="throughput" x1="0" x2="0" y1="0" y2="1">
                        <stop offset="5%" stopColor="#0f766e" stopOpacity={0.35} />
                        <stop offset="95%" stopColor="#0f766e" stopOpacity={0.02} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid stroke="#d9dee5" vertical={false} />
                    <XAxis dataKey="name" tickLine={false} axisLine={false} />
                    <YAxis tickLine={false} axisLine={false} width={48} />
                    <Tooltip />
                    <Area type="monotone" dataKey="rate" name={selectedChartRateUnit} stroke="#0f766e" fill="url(#throughput)" />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </>
          )}

          {resultView === 'logs' && (
            <div className="result-pre-shell log-view-shell">
              <div className="section-title">
                <FileJson size={16} aria-hidden="true" />
                <span>实时日志</span>
              </div>
              <pre ref={logPreRef} onScroll={handleLogScroll}>
                {logs.length
                  ? logs.map((event) => `[${event.kind}] ${event.message}`).join('\n')
                  : '等待运行。浏览器预览会使用示例 iperf3 JSON 输出。'}
              </pre>
              {showScrollToBottom && (
                <button type="button" className="scroll-bottom-button" onClick={scrollLogsToBottom}>
                  <ChevronDown size={16} aria-hidden="true" />
                  <span>到底部</span>
                </button>
              )}
            </div>
          )}

          {resultView === 'raw' && (
            <div className="result-pre-shell">
              <div className="section-title">
                <TerminalSquare size={16} aria-hidden="true" />
                <span>原始输出</span>
              </div>
              <pre>{result.rawText || '暂无原始输出。'}</pre>
            </div>
          )}
        </section>
      </section>

      {toast && (
        <button type="button" className="toast" onClick={() => setToast('')}>
          {toast}
        </button>
      )}

      <a className="doc-link" href="https://iperf.fr/iperf-doc.php" target="_blank" rel="noreferrer">
        <BookOpen size={15} aria-hidden="true" />
        <span>iperf.fr 文档</span>
      </a>
    </main>
  )
}

export default App
