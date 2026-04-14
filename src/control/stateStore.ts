import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export type ProjectSettings = {
  rootDir: string;
  apiBase: string;
  model?: string;
  mcpEnabled: boolean;
  temperature: number;
  maxTokens: number;
  trustedRoots: string[];
};

export type ProjectRecord = ProjectSettings & {
  id: string;
  name: string;
  pinned: boolean;
  createdAt: number;
  updatedAt: number;
};

export type ChatMessage = {
  role: string;
  content: unknown;
  ts: number;
  [key: string]: unknown;
};

type ChatMessageInput = {
  role: string;
  content: unknown;
  ts?: number;
  [key: string]: unknown;
};

export type ChatWindowRecord = {
  id: string;
  projectId: string;
  title: string;
  pinned: boolean;
  archived: boolean;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
};

export type UIState = {
  version: number;
  activeProjectId: string | null;
  activeChatId: string | null;
  projects: ProjectRecord[];
  chats: ChatWindowRecord[];
};

const UI_STATE_PATH = path.resolve(process.env.UI_STATE_JSON || "db/ui_state.json");
const TMP_STATE_PATH = `${UI_STATE_PATH}.tmp`;
const BAK_STATE_PATH = `${UI_STATE_PATH}.bak`;
const MAX_CHAT_MESSAGES = Math.max(20, Number(process.env.CHAT_MESSAGES_MAX || 500));

let cache: UIState | null = null;
let writeQueue: Promise<unknown> = Promise.resolve();

function now() {
  return Date.now();
}

async function writeStateFile(state: UIState) {
  await fs.mkdir(path.dirname(UI_STATE_PATH), { recursive: true });
  const payload = JSON.stringify(state, null, 2);
  await fs.writeFile(TMP_STATE_PATH, payload, "utf8");
  await fs.copyFile(TMP_STATE_PATH, BAK_STATE_PATH).catch(() => {});
  await fs.rename(TMP_STATE_PATH, UI_STATE_PATH);
}

