const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const path = require('path');

const dbPath = path.join(__dirname, 'chat.db');
const db = new sqlite3.Database(dbPath);

db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sender_id INTEGER NOT NULL,
      recipient_id INTEGER NOT NULL,
      content TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (sender_id) REFERENCES users(id),
      FOREIGN KEY (recipient_id) REFERENCES users(id)
    )
  `);

  db.run(`CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(sender_id, recipient_id)`);

  const users = [
    { username: 'mateus', password: '01850309' },
    { username: 'debora', password: '23092025' }
  ];

  const insertUser = db.prepare('INSERT OR IGNORE INTO users (username, password_hash) VALUES (?, ?)');

  for (const user of users) {
    const hash = bcrypt.hashSync(user.password, 10);
    insertUser.run(user.username, hash, function(err) {
      if (err) console.error(`Error creating user ${user.username}:`, err);
      else console.log(`User ${user.username} created/verified`);
    });
  }

  insertUser.finalize();

  console.log('Database initialized successfully at:', dbPath);
});

db.close();