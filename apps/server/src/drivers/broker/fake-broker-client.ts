/**
 * Deterministic, in-memory {@link BrokerClient} seeded from fixtures
 * (ARCHITECTURE.md §9). Touches no network, no socket, no real Docker
 * daemon. **The default in development mode** — see
 * `create-broker-client.ts` — so the panel is fully developable on a
 * machine with no Docker at all, and a developer cannot restart their
 * own containers by accident.
 */
import { Readable } from 'node:stream';
import {
  DMS_ENV_KEYS,
  type DmsConfigFileKey,
  type DmsExecResponse,
  computeProtectedVolumeNames,
  type BackupVolumeKey,
  type ConsoleCommand,
  type ConsoleExecResponse,
  type ContainerInspectResponse,
  type ContainerLogLine,
  type ContainerStatsResponse,
  type ContainerSummary,
  type ImagePruneResponse,
  type ImageSummary,
  type LogFileSource,
  type NetworkSummary,
  type SystemDfResponse,
  type SystemInfoResponse,
  type SystemPingResponse,
  type SystemVersionResponse,
  type VolumeSummary,
} from '@dwg/shared';
import {
  BrokerRequestError,
  type BrokerClient,
  type ContainerListParams,
  type ContainerLogsParams,
  type LogsFileParams,
} from './types.js';
import type { DmsCommandRequest } from '../dms/exec-port.js';
import {
  FIXTURE_DMS_ENV,
  FIXTURE_DOVECOT_QUOTAS_CF,
  FIXTURE_POSTFIX_ACCOUNTS_CF,
  FIXTURE_POSTFIX_RECEIVE_ACCESS_CF,
  FIXTURE_POSTFIX_SEND_ACCESS_CF,
  FIXTURE_POSTFIX_VIRTUAL_CF,
} from '../dms/fixtures/index.js';

/** The same captured `.cf` fixtures `FakeDmsDriver` parses, keyed by the broker's own symbolic file keys. */
const FIXTURE_DMS_CONFIG_FILES: Record<DmsConfigFileKey, string> = {
  'postfix-accounts': FIXTURE_POSTFIX_ACCOUNTS_CF,
  'postfix-virtual': FIXTURE_POSTFIX_VIRTUAL_CF,
  'dovecot-quotas': FIXTURE_DOVECOT_QUOTAS_CF,
  'postfix-send-access': FIXTURE_POSTFIX_SEND_ACCESS_CF,
  'postfix-receive-access': FIXTURE_POSTFIX_RECEIVE_ACCESS_CF,
};
import {
  FIXTURE_CONSOLE_OUTPUTS,
  FIXTURE_CONTAINERS,
  FIXTURE_CONTAINER_INSPECT_RUNNING,
  FIXTURE_CONTAINER_INSPECT_STOPPED,
  FIXTURE_CONTAINER_MOUNTS,
  FIXTURE_CONTAINER_STATS,
  FIXTURE_FAIL2BAN_LOG_LINES,
  FIXTURE_IMAGES,
  FIXTURE_IMAGE_PRUNE_RESULT,
  FIXTURE_LOG_LINES,
  FIXTURE_MAIL_LOG_LINES,
  FIXTURE_NETWORKS,
  FIXTURE_SYSTEM_DF,
  FIXTURE_SYSTEM_INFO,
  FIXTURE_SYSTEM_PING,
  FIXTURE_SYSTEM_VERSION,
  FIXTURE_VOLUMES,
  buildFixtureVolumeTar,
} from './fixtures/index.js';

const FIXTURE_LOG_FILE_LINES: Readonly<Record<LogFileSource, readonly string[]>> = {
  mail: FIXTURE_MAIL_LOG_LINES,
  fail2ban: FIXTURE_FAIL2BAN_LOG_LINES,
};

export class FakeBrokerClient implements BrokerClient {
  /**
   * The one piece of mutable state this fake tracks: start/stop/restart
   * observably change what a following `containerInspect()`/
   * `containerList()` reports, which is what makes the fake usable for
   * exercising a UI flow ("stop, see it go to exited, start it again")
   * rather than only ever returning one frozen snapshot.
   */
  private running = true;

  async containerList(params: ContainerListParams = {}): Promise<readonly ContainerSummary[]> {
    const all = params.all ?? false;
    const containers = FIXTURE_CONTAINERS.map((container) => ({
      ...container,
      state: this.running ? container.state : 'exited',
      status: this.running ? container.status : 'Exited (0) 2 minutes ago',
    }));
    return all ? containers : containers.filter((c) => c.state === 'running');
  }

  async containerInspect(): Promise<ContainerInspectResponse> {
    return this.running ? FIXTURE_CONTAINER_INSPECT_RUNNING : FIXTURE_CONTAINER_INSPECT_STOPPED;
  }

  async containerStart(): Promise<void> {
    this.running = true;
  }

  async containerStop(): Promise<void> {
    this.running = false;
  }

  async containerRestart(): Promise<void> {
    this.running = true;
  }

  async containerStats(): Promise<ContainerStatsResponse> {
    return { ...FIXTURE_CONTAINER_STATS, sampledAt: new Date().toISOString() };
  }

  async containerLogs(params: ContainerLogsParams = {}): Promise<readonly ContainerLogLine[]> {
    const tail = params.tail ?? FIXTURE_LOG_LINES.length;
    return FIXTURE_LOG_LINES.slice(-tail);
  }

