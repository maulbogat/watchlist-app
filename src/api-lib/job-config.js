const JOB_CONFIG_COLLECTION = "meta";
const JOB_CONFIG_DOC_ID = "jobConfig";

function jobConfigRef(db) {
  return db.collection(JOB_CONFIG_COLLECTION).doc(JOB_CONFIG_DOC_ID);
}

async function readJobConfig(db) {
  const snap = await jobConfigRef(db).get();
  const data = snap.exists ? snap.data() || {} : {};
  return {
    checkUpcomingEnabled: data.checkUpcomingEnabled !== false,
    githubBackupEnabled: data.githubBackupEnabled !== false,
    lastRunAt: data.lastRunAt || null,
    lastRunStatus: data.lastRunStatus || null,
    lastRunMessage: data.lastRunMessage || null,
    lastRunResult: data.lastRunResult || null,
  };
}

async function setCheckUpcomingEnabled(db, enabled) {
  await jobConfigRef(db).set(
    {
      checkUpcomingEnabled: !!enabled,
      updatedAt: new Date().toISOString(),
    },
    { merge: true }
  );
  return readJobConfig(db);
}

async function setGithubBackupEnabled(db, enabled) {
  await jobConfigRef(db).set(
    {
      githubBackupEnabled: !!enabled,
      updatedAt: new Date().toISOString(),
    },
    { merge: true }
  );
  return readJobConfig(db);
}

async function writeCheckUpcomingRunResult(db, payload) {
  await jobConfigRef(db).set(
    {
      lastRunAt: new Date().toISOString(),
      lastRunStatus: payload?.status || null,
      lastRunMessage: payload?.message || null,
      lastRunResult: payload?.result || null,
      lastRunTrigger: payload?.trigger || null,
      updatedAt: new Date().toISOString(),
    },
    { merge: true }
  );
}

module.exports = {
  readJobConfig,
  setCheckUpcomingEnabled,
  setGithubBackupEnabled,
  writeCheckUpcomingRunResult,
};
