CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY);
CREATE TABLE sources (
  id TEXT PRIMARY KEY, requestId TEXT NOT NULL UNIQUE, rawPath TEXT NOT NULL UNIQUE,
  inputType TEXT NOT NULL DEFAULT 'message', createdAt TEXT NOT NULL,
  contentHash TEXT NOT NULL, status TEXT NOT NULL
);
CREATE TABLE notes (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, wikiPath TEXT NOT NULL UNIQUE,
  currentVersion INTEGER NOT NULL, contentHash TEXT NOT NULL,
  createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
);
CREATE TABLE change_proposals (
  id TEXT PRIMARY KEY, runId TEXT, action TEXT NOT NULL, targetNoteId TEXT NOT NULL,
  baseVersion INTEGER, proposedTitle TEXT NOT NULL, proposedContent TEXT NOT NULL,
  sourceIds TEXT NOT NULL, dependencies TEXT NOT NULL, contentHash TEXT NOT NULL,
  reason TEXT NOT NULL, status TEXT NOT NULL, restoredFromVersion INTEGER,
  createdAt TEXT NOT NULL, decidedAt TEXT
);
CREATE TABLE note_versions (
  noteId TEXT NOT NULL REFERENCES notes(id), version INTEGER NOT NULL,
  title TEXT NOT NULL, contentHash TEXT NOT NULL, snapshotPath TEXT NOT NULL UNIQUE,
  createdAt TEXT NOT NULL, proposalId TEXT NOT NULL REFERENCES change_proposals(id),
  restoredFromVersion INTEGER, PRIMARY KEY(noteId, version)
);
CREATE TABLE note_sources (
  noteId TEXT NOT NULL REFERENCES notes(id), sourceId TEXT NOT NULL REFERENCES sources(id),
  PRIMARY KEY(noteId, sourceId)
);
CREATE TABLE note_version_sources (
  noteId TEXT NOT NULL, version INTEGER NOT NULL, sourceId TEXT NOT NULL REFERENCES sources(id),
  FOREIGN KEY(noteId, version) REFERENCES note_versions(noteId, version),
  PRIMARY KEY(noteId, version, sourceId)
);
CREATE TABLE write_operations (
  id TEXT PRIMARY KEY, proposalId TEXT NOT NULL UNIQUE REFERENCES change_proposals(id),
  noteId TEXT NOT NULL, fromVersion INTEGER NOT NULL, toVersion INTEGER NOT NULL,
  beforeHash TEXT, afterHash TEXT NOT NULL, state TEXT NOT NULL,
  error TEXT, createdAt TEXT NOT NULL
);
CREATE UNIQUE INDEX one_active_write ON write_operations ((1)) WHERE state IN ('prepared', 'file_replaced', 'needs_recovery');
CREATE TABLE agent_runs (
  id TEXT PRIMARY KEY, requestId TEXT NOT NULL, sourceId TEXT NOT NULL REFERENCES sources(id),
  intent TEXT, status TEXT NOT NULL, selectedTools TEXT NOT NULL DEFAULT '[]',
  durationMs INTEGER, usage TEXT, result TEXT, errorCode TEXT, createdAt TEXT NOT NULL
);
CREATE UNIQUE INDEX one_active_run_request ON agent_runs(requestId) WHERE status = 'running';
CREATE TABLE audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, eventType TEXT NOT NULL, actor TEXT NOT NULL,
  noteId TEXT, proposalId TEXT, operationId TEXT, detail TEXT NOT NULL, createdAt TEXT NOT NULL
);
CREATE VIRTUAL TABLE notes_fts USING fts5(noteId UNINDEXED, title, content, tokenize='unicode61');
INSERT INTO schema_migrations VALUES (1);
