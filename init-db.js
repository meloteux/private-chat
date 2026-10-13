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
    ['type', "ALTER TABLE messages ADD COLUMN type TEXT DEFAULT 'text'"],
    ['media_url', 'ALTER TABLE messages ADD COLUMN media_url TEXT'],
    ['media_name', 'ALTER TABLE messages ADD COLUMN media_name TEXT'],
    ['media_size', 'ALTER TABLE messages ADD COLUMN media_size INTEGER'],
    ['media_duration', 'ALTER TABLE messages ADD COLUMN media_duration INTEGER'],
    ['reply_to_id', 'ALTER TABLE messages ADD COLUMN reply_to_id INTEGER'],
    ['edited_at', 'ALTER TABLE messages ADD COLUMN edited_at DATETIME'],
    ['deleted_at', 'ALTER TABLE messages ADD COLUMN deleted_at DATETIME'],
    ['deleted_for_everyone', 'ALTER TABLE messages ADD COLUMN deleted_for_everyone BOOLEAN DEFAULT 0']
  ];
  for (const [col, sql] of msgMigrations) {
    if (!msgCols.includes(col)) {
      await run(sql);
      console.log(`Migrated: messages.${col}`);
    }
  }

  await run(`CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(sender_id, recipient_id)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_reactions_message ON reactions(message_id)`);

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