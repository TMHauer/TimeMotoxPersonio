export type OpenSession = {
  email: string;
  startAtUtcMs: number;
  startBerlinISO: string;
  autoCloseAtUtcMs: number;
  autoCloseAtBerlinISO: string;
  personioPeriodId: string;
  openedEventId: string;
};

type RedisLike = {
  get(key: string): Promise<any>;
  set(key: string, value: any, ...args: any[]): Promise<any>;
  del(key: string): Promise<any>;
};

const KEY_OPEN = (email: string) => `session:open:${email}`;

// Canonical function names
export async function getOpenSession(redis: RedisLike, email: string): Promise<OpenSession | null> {
  const raw = await redis.get(KEY_OPEN(email));
  if (!raw) return null;
  try {
    return typeof raw === "string" ? (JSON.parse(raw) as OpenSession) : (raw as OpenSession);
  } catch {
    return null;
  }
}

export async function setOpenSession(redis: RedisLike, session: OpenSession): Promise<void> {
  await redis.set(KEY_OPEN(session.email), JSON.stringify(session));
}

export async function clearOpenSession(redis: RedisLike, email: string): Promise<void> {
  await redis.del(KEY_OPEN(email));
}

// Also export the "short" aliases (in case other files already use them)
export const getOpen = getOpenSession;
export const setOpen = setOpenSession;
export const clearOpen = clearOpenSession;
