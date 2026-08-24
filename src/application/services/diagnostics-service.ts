import { describeActionCode } from '../../domain/sync/action-codes.js';
import type { Workspace } from '../workspace.js';

/**
 * Answers "is this thing actually in sync, and with what?".
 *
 * Worth a tool of its own because every confusing symptom this integration can
 * produce — a task that does not appear on the phone, an edit that seems to
 * vanish, a stale-looking list — resolves to one of three facts: which layout
 * the folder uses, which devices have written to it, and whether anything in
 * the operation log could not be replayed. Guessing at those from the outside
 * is miserable; reporting them is cheap.
 */

export interface DeviceActivity {
  readonly clientId: string;
  readonly isThisServer: boolean;
  /** The device's counter in the shared vector clock. */
  readonly clockValue: number;
  readonly recentOperations: number;
}

export interface SyncStatus {
  readonly layout: string;
  readonly syncVersion: number;
  readonly schemaVersion: number;
  readonly lastModified: string;
  readonly lastWrittenBy: string;
  readonly thisServerClientId: string;
  readonly mode: 'read-only' | 'read-write';
  readonly isEncrypted: boolean;
  readonly devices: readonly DeviceActivity[];
  readonly operationLog: {
    readonly retained: number;
    readonly capacity: number;
  };
  /**
   * Present only when something needs the user's attention. Absent means
   * healthy — a caller can branch on its existence rather than parsing prose.
   */
  readonly warnings?: readonly string[];
}

export interface RecentOperation {
  readonly at: string;
  readonly by: string;
  readonly action: string;
  readonly entityType: string;
  readonly entityId?: string;
}

export class DiagnosticsService {
  constructor(
    private readonly workspace: Workspace,
    private readonly options: {
      readonly clientId: string;
      readonly mode: 'read-only' | 'read-write';
      readonly isEncrypted: boolean;
      readonly operationLogCapacity: number;
    },
  ) {}

  async status(): Promise<SyncStatus> {
    const view = await this.workspace.read({ forceRefresh: true });
    const { snapshot, diagnostics } = view;

    const operationsByClient = new Map<string, number>();
    for (const op of snapshot.recentOps) {
      operationsByClient.set(op.c, (operationsByClient.get(op.c) ?? 0) + 1);
    }

    const devices: DeviceActivity[] = Object.entries(snapshot.vectorClock)
      .map(([clientId, clockValue]) => ({
        clientId,
        isThisServer: clientId === this.options.clientId,
        clockValue,
        recentOperations: operationsByClient.get(clientId) ?? 0,
      }))
      .sort((left, right) => right.clockValue - left.clockValue);

    const warnings: string[] = [];
    if (diagnostics.unhandledActionCodes.length > 0) {
      warnings.push(
        'Some operations in the log could not be replayed, so the view may be ' +
          `incomplete: ${diagnostics.unhandledActionCodes.join(', ')}. ` +
          'Open Super Productivity and let it sync once to compact the log.',
      );
    }
    const remaining = this.options.operationLogCapacity - snapshot.recentOps.length;
    if (remaining < 100) {
      warnings.push(
        `The operation log is nearly full (${snapshot.recentOps.length} of ` +
          `${this.options.operationLogCapacity}). Open Super Productivity to compact it.`,
      );
    }

    return {
      layout: snapshot.layout,
      syncVersion: snapshot.syncVersion,
      schemaVersion: snapshot.schemaVersion,
      lastModified: new Date(snapshot.lastModified).toISOString(),
      lastWrittenBy: snapshot.clientId,
      thisServerClientId: this.options.clientId,
      mode: this.options.mode,
      isEncrypted: this.options.isEncrypted,
      devices,
      operationLog: {
        retained: snapshot.recentOps.length,
        capacity: this.options.operationLogCapacity,
      },
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  }

  /** The tail of the operation log, in plain language. */
  async recentOperations(limit = 20): Promise<RecentOperation[]> {
    const view = await this.workspace.read();
    return view.snapshot.recentOps
      .slice(-limit)
      .reverse()
      .map((op) => ({
        at: new Date(op.t).toISOString(),
        by: op.c,
        action: describeActionCode(op.a),
        entityType: op.e,
        ...(op.d === undefined ? {} : { entityId: op.d }),
      }));
  }
}
