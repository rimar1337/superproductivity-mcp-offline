/**
 * Super Productivity stores operations with two-to-three character action codes
 * instead of full NgRx action names, to keep the sync file small.
 *
 * These codes are a **frozen wire format**. Upstream's own header says it
 * loudly: "NEVER change or reassign existing codes. They are persisted in
 * IndexedDB and used for sync." Emitting the wrong code is not a rendering bug
 * — it dispatches a different reducer on the user's other devices.
 *
 * The map is transcribed from
 * `src/app/op-log/persistence/compact/action-type-codes.ts`. It is complete
 * rather than limited to the codes we emit, because reading it back is how the
 * history and status tools explain what other devices have been doing.
 */

/** Every action code this server may write. Deliberately a narrow subset. */
export const EMITTED_ACTION_CODE = {
  /** `[Task Shared] addTask` — create a task. */
  taskAdd: 'HA',
  /** `[Task Shared] updateTask` — patch a task (title, notes, isDone, …). */
  taskUpdate: 'HU',
  /** `[Task Shared] deleteTask` — delete a task and its subtasks. */
  taskDelete: 'HD',
  /** `[Task Shared] scheduleTaskWithTime` — set a timed due date. */
  taskScheduleWithTime: 'HS',
  /** `[Task Shared] unscheduleTask` — clear a timed due date. */
  taskUnschedule: 'HSX',
  /** `[Task Shared] planTasksForToday` — move tasks into Today. */
  taskPlanForToday: 'HPT',
  /** `[Task Shared] removeTasksFromTodayTag` — take tasks out of Today. */
  taskRemoveFromToday: 'HRT',
  /** `[Task Shared] moveToArchive` — archive completed tasks. */
  taskMoveToArchive: 'HX',
  /** `[Project] addProject` — create a project. */
  projectAdd: 'PA',
  /** `[Project] updateProject` — patch a project. */
  projectUpdate: 'PU',
  /** `[Tag] addTag` — create a tag. */
  tagAdd: 'GA',
  /** `[Tag] updateTag` — patch a tag. */
  tagUpdate: 'GU',
} as const;

export type EmittedActionCode =
  (typeof EMITTED_ACTION_CODE)[keyof typeof EMITTED_ACTION_CODE];

/**
 * Full code → human-readable action name, for explaining a sync file's history.
 *
 * Unknown codes are returned unchanged by {@link describeActionCode}, matching
 * upstream's `decodeActionType`: a newer Super Productivity may write codes this
 * release has never heard of, and that is not an error.
 */
