/**
 * Health centre service (M9 — FEATURE_MATRIX.md §26). Three checks —
 * broker connectivity, the managed container's own state, and general
 * Docker daemon reachability — each independently fetched and
 * independently allowed to fail, per the milestone brief: "never infer one
 * check's state from another's."
 *
 * Concretely, that rule means every `checkXxx` method below makes its own
 * broker call inside its own `try`/`catch` and stamps its own `checkedAt`
 * at the moment *it* resolves — never a shared "is the broker up" flag
 * gating the others, and never one shared timestamp for the whole
 * response. `Promise.all` runs the three concurrently, but each promise
 * always resolves to a `HealthCheck` (never rejects) precisely so one
 * check's failure can never affect whether the others even run, let alone
 * what they report. A test that makes `systemPing` reject while
 * `containerInspect`/`systemInfo` still resolve — a real possibility if,
 * say, the Docker Engine's `/ping` handler alone were misbehaving — must
 * see exactly one check go critical/unknown and the other two report their
 * own honestly-observed state.
 */
import type { HealthCheck, HealthCheckId } from '@dwg/shared';
import type { BrokerClient } from '../../drivers/broker/types.js';

function timestamp(): string {
  return new Date().toISOString();
}

function healthy(id: HealthCheckId, label: string): HealthCheck {
  return { id, label, state: 'healthy', message: null, checkedAt: timestamp() };
}

export class HealthService {
  constructor(private readonly broker: BrokerClient) {}

  async getChecks(): Promise<readonly HealthCheck[]> {
    const [broker, managedContainer, dockerDaemon] = await Promise.all([
      this.checkBroker(),
      this.checkManagedContainer(),
      this.checkDockerDaemon(),
    ]);
    return [broker, managedContainer, dockerDaemon];
  }

  private async checkBroker(): Promise<HealthCheck> {
    const label = 'Broker connectivity';
    try {
      await this.broker.systemPing();
      return healthy('broker', label);
    } catch {
      return {
        id: 'broker',
        label,
        state: 'critical',
        message: 'The Docker broker did not respond to a ping.',
        checkedAt: timestamp(),
      };
    }
  }

  private async checkManagedContainer(): Promise<HealthCheck> {
    const label = 'Mail container';
    try {
      const inspect = await this.broker.containerInspect();
      if (!inspect.state.running) {
        return {
          id: 'managed-container',
          label,
          state: 'critical',
          message: `Container is not running (status: ${inspect.state.status}).`,
          checkedAt: timestamp(),
        };
      }
      if (inspect.state.health === 'unhealthy') {
        return {
          id: 'managed-container',
          label,
          state: 'critical',
          message: "Container's own healthcheck reports unhealthy.",
          checkedAt: timestamp(),
        };
      }
      if (inspect.state.health === 'starting') {
        return {
          id: 'managed-container',
          label,
          state: 'warning',
          message: "Container's own healthcheck is still starting.",
          checkedAt: timestamp(),
        };
      }
      return healthy('managed-container', label);
    } catch {
      return {
        id: 'managed-container',
        label,
        state: 'unknown',
        message: 'Could not determine the managed container state.',
        checkedAt: timestamp(),
      };
    }
  }

  private async checkDockerDaemon(): Promise<HealthCheck> {
    const label = 'Docker daemon';
    try {
      await this.broker.systemInfo();
      return healthy('docker-daemon', label);
    } catch {
      return {
        id: 'docker-daemon',
        label,
        state: 'unknown',
        message: 'Could not reach the Docker daemon for system information.',
        checkedAt: timestamp(),
      };
    }
  }
}