function asString(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

function asBool(v: unknown, fallback = false): boolean {
  return typeof v === "boolean" ? v : fallback;
}

function asStringArray(v: unknown, fallback: string[] = []): string[] {
  if (!Array.isArray(v)) return fallback;
  const out = v
    .map((x) => String(x || "").trim())
    .filter(Boolean);
  return Array.from(new Set(out));
}

function sanitizeProjectSettings(settings: Partial<ProjectSettings>, fallback: ProjectSettings): ProjectSettings {
  const tempRaw = Number((settings as any).temperature);
  const maxRaw = Number((settings as any).maxTokens);
  const temperature = Number.isFinite(tempRaw) ? Math.max(0, Math.min(2, tempRaw)) : fallback.temperature;
  const maxTokens = Number.isFinite(maxRaw) ? Math.max(128, Math.min(128000, Math.round(maxRaw))) : fallback.maxTokens;
  const rootDir = asString(settings.rootDir, fallback.rootDir);
  const trustedRoots = asStringArray((settings as any).trustedRoots, fallback.trustedRoots || []);
  if (!trustedRoots.includes(rootDir)) trustedRoots.unshift(rootDir);
  return {
    rootDir,
    apiBase: asString(settings.apiBase, fallback.apiBase),
    model: asString(settings.model, fallback.model || ""),
    mcpEnabled: asBool(settings.mcpEnabled, fallback.mcpEnabled),
    temperature,
    maxTokens,
    trustedRoots,
  };
}

function defaultChat(projectId: string): ChatWindowRecord {
  const ts = now();
  return {
    id: randomUUID(),
    projectId,
    title: "New chat",
    pinned: false,
    archived: false,
    createdAt: ts,
    updatedAt: ts,
    messages: [],
  };
}

function defaultState(defaultSettings: ProjectSettings): UIState {
  const ts = now();
  const projectId = randomUUID();
  const project: ProjectRecord = {
    id: projectId,
    name: "Default",
    pinned: false,
    createdAt: ts,
    updatedAt: ts,
    ...defaultSettings,
  };
  const chat = defaultChat(projectId);
  return {
    version: 3,
    activeProjectId: projectId,
    activeChatId: chat.id,
    projects: [project],
    chats: [chat],
  };
}

function normalizeState(raw: unknown, fallbackSettings: ProjectSettings): UIState {
  if (!raw || typeof raw !== "object") return defaultState(fallbackSettings);
  const src = raw as Partial<UIState>;
  const ts = now();

  const projectsSrc = Array.isArray(src.projects) ? src.projects : [];
  const projects: ProjectRecord[] = projectsSrc
    .map((p: any) => {
      const fallback = sanitizeProjectSettings({}, fallbackSettings);
      const merged = sanitizeProjectSettings(p || {}, fallback);
      return {
        id: asString(p?.id, randomUUID()),
        name: asString(p?.name, "Project"),
        pinned: asBool(p?.pinned, false),
        createdAt: typeof p?.createdAt === "number" ? p.createdAt : ts,
        updatedAt: typeof p?.updatedAt === "number" ? p.updatedAt : ts,
        ...merged,
      };
    })
    .filter((p) => !!p.id);

  if (!projects.length) return defaultState(fallbackSettings);

  const projectIdSet = new Set(projects.map((p) => p.id));
  const chatsSrc = Array.isArray(src.chats) ? src.chats : [];
  let chats: ChatWindowRecord[] = chatsSrc
    .map((c: any) => ({
      id: asString(c?.id, randomUUID()),
      projectId: asString(c?.projectId, ""),
      title: asString(c?.title, "Chat"),
      pinned: asBool(c?.pinned, false),
      archived: asBool(c?.archived, false),
      createdAt: typeof c?.createdAt === "number" ? c.createdAt : ts,
      updatedAt: typeof c?.updatedAt === "number" ? c.updatedAt : ts,
      messages: Array.isArray(c?.messages) ? c.messages : [],
    }))
    .filter((c) => c.projectId && projectIdSet.has(c.projectId));

  for (const p of projects) {
    if (!chats.some((c) => c.projectId === p.id)) chats.push(defaultChat(p.id));
  }

  const firstProject = projects[0];
  const activeProjectId =
    typeof src.activeProjectId === "string" && projectIdSet.has(src.activeProjectId)
      ? src.activeProjectId
      : firstProject.id;

  const activeChatCandidates = chats.filter((c) => c.projectId === activeProjectId);
  const activeChatIdSet = new Set(chats.map((c) => c.id));
  const activeChatId =
    typeof src.activeChatId === "string" && activeChatIdSet.has(src.activeChatId)
      ? src.activeChatId
      : activeChatCandidates[0]?.id || chats[0]?.id || null;

  return {
    version: 3,
    activeProjectId,
    activeChatId,
    projects,
    chats,
  };
}

async function updateState(mutator: (state: UIState) => UIState | void): Promise<UIState> {
  if (!cache) throw new Error("UI state not initialized");
  writeQueue = writeQueue.then(async () => {
    if (!cache) return;
    const cloned = JSON.parse(JSON.stringify(cache)) as UIState;
    const maybe = mutator(cloned);
    cache = maybe || cloned;
    await writeStateFile(cache);
  });
  await writeQueue;
  return getUIState();
}

export async function initUIState(defaultSettings: ProjectSettings): Promise<UIState> {
  try {
    const text = await fs.readFile(UI_STATE_PATH, "utf8");
    cache = normalizeState(JSON.parse(text), defaultSettings);
  } catch {
    cache = defaultState(defaultSettings);
    await writeStateFile(cache);
  }
  return cache;
}

export function getUIState(): UIState {
  if (!cache) throw new Error("UI state not initialized");
  return cache;
}

export function getActiveProject(): ProjectRecord {
  const st = getUIState();
  const active = st.projects.find((p) => p.id === st.activeProjectId);
  if (!active) throw new Error("Active project not found");
  return active;
}

export function getActiveChat(): ChatWindowRecord | null {
  const st = getUIState();
  return st.chats.find((c) => c.id === st.activeChatId) || null;
}

export async function setActiveProject(projectId: string): Promise<UIState> {
  return updateState((st) => {
    const project = st.projects.find((p) => p.id === projectId);
    if (!project) throw new Error("Project not found");
    st.activeProjectId = project.id;
    const chats = st.chats.filter((c) => c.projectId === project.id);
    const live = chats.find((c) => !c.archived);
    st.activeChatId = live?.id || chats[0]?.id || null;
  });
}

export async function listProjects() {
  const st = getUIState();
  const projects = [...st.projects].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    if (a.updatedAt !== b.updatedAt) return b.updatedAt - a.updatedAt;
    return a.name.localeCompare(b.name);
  });
  return { projects, activeProjectId: st.activeProjectId };
}

export async function createProject(input: Partial<ProjectRecord>, fallback: ProjectSettings) {
  return updateState((st) => {
    const ts = now();
    const project: ProjectRecord = {
      id: randomUUID(),
      name: asString(input.name, `Project ${st.projects.length + 1}`),
      pinned: asBool((input as any).pinned, false),
      createdAt: ts,
      updatedAt: ts,
      ...sanitizeProjectSettings(input, fallback),
    };
    st.projects.push(project);
    const chat = defaultChat(project.id);
    st.chats.push(chat);
    st.activeProjectId = project.id;
    st.activeChatId = chat.id;
  });
}

