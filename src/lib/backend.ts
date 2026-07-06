import { buildCommandPreview } from './command'
import { parseIperfOutput } from './results'
import type {
  BinaryResolution,
  CommandPreview,
  IperfConfig,
  IperfResult,
  RunEvent,
  RunSession,
  SavedProfile,
  SshConfig,
  ValidationIssue,
} from './types'

const PROFILE_KEY = 'iperf3-ui.profiles'
const mockEvents = new Map<string, RunEvent[]>()

function isTauriRuntime() {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

async function invokeCommand<T>(command: string, payload?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<T>(command, payload)
}

function loadLocalProfiles(): SavedProfile[] {
  try {
    return JSON.parse(localStorage.getItem(PROFILE_KEY) ?? '[]') as SavedProfile[]
  } catch {
    return []
  }
}

function saveLocalProfiles(profiles: SavedProfile[]) {
  localStorage.setItem(PROFILE_KEY, JSON.stringify(profiles))
}

function mockIperfJson(): string {
  return JSON.stringify(
    {
      start: { test_start: { protocol: 'TCP' } },
      intervals: [
        { sum: { start: 0, end: 1, seconds: 1, bytes: 11812000, bits_per_second: 94496000, retransmits: 0 } },
        { sum: { start: 1, end: 2, seconds: 1, bytes: 12501000, bits_per_second: 100008000, retransmits: 1 } },
        { sum: { start: 2, end: 3, seconds: 1, bytes: 13107000, bits_per_second: 104856000, retransmits: 0 } },
      ],
      end: {
        sum_received: { seconds: 3, bytes: 37420000, bits_per_second: 99786666.67, retransmits: 1 },
        cpu_utilization_percent: { host_total: 4.2, remote_total: 3.8 },
      },
    },
    null,
    2,
  )
}

export async function resolveBinary(customBinaryPath: string): Promise<BinaryResolution> {
  if (isTauriRuntime()) {
    return invokeCommand<BinaryResolution>('resolve_binary', { customPath: customBinaryPath })
  }
  return {
    path: customBinaryPath || 'iperf3',
    source: customBinaryPath ? 'custom' : 'path',
    exists: false,
    version: 'browser preview',
  }
}

export async function selectIperfBinary(): Promise<string | undefined> {
  if (isTauriRuntime()) {
    return invokeCommand<string | null>('select_iperf_binary').then((value) => value ?? undefined)
  }
  return undefined
}

export async function validateConfigRemote(config: IperfConfig): Promise<ValidationIssue[]> {
  if (isTauriRuntime()) {
    return invokeCommand<ValidationIssue[]>('validate_config', { config })
  }
  return buildCommandPreview(config).issues
}

export async function buildCommand(config: IperfConfig): Promise<CommandPreview> {
  if (isTauriRuntime()) {
    return invokeCommand<CommandPreview>('build_command', { config })
  }
  return buildCommandPreview(config, config.customBinaryPath || 'iperf3')
}

export async function startRun(config: IperfConfig): Promise<RunSession> {
  if (isTauriRuntime()) {
    return invokeCommand<RunSession>('start_run', { config })
  }
  const command = buildCommandPreview(config, config.customBinaryPath || 'iperf3')
  const id = `mock-${Date.now()}`
  const now = new Date().toISOString()
  mockEvents.set(id, [
    {
      id: `${id}-1`,
      sessionId: id,
      kind: 'status',
      timestamp: now,
      message: 'Browser preview: Tauri runtime is not available, using sample iperf3 output.',
    },
    {
      id: `${id}-2`,
      sessionId: id,
      kind: 'stdout',
      timestamp: now,
      message: mockIperfJson(),
    },
    {
      id: `${id}-3`,
      sessionId: id,
      kind: 'exit',
      timestamp: now,
      message: 'Mock run completed.',
    },
  ])
  return { id, command, startedAt: now, status: 'running' }
}

export async function startSshCommand(ssh: SshConfig, config: IperfConfig): Promise<RunSession> {
  if (isTauriRuntime()) {
    return invokeCommand<RunSession>('start_ssh_run', { ssh, config })
  }
  const id = `mock-ssh-${Date.now()}`
  const now = new Date().toISOString()
  const command = buildCommandPreview({ ...config, mode: 'server' }, 'iperf3')
  const target = `${ssh.username || 'root'}@${ssh.host || 'host'}`
  mockEvents.set(id, [
    {
      id: `${id}-1`,
      sessionId: id,
      kind: 'status',
      timestamp: now,
      message: `Browser preview: ssh ${target} "${command.preview}"`,
    },
    {
      id: `${id}-2`,
      sessionId: id,
      kind: 'exit',
      timestamp: now,
      message: 'Mock ssh run completed.',
    },
  ])
  return {
    id,
    command: { binary: 'ssh', args: [target, command.preview], preview: `ssh ${target} "${command.preview}"`, issues: [] },
    startedAt: now,
    status: 'running',
  }
}

export async function stopRun(sessionId: string): Promise<void> {
  if (isTauriRuntime()) {
    await invokeCommand('stop_run', { sessionId })
  }
}

export async function getRunEvents(sessionId: string): Promise<RunEvent[]> {
  if (isTauriRuntime()) {
    return invokeCommand<RunEvent[]>('get_run_events', { sessionId })
  }
  return mockEvents.get(sessionId) ?? []
}

export async function saveProfile(profile: SavedProfile): Promise<SavedProfile[]> {
  if (isTauriRuntime()) {
    return invokeCommand<SavedProfile[]>('save_profile', { profile })
  }
  const profiles = loadLocalProfiles().filter((item) => item.id !== profile.id)
  profiles.unshift(profile)
  saveLocalProfiles(profiles)
  return profiles
}

export async function renameProfile(id: string, name: string): Promise<SavedProfile[]> {
  if (isTauriRuntime()) {
    return invokeCommand<SavedProfile[]>('rename_profile', { id, name })
  }
  const profiles = loadLocalProfiles().map((profile) => (profile.id === id ? { ...profile, name } : profile))
  saveLocalProfiles(profiles)
  return profiles
}

export async function deleteProfile(id: string): Promise<SavedProfile[]> {
  if (isTauriRuntime()) {
    return invokeCommand<SavedProfile[]>('delete_profile', { id })
  }
  const profiles = loadLocalProfiles().filter((profile) => profile.id !== id)
  saveLocalProfiles(profiles)
  return profiles
}

export async function loadProfiles(): Promise<SavedProfile[]> {
  if (isTauriRuntime()) {
    return invokeCommand<SavedProfile[]>('load_profiles')
  }
  return loadLocalProfiles()
}

export async function profilesStoragePath(): Promise<string> {
  if (isTauriRuntime()) {
    return invokeCommand<string>('profiles_storage_path')
  }
  return 'localStorage: iperf3-ui.profiles'
}

export async function exportResult(result: IperfResult, format: 'json' | 'csv' | 'txt'): Promise<string> {
  if (isTauriRuntime()) {
    return invokeCommand<string>('export_result', { result, format })
  }

  const payload =
    format === 'json'
      ? JSON.stringify(result.rawJson ?? result, null, 2)
      : format === 'csv'
        ? ['start,end,seconds,bits_per_second,retransmits,jitter_ms,lost_percent']
            .concat(
              result.intervals.map((row) =>
                [
                  row.start,
                  row.end,
                  row.seconds,
                  row.bitsPerSecond,
                  row.retransmits ?? '',
                  row.jitterMs ?? '',
                  row.lostPercent ?? '',
                ].join(','),
              ),
            )
            .join('\n')
        : result.rawText

  const blob = new Blob([payload], { type: 'text/plain;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `iperf3-result.${format}`
  link.click()
  URL.revokeObjectURL(url)
  return `downloaded iperf3-result.${format}`
}

export function resultFromEvents(events: RunEvent[]) {
  return parseIperfOutput(
    events
      .filter((event) => event.kind === 'stdout' || event.kind === 'stderr')
      .map((event) => event.message),
  )
}
