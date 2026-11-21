/** Application boundary for the desktop adapter. Times are Unix seconds. */
export type Page = "home" | "calendar" | "focus" | "notes" | "flow" | "activity";
export type StudyDay = string; // Local YYYY-MM-DD, validated by the adapter.
export interface Task {
  id: string;
  title: string;
  course: string;
  estimatedSeconds: number | null;
  completedAt: number | null;
}
export interface ScheduleBlock {
  id: string;
  taskId: string;
  startsAt: number;
  plannedSeconds: number;
}
export interface FocusSession {
  id: string;
  taskId: string | null;
  state: "running" | "paused" | "finished";
  plannedSeconds: number;
  elapsedSeconds: number; // Accumulated at last transition.
  startedAt: number;
  stateChangedAt: number;
  revision: number;
}
type BlockContent =
  | { kind: "text" | "question" | "thought" | "workflow"; title: string; body: string }
  | { kind: "task_ref"; taskId: string };
export type NoteBlock = { id: string } & BlockContent;
export interface DayNote {
  id: string;
  studyDate: StudyDay;
  title: string;
  revision: number;
  blocks: readonly NoteBlock[]; // Document order, mapped to note_blocks.position.
}
export interface TaskNote {
  body: string;
  revision: number;
}
export interface WorkbenchView {
  pending: readonly Task[];
  completedOnDay: readonly Task[];
  scheduled: readonly (ScheduleBlock & { task: Task })[];
  note: DayNote | null;
  openFocus: FocusSession | null;
  focusSummary: { finishedSessions: number; elapsedSeconds: number };
}
/** Caller supplies stable creation IDs so an interrupted request can be retried. */
export type Command =
  | { type: "createTask"; id: string; title: string; course: string; estimatedSeconds: number | null }
  | { type: "setTaskCompleted"; taskId: string; completed: boolean }
  | { type: "saveSchedule"; block: ScheduleBlock }
  | { type: "removeSchedule"; blockId: string }
  | { type: "startFocus"; id: string; taskId: string | null; plannedSeconds: number }
  | { type: "changeFocus"; id: string; expectedRevision: number; action: "pause" | "resume" | "finish" }
  | { type: "saveDayNote"; note: Omit<DayNote, "revision">; expectedRevision: number | null }
  | { type: "saveTaskNote"; taskId: string; body: string; expectedRevision: number };
export type CommandResult =
  | { ok: true }
  | { ok: false; reason: "invalid" | "missing" | "conflict" | "storage" };
export interface Workbench {
  readDay(day: StudyDay, timeZone: string): Promise<WorkbenchView>;
  readTaskNote(taskId: string): Promise<TaskNote>;
  execute(command: Command): Promise<CommandResult>;
}