export async function updateProject(projectId: string, patch: Partial<ProjectRecord>, fallback: ProjectSettings) {
  return updateState((st) => {
    const p = st.projects.find((x) => x.id === projectId);
    if (!p) throw new Error("Project not found");
    const nextSettings = sanitizeProjectSettings(patch, p);
    p.name = asString(patch.name, p.name);
    if (typeof (patch as any).pinned === "boolean") p.pinned = (patch as any).pinned;
    p.rootDir = nextSettings.rootDir;
    p.apiBase = nextSettings.apiBase;
    p.model = nextSettings.model;
    p.mcpEnabled = nextSettings.mcpEnabled;
    p.temperature = nextSettings.temperature;
    p.maxTokens = nextSettings.maxTokens;
    p.trustedRoots = nextSettings.trustedRoots;
    p.updatedAt = now();
  });
}

export async function deleteProject(projectId: string) {
  return updateState((st) => {
    if (st.projects.length <= 1) throw new Error("Cannot delete the last project");
    const exists = st.projects.some((p) => p.id === projectId);
    if (!exists) throw new Error("Project not found");

    st.projects = st.projects.filter((p) => p.id !== projectId);
    st.chats = st.chats.filter((c) => c.projectId !== projectId);
    if (st.activeProjectId === projectId) {
      const next = st.projects[0];
      st.activeProjectId = next?.id || null;
      st.activeChatId = st.chats.find((c) => c.projectId === next?.id)?.id || null;
    } else if (st.activeChatId && !st.chats.some((c) => c.id === st.activeChatId)) {
      st.activeChatId = st.chats.find((c) => c.projectId === st.activeProjectId)?.id || null;
    }
  });
}

export async function listChats(projectId: string, opts?: { includeArchived?: boolean }) {
  const st = getUIState();
  const includeArchived = opts?.includeArchived === true;
  const chats = st.chats
    .filter((c) => c.projectId === projectId && (includeArchived || !c.archived))
    .sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      if (a.updatedAt !== b.updatedAt) return b.updatedAt - a.updatedAt;
      return a.title.localeCompare(b.title);
    });
  return { chats, activeChatId: st.activeChatId };
}

export function getChat(chatId: string): ChatWindowRecord {
  const st = getUIState();
  const chat = st.chats.find((c) => c.id === chatId);
  if (!chat) throw new Error("Chat not found");
  return chat;
}

export async function createChat(projectId: string, title?: string) {
  return updateState((st) => {
    const project = st.projects.find((p) => p.id === projectId);
    if (!project) throw new Error("Project not found");
    const ts = now();
    const chat: ChatWindowRecord = {
      id: randomUUID(),
      projectId,
      title: title?.trim() || "New chat",
      pinned: false,
      archived: false,
      createdAt: ts,
      updatedAt: ts,
      messages: [],
    };
    st.chats.push(chat);
    st.activeProjectId = projectId;
    st.activeChatId = chat.id;
    project.updatedAt = now();
  });
}

export async function updateChat(chatId: string, patch: Partial<ChatWindowRecord>) {
  return updateState((st) => {
    const chat = st.chats.find((c) => c.id === chatId);
    if (!chat) throw new Error("Chat not found");
    if (typeof patch.title === "string") chat.title = patch.title;
    if (typeof patch.pinned === "boolean") chat.pinned = patch.pinned;
    if (typeof patch.archived === "boolean") chat.archived = patch.archived;
    if (Array.isArray(patch.messages)) chat.messages = patch.messages as ChatMessage[];
    chat.updatedAt = now();
    const project = st.projects.find((p) => p.id === chat.projectId);
    if (project) project.updatedAt = now();
  });
}

export async function appendChatMessage(chatId: string, message: ChatMessageInput) {
  return updateState((st) => {
    const chat = st.chats.find((c) => c.id === chatId);
    if (!chat) throw new Error("Chat not found");
    const nextMessage: ChatMessage = {
      ...message,
      ts: typeof message.ts === "number" ? message.ts : now(),
    };
    chat.messages.push(nextMessage);
    if (chat.messages.length > MAX_CHAT_MESSAGES) {
      chat.messages = chat.messages.slice(chat.messages.length - MAX_CHAT_MESSAGES);
    }
    chat.updatedAt = now();

    const project = st.projects.find((p) => p.id === chat.projectId);
    if (project) project.updatedAt = now();
  });
}

export async function setActiveChat(chatId: string) {
  return updateState((st) => {
    const chat = st.chats.find((c) => c.id === chatId);
    if (!chat) throw new Error("Chat not found");
    if (chat.archived) throw new Error("Cannot activate archived chat");
    st.activeChatId = chat.id;
    st.activeProjectId = chat.projectId;
  });
}

