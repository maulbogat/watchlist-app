/**
 * Global Firestore read quota guard (Admin SDK only).
 * Updates meta/usageStats in a transaction; does not route through other Firestore helpers.
 */

/** @typedef {'hourly' | 'daily'} QuotaPeriod */

class QuotaExceededError extends Error {
  /**
   * @param {QuotaPeriod} period
   */
  constructor(period) {
    super(`Firestore quota exceeded: ${period}`);
    this.name = "QuotaExceededError";
    /** @type {QuotaPeriod} */
    this.period = period;
  }
}

const USAGE_PATH = "meta/usageStats";

/**
 * @param {string} [name]
 * @param {number} defaultVal
 * @returns {number}
 */
function parseEnvInt(name, defaultVal) {
  const v = name ? process.env[name] : undefined;
  if (v == null || String(v).trim() === "") return defaultVal;
  const n = parseInt(String(v).trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : defaultVal;
}

/**
 * @param {Date} d
 * @returns {string}
 */
function utcDateString(d) {
  return d.toISOString().slice(0, 10);
}

/**
 * @param {Date} d
 * @returns {number}
 */
function utcHour(d) {
  return d.getUTCHours();
}

/**
 * @param {import('firebase-admin/firestore').Firestore} db
 * @param {number} estimatedReads
 * @returns {Promise<void>}
 */
async function checkFirestoreQuota(db, estimatedReads) {
  const hourlyLimit = parseEnvInt("FIRESTORE_HOURLY_READ_LIMIT", 5000);
  const dailyLimit = parseEnvInt("FIRESTORE_DAILY_READ_LIMIT", 45000);
  const ref = db.doc(USAGE_PATH);
  const now = new Date();
  const today = utcDateString(now);
  const hour = utcHour(now);
  const n = Number(estimatedReads);
  const delta = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const d = snap.exists ? snap.data() || {} : {};

    let readsToday = Number(d.readsToday);
    if (!Number.isFinite(readsToday)) readsToday = 0;
    let readsThisHour = Number(d.readsThisHour);
    if (!Number.isFinite(readsThisHour)) readsThisHour = 0;
    let lastResetDate = typeof d.lastResetDate === "string" ? d.lastResetDate : "";
    let lastResetHour = Number(d.lastResetHour);
    if (!Number.isFinite(lastResetHour)) lastResetHour = -1;

    if (lastResetDate !== today) {
      readsToday = 0;
      lastResetDate = today;
    }
    if (lastResetHour !== hour) {
      readsThisHour = 0;
      lastResetHour = hour;
    }

    const nextToday = readsToday + delta;
    const nextHour = readsThisHour + delta;

    if (nextHour > hourlyLimit) {
      throw new QuotaExceededError("hourly");
    }
    if (nextToday > dailyLimit) {
      throw new QuotaExceededError("daily");
    }

    tx.set(
      ref,
      {
        readsToday: nextToday,
        readsThisHour: nextHour,
        lastResetDate: today,
        lastResetHour: hour,
        updatedAt: now.toISOString(),
      },
      { merge: true }
    );
  });
}

module.exports = {
  checkFirestoreQuota,
  QuotaExceededError,
};
