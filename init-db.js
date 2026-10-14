const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');

const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

const dbPath = path.join(__dirname, 'chat.db');
const db = new sqlite3.Database(dbPath);

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function(err) {
      err ? reject(err) : resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows));
  });
}

async function init() {
  await run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    avatar_url TEXT,
    theme TEXT DEFAULT 'system',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  await run(`CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sender_id INTEGER NOT NULL,
    recipient_id INTEGER NOT NULL,
    type TEXT DEFAULT 'text',
    content TEXT NOT NULL,
    media_url TEXT,
    media_name TEXT,
    media_size INTEGER,
    media_duration INTEGER,
    reply_to_id INTEGER,
    edited_at DATETIME,
    deleted_at DATETIME,
    deleted_for_everyone BOOLEAN DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (sender_id) REFERENCES users(id),
    FOREIGN KEY (recipient_id) REFERENCES users(id),
    FOREIGN KEY (reply_to_id) REFERENCES messages(id)
  )`);

  await run(`CREATE TABLE IF NOT EXISTS reactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    emoji TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id),
    UNIQUE(message_id, user_id, emoji)
  )`);

  await run(`CREATE TABLE IF NOT EXISTS message_deletions (
    message_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (message_id, user_id),
    FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id)
  )`);

  const userCols = (await all(`PRAGMA table_info(users)`)).map(r => r.name);
  const msgCols = (await all(`PRAGMA table_info(messages)`)).map(r => r.name);

  const userMigrations = [
    ['avatar_url', 'ALTER TABLE users ADD COLUMN avatar_url TEXT'],
    ['theme', "ALTER TABLE users ADD COLUMN theme TEXT DEFAULT 'system'"]
  ];
  for (const [col, sql] of userMigrations) {
    if (!userCols.includes(col)) {
      await run(sql);
      console.log(`Migrated: users.${col}`);
    }
  }

  const msgMigrations = [
    ['typing_status', 'ALTER TABLE messages ADD COLUMN typing_status TEXT'],
    ['edit_history', 'ALTER TABLE messages ADD COLUMN edit_history TEXT'],
    ['read_at', 'ALTER TABLE messages ADD COLUMN read_at DATETIME'],
    ['is_pinned', 'ALTER TABLE messages ADD COLUMN is_pinned BOOLEAN DEFAULT 0']
  ];
  for (const [col, sql] of msgMigrations) {
    if (!msgCols.includes(col)) {
      await run(sql);
      console.log(`Migrated: messages.${col}`);
    }
  }

  await run(`CREATE TABLE IF NOT EXISTS settings (
    user_id INTEGER PRIMARY KEY,
    theme TEXT DEFAULT 'system',
    notifications BOOLEAN DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  )`);

  await run(`CREATE TABLE IF NOT EXISTS user_presence (
    user_id INTEGER PRIMARY KEY,
    status TEXT DEFAULT 'offline',
    last_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
    typing_to INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (typing_to) REFERENCES users(id)
  )`);

  await run(`CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(sender_id, recipient_id)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_reactions_message ON reactions(message_id)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_message_deletions_lookup ON message_deletions(message_id, user_id)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_messages_read ON messages(recipient_id, read_at)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_messages_pinned ON messages(sender_id, recipient_id, is_pinned)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_messages_search ON messages(content)`);
  await run('PRAGMA foreign_keys = ON');

  const users = [
    { username: 'mateus', password: '01850309' },
    { username: 'debora', password: '23092025' }
  ];

  for (const user of users) {
    const existing = await all('SELECT id FROM users WHERE username = ?', [user.username]);
    if (!existing.length) {
      const hash = bcrypt.hashSync(user.password, 10);
      await run('INSERT INTO users (username, password_hash) VALUES (?, ?)', [user.username, hash]);
      console.log(`User ${user.username} created`);
    } else {
      console.log(`User ${user.username} verified`);
    }
  }

  console.log('Database initialized successfully at:', dbPath);
  db.close(() => console.log('Done'));
}

init().catch(e => {
  console.error('Init failed:', e);
  process.exit(1);
});