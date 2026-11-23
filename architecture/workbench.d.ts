/** Application boundary for the desktop adapter. Times are Unix seconds. */
export type Page = "home" | "calendar" | "focus" | "activity" | "review" | "ai";
export type StudyDay = string; // Workbench-time-zone YYYY-MM-DD (Asia/Shanghai by default).
export interface Task {
  id: string;
  title: string;
  course: string; // '日计划' = plan-only item; '长期项目' = a project's main task.
  estimatedSeconds: number | null;
  completedAt: number | null;
  projectId: string | null; // v2
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

// ------------------------------------------------------------- v2: 长期项目
export interface Project {
  id: string;
  title: string;
  goal: string;
  startDay: StudyDay;
  dueDay: StudyDay | null;      // null = 无截止
  dailyMinutes: number | null;  // 每天计划投入分钟
  mainTaskId: string;           // 自动建的主任务（course='长期项目'），日计划/专注/正文都用它
  createdAt: number;
  completedAt: number | null;
  archivedAt: number | null;
}
export interface ProjectLog { day: StudyDay; note: string; progress: number | null; updatedAt: number }
/** view.projects 里的一项：某天视角下的项目进度。 */
export interface ProjectView extends Project {
  dayIndex: number;             // 第几天（开始当天 = 1）
  totalDays: number | null;
  daysLeft: number | null;      // 距截止还剩几天，负数 = 逾期
  focusSecondsOnDay: number;    // 当天在项目所有任务上的已结束专注
  focusSecondsTotal: number;    // 截至当天的累计
  taskCount: number;            // 子任务数（不含主任务）
  doneTaskCount: number;
  log: ProjectLog | null;       // 当天的进展
  lastLog: ProjectLog | null;   // 当天之前最近一条
}

export interface WorkbenchView {
  day: StudyDay;
  timeZone: string;
  range: { start: number; end: number };
  pending: readonly Task[];
  completedOnDay: readonly Task[];
  scheduled: readonly (ScheduleBlock & { task: Task })[];
  note: DayNote | null;
  openFocus: FocusSession | null;
  focusSummary: { finishedSessions: number; elapsedSeconds: number };
  projects: readonly ProjectView[]; // v2：当天在进行的项目（已开始、未归档；当天之后才完成的也算）
}

/** Caller supplies stable creation IDs so an interrupted request can be retried. POST /api/command */
export type Command =
  | { type: "createTask"; id: string; title: string; course: string; estimatedSeconds: number | null; projectId?: string | null }
  | { type: "updateTask"; taskId: string; title?: string; course?: string; estimatedSeconds?: number | null }
  | { type: "setTaskCompleted"; taskId: string; completed: boolean }
  | { type: "saveSchedule"; block: ScheduleBlock }
  | { type: "removeSchedule"; blockId: string }
  | { type: "startFocus"; id: string; taskId: string | null; plannedSeconds: number }
  | { type: "changeFocus"; id: string; expectedRevision: number; action: "pause" | "resume" | "finish" }
  | { type: "saveDayNote"; note: Omit<DayNote, "revision">; expectedRevision: number | null }
  | { type: "saveTaskNote"; taskId: string; body: string; expectedRevision: number }
  // v2
  | { type: "createProject"; id: string; title: string; goal?: string; startDay: StudyDay; dueDay?: StudyDay | null; dailyMinutes?: number | null; mainTaskId: string }
  | { type: "updateProject"; projectId: string; title?: string; goal?: string; startDay?: StudyDay; dueDay?: StudyDay | null; dailyMinutes?: number | null }
  | { type: "setProjectState"; projectId: string; action: "complete" | "reopen" | "archive" | "unarchive" }
  | { type: "saveProjectLog"; projectId: string; day: StudyDay; note: string; progress?: number | null };
export type CommandResult =
  | { ok: true }
  | { ok: false; reason: "invalid" | "missing" | "conflict" | "storage" };
export interface Workbench {
  readDay(day: StudyDay, timeZone: string): Promise<WorkbenchView>;
  readTaskNote(taskId: string): Promise<TaskNote>;
  execute(command: Command): Promise<CommandResult>;
}

// ------------------------------------------------------------- v2: 每日维护（app/lib/digest.js）
/** GET /api/review?day=YYYY-MM-DD（默认昨天）→ { ok, digest, factsHash, review, today } */
export interface DayDigest {
  day: StudyDay;
  weekday: string;              // '周六'
  timeZone: string;
  completed: { id: string; title: string; course: string; projectId: string | null }[];
  focus: {
    sessions: number;
    seconds: number;
    byTask: { taskId: string | null; title: string; seconds: number; sessions: number }[]; // 秒数降序；taskId=null 为自由专注
  };
  plan: {
    blocks: {
      id: string; taskId: string; title: string; start: string /* HH:MM */; startsAt: number; minutes: number;
      planOnly: boolean; projectId: string | null; taskDone: boolean; focusSeconds: number;
    }[];
    plannedSeconds: number;
    focusedOnPlannedSeconds: number;
    followRate: number | null;  // 计划里的任务被专注过或完成的比例；没有计划为 null
  };
  unfinishedBlocks: DayDigest["plan"]["blocks"]; // 任务未完成的块：看板「顺延到今天」的候选
  projects: (Pick<ProjectView, "id" | "title" | "goal" | "startDay" | "dueDay" | "dayIndex" | "totalDays" | "daysLeft"
    | "dailyMinutes" | "focusSecondsOnDay" | "focusSecondsTotal" | "taskCount" | "doneTaskCount" | "completedAt" | "log">)[];
  pendingCount: number;
  isEmpty: boolean;
}
export interface DailyReview {
  day: StudyDay; factsHash: string; text: string; provider: string; model: string; createdAt: number;
  stale: boolean;               // 回顾生成后当天记录又变过
}

// ------------------------------------------------------------- v2: 给外部 AI 读的数据
/** GET /api/context?days=14&end=YYYY-MM-DD&notes=1&format=json|md；也由 app/tools/export-ai.mjs 离线生成。不含任何 API Key。 */
export interface AiContext {
  format: "learning-space-ai-context";
  version: 1;
  generatedAt: number;
  timeZone: string;
  today: StudyDay;
  range: { from: StudyDay; to: StudyDay; days: number };
  guide: Record<string, string>;  // 字段口径说明（中文）
  pendingTasks: Pick<Task, "id" | "title" | "course" | "projectId">[];
  projects: (Project & { logs: ProjectLog[] })[];
  days: DayDigest[];              // 从旧到新
  taskNotes?: { taskId: string; title: string; body: string }[]; // 仅 notes=1
}

// ------------------------------------------------------------- v2: 模型接入（app/lib/ai-routes.js，CC Switch 式）
/**
 * 配置文件 app/data/ai-providers.json（gitignore，不进数据库、不进导出）：
 * { version: 1, activeId: string | null, providers: AiProviderRecord[] }，原子写入（临时文件 + rename）。
 */
export type AiProtocol = "openai" | "anthropic"; // openai = OpenAI 兼容 /chat/completions；anthropic = /v1/messages
export interface AiProviderRecord {
  id: string;
  name: string;
  presetId: string | null;      // 来自哪个预设，自定义为 null
  protocol: AiProtocol;
  baseUrl: string;              // 只允许 http(s)
  apiKey: string;               // 仅存文件，任何接口都不返回
  model: string;
  models: string[];             // 最近一次「获取模型列表」的结果
  createdAt: number;
  updatedAt: number;
  lastTest: { ok: boolean; at: number; latencyMs: number | null; message: string } | null;
}
/** 接口返回给前端的形状：没有 apiKey，只有提示。 */
export type AiProviderPublic = Omit<AiProviderRecord, "apiKey"> & { hasKey: boolean; keyHint: string /* 'sk-…a1b2' 或 '' */ };
export interface AiPreset {
  id: string; name: string; protocol: AiProtocol; baseUrl: string;
  models: string[];             // 建议模型，可被在线列表覆盖
  keyUrl: string;               // 去哪里申请 Key
  needsKey: boolean;            // Ollama 等本地服务为 false
  note: string;
}
/**
 * 路由（全部返回 { ok: true, ...payload }；错误按 WorkbenchError 的 reason 映射 400/404/409/500）：
 *   GET  /api/ai/presets                      → { presets: AiPreset[] }
 *   GET  /api/ai/providers                    → { activeId, providers: AiProviderPublic[] }
 *   POST /api/ai/providers/save    { provider: Partial<AiProviderRecord> & { name; protocol; baseUrl; model } }
 *                                             → { provider: AiProviderPublic }   （apiKey 省略或空串 = 保留原 Key；第一个供应商自动设为当前）
 *   POST /api/ai/providers/delete  { id }     → { activeId }
 *   POST /api/ai/providers/activate { id }    → { activeId }
 *   POST /api/ai/providers/models  { id } | { protocol, baseUrl, apiKey }
 *                                             → { models: string[] }            （带 id 时顺便存进 provider.models）
 *   POST /api/ai/providers/test    { id }     → { result: { ok, latencyMs, model, reply } }（同时写 lastTest）
 *   POST /api/ai/import            { text }   → { imported: number, providers: AiProviderPublic[] }
 *        接受：本工作台导出格式；CC Switch 风格的 settingsConfig.env（ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN /
 *        ANTHROPIC_API_KEY / ANTHROPIC_MODEL）；Codex 风格（OPENAI_API_KEY + base_url + model）；
 *        { name, baseUrl|base_url, apiKey|api_key, model } 对象或数组；KEY=VALUE 环境变量文本。
 *   GET  /api/ai/export                       → { format: "learning-space-ai-providers", version: 1, providers: 去掉 apiKey 的记录 }
 *   POST /api/ai/review            { day?: StudyDay; force?: boolean }
 *                                             → { review: DailyReview }        （未变且未 force 直接返回缓存；用当前供应商生成后存 daily_reviews）
 *        v3：素材 = digest.reviewMaterial(day)：当天统计 + 当天任务正文新增（task_note_days 按天留底求差）与接触过的正文摘录
 *        + 前 6 天概况；输出五节【今日概览】【记录要点】【收获】【成长】【明天建议】，300–600 字；指纹 reviewHash 含当天正文。
 */

// ------------------------------------------------------------- v2: 前端模块上下文（app.js → board / ai-settings / projects）
export interface ModuleContext {
  api: {
    get(path: string): Promise<any>;
    post(path: string, body?: unknown): Promise<any>;
    command(command: Command): Promise<{ ok: true; result: unknown }>;
  };
  state: { day: StudyDay; view: WorkbenchView; page: Page }; // 只读，别改外壳状态
  notify(message: string, kind?: "" | "bad"): void;
  modal(html: string): void;    // 打开 #dialog，内容放进 #dialogBody
  closeDialog(): void;
  reload(): Promise<void>;      // 写操作后刷新当天视图
  gotoPage(page: Page): void;
  run(fn: () => Promise<unknown>, success?: string): Promise<boolean | undefined>; // 带忙碌锁、错误提示、成功后 reload
  openTask(taskId: string): void; // 打开某任务的正文（首页）
  prefs: { get(key: string): string | null; set(key: string, value: string): void }; // localStorage 安全封装
  flushNotes(): Promise<boolean>; // 立即保存正文草稿；true = 没有未保存内容（v3：安装更新前调用）
}

// ------------------------------------------------------------- v3: 自动更新（app/lib/updater.js，参考贾维喵管家）
/**
 * 发布源与公钥：app/lib/update-config.js；版本号唯一来源：app/version.json（发版标签必须是 v<version>）。
 * Release 资产 latest.json（下面的 UpdateManifest 原文）+ latest.json.sig（对原文字节的 Ed25519 签名，base64），
 * 由 desktop/release-manifest.mjs 在 CI 里用 secret UPDATE_SIGNING_KEY 生成。
 * 客户端：先验签 → 核对 format/repo/tag/版本 → 本平台包的 url 必须是 https://github.com/<repo>/releases/download/v<版本>/<name>
 * → 下载限 400 MiB、边下边算 SHA-256 → 安装前再算一次 → 用户确认 → 桌面版安装（备份资料库、解压、替换、重启）。
 */
export interface UpdateManifest {
  format: "learning-workbench-update";
  repo: string;                  // 'aiyinsitan520/learning-workbench'
  version: string;               // x.y.z，不带预发布后缀
  tag: string;                   // 'v' + version
  publishedAt: string;           // ISO 时间
  notes: string;                 // 更新说明（desktop/release-notes/<tag>.md）
  packages: Partial<Record<"win32-x64" | "darwin-arm64" | "darwin-x64", { name: string; url: string; size: number; sha256: string }>>;
}
export interface UpdateStatus {
  current: string;
  edition: "desktop" | "source";  // 源码运行只能检查，更新用 git pull
  platform: string;
  status: "idle" | "checking" | "latest" | "available" | "downloading" | "ready" | "installing" | "error";
  latest: { version: string; notes: string; publishedAt: string | null; package: { name: string; size: number } | null } | null;
  progress: { received: number; total: number } | null;
  error: { code: string; message: string } | null;
  checkedAt: number | null;
  autoCheck: boolean;            // 启动 1 分钟后 + 每 6 小时检查；只检查不下载
  signed: boolean;               // 本版本是否带更新公钥
  install: { mode: "restart" | "open" | null; reason: string }; // restart=Windows 替换重启；open=Mac 打开 DMG；null=不能安装
  releasesUrl: string;
  justUpdated: { ok: boolean; from: string; to: string; backup?: string; log?: string } | null;
}
/**
 *   GET  /api/update                                   → { update: UpdateStatus }
 *   POST /api/update { action: 'check' }               → { update }（网络错误写进 update.error，不报 HTTP 错）
 *   POST /api/update { action: 'download' }            → { update }（后台下载，轮询 GET 看进度）
 *   POST /api/update { action: 'install' }             → { update, result: { restarting?: true; opened?: true; message } }
 *   POST /api/update { action: 'settings', autoCheck } → { update }
 *   不能执行的操作（没有新版、不能安装、未下载完）→ 409。
 */