  async systemPing(): Promise<SystemPingResponse> {
    return FIXTURE_SYSTEM_PING;
  }

  async systemVersion(): Promise<SystemVersionResponse> {
    return FIXTURE_SYSTEM_VERSION;
  }

  async systemInfo(): Promise<SystemInfoResponse> {
    return FIXTURE_SYSTEM_INFO;
  }

  async systemDf(): Promise<SystemDfResponse> {
    return FIXTURE_SYSTEM_DF;
  }

  async imageList(): Promise<readonly ImageSummary[]> {
    return FIXTURE_IMAGES;
  }

  async volumeList(): Promise<readonly VolumeSummary[]> {
    return FIXTURE_VOLUMES;
  }

  async networkList(): Promise<readonly NetworkSummary[]> {
    return FIXTURE_NETWORKS;
  }

  /**
   * Mirrors the real broker's own `volume.remove` handler
   * (`apps/broker/src/operations.ts`) exactly: re-derive the protected set
   * from the managed container's current mounts and refuse — via the same
   * {@link BrokerRequestError} `RealBrokerClient` would throw for the
   * broker's `403 FORBIDDEN` — rather than silently succeeding. This is
   * what makes "deleting a protected DMS volume is refused" testable in
   * development/test mode, where this fake is the active driver.
   */
  async volumeRemove(name: string): Promise<void> {
    const protectedNames = computeProtectedVolumeNames(FIXTURE_CONTAINER_MOUNTS);
    if (protectedNames.has(name)) {
      throw new BrokerRequestError(
        403,
        'This volume backs a protected mail-data mount and cannot be removed.',
      );
    }
    // Nothing to actually mutate — FIXTURE_VOLUMES is a static list, same
    // as every other fixture-backed read in this class.
  }

  async imagePrune(): Promise<ImagePruneResponse> {
    return FIXTURE_IMAGE_PRUNE_RESULT;
  }

  async logsFile(source: LogFileSource, params: LogsFileParams = {}): Promise<readonly string[]> {
    const lines = FIXTURE_LOG_FILE_LINES[source];
    const tail = params.tail ?? lines.length;
    return lines.slice(-tail);
  }

  async consoleExec(command: ConsoleCommand): Promise<ConsoleExecResponse> {
    return FIXTURE_CONSOLE_OUTPUTS[command];
  }

  /** A small, deterministic, hand-built tar per volume key (`fixtures/archive.ts` — labelled there as constructed, not captured; there is no Docker daemon here to capture from). Real enough to exercise manifest generation and restore's round trip end to end without a broker. */
  async archiveGet(volumeKey: BackupVolumeKey): Promise<NodeJS.ReadableStream> {
    return Readable.from([buildFixtureVolumeTar(volumeKey)]);
  }

  /** Nothing to actually write — same "static fixture, no real backing store" shape as `volumeRemove` above. Still fully drains `tarStream`, matching what a real archive write would do, so a caller awaiting this in a loop behaves identically against either driver. */
  async archivePut(_volumeKey: BackupVolumeKey, tarStream: NodeJS.ReadableStream): Promise<void> {
    for await (const _chunk of tarStream) {
      // Drain only — see the doc comment above.
    }
  }

  // -------------------------------------------------------------------------
  // M16 — docker-mailserver.
  //
  // The three *reads* below return the same fixtures `FakeDmsDriver` parses,
  // so `RealDmsDriver` + `BrokerDmsExecPort` + this client compose into a
  // genuinely exercisable stack with no Docker daemon — which is what
  // `real-dms-driver.broker.test.ts` uses to prove the adapter actually
  // speaks the operations it claims to.
  //
  // `dmsCommand` deliberately refuses instead. Simulating the *output* of 26
  // real DMS commands is `FakeDmsDriver`'s entire job, and it does it against
  // captured fixtures; a second, thinner imitation living here would be a
  // fixture set nobody maintains, quietly diverging from the one that is
  // actually used. Development never reaches this method — `createDmsDriver`
  // returns `FakeDmsDriver` whenever the real drivers are off — so this is a
  // loud failure on a path that should not exist, not a limitation anyone hits.
  // -------------------------------------------------------------------------

  async dmsFileRead(file: DmsConfigFileKey): Promise<string | null> {
    return FIXTURE_DMS_CONFIG_FILES[file];
  }

  async dmsEnvRead(): Promise<Readonly<Record<string, string>>> {
    const env: Record<string, string> = {};
    for (const key of DMS_ENV_KEYS) {
      const value = FIXTURE_DMS_ENV[key];
      if (value !== undefined) env[key] = value;
    }
    return env;
  }

  /** No DKIM key has been generated in the fixture deployment — `null` is the honest answer, and the one that exercises the "not generated" branch. */
  async dmsDkimRecordRead(_domain: string, _selector: string): Promise<string | null> {
    return null;
  }

  async dmsCommand(request: DmsCommandRequest): Promise<DmsExecResponse> {
    throw new Error(
      `FakeBrokerClient does not simulate DMS command execution (asked for "${request.operation}"). ` +
        'Development uses FakeDmsDriver, which models these operations against captured fixtures; ' +
        "see this method's own comment for why a second imitation does not live here.",
    );
  }
}