export async function deleteChat(chatId: string) {
  return updateState((st) => {
    const chat = st.chats.find((c) => c.id === chatId);
    if (!chat) throw new Error("Chat not found");
    st.chats = st.chats.filter((c) => c.id !== chatId);

    const projectChats = st.chats.filter((c) => c.projectId === chat.projectId);
    if (!projectChats.length) {
      const replacement = defaultChat(chat.projectId);
      st.chats.push(replacement);
      if (st.activeChatId === chatId) st.activeChatId = replacement.id;
    } else if (st.activeChatId === chatId) {
      st.activeChatId = projectChats[0].id;
    }
    const project = st.projects.find((p) => p.id === chat.projectId);
    if (project) project.updatedAt = now();
  });
}

export async function archiveChat(chatId: string) {
  return updateState((st) => {
    const chat = st.chats.find((c) => c.id === chatId);
    if (!chat) throw new Error("Chat not found");
    chat.archived = true;
    chat.updatedAt = now();

    if (st.activeChatId === chatId) {
      const next = st.chats.find((c) => c.projectId === chat.projectId && !c.archived && c.id !== chatId);
      st.activeChatId = next?.id || null;
    }

    const project = st.projects.find((p) => p.id === chat.projectId);
    if (project) project.updatedAt = now();
  });
}

export async function bulkDeleteChats(projectId: string, opts?: { includePinned?: boolean; includeArchived?: boolean }) {
  return updateState((st) => {
    const includePinned = opts?.includePinned === true;
    const includeArchived = opts?.includeArchived === true;

    const keep: ChatWindowRecord[] = [];
    let deleted = 0;
    for (const chat of st.chats) {
      if (chat.projectId !== projectId) {
        keep.push(chat);
        continue;
      }
      if (!includeArchived && chat.archived) {
        keep.push(chat);
        continue;
      }
      if (!includePinned && chat.pinned) {
        keep.push(chat);
        continue;
      }
      deleted++;
    }
    st.chats = keep;

    const hasLive = st.chats.some((c) => c.projectId === projectId && !c.archived);
    if (!hasLive) st.chats.push(defaultChat(projectId));

    if (st.activeProjectId === projectId) {
      const next = st.chats.find((c) => c.projectId === projectId && !c.archived);
      st.activeChatId = next?.id || null;
    }

    const project = st.projects.find((p) => p.id === projectId);
    if (project) project.updatedAt = now();
    if (deleted === 0) throw new Error("No chats matched deletion filter");
  });
}

export async function duplicateProject(projectId: string, fallback: ProjectSettings) {
  return updateState((st) => {
    const source = st.projects.find((p) => p.id === projectId);
    if (!source) throw new Error("Project not found");
    const ts = now();
    const cloned: ProjectRecord = {
      id: randomUUID(),
      name: `${source.name} Copy`,
      pinned: false,
      createdAt: ts,
      updatedAt: ts,
      ...sanitizeProjectSettings(source, fallback),
    };
    st.projects.push(cloned);
    const chat = defaultChat(cloned.id);
    st.chats.push(chat);
    st.activeProjectId = cloned.id;
    st.activeChatId = chat.id;
  });
}

export function exportProjectConfig(projectId: string) {
  const st = getUIState();
  const p = st.projects.find((x) => x.id === projectId);
  if (!p) throw new Error("Project not found");
  return {
    version: 1,
    exportedAt: Date.now(),
    project: {
      name: p.name,
      pinned: p.pinned,
      rootDir: p.rootDir,
      apiBase: p.apiBase,
      model: p.model,
      mcpEnabled: p.mcpEnabled,
      temperature: p.temperature,
      maxTokens: p.maxTokens,
      trustedRoots: p.trustedRoots,
    },
  };
}

export async function importProjectConfig(input: any, fallback: ProjectSettings) {
  const raw = input?.project || input;
  if (!raw || typeof raw !== "object") throw new Error("Invalid project config payload");
  return createProject(
    {
      name: asString(raw.name, undefined as any),
      pinned: asBool(raw.pinned, false),
      rootDir: asString(raw.rootDir, fallback.rootDir),
      apiBase: asString(raw.apiBase, fallback.apiBase),
      model: asString(raw.model, fallback.model || ""),
      mcpEnabled: asBool(raw.mcpEnabled, fallback.mcpEnabled),
      temperature: Number(raw.temperature),
      maxTokens: Number(raw.maxTokens),
      trustedRoots: asStringArray(raw.trustedRoots, fallback.trustedRoots),
    } as any,
    fallback
  );
}

export async function backupUIState(filePath?: string) {
  const st = getUIState();
  const target = path.resolve(filePath || `db/ui_state.backup.${Date.now()}.json`);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, JSON.stringify(st, null, 2), "utf8");
  return { path: target };
}

export async function restoreUIState(payload: any, fallback: ProjectSettings) {
  const normalized = normalizeState(payload, fallback);
  cache = normalized;
  await writeStateFile(normalized);
  return normalized;
}