export const ACTION_CODE_DESCRIPTIONS: Readonly<Record<string, string>> = {
  // Archive
  AC: 'Archive compress',
  AF: 'Archive flush young to old',
  AR: 'Archive remote data applied',
  // Boards
  BA: 'Board added',
  BD: 'Board removed',
  BU: 'Board updated',
  BP: 'Board panel config updated',
  BT: 'Board panel task ids updated',
  BS: 'Boards sorted',
  // Global config
  CU: 'Global config section updated',
  // Metrics
  EA: 'Metric added',
  ED: 'Metric deleted',
  EU: 'Metric updated',
  EX: 'Metric upserted',
  EL: 'Focus session logged',
  // Tags
  GA: 'Tag created',
  GU: 'Tag updated',
  GD: 'Tag deleted',
  GDM: 'Multiple tags deleted',
  GO: 'Tag order updated',
  GC: 'Tag advanced config updated',
  // Task shared (multi-entity)
  HA: 'Task created',
  HU: 'Task updated',
  HD: 'Task deleted',
  HDM: 'Multiple tasks deleted',
  HX: 'Task moved to archive',
  HR: 'Task restored from archive',
  HRD: 'Deleted task restored',
  HCS: 'Task converted to subtask',
  HC: 'Subtask converted to task',
  HS: 'Task scheduled with time',
  HSR: 'Task rescheduled',
  HSX: 'Task unscheduled',
  HRX: 'Reminder dismissed',
  HUM: 'Multiple tasks updated',
  HMP: 'Task moved to project',
  HPD: 'Project deleted (tasks)',
  HPT: 'Task planned for today',
  HRT: 'Task removed from today',
  HGT: 'Tag added to task',
  HGR: 'All tags removed from task',
  HMT: 'Task reordered in today',
  HBP: 'Tasks batch-updated in project',
  HID: 'Issue provider deleted (tasks)',
  HIM: 'Issue providers deleted (tasks)',
  HRC: 'Repeat config deleted (tasks)',
  HSS: 'Short syntax applied',
  HDL: 'Deadline set',
  HDT: 'Deadline planned for today',
  HXD: 'Deadline removed',
  HCR: 'Deadline reminder cleared',
  // Issue providers
  IA: 'Issue provider added',
  IU: 'Issue provider updated',
  IS: 'Issue provider sorted first',
  // Time tracking
  KS: 'Time tracking sessions synced',
  KT: 'Time spent synced',
  KW: 'Work context data updated',
  // Planner
  LU: 'Planner day upserted',
  LT: 'Planner task transferred',
  LM: 'Planner item moved in list',
  LB: 'Planner item moved before task',
  LP: 'Task planned for day',
  // Menu tree
  MP: 'Menu tree project updated',
  MG: 'Menu tree tag updated',
  MU: 'Menu tree folder updated',
  MD: 'Menu tree folder deleted',
  // Notes
  NA: 'Note added',
  NU: 'Note updated',
  ND: 'Note deleted',
  NO: 'Note order updated',
  NM: 'Note moved to project',
  // Projects
  PA: 'Project created',
  PU: 'Project updated',
  PO: 'Project order updated',
  PC: 'Project advanced config updated',
  PX: 'Project archived',
  PR: 'Project unarchived',
  PCO: 'Project completed',
  PRO: 'Project reopened',
  PH: 'Project visibility toggled',
  PM: 'Task moved in backlog',
  PMU: 'Task moved up in backlog',
  PMD: 'Task moved down in backlog',
  PMT: 'Task moved to top of backlog',
  PMB: 'Task moved to bottom of backlog',
  PRB: 'Task moved to backlog',
  PBR: 'Task moved from backlog',
  PAB: 'Task auto-moved to backlog',
  PAR: 'Task auto-moved from backlog',
  PBA: 'All backlog tasks moved',
  // Repeat configs
  RA: 'Repeat config added',
  RU: 'Repeat config updated',
  RUM: 'Multiple repeat configs updated',
  RD: 'Repeat config deleted',
  RDM: 'Multiple repeat configs deleted',
  RDI: 'Repeat instance deleted',
  RX: 'Repeat config upserted',
  // Sections
  S1: 'Section added',
  S2: 'Section deleted',
  S3: 'Section updated',
  S4: 'Section order updated',
  S5: 'Task added to section',
  S6: 'Task removed from section',
  // Simple counters
  SA: 'Counter added',
  SU: 'Counter updated',
  SUS: 'Counter upserted',
  SD: 'Counter deleted',
  SDM: 'Multiple counters deleted',
  SUA: 'All counters updated',
  ST: 'Counter set for today',
  SI: 'Counter increased today',
  SX: 'Counter decreased today',
  SG: 'Counter toggled',
  SO: 'All counters turned off',
  SF: 'Counter set off',
  SN: 'Counter set on',
  SFD: 'Counter set for date',
  SC: 'Counter time synced',
  SM: 'Counter order updated',
  // Tasks (single-entity)
  TU: 'Multiple tasks updated (simple)',
  TA: 'Subtask added',
  TMS: 'Subtask moved',
  TMU: 'Task moved up',
  TMD: 'Task moved down',
  TMT: 'Task moved to top',
  TMB: 'Task moved to bottom',
  TR: 'Time spent removed',
  TRD: 'Time spent rounded',
  TGS: 'Tags added via short syntax',
  TUU: 'Task UI state updated',
  // Plugins
  UU: 'Plugin user data upserted',
  UD: 'Plugin user data deleted',
  UM: 'Plugin metadata upserted',
  UDM: 'Plugin metadata deleted',
  // Work context ordering
  WMU: 'Work context item moved up',
  WMD: 'Work context item moved down',
  WMT: 'Work context item moved to top',
  WMB: 'Work context item moved to bottom',
  WM: 'Work context item moved',
  // Attachments
  XA: 'Attachment added',
  XU: 'Attachment updated',
  XD: 'Attachment deleted',
  // System
  YL: 'All data loaded',
  YB: 'Backup data loaded',
  YM: 'Migration genesis import',
  YR: 'Recovery data import',
  ZR: 'Automatic repair',
};

/**
 * Human-readable label for an action code, falling back to the raw code.
 *
 * The fallback is intentional: a Super Productivity release newer than this one
 * will write codes we have never seen, and showing the code beats pretending
 * the entry does not exist.
 */
export const describeActionCode = (code: string): string =>
  ACTION_CODE_DESCRIPTIONS[code] ?? code;
